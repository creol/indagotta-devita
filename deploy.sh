#!/bin/bash
# deploy.sh — Rebuild and restart the Sing Along container.
#
# Run it on chonk, or let watch-deploy.sh run it for you:
#   bash deploy.sh            normal build, reuses cached layers
#   bash deploy.sh --clean    full --no-cache rebuild
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*"version": *"//;s/".*//')
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deploying singalong v${VERSION}..."

# Container Station's docker is not on a non-interactive shell's PATH. That is
# why `ssh chonk 'bash deploy.sh'` dies with "docker: command not found" while
# the identical command typed into an SSH session works -- and it would break
# the cron watcher too, since cron is non-interactive as well.
if ! command -v docker >/dev/null 2>&1; then
  # Ask a login shell first: it resolves the same docker an interactive session
  # would use, which matters because several volumes each carry a copy.
  DOCKER_BIN="$(bash -lc 'command -v docker' 2>/dev/null)"
  if [ -x "$DOCKER_BIN" ]; then
    PATH="$(dirname "$DOCKER_BIN"):$PATH"
  else
    for candidate in /share/*/.qpkg/container-station/bin; do
      if [ -x "$candidate/docker" ]; then PATH="$candidate:$PATH"; break; fi
    done
  fi
  export PATH
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found. Is Container Station installed and running?"
  exit 1
fi

# QNAP's docker socket is admin:administrators, and this account is usually in
# that group -- so sudo is often unnecessary. Test before reaching for it: a
# sudo password prompt has nowhere to go in an unattended run (cron, ssh) and
# would hang the deploy indefinitely rather than failing.
SUDO=""
if [ "$(id -u)" != "0" ] && ! docker ps >/dev/null 2>&1; then
  SUDO="sudo"
  # Fail fast rather than blocking on a prompt nobody can answer.
  if ! sudo -n true 2>/dev/null; then
    if [ ! -t 0 ]; then
      echo "ERROR: docker needs sudo here, but this is not an interactive shell"
      echo "       and sudo wants a password, so it would hang."
      echo "       Run it from an SSH session, or add this account to the group"
      echo "       owning /var/run/docker.sock."
      exit 1
    fi
    echo "docker requires sudo; you will be prompted for a password."
  fi
fi

# docker compose v2 if present, else the v1 binary.
if $SUDO docker compose version >/dev/null 2>&1; then
  COMPOSE="$SUDO docker compose"
else
  COMPOSE="$SUDO docker-compose"
fi

# Fail before a multi-minute build rather than after it. The compose file uses
# ${AUDD_API_TOKEN:?...}, so a missing token would stop `up -d` anyway — this
# just makes the failure immediate and the reason obvious.
# Container Station ships docker as a wrapper that points its config directory
# at container-station's own homes folder, which an ordinary account cannot
# write. buildx needs to create state there, so `docker compose build` fails
# with "mkdir ...: permission denied" -- but only when not root, which is
# exactly why an interactive `sudo` run works and an unattended one does not.
if ! ${SUDO} docker buildx ls >/dev/null 2>&1; then
  DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
  export DOCKER_CONFIG
  mkdir -p "$DOCKER_CONFIG" 2>/dev/null || true
  if ! ${SUDO} docker buildx ls >/dev/null 2>&1; then
    echo "ERROR: docker buildx is unusable, and a writable DOCKER_CONFIG did not"
    echo "       fix it. Tried: $DOCKER_CONFIG"
    exit 1
  fi
fi

if [ ! -f .env ]; then
  echo "ERROR: no .env here. Song recognition needs a token:"
  echo "    echo 'AUDD_API_TOKEN=your_token_here' > $SCRIPT_DIR/.env"
  exit 1
fi

# A .env created on Windows is the single most likely way this deploy breaks, and
# the error docker returns for it is unreadable -- the whole first line arrives as
# one variable name full of NUL bytes. Two distinct faults, both caught here:
#
#   BOM   PowerShell 5.1's `echo x > file` writes UTF-16LE with a byte-order mark.
#         Docker's parser reads it as garbage and fails before any build starts.
#   CRLF  Survives even a plain ASCII file, and is worse because it does NOT fail:
#         the trailing CR is included in the value, so a token that looks perfect
#         is silently rejected by AudD as invalid.
#
# Detection avoids embedding a carriage return in this script: `tr -cd` keeps only
# CR bytes and counts them, so there is no escape sequence to get mangled by an
# editor, a git checkout, or a copy through a Windows share.
# busybox on QNAP has no `od`, so check the SHAPE of the text rather than raw
# bytes. Strip NULs -- which are what make a UTF-16 file unreadable -- and
# require the first meaningful line to look like a comment or NAME=value. A
# UTF-8 BOM, a UTF-16 encoding, and any other mangling all fail this the same
# obvious way, without needing a hex dump to detect them.
ENV_FIRST_LINE="$(head -c 1024 .env | tr -d '\000' | grep -v '^[[:space:]]*$' | head -1)"
case "$ENV_FIRST_LINE" in
  '#'*) : ;;
  [A-Za-z_]*=*) : ;;
  *)
    cat <<'MSG'
ERROR: .env does not start with a readable NAME=value line.
       Almost always this means it was written on Windows: PowerShell's
       `echo x > file` produces UTF-16 with a byte-order mark, which docker
       cannot parse. Recreate it here, in this shell:

         echo 'AUDD_API_TOKEN=your_token_here' > .env

       or convert the existing file in place, keeping your token:

         python3 -c "import pathlib;p=pathlib.Path('.env');p.write_bytes(p.read_bytes().decode('utf-16').replace(chr(13),'').encode('utf-8'))"
MSG
    exit 1
    ;;
esac

if [ "$(tr -cd '\r' < .env | wc -c | tr -d ' ')" != "0" ]; then
  cat <<'MSG'
ERROR: .env has Windows CRLF line endings.
       The trailing carriage return becomes part of the token, so AudD rejects
       it while the file looks perfectly correct. Strip them:

         sed -i 's/\r$//' .env
MSG
  exit 1
fi

BUILD_ARGS=""
if [ "$1" = "--clean" ]; then
  BUILD_ARGS="--no-cache"
  echo "Full rebuild (--no-cache) — expect several minutes."
fi

# `|| BUILD_EXIT=$?` rather than a bare call: `set -e` above would otherwise
# abort here and skip the check entirely, and `up -d` would never run — but a
# piped build would also make $? the pipe's status, reporting a failed build as
# success and redeploying the previous image against the new config.
BUILD_EXIT=0
$COMPOSE build $BUILD_ARGS || BUILD_EXIT=$?

# A build can fail because this NAS's zfs graph driver lost a layer rather than
# because the source is wrong — the same transient failure documented in
# campaign_app/deploy.sh. Clear dangling layers and the build cache, retry once.
# Dangling images only: never -a, never --volumes, so no other stack's tagged
# image can be caught by it.
if [ "$BUILD_EXIT" != "0" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Build failed (exit $BUILD_EXIT) — pruning and retrying once..."
  $SUDO docker image prune -f 2>&1 | tail -1 || echo "  image prune skipped (non-fatal)"
  $SUDO docker builder prune -f 2>&1 | tail -1 || echo "  builder prune skipped (non-fatal)"
  BUILD_EXIT=0
  $COMPOSE build $BUILD_ARGS || BUILD_EXIT=$?
fi

if [ "$BUILD_EXIT" != "0" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] BUILD FAILED (exit $BUILD_EXIT), including after a prune and one retry — not restarting. The old container is still up."
  exit "$BUILD_EXIT"
fi

$COMPOSE up -d

# Reclaim what this build orphaned. Every rebuild retags singalong:latest and
# leaves the previous image as an untagged layer set; unattended auto-deploys
# accumulate those until the volume fills. Same rules as campaign_app: dangling
# images only (never -a, which would take a stopped sidecar's tagged image), no
# --volumes, and a week of build cache kept so a same-week rebuild stays fast.
# Cleanup failures are logged, never fatal — a deploy that worked must not be
# reported as failed because a prune did not.
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Reclaiming dangling images and stale build cache..."
$SUDO docker image prune -f 2>&1 | tail -1 || echo "  image prune skipped (non-fatal)"
$SUDO docker builder prune -f --filter until=168h 2>&1 | tail -1 || echo "  builder prune skipped (non-fatal)"

# Confirm the container actually answers, rather than trusting `up -d`.
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3300/healthz >/dev/null 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deployed v${VERSION}. Verify with: curl -s localhost:3300/healthz"
    exit 0
  fi
  sleep 1
done

echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: container started but /healthz did not answer within 30s."
echo "  Check: $COMPOSE logs --tail=50"
exit 1
