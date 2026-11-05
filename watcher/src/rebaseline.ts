/**
 * The only way a baseline is created or changed. Reads the contract's code identity at
 * (head - confirmations) and writes it as the new baseline, retiring the old one. A new
 * baseline also starts monitoring: the watcher watches exactly the contracts with baselines.
 *
 *   npm run rebaseline -w watcher -- --chain 11155111 --address 0x... --kind eip1967 \
 *     [--reason "initial"] [--descriptor-hash 0x...] [--swarm-ref <hex>]
 */
import { parseArgs } from "node:util";
import { codeIdentityHash, PROXY_KINDS, readIdentity, type ProxyKind } from "@driftguard/core";
import { getAddress, isHex, type Hex } from "viem";
import { clientFor, loadConfig } from "./config.ts";
import { makeSink } from "./sinks.ts";

const { values } = parseArgs({
  options: {
    chain: { type: "string" },
    address: { type: "string" },
    kind: { type: "string" },
    reason: { type: "string", default: "initial baseline" },
    "descriptor-hash": { type: "string", default: "" },
    "swarm-ref": { type: "string", default: "" },
  },
});

if (!values.chain || !values.address || !values.kind) {
  console.error("usage: rebaseline --chain <id> --address <0x..> --kind <" + PROXY_KINDS.join("|") + ">");
  process.exit(2);
}
if (!(PROXY_KINDS as readonly string[]).includes(values.kind)) throw new Error(`unknown kind ${values.kind}`);
const descriptorHash = values["descriptor-hash"]!;
if (descriptorHash && !isHex(descriptorHash)) throw new Error("--descriptor-hash must be 0x-hex");

const config = loadConfig();
const chainId = Number(values.chain);
const address = getAddress(values.address);
const kind = values.kind as ProxyKind;
const client = clientFor(chainId);
const block = (await client.getBlockNumber()) - config.confirmations;
const identity = await readIdentity(client, address, kind, block);

// Refuse an empty baseline: it would make every later read look like a change (or hide one).
const empty =
  (kind === "eip1967" || kind === "beacon" || kind === "safe") && /^0x0{40}$/i.test(identity.implementation);
const noCode = /^0x0{64}$/i.test(identity.implementationCodehash) && kind !== "diamond";
if (empty || noCode) {
  console.error(
    `refusing baseline: ${address} on chain ${chainId} has no ${kind} implementation/code at block ${block}. ` +
      `Is it deployed, and at least ${config.confirmations} blocks old?`,
  );
  process.exit(1);
}
const sink = await makeSink(config);

const key = await sink.writeBaseline({
  chainId,
  address,
  identity,
  identityHash: codeIdentityHash(identity),
  block,
  baselinedAt: Math.floor(Date.now() / 1000),
  descriptorHash: descriptorHash as Hex | "",
  swarmRef: values["swarm-ref"]!,
  reason: values.reason!,
  previousKey: "",
});

console.log(JSON.stringify({ msg: "baseline written", sink: sink.name, key, chainId, address, block: block.toString(), identity }, null, 2));
