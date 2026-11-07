/**
 * Chain access for the browser: a plain `eth_call`/`eth_getStorageAt` client per chain.
 *
 * Reads go straight from the viewer's browser to the RPC provider, so the provider sees the
 * viewer's IP and which contract they opened. `ROUTE_LABEL` is recorded next to every live result
 * and in the session menu so that is disclosed rather than left for the reader to assume — the one
 * thing Argos must never do is imply a privacy property it does not have.
 */
import { codeIdentityHash, readIdentity, type CodeIdentity, type ProxyKind } from "@driftguard/core";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { CHAINS } from "./config.ts";

/**
 * How a live read reached the chain, shown beside the result and stored in the evidence record.
 * A constant now that there is one route; it stays a label rather than inline text so the wording
 * cannot drift between the six screens that disclose it.
 */
export const ROUTE_LABEL = "direct RPC, not anonymized";

const VIEM_CHAINS = { 1: mainnet, 11155111: sepolia } as const;
const clients = new Map<number, PublicClient>();

export function clientFor(chainId: number): PublicClient {
  const existing = clients.get(chainId);
  if (existing) return existing;
  const info = CHAINS[chainId];
  if (!info) throw new Error(`chain ${chainId} is not supported`);
  const client = createPublicClient({
    chain: VIEM_CHAINS[chainId as keyof typeof VIEM_CHAINS],
    // One retry: a public endpoint drops the occasional request, and a read the user asked for is
    // worth retrying once. Still bounded, so a failure is reported rather than hidden in a loop.
    transport: http(info.rpcUrl, { retryCount: 1, timeout: 20_000 }),
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
