/**
 * Browser-side configuration. No secrets here: the web app holds no keys. Arkiv is read keyless,
 * and chain reads go direct unless the viewer explicitly opts in to Anon-RPC (Nym); see
 * lib/transport.ts for why direct is the default.
 */
export { TRUSTED_CREATORS } from "@driftguard/core";

/** Nym anon-client specifier (IWorkerSpecifier) on Ethereum mainnet, from ethereum/anon-rpc adopters.json5. */
export const NYM_SPECIFIER = "0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0";

export interface ChainInfo {
  id: number;
  name: string;
  rpcUrl: string;
  explorer: string;
}

const env = import.meta.env;
export const CHAINS: Record<number, ChainInfo> = {
  1: { id: 1, name: "Ethereum", rpcUrl: env.VITE_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
  11155111: {
    id: 11155111,
    name: "Sepolia",
    rpcUrl: env.VITE_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
};

/** Used only by the harness to read the Nym specifier contract (bootstrap; reveals only "loads the Nym worker"). */
export const BOOTSTRAP_RPC_URL = CHAINS[1]!.rpcUrl;

/** The Sepolia demo proxy we upgrade A→B→A in the demo (contracts/deployments/11155111.json). */
export const DEMO_PROXY = {
  chainId: 11155111,
  address: "0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5",
  label: "Argos demo proxy",
} as const;

export const ARKIV_EXPLORER = "https://rabdi.explorer.arkiv.network";
/** Arkiv block time in seconds (SDK BLOCK_TIME), to turn $expiresAt blocks into wall time. */
export const ARKIV_BLOCK_SECONDS = 2;
/**
 * Keyless Arkiv reads have a cost budget (Test 2), so the table's bulk read refreshes every 90 s.
 * Worst-case record age shown = watcher write interval (120 s) + poll (60 s) + this, which keeps
 * a healthy watcher under the 5-minute staleness line. "Check" always reads fresh.
 */
export const ARKIV_REFRESH_MS = 90_000;

/**
 * Swarm gateway for descriptor downloads (GET /bytes/:ref). The public gateway answers with
 * `Access-Control-Allow-Origin: *`. What it returns is never trusted: keccak256 of the bytes must
 * equal the ERC-8176 hash on the writer's Arkiv row, or the descriptor is rejected.
 */
export const SWARM_GATEWAY = (import.meta.env.VITE_SWARM_GATEWAY as string | undefined) ?? "https://api.gateway.ethswarm.org";

/**
 * CONTROLLED DEMO: a second Sepolia proxy whose own (non-upgradeable) code reports its
 * implementation, plus ArgosGuard, which checks that implementation and makes the call in one
 * transaction (contracts/src/ArgosGuardableProxy.sol, ArgosGuard.sol;
 * contracts/deployments/11155111-guard.json). No registry contract has this getter.
 */
export const GUARD_DEMO = {
  chainId: 11155111,
  proxy: "0x3c93e603bbeD9Dc2Af817BC2D98Bc1D35CF1D669",
  guard: "0x32189Bb40fD8E565a870d6b513F1E32e6832E46a",
  label: "Argos guard demo proxy",
} as const;
