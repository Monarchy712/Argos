/**
 * CONTROLLED DEMO: check-and-call guard on our own Sepolia proxy (not the video demo proxy, and
 * not any registry contract).
 *
 *   node --env-file=.env scripts/guard-demo.ts            # guarded call, upgrade A→B, guarded call again, back to A
 *   node --env-file=.env scripts/guard-demo.ts --keep-b   # leave the proxy at B afterwards
 *
 * 1. Reads the expected implementation from the Argos baseline on Arkiv (writer wallet only).
 * 2. Sends ArgosGuard.checkAndCall(proxy, expected, increment()) → succeeds, counter +1.
 * 3. Upgrades the proxy to ImplB (scripts/demo-upgrade.sh B guard).
 * 4. Tries the same guarded call → reverts with ImplementationChanged(proxy, expected, actual);
 *    nothing runs. The revert is caught at gas estimation, so no failing tx is mined.
 * 5. Upgrades back to ImplA (unless --keep-b).
 *
 * Needs SEPOLIA_RPC_URL and SEPOLIA_DEPLOYER_PRIVATE_KEY in .env (never printed).
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createPublicClient as arkivClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { and, eq } from "@arkiv-network/sdk/query";
import { addr, u64 } from "@arkiv-network/sdk/schema";
import { BaselineSchema, TRUSTED_CREATORS } from "@driftguard/core";
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isHex, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const dep = JSON.parse(readFileSync(new URL("../contracts/deployments/11155111-guard.json", import.meta.url), "utf8")) as Record<string, Address>;
const keepB = process.argv.includes("--keep-b");
const key = process.env.SEPOLIA_DEPLOYER_PRIVATE_KEY;
if (!key || !isHex(key)) throw new Error("set SEPOLIA_DEPLOYER_PRIVATE_KEY in .env");
const rpc = process.env.SEPOLIA_RPC_URL;
const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });
const wallet = createWalletClient({ chain: sepolia, transport: http(rpc), account: privateKeyToAccount(key) });

const guardAbi = parseAbi([
  "function checkAndCall(address proxy, address expectedImplementation, bytes data) payable returns (bytes)",
  "error ImplementationChanged(address proxy, address expected, address actual)",
]);
const demoAbi = parseAbi(["function increment()", "function counter() view returns (uint256)", "function version() view returns (string)", "function argosImplementation() view returns (address)"]);
const say = (msg: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);
const name = (a: string) => (getAddress(a) === getAddress(dep.implA!) ? "ImplA" : getAddress(a) === getAddress(dep.implB!) ? "ImplB" : a);

// 1. expected implementation = the Argos baseline on Arkiv
const ark = arkivClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });
const base = await ark
  .select({ $key: true, implementation: true, baseline_block: true })
  .from(BaselineSchema)
  .where(and(eq("chain_id", u64(11155111n)), eq("address", addr(dep.proxy!))))
  .createdBy(TRUSTED_CREATORS.writer)
  .limit(1)
  .fetch();
const b = base.entities[0];
if (!b) throw new Error("no Argos baseline on Arkiv for the guard proxy; run rebaseline first");
const expected = getAddress(b.implementation.value);
say(`Argos baseline on Arkiv (${b.$key.slice(0, 10)}…, block ${b.baseline_block.value}): expected implementation ${expected} (${name(expected)})`);

const status = async () => {
  const [impl, counter, version] = await Promise.all([
    pub.readContract({ address: dep.proxy!, abi: demoAbi, functionName: "argosImplementation" }),
    pub.readContract({ address: dep.proxy!, abi: demoAbi, functionName: "counter" }),
    pub.readContract({ address: dep.proxy!, abi: demoAbi, functionName: "version" }),
  ]);
  say(`proxy ${dep.proxy}: argosImplementation() = ${name(impl)}, version() = "${version}", counter = ${counter}`);
};

async function guardedIncrement(): Promise<void> {
  const data = encodeFunctionData({ abi: demoAbi, functionName: "increment" });
  try {
    const { request } = await pub.simulateContract({ account: wallet.account, address: dep.guard!, abi: guardAbi, functionName: "checkAndCall", args: [dep.proxy!, expected, data] });
    const hash = await wallet.writeContract(request);
    const r = await pub.waitForTransactionReceipt({ hash });
    say(`guarded call OK: checkAndCall(proxy, ${name(expected)}, increment()) mined in block ${r.blockNumber}, tx ${hash}`);
  } catch (err) {
    const rev = err instanceof BaseError ? err.walk((e) => e instanceof ContractFunctionRevertedError) : null;
    if (rev instanceof ContractFunctionRevertedError && rev.data?.errorName === "ImplementationChanged") {
      const [, exp, act] = rev.data.args as [Address, Address, Address];
      say(`guarded call REVERTED: ImplementationChanged(expected ${name(exp)}, actual ${name(act)}). increment() did not run.`);
      return;
    }
    throw err;
  }
}

const upgrade = (target: "A" | "B") => execFileSync("bash", ["scripts/demo-upgrade.sh", target, "guard"], { stdio: "inherit" });

await status();
await guardedIncrement();
await status();
say("upgrading the guard proxy to ImplB…");
upgrade("B");
await status();
await guardedIncrement();
await status();
if (!keepB) {
  say("restoring ImplA…");
  upgrade("A");
  await status();
}
