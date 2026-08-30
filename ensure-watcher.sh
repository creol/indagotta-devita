#!/bin/bash
# ensure-watcher.sh — start watch-deploy.sh if it is not already running.
#
# This is what makes the watcher permanent. Run it from cron every few minutes and
# the watcher comes back on its own after a crash, after an SSH drop, and after a
# reboot — without installing anything into QTS's boot sequence, which QNAP
# firmware updates overwrite.
#
# Idempotent by design: running it when a watcher is already up is a no-op, so
# there is no harm in a tight cron schedule and no harm in running it by hand.
#
#   Install (on chonk, once) — MUST be root, see --install-cron below:
#     sudo bash ensure-watcher.sh --install-cron
#
#   Check:
#     bash ensure-watcher.sh --status

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PIDFILE="$SCRIPT_DIR/.watcher.pid"
LOCKDIR="$SCRIPT_DIR/.watcher.lock"
LOG_FILE="$SCRIPT_DIR/deploy.log"
MAX_LOG_BYTES=20971520          # 20 MB — a --no-cache build writes a lot
STALE_LOCK_SECS=600

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

# Is this pid a live watcher of ours? /proc is authoritative. A bare `kill -0`
# would also succeed for a recycled pid belonging to something else entirely,
# which would leave us thinking the watcher is up when it is long gone.
is_watcher() {
  [ -n "$1" ] || return 1
  [ -r "/proc/$1/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q 'watch-deploy\.sh'
}

running_pid() {
  local pid
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE" 2>/dev/null)"
    if is_watcher "$pid"; then echo "$pid"; return 0; fi
  fi
  # Started by hand without a pidfile — adopt it rather than starting a second one.
  for d in /proc/[0-9]*; do
    pid="${d#/proc/}"
    [ "$pid" = "$$" ] && continue
    if is_watcher "$pid"; then echo "$pid"; return 0; fi
  done
  return 1
}

case "$1" in
  --status)
    if pid="$(running_pid)"; then
      # Report the version too. "Running" was never the whole question: a watcher
      # alive on outdated code looks healthy here while doing none of what the
      # current script does, which is how a newly added heartbeat never appeared.
      want="$(md5sum "$SCRIPT_DIR/watch-deploy.sh" 2>/dev/null | cut -d' ' -f1)"
      have="$(cat "$SCRIPT_DIR/.watcher.ver" 2>/dev/null)"
      owner="$(awk '/^Uid:/{print $2}' "/proc/$pid/status" 2>/dev/null)"
      if [ -n "$want" ] && [ "$want" != "$have" ]; then
        echo "watcher running (pid $pid, uid ${owner:-?}) — but on OUTDATED code"
        echo "  run this to replace it (sudo if the uid above is not yours):"
        echo "    sudo bash $SCRIPT_DIR/ensure-watcher.sh"
        exit 1
      fi
      echo "watcher running (pid $pid, uid ${owner:-?}, current)"
      exit 0
    fi
    echo "watcher NOT running"; exit 1
    ;;
  --install-cron)
    # QNAP keeps cron in /etc/config/crontab and needs it reloaded explicitly;
    # appending to the file alone does nothing until crond re-reads it.
    #
    # This MUST run as root. As a normal user the append can still succeed while
    # `crontab` refuses ("must be suid to work properly") and crond.sh cannot write
    # its own log — which leaves the line in the file, unloaded, looking installed.
    # Worse, crond.sh stops the daemon before it fails to start it again, so a
    # non-root attempt can take QNAP's whole scheduler down with it.
    if [ "$(id -u)" != "0" ]; then
      echo "ERROR: --install-cron must run as root."
      echo "       Re-run:  sudo bash $SCRIPT_DIR/ensure-watcher.sh --install-cron"
      echo "       (A non-root attempt can stop crond without restarting it,"
      echo "        taking every other scheduled task on the NAS down too.)"
      exit 1
    fi

    CRONTAB_FILE=/etc/config/crontab
    LINE="*/5 * * * * /bin/bash $SCRIPT_DIR/ensure-watcher.sh"

    if grep -Fq "ensure-watcher.sh" "$CRONTAB_FILE" 2>/dev/null; then
      echo "cron entry already present:"
      grep -F "ensure-watcher.sh" "$CRONTAB_FILE"
    else
      echo "$LINE" >> "$CRONTAB_FILE" || { echo "ERROR: could not write $CRONTAB_FILE"; exit 1; }
      echo "appended to $CRONTAB_FILE"
    fi

    # Every step checked. The previous version reported success unconditionally,
    # so a refused reload read exactly like a working install.
    rc=0
    crontab "$CRONTAB_FILE" || rc=$?
    if [ "$rc" != "0" ]; then
      echo "ERROR: 'crontab $CRONTAB_FILE' failed (exit $rc). The line is in the file"
      echo "       but crond has NOT loaded it. Nothing is scheduled."
      exit 1
    fi

    /etc/init.d/crond.sh restart || echo "WARNING: crond.sh restart reported a failure"

    # Verify rather than assume: confirm the daemon came back and the entry is live.
    sleep 1
    if ! ps | grep -q '[c]rond'; then
      echo "ERROR: crond is NOT running after the restart. QNAP's other scheduled"
      echo "       tasks are down as well. Start it with: /etc/init.d/crond.sh start"
      exit 1
    fi
    if crontab -l 2>/dev/null | grep -Fq "ensure-watcher.sh"; then
      echo "verified: crond is running and has the entry loaded"
    else
      echo "WARNING: crond is running but 'crontab -l' does not show the entry."
      echo "         Check $CRONTAB_FILE by hand."
    fi
    echo "NOTE: QNAP firmware updates can overwrite $CRONTAB_FILE. Re-run this"
    echo "      after a firmware upgrade, or the watcher loses its safety net."
    exec /bin/bash "$SCRIPT_DIR/ensure-watcher.sh"
    ;;
esac

# One ensure-watcher at a time. mkdir is atomic on every filesystem that matters,
# unlike a lockfile written with test-then-create, and busybox has it. Without this
# two cron ticks landing together could start two watchers, and two watchers means
# two concurrent --no-cache builds of the same container.
# Age is read from a timestamp written inside the lock, not from the directory's
# mtime. `date -r FILE` is a GNU extension that busybox does not always carry, and
# the failure mode was the worst available: date -r fails, the `|| date +%s`
# fallback makes the age zero, the lock reads as permanently fresh and this script
# does nothing for ever. An unreadable or malformed stamp is therefore treated as
# STALE — a rare duplicate start is caught by the pid check a few lines below,
# whereas a wedged supervisor is silent and permanent.
lock_age() {
  local created
  created="$(cat "$LOCKDIR/created" 2>/dev/null)"
  case "$created" in
    '' | *[!0-9]* ) echo "$(( STALE_LOCK_SECS + 1 ))"; return ;;
  esac
  echo "$(( $(date +%s) - created ))"
}

if ! mkdir "$LOCKDIR" 2>/dev/null; then
  # A lock left behind by a killed run would otherwise block this for ever.
  if [ -d "$LOCKDIR" ] && [ "$(lock_age)" -lt "$STALE_LOCK_SECS" ]; then
    exit 0
  fi
  rm -rf "$LOCKDIR" 2>/dev/null
  mkdir "$LOCKDIR" 2>/dev/null || exit 0
fi
date +%s > "$LOCKDIR/created" 2>/dev/null
# rm -rf, not rmdir: the lock now holds the stamp file.
trap 'rm -rf "$LOCKDIR" 2>/dev/null' EXIT

if pid="$(running_pid)"; then
  echo "$pid" > "$PIDFILE"
  # Alive is not the same as current. A watcher started before watch-deploy.sh was
  # edited keeps running the old code for ever, which is how a heartbeat that had
  # just been added never appeared: this script saw a healthy process and left it
  # alone. Compare what it recorded at startup against the file on disk.
  want="$(md5sum "$SCRIPT_DIR/watch-deploy.sh" 2>/dev/null | cut -d' ' -f1)"
  have="$(cat "$SCRIPT_DIR/.watcher.ver" 2>/dev/null)"
  if [ -n "$want" ] && [ "$want" != "$have" ]; then
    echo "[$(stamp)] ensure-watcher: watcher $pid is running an outdated watch-deploy.sh — replacing" >> "$LOG_FILE"
    # TERM, not KILL, so its trap clears the pid and version files. bash defers a
    # trap until the current foreground command returns, so this can take up to the
    # inotifywait timeout. Deliberately do NOT start a replacement here: the next
    # tick finds no watcher and starts one cleanly, which cannot produce two
    # watchers building the same image at once.
    #
    # The failure is reported rather than swallowed. Cron runs this as root and the
    # watcher it starts is root-owned, so a hand-run as an ordinary user cannot
    # signal it — and a suppressed "Operation not permitted" looks exactly like
    # success, which is the silent-failure pattern this whole mechanism exists to
    # avoid.
    if ! kill "$pid" 2>/dev/null; then
      msg="ensure-watcher: could NOT signal watcher $pid (uid $(id -u)); it is still running old code. Re-run with sudo."
      echo "[$(stamp)] $msg" >> "$LOG_FILE"
      [ -t 1 ] && echo "$msg"
    fi
  fi
  exit 0
fi

# Rotate before starting rather than after: this file has been left to grow
# unbounded and is already megabytes.
if [ -f "$LOG_FILE" ]; then
  size=$(wc -c < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "${size:-0}" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null
  fi
fi

echo "[$(stamp)] ensure-watcher: no watcher running — starting one" >> "$LOG_FILE"

# setsid detaches it into its own session, so neither an SSH drop nor cron's own
# exit can take it down with SIGHUP. stdout goes to /dev/null deliberately: the
# watcher already tees into deploy.log, and redirecting here as well is what made
# every line in that file appear twice.
#
# The fallback is not a downgrade: SIGHUP-on-exit is a controlling-terminal
# behaviour, and a cron job has no terminal, so a plain background job started from
# cron is not exposed to what killed the interactive one. setsid is preferred only
# because it also covers the case where someone runs this by hand over SSH.
if command -v setsid >/dev/null 2>&1; then
  setsid /bin/bash "$SCRIPT_DIR/watch-deploy.sh" </dev/null >/dev/null 2>&1 &
else
  /bin/bash "$SCRIPT_DIR/watch-deploy.sh" </dev/null >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi
