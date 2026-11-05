#!/usr/bin/env bash
# Test 3 (proxy detection): deploy ImplA/ImplB/proxy, baseline, upgrade A→B with the watcher
# running, hard-kill the watcher, upgrade B→A while it is down, restart it, and check that it
# resumes from its cursor, sees the missed event, and keeps ever_changed_since_baseline = true.
#
#   scripts/test3.sh local     # anvil on 127.0.0.1:8545 (well-known anvil test key)
#   scripts/test3.sh sepolia   # needs SEPOLIA_RPC_URL + funded SEPOLIA_DEPLOYER_PRIVATE_KEY in .env
#
# Uses the file sink, so no Arkiv writes. Output: docs/test-runs/test3-<network>.txt
set -euo pipefail
cd "$(dirname "$0")/.."
NET="${1:-local}"
set -a; [ -f .env ] && . ./.env; set +a

if [ "$NET" = local ]; then
  RPC="${LOCAL_RPC_URL:-http://127.0.0.1:8545}"; CHAIN=31337; POLL=3000; WAIT=8
  export DEPLOYER_PRIVATE_KEY="$(cast wallet private-key "test test test test test test test test test test test junk" 0)"
else
  RPC="$SEPOLIA_RPC_URL"; CHAIN=11155111; POLL=15000; WAIT=60
  export DEPLOYER_PRIVATE_KEY="$SEPOLIA_DEPLOYER_PRIVATE_KEY"
fi

mkdir -p docs/test-runs; LOG="docs/test-runs/test3-$NET.txt"
STATE="watcher/state/test3-$NET"
rm -rf "$STATE"; mkdir -p "$STATE"; : > "$LOG"
say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
export WATCHER_SINK=file WATCHER_STATE_DIR="$STATE" WATCHER_POLL_MS=$POLL WATCHER_WRITE_EVERY_MS=$((POLL * 2))

say "== Test 3 on $NET (chain $CHAIN)"
say "deploy ImplA, ImplB, TransparentUpgradeableProxy(ImplA)"
(cd contracts && forge script script/DeployDemo.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1 | grep -E '^\s+(proxy|implA|implB|proxyAdmin) ' | tee -a "../$LOG")
DEP="contracts/deployments/$CHAIN.json"
PROXY=$(node -p "require('./$DEP').proxy"); IMPL_A=$(node -p "require('./$DEP').implA"); IMPL_B=$(node -p "require('./$DEP').implB")

say "baseline (rebaseline CLI)"
node watcher/src/rebaseline.ts --chain $CHAIN --address "$PROXY" --kind eip1967 --reason "test3" | grep -E '"(implementation|block)"' | tee -a "$LOG"

start_watcher() { node watcher/src/main.ts >> "$STATE/watcher.log" 2>&1 & WPID=$!; say "watcher started (pid $WPID)"; }
start_watcher
sleep "$WAIT"

say "upgrade A→B"
(cd contracts && TARGET=B forge script script/UpgradeDemo.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1 | grep -E 'to implementation' | tee -a "../$LOG")
sleep "$WAIT"

say "hard-kill watcher (no graceful shutdown)"
kill -9 "$WPID" 2>/dev/null || taskkill //F //PID "$WPID" >/dev/null 2>&1 || true
CURSOR_AT_KILL=$(node -p "require('./$STATE/cursor-file.json').chains['$CHAIN']")
say "cursor at kill: block $CURSOR_AT_KILL"

say "upgrade B→A while the watcher is down"
(cd contracts && TARGET=A forge script script/UpgradeDemo.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1 | grep -E 'to implementation' | tee -a "../$LOG")

start_watcher
sleep "$WAIT"
kill -9 "$WPID" 2>/dev/null || taskkill //F //PID "$WPID" >/dev/null 2>&1 || true

say "== watcher log"
grep -E '"msg":"(start|change|cycle failed)"' "$STATE/watcher.log" | tee -a "$LOG"
say "== independent slot read (cast)"
cast storage "$PROXY" 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url "$RPC" | tee -a "$LOG"

say "== checks"
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const s = JSON.parse(readFileSync('$STATE/file-sink.json','utf8'));
const id = '$CHAIN:' + '$PROXY'.toLowerCase();
const cs = s.currentStates[id], lc = s.latestChanges[id];
const log = readFileSync('$STATE/watcher.log','utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const changes = log.filter(l => l.msg === 'change' && l.field === 'implementation');
const starts = log.filter(l => l.msg === 'start');
const A = '$IMPL_A'.toLowerCase(), B = '$IMPL_B'.toLowerCase();
const checks = {
  'A→B detected by event': changes.some(c => c.from === A && c.to === B && c.by === 'event'),
  'B→A (while down) detected by event after restart': changes.some(c => c.from === B && c.to === A && c.by === 'event'),
  'restart resumed from saved cursor': starts.length === 2 && starts[1].resumeFrom['$CHAIN'] === '$CURSOR_AT_KILL',
  'current_state.implementation is A (slot read)': cs.identity.implementation.toLowerCase() === A,
  'matches_baseline = true after B→A': cs.matchesBaseline === true,
  'ever_changed_since_baseline stays true': cs.everChangedSinceBaseline === true,
  'latest_change = B→A with tx hash': lc.previousValue === B && lc.newValue === A && lc.txHash.length === 66,
};
let ok = true;
for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS ' : 'FAIL ') + k); ok &&= v; }
console.log(ok ? 'PHASE 1 (events + restart): PASS' : 'PHASE 1 (events + restart): FAIL');
process.exit(ok ? 0 : 1);
" | tee -a "$LOG"

say "== phase 2: slot-read detection alone (event scanning disabled)"
STATE2="$STATE/slot-only"; mkdir -p "$STATE2"
WATCHER_STATE_DIR="$STATE2" node watcher/src/rebaseline.ts --chain $CHAIN --address "$PROXY" --kind eip1967 --reason "test3 slot-only" > /dev/null
WATCHER_STATE_DIR="$STATE2" WATCHER_DISABLE_EVENTS=1 node watcher/src/main.ts >> "$STATE2/watcher.log" 2>&1 & WPID=$!
sleep "$WAIT"
say "upgrade A→B (watcher can only see it through slot reads)"
(cd contracts && TARGET=B forge script script/UpgradeDemo.s.sol --rpc-url "$RPC" --broadcast --slow 2>&1 | grep -E 'to implementation' | tee -a "../$LOG")
sleep "$WAIT"
kill -9 "$WPID" 2>/dev/null || taskkill //F //PID "$WPID" >/dev/null 2>&1 || true
grep -E '"msg":"change"' "$STATE2/watcher.log" | tee -a "$LOG"
node --input-type=module -e "
import { readFileSync } from 'node:fs';
const s = JSON.parse(readFileSync('$STATE2/file-sink.json','utf8'));
const id = '$CHAIN:' + '$PROXY'.toLowerCase();
const cs = s.currentStates[id], lc = s.latestChanges[id] ?? {};
const B = '$IMPL_B'.toLowerCase();
const checks = {
  'slot read detected the implementation change': lc.field !== undefined && lc.detectedBy === 'slot',
  'current_state.implementation is B': cs.identity.implementation.toLowerCase() === B,
  'matches_baseline = false': cs.matchesBaseline === false,
};
let ok = true;
for (const [k, v] of Object.entries(checks)) { console.log((v ? 'PASS ' : 'FAIL ') + k); ok &&= v; }
console.log(ok ? 'PHASE 2 (slot-only): PASS' : 'PHASE 2 (slot-only): FAIL');
process.exit(ok ? 0 : 1);
" | tee -a "$LOG"
say "TEST 3 ($NET): PASS"
