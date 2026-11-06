#!/usr/bin/env bash
# Points a Sepolia demo proxy at ImplA or ImplB (through its ProxyAdmin), for the demo video.
#
#   bash scripts/demo-upgrade.sh B          # video demo proxy, A → B: the badge turns RED
#   bash scripts/demo-upgrade.sh A          # back to A
#   bash scripts/demo-upgrade.sh B guard    # the guard demo proxy (deployments/11155111-guard.json)
#
# Needs SEPOLIA_RPC_URL and SEPOLIA_DEPLOYER_PRIVATE_KEY in .env (the key is never printed).
# Prints the tx hash and the implementation slot after the upgrade.
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

PROXY=$(node -p "require('./contracts/deployments/$DEPFILE').proxy")
SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc
echo "[$(date +%H:%M:%S)] proxy $PROXY → Impl$TARGET"
(cd contracts && DEPLOYER_PRIVATE_KEY="$SEPOLIA_DEPLOYER_PRIVATE_KEY" TARGET="$TARGET" DEPLOYMENT="$DEPFILE" \
  forge script script/UpgradeDemo.s.sol --rpc-url "$SEPOLIA_RPC_URL" --broadcast --slow \
  --skip-simulation --gas-estimate-multiplier 130 2>&1 | grep -E "Hash|to implementation|Error|revert" || true)
IMPL=$(cast storage "$PROXY" "$SLOT" --rpc-url "$SEPOLIA_RPC_URL")
echo "[$(date +%H:%M:%S)] implementation slot now: 0x${IMPL: -40}  (block $(cast block-number --rpc-url "$SEPOLIA_RPC_URL"))"
