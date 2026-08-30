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

# QNAP requires root for docker.
SUDO=""
if [ "$(id -u)" != "0" ]; then
  SUDO="sudo"
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
if [ ! -f .env ]; then
  echo "ERROR: no .env here. Song recognition needs a token:"
  echo "    echo 'AUDD_API_TOKEN=your_token_here' > $SCRIPT_DIR/.env"
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
