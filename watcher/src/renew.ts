/**
 * Extends long-lived Argos entities that will expire within EXPIRY.renewBelowSeconds
 * (30 days) back to the maximum lifetime (~182 days). Safe to run any time; does nothing when
 * nothing is close to expiry. current_state is never renewed here: its short expiry is the point.
 *
 *   npm run renew -w watcher            # renews whatever this .env has keys for
 *   npm run renew -w watcher -- --dry   # report only
 *
 * Writer key → dg_baseline, dg_descriptor, dg_deployment. Watcher key → dg_latest_change.
 */
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc, lt } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import { http, isHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  BaselineSchema,
  DeploymentSchema,
  DescriptorSchema,
  EXPIRY,
  LatestChangeSchema,
  TRUSTED_CREATORS,
} from "@driftguard/core";

const BLOCK_SECONDS = 2; // Arkiv block time (SDK BLOCK_TIME)
const dry = process.argv.includes("--dry");
const chain = rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" });
const pub = createPublicClient({ chain, transport: http() });
const head = await pub.getBlockNumber();
const threshold = head + BigInt(EXPIRY.renewBelowSeconds / BLOCK_SECONDS);

type RenewSchema = typeof BaselineSchema | typeof DescriptorSchema | typeof DeploymentSchema | typeof LatestChangeSchema;
const plan: { role: "writer" | "watcher"; keyName: string; schemas: [string, RenewSchema][] }[] = [
  { role: "writer", keyName: "ARKIV_WRITER_PRIVATE_KEY", schemas: [["dg_baseline", BaselineSchema], ["dg_descriptor", DescriptorSchema], ["dg_deployment", DeploymentSchema]] },
  { role: "watcher", keyName: "ARKIV_WATCHER_PRIVATE_KEY", schemas: [["dg_latest_change", LatestChangeSchema]] },
];

for (const { role, keyName, schemas } of plan) {
  const key = process.env[keyName];
  if (!key || !isHex(key)) {
    console.log(`${role}: ${keyName} not set, skipping`);
    continue;
  }
  const wallet = createWalletClient({ chain, transport: http(), account: privateKeyToAccount(key as Hex) });
  for (const [name, schema] of schemas) {
    const due: Hex[] = [];
    for (let offset = 0; ; ) {
      const page = await pub
        .select({ $key: true })
        .from(schema)
        .where(lt("$expiresAt", u64(threshold)))
        .createdBy(TRUSTED_CREATORS[role])
        .orderBy(asc("$key"))
        .limit(100)
        .offset(offset)
        .fetch();
      due.push(...page.entities.map((e) => e.$key));
      const covered = page.entities.length + page.skipped;
      if (covered < 100) break;
      offset += covered;
    }
    console.log(`${name}: ${due.length} expiring within ${EXPIRY.renewBelowSeconds / 86400} days`);
    if (dry) continue;
    for (let i = 0; i < due.length; i += 50) {
      const extensions = due.slice(i, i + 50).map((entityKey) => ({ entityKey, expiration: ExpirationTime.max() }));
      const res = await wallet.executeBatch({ extensions });
      console.log(`  extended ${res.extendedEntities.length} (tx ${res.txHash})`);
    }
  }
}
