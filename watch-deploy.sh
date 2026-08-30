#!/bin/bash
# watch-deploy.sh — Watch source files and auto-redeploy on changes.
#
# Do not start this directly. Use ensure-watcher.sh, which is idempotent,
# detaches it properly, and is what cron re-runs to bring it back after a crash
# or a reboot:
#
#   bash ensure-watcher.sh
#
# Not `nohup bash watch-deploy.sh &`: QNAP's busybox has no nohup, and a plain
# background job dies with SIGHUP when the SSH session that started it drops.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PIDFILE="$SCRIPT_DIR/.watcher.pid"
echo $$ > "$PIDFILE"

# Record this script's checksum at startup so ensure-watcher.sh can tell a
# current watcher from one still running pre-edit code.
VERFILE="$SCRIPT_DIR/.watcher.ver"
md5sum "$SCRIPT_DIR/watch-deploy.sh" 2>/dev/null | cut -d' ' -f1 > "$VERFILE"

# EXIT alone for cleanup, with separate handlers that actually exit. A single
# `trap ... EXIT INT TERM` runs on TERM but does NOT exit — bash resumes the
# loop — leaving a watcher alive that has just deleted its own pid file.
trap 'rm -f "$PIDFILE" "$VERFILE"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

# Unlike campaign_app, whose source is a handful of flat files, this is a Vite
# project: the app is a tree. So these are DIRECTORIES walked recursively, plus
# the few root files that change what gets built. Anything baked into the image
# by the Dockerfile must appear here, or editing it changes production behaviour
# on the next rebuild without ever triggering one.
#
# Deliberately absent: node_modules and dist (build outputs, rewritten by every
# build — watching them would make the watcher retrigger itself forever).
WATCH_PATHS="src api server public index.html vite.config.ts tsconfig.json package.json Dockerfile docker-compose.yml"
LOG_FILE="$SCRIPT_DIR/deploy.log"

# Liveness beacon. campaign_app writes this into its bind-mounted data/ so the
# app container can report a dead watcher over HTTP; this project has no
# bind-mount and no such endpoint, so the file is local and `ensure-watcher.sh
# --status` is what reads it. The cron safety net is the part that matters.
HEARTBEAT="$SCRIPT_DIR/.watcher-heartbeat"
beat() { date +%s > "$HEARTBEAT" 2>/dev/null; }
beat

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Watcher started (PID $$). Monitoring: $WATCH_PATHS" | tee -a "$LOG_FILE"

# Hash the file LIST as well as the contents, so an added, deleted or renamed
# file is detected even when the total bytes happen to be unchanged.
# `-exec ... +` rather than xargs: no quoting surprises on paths with spaces.
get_hash() {
  {
    find $WATCH_PATHS -type f 2>/dev/null | sort
    find $WATCH_PATHS -type f -exec cat {} + 2>/dev/null
  } | md5sum | cut -d' ' -f1
}

LAST_HASH=$(get_hash)

if command -v inotifywait >/dev/null 2>&1; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Using inotifywait (recursive)" | tee -a "$LOG_FILE"
  while true; do
    # -r because these are directories. -t 60 so a quiet week still ticks the
    # heartbeat; without it inotifywait blocks forever and the beacon goes
    # stale while the watcher is perfectly healthy.
    inotifywait -q -t 60 -r -e modify,create,delete,move $WATCH_PATHS 2>/dev/null
    beat
    sleep 1  # debounce
    # Inner loop: keep redeploying while files keep changing, so edits made
    # *during* a build are not lost (inotifywait is not listening then).
    while NEW_HASH=$(get_hash); [ "$NEW_HASH" != "$LAST_HASH" ]; do
      LAST_HASH="$NEW_HASH"
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Changes detected — redeploying..." | tee -a "$LOG_FILE"
      bash "$SCRIPT_DIR/deploy.sh" 2>&1 | tee -a "$LOG_FILE"
      sleep 1
    done
  done
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] inotifywait not found — polling every 5s" | tee -a "$LOG_FILE"
  while true; do
    sleep 5
    beat
    while NEW_HASH=$(get_hash); [ "$NEW_HASH" != "$LAST_HASH" ]; do
      LAST_HASH="$NEW_HASH"
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Changes detected — redeploying..." | tee -a "$LOG_FILE"
      bash "$SCRIPT_DIR/deploy.sh" 2>&1 | tee -a "$LOG_FILE"
      sleep 1
    done
  done
fi
