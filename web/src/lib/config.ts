/**
 * Browser-side configuration. No secrets here: the web app holds no keys. Arkiv is read keyless
 * and live chain reads go straight to a public RPC endpoint; lib/chain.ts carries the label the UI
 * uses to disclose that.
 */
export { ARKIV_BLOCK_SECONDS, TRUSTED_CREATORS } from "@driftguard/core";
import { viteEnv } from "./env.ts";

export interface ChainInfo {
  id: number;
  name: string;
  rpcUrl: string;
  explorer: string;
}

// Read through lib/env.ts so this module imports cleanly under `node --test`; see the note there.
const env = { VITE_MAINNET_RPC_URL: viteEnv("VITE_MAINNET_RPC_URL"), VITE_SEPOLIA_RPC_URL: viteEnv("VITE_SEPOLIA_RPC_URL"), VITE_SWARM_GATEWAY: viteEnv("VITE_SWARM_GATEWAY") };
export const CHAINS: Record<number, ChainInfo> = {
  1: { id: 1, name: "Ethereum", rpcUrl: env.VITE_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
  11155111: {
    id: 11155111,
    name: "Sepolia",
    rpcUrl: env.VITE_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
    explorer: "https://sepolia.etherscan.io",
  },
};


export const ARKIV_EXPLORER = "https://rabdi.explorer.arkiv.network";
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
export const SWARM_GATEWAY = env.VITE_SWARM_GATEWAY ?? "https://api.gateway.ethswarm.org";

/**
 * Argos's own demonstration contracts. Re-exported from lib/demo.ts, which has no Vite-only
 * imports so its identity test runs under plain `node --test`.
 */
export { DEMO_CONTRACTS, DEMO_PROXY, GUARD_DEMO, demoContractInfo, isDemoContract, type DemoContract } from "./demo.ts";
