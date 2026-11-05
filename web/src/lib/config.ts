/**
 * Browser-side configuration. No secrets here: the web app holds no keys. Arkiv is read keyless,
 * and chain reads go through Anon-RPC (Nym) unless the viewer explicitly picks direct mode.
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
  label: "DriftGuard demo proxy",
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
