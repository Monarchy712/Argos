import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet, sepolia, foundry } from "viem/chains";

const WATCHER_DIR = fileURLToPath(new URL("..", import.meta.url));

/** RPC per chain, from .env. The watcher uses ordinary RPC (only the browser goes through Nym). */
const RPC_ENV: Record<number, string> = {
  1: "MAINNET_RPC_URL",
  11155111: "SEPOLIA_RPC_URL",
  31337: "LOCAL_RPC_URL",
};
const CHAINS = { 1: mainnet, 11155111: sepolia, 31337: foundry } as const;

export interface WatcherConfig {
  /** Slot reads (and event scans) every N ms. */
  pollMs: number;
  /** current_state written at least every N ms, and immediately on change. */
  writeEveryMs: number;
  /** Blocks behind head treated as final. */
  confirmations: bigint;
  /** Max block span per eth_getLogs call. */
  logChunk: bigint;
  /** Max addresses per eth_getLogs call (PublicNode allows 10). */
  logMaxAddresses: number;
  stateDir: string;
  sink: "file" | "arkiv";
  /** Test switch: skip event scans so only slot reads can detect changes. */
  disableEvents: boolean;
}

export function loadConfig(env = process.env): WatcherConfig {
  return {
    pollMs: Number(env.WATCHER_POLL_MS ?? 60_000),
    writeEveryMs: Number(env.WATCHER_WRITE_EVERY_MS ?? 120_000),
    confirmations: BigInt(env.WATCHER_CONFIRMATIONS ?? 2),
    logChunk: BigInt(env.WATCHER_LOG_CHUNK ?? 2_000),
    logMaxAddresses: Number(env.WATCHER_LOG_MAX_ADDRESSES ?? 10),
    stateDir: env.WATCHER_STATE_DIR ?? join(WATCHER_DIR, "state"),
    sink: (env.WATCHER_SINK ?? "arkiv") as "file" | "arkiv",
    disableEvents: env.WATCHER_DISABLE_EVENTS === "1",
  };
}

const clients = new Map<number, PublicClient>();

export function clientFor(chainId: number, env = process.env): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;
  const envName = RPC_ENV[chainId];
  if (!envName) throw new Error(`no RPC configured for chain ${chainId}`);
  const url = env[envName] ?? (chainId === 31337 ? "http://127.0.0.1:8545" : undefined);
  if (!url) throw new Error(`set ${envName} in .env`);
  const chain = CHAINS[chainId as keyof typeof CHAINS];
  const client = createPublicClient({ chain, transport: http(url, { retryCount: 3 }) }) as PublicClient;
  clients.set(chainId, client);
  return client;
}
