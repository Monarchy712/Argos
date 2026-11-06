#!/usr/bin/env bash
# Points a Sepolia demo proxy at ImplA or ImplB (ProxyAdmin.upgradeAndCall), for the demo video.
#
#   bash scripts/demo-upgrade.sh B          # video demo proxy, A → B: the badge turns RED
#   bash scripts/demo-upgrade.sh A          # back to A
#   bash scripts/demo-upgrade.sh B guard    # the guard demo proxy (deployments/11155111-guard.json)
#
# Needs SEPOLIA_RPC_URL and SEPOLIA_DEPLOYER_PRIVATE_KEY in .env (the key is never printed).
# Uses `cast send` rather than `forge script`: forge reads state at a pinned block number, which a
# load-balanced public RPC sometimes doesn't have yet ("block not found"). Same transaction as
# contracts/script/UpgradeDemo.s.sol.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:-}"
WHICH="${2:-}"
if [ "$TARGET" != A ] && [ "$TARGET" != B ]; then echo "usage: bash scripts/demo-upgrade.sh A|B [guard]" >&2; exit 2; fi
DEPFILE=11155111.json
[ "$WHICH" = guard ] && DEPFILE=11155111-guard.json
set -a; [ -f .env ] && . ./.env; set +a
: "${SEPOLIA_RPC_URL:?set SEPOLIA_RPC_URL in .env}"
: "${SEPOLIA_DEPLOYER_PRIVATE_KEY:?set SEPOLIA_DEPLOYER_PRIVATE_KEY in .env}"

dep() { node -p "require('./contracts/deployments/$DEPFILE').$1"; }
PROXY=$(dep proxy)
ADMIN=$(dep proxyAdmin)
IMPL_WANTED=$(dep "impl$TARGET")
SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
echo "[$(date +%H:%M:%S)] proxy $PROXY → Impl$TARGET ($IMPL_WANTED)"

for attempt in 1 2 3 4 5; do
  if OUT=$(cast send "$ADMIN" "upgradeAndCall(address,address,bytes)" "$PROXY" "$IMPL_WANTED" 0x \
      --private-key "$SEPOLIA_DEPLOYER_PRIVATE_KEY" --rpc-url "$SEPOLIA_RPC_URL" 2>&1); then
    echo "$OUT" | grep -E "^(transactionHash|blockNumber|status) " | sed 's/  */ /g'
    break
  fi
  echo "$OUT" | tail -1
  if [ "$attempt" = 5 ] || ! echo "$OUT" | grep -qE "block not found|error sending request|timed out|429|nonce too low"; then
    echo "[$(date +%H:%M:%S)] upgrade failed" >&2; exit 1
  fi
  echo "[$(date +%H:%M:%S)] transient RPC error (attempt $attempt), retrying"; sleep 6
done

# Read the slot until a backend that has the new block answers (up to ~60 s).
for _ in $(seq 1 20); do
  IMPL=$(cast storage "$PROXY" "$SLOT" --rpc-url "$SEPOLIA_RPC_URL" 2>/dev/null || echo "")
  [ "$(echo "0x${IMPL: -40}" | tr 'A-F' 'a-f')" = "$(echo "$IMPL_WANTED" | tr 'A-F' 'a-f')" ] && break
  sleep 3
done
echo "[$(date +%H:%M:%S)] implementation slot now: 0x${IMPL: -40}  (block $(cast block-number --rpc-url "$SEPOLIA_RPC_URL"))"
# The watcher and `rebaseline` read at head - 2. Return only once the upgrade is that deep, so a
# rebaseline run right after this script records the new implementation, not the old one.
MINED=$(echo "$OUT" | awk '/^blockNumber /{print $2}')
if [ -n "$MINED" ]; then
  until [ $(( $(cast block-number --rpc-url "$SEPOLIA_RPC_URL") - 2 )) -ge "$MINED" ]; do sleep 3; done
  echo "[$(date +%H:%M:%S)] 2 confirmations: safe to rebaseline"
fi
