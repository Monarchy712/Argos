#!/usr/bin/env bash
# Keeps the Argos watcher running.
#
#   bash scripts/watcher-supervisor.sh          # run it (detach it yourself, see below)
#   setsid nohup bash scripts/watcher-supervisor.sh >/dev/null 2>&1 < /dev/null & disown
#
# Why this exists: a dead watcher is not a silent failure in Argos. Entity expiry no longer
# forces it -- current_state rows now carry the SDK's maximum retention and are renewed on a
# sliding window -- but monitoring *freshness* is tracked separately from expiry, so a stopped
# watcher still turns every contract NOT VERIFIED once its last checkpoint goes stale. That is
# the correct behaviour and the reason the process has to come back. On 2026-11-06 the watcher
# was killed twice by signals sent to the process group of whatever shell started it, each time
# going unnoticed for ~1 hour. This restarts it and records every restart in the same log, so a
# gap is visible after the fact.
#
# The watcher reads .env, so ARGOS_HTTP_PORT there is what brings the baseline publisher up with
# it. Without that variable the endpoint stays off and Add Contract reports a blocked publisher.
#
# Stop it with: pkill -f watcher-supervisor.sh && pkill -f 'watcher/src/main.ts'
set -u
cd "$(dirname "$0")/.." || exit 1
LOG=watcher/state/live.log
mkdir -p watcher/state

log() { printf '{"t":"%s","msg":"supervisor","detail":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$1" >> "$LOG"; }

# A SIGTERM aimed at us should stop the whole thing, not trigger a restart.
stopping=0
trap 'stopping=1; log "stopping on signal"; kill "${child:-0}" 2>/dev/null' TERM INT

log "supervisor started (pid $$)"
attempt=0
while [ "$stopping" -eq 0 ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -gt 1 ] && log "restarting watcher (restart #$((attempt - 1)))"
  node --env-file=.env watcher/src/main.ts >> "$LOG" 2>&1 &
  child=$!
  wait "$child"
  code=$?
  [ "$stopping" -eq 1 ] && break
  log "watcher exited with code $code"
  # Back off a little so a persistent crash (bad .env, Arkiv down) doesn't spin the CPU.
  sleep 5
done
log "supervisor stopped"
