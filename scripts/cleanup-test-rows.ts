/**
 * Deletes DriftGuard test rows (chain_id 31337) written by our writer/watcher wallets, so test
 * runs never leave a baseline the real watcher would try to monitor.
 *
 *   node --env-file=.env scripts/cleanup-test-rows.ts
 */
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { eq } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BaselineSchema, CurrentStateSchema, LatestChangeSchema, TRUSTED_CREATORS } from "@driftguard/core";

const TEST_CHAIN = u64(31337n);
const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });
const pub = createPublicClient({ chain, transport: http() });

async function keysOf(schema: typeof BaselineSchema | typeof CurrentStateSchema | typeof LatestChangeSchema, creator: Hex) {
  const page = await pub.select({ $key: true }).from(schema).where(eq("chain_id", TEST_CHAIN)).createdBy(creator).limit(100).fetch();
  return page.entities.map((e) => ({ entityKey: e.$key }));
}

for (const [role, keyName, schemas] of [
  ["writer", "ARKIV_WRITER_PRIVATE_KEY", [BaselineSchema]],
  ["watcher", "ARKIV_WATCHER_PRIVATE_KEY", [CurrentStateSchema, LatestChangeSchema]],
] as const) {
  const creator = TRUSTED_CREATORS[role];
  const deletes = (await Promise.all(schemas.map((s) => keysOf(s, creator)))).flat();
  if (deletes.length === 0) {
    console.log(`${role}: no test rows`);
    continue;
  }
  const wallet = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(process.env[keyName] as Hex) });
  const res = await wallet.executeBatch({ deletes });
  console.log(`${role}: deleted ${res.deletedEntities.length} test rows (tx ${res.txHash})`);
}
