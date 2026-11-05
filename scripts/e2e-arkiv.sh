#!/usr/bin/env bash
# End-to-end: watcher with the Arkiv sink against the Sepolia demo proxy.
#   1. put the proxy on ImplA, write the real baseline to Arkiv (writer wallet)
#   2. watcher running → current_state appears on Arkiv, matches_baseline = true
#   3. upgrade A→B → latest_change (event) + current_state.matches_baseline = false
#   4. upgrade B→A → matches_baseline = true, ever_changed_since_baseline stays true
#   5. stop the watcher; current_state then expires within 10 min (check later with show-arkiv)
# Reads back through scripts/show-arkiv.ts (trusted creators only), like the web app.
#
#   scripts/e2e-arkiv.sh        Output: docs/test-runs/e2e-arkiv-sepolia.txt
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

CHAIN=11155111; RPC="$SEPOLIA_RPC_URL"; DEP="contracts/deployments/$CHAIN.json"
PROXY=$(node -p "require('./$DEP').proxy"); ADMIN=$(node -p "require('./$DEP').proxyAdmin")
IMPL_A=$(node -p "require('./$DEP').implA"); IMPL_B=$(node -p "require('./$DEP').implB")
IMPL_SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
export WATCHER_SINK=arkiv WATCHER_STATE_DIR=watcher/state/e2e WATCHER_POLL_MS=15000 WATCHER_WRITE_EVERY_MS=60000
LOG=docs/test-runs/e2e-arkiv-sepolia.txt; mkdir -p docs/test-runs "$WATCHER_STATE_DIR"; : > "$LOG"
rm -f "$WATCHER_STATE_DIR/cursor-arkiv.json"
say() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }

impl_now() { local v; v=$(cast storage "$PROXY" $IMPL_SLOT --rpc-url "$RPC"); echo "0x${v: -40}"; }
lower() { echo "$1" | tr 'A-F' 'a-f'; }
# Upgrade through the ProxyAdmin with cast (gas estimated by the node), then wait 3 blocks so
# the watcher's head-2 reads include it.
upgrade_to() {
  local tx block
  tx=$(cast send "$ADMIN" "upgradeAndCall(address,address,bytes)" "$PROXY" "$1" 0x \
        --private-key "$SEPOLIA_DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.status!=="0x1")process.exit(1);console.log(r.transactionHash+" "+parseInt(r.blockNumber))})')
  say "upgraded to $1 in tx ${tx% *} (block ${tx#* })"
  block=${tx#* }
  until [ $(( $(cast block-number --rpc-url "$RPC") - 2 )) -ge "$block" ]; do sleep 3; done
}
show() { node scripts/show-arkiv.ts --json > "$WATCHER_STATE_DIR/show.json"; node -e "
const rows=require('./$WATCHER_STATE_DIR/show.json'); const r=rows.find(x=>x.contract==='$CHAIN:'+'$PROXY'.toLowerCase());
console.log(JSON.stringify(r?{current:r.current,latest_change:r.latest_change}:'no row'))" | tee -a "$LOG"; }
check() { # check <label> <js expression over r>
  node -e "
const rows=require('./$WATCHER_STATE_DIR/show.json'); const r=rows.find(x=>x.contract==='$CHAIN:'+'$PROXY'.toLowerCase());
const ok = !!r && typeof r.current==='object' && ($2);
console.log((ok?'PASS ':'FAIL ')+'$1'); process.exit(ok?0:1)" | tee -a "$LOG"
}
wait_cycle() { sleep 40; }

say "== E2E watcher → Arkiv on Sepolia demo proxy $PROXY"
if [ "$(impl_now)" != "$(lower "$IMPL_A")" ]; then say "proxy on $(impl_now); moving to ImplA"; upgrade_to "$IMPL_A"; fi

say "write baseline to Arkiv (writer wallet)"
node watcher/src/rebaseline.ts --chain $CHAIN --address "$PROXY" --kind eip1967 --reason "Sepolia demo proxy, ImplA" | grep -E '"(key|block|implementation)"' | tee -a "$LOG"

node watcher/src/main.ts >> "$WATCHER_STATE_DIR/watcher.log" 2>&1 & WPID=$!
say "watcher started (pid $WPID, arkiv sink)"
trap 'kill -9 $WPID 2>/dev/null || true' EXIT
wait_cycle; show
check "current_state on Arkiv, matches_baseline = true" "r.current.matches_baseline===true && r.current.implementation.toLowerCase()==='$(lower "$IMPL_A")'"

upgrade_to "$IMPL_B"; wait_cycle; show
check "after A→B: matches_baseline = false" "r.current.matches_baseline===false && r.current.implementation.toLowerCase()==='$(lower "$IMPL_B")'"
check "latest_change A→B detected by event, with tx" "r.latest_change.to==='$(lower "$IMPL_B")' && r.latest_change.by==='event' && r.latest_change.tx.length===66"

upgrade_to "$IMPL_A"; wait_cycle; show
check "after B→A: matches_baseline = true" "r.current.matches_baseline===true"
check "ever_changed_since_baseline stays true (A→B→A)" "r.current.ever_changed_since_baseline===true"

kill -9 $WPID 2>/dev/null || true
say "watcher stopped; current_state should expire within 10 min → NOT VERIFIED (re-check with show-arkiv)"
say "== watcher log"; grep -E '"msg":"(start|change|cycle failed|cycle)"' "$WATCHER_STATE_DIR/watcher.log" | tail -20 | tee -a "$LOG"
grep -q '^FAIL' "$LOG" && { say "E2E: FAIL"; exit 1; } || say "E2E: PASS"
