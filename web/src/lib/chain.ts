/**
 * Chain access for the browser. Every client uses anonAwareFetch, so reads follow the selected
 * transport (Nym by default) and fail rather than fall back when Nym is unavailable.
 */
import { codeIdentityHash, readIdentity, type CodeIdentity, type ProxyKind } from "@driftguard/core";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { CHAINS } from "./config.ts";
import { anonAwareFetch } from "./transport.ts";

const VIEM_CHAINS = { 1: mainnet, 11155111: sepolia } as const;
const clients = new Map<number, PublicClient>();

export function clientFor(chainId: number): PublicClient {
  const existing = clients.get(chainId);
  if (existing) return existing;
  const info = CHAINS[chainId];
  if (!info) throw new Error(`chain ${chainId} is not supported`);
  const client = createPublicClient({
    chain: VIEM_CHAINS[chainId as keyof typeof VIEM_CHAINS],
    // retryCount 0: a failed anonymized read is reported, not retried behind the user's back
    transport: http(info.rpcUrl, { fetchFn: anonAwareFetch as typeof fetch, retryCount: 0, timeout: 35_000 }),
  }) as PublicClient;
  clients.set(chainId, client);
  return client;
}

export interface LiveRead {
  identity: CodeIdentity;
  identityHash: `0x${string}`;
  block: bigint;
  ms: number;
}

/** Live code-identity read at (head - 2), the same snapshot the watcher takes. */
export async function liveIdentity(chainId: number, address: Address, kind: ProxyKind): Promise<LiveRead> {
  const t0 = performance.now();
  const client = clientFor(chainId);
  const block = (await client.getBlockNumber()) - 2n;
  const identity = await readIdentity(client, address, kind, block);
  return { identity, identityHash: codeIdentityHash(identity), block, ms: Math.round(performance.now() - t0) };
}
