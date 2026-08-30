#!/bin/bash
# deploy.sh -- Rebuild and restart the Sing Along container. Run this on the NAS.
#
#   cd /share/ZFS21_DATA/docker_containers/indagotta-devita
#   ./deploy.sh            # normal build, reuses cached layers
#   ./deploy.sh --clean    # full rebuild, no cache
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# QNAP needs root for docker.
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

if [ ! -f .env ]; then
  echo "ERROR: no .env file here."
  echo "Create one with your AudD token:"
  echo "    echo 'AUDD_API_TOKEN=your_token_here' > .env"
  exit 1
fi

BUILD_ARGS=""
if [ "$1" = "--clean" ]; then
  BUILD_ARGS="--no-cache"
  echo "Full rebuild (--no-cache) -- this will take a few minutes."
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Building sing-along..."

# Check the build's exit status explicitly. Piping it elsewhere would make $?
# the pipe's status, so a failed build would read as success and `up -d` would
# happily restart the OLD image against the new config.
$COMPOSE build $BUILD_ARGS
BUILD_STATUS=$?
if [ $BUILD_STATUS -ne 0 ]; then
  echo "BUILD FAILED (exit $BUILD_STATUS) -- container left running on the previous image."
  exit $BUILD_STATUS
fi

echo "Build OK. Restarting container..."
$COMPOSE up -d

echo "Waiting for the health check..."
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3300/healthz >/dev/null 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Deployed. http://127.0.0.1:3300/healthz -> ok"
    exit 0
  fi
  sleep 1
done

echo "WARNING: container started but /healthz did not answer within 30s."
echo "Check the logs:  $COMPOSE logs --tail=50"
exit 1
