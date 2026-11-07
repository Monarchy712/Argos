/**
 * Proxy inspection, against a fake node so every branch is exercised deterministically —
 * including the ones that need a node to misbehave.
 *
 * The three outcomes these tests keep apart are the whole point of inspectContract: a detected
 * proxy, a proxy Argos cannot read, and a contract that is genuinely not a proxy. A failed read
 * must be none of the three.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { hasDelegatecall, inspectContract, InspectionError, classifyContract } from "../src/classify.ts";
import {
  BEACON_SLOT,
  EIP1822_PROXIABLE_SLOT,
  eip1167Implementation,
  IMPLEMENTATION_SLOT,
  SAFE_SINGLETON_SLOT,
  ZEPPELINOS_IMPLEMENTATION_SLOT,
} from "../src/slots.ts";
import { readAddressSlot, SlotReadError } from "../src/read.ts";

const PROXY = getAddress("0x00000000000000000000000000000000000000a1");
const IMPL = getAddress("0x00000000000000000000000000000000000000b2");
const BEACON = getAddress("0x00000000000000000000000000000000000000c3");
const BLOCK = 1000n;

const word = (a: Address) => (`0x${a.slice(2).toLowerCase().padStart(64, "0")}`) as Hex;
const ZERO_WORD = `0x${"0".repeat(64)}` as Hex;

/** A plain Solidity-ish contract body: big enough not to look like a forwarder, no DELEGATECALL. */
const ORDINARY_CODE = `0x6080604052${"60".repeat(300)}`;
/** A forwarder-sized body that does contain DELEGATECALL (0xf4). */
const FORWARDER_CODE = `0x6080604052${"00".repeat(40)}f4${"00".repeat(20)}`;

interface FakeNode {
  code?: Record<string, string>;
  slots?: Record<string, Hex>;
  /** slot → throw instead of answering */
  slotFails?: string[];
  /** slot → answer with undefined, the "node declined" shape */
  slotMissing?: string[];
  facets?: unknown[] | "revert";
  beaconImpl?: Address | "revert";
}

function fakeClient(n: FakeNode) {
  return {
    async getCode({ address }: { address: Address }) {
      return (n.code?.[address.toLowerCase()] ?? "0x") as Hex;
    },
    async getStorageAt({ address, slot }: { address: Address; slot: Hex }) {
      if (n.slotFails?.includes(slot)) throw new Error(`node refused ${slot}`);
      if (n.slotMissing?.includes(slot)) return undefined;
      void address;
      return n.slots?.[slot] ?? ZERO_WORD;
    },
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "facets") {
        if (n.facets === "revert" || n.facets === undefined) throw new Error("not a loupe");
        return n.facets;
      }
      if (functionName === "implementation") {
        if (n.beaconImpl === "revert" || n.beaconImpl === undefined) throw new Error("no implementation()");
        return n.beaconImpl;
      }
      throw new Error(`unexpected call ${functionName}`);
    },
  } as never;
}

const withCode = (...addrs: Address[]) =>
  Object.fromEntries(addrs.map((a) => [a.toLowerCase(), ORDINARY_CODE]));

/* ------------------------------------------------------------------ detected proxies */

test("EIP-1967 implementation slot → eip1967, monitored as eip1967", async () => {
  const r = await inspectContract(
    fakeClient({ code: withCode(PROXY, IMPL), slots: { [IMPLEMENTATION_SLOT]: word(IMPL) } }),
    PROXY, BLOCK,
  );
  assert.equal(r.architecture, "eip1967");
  assert.equal(r.monitorAs, "eip1967");
  assert.equal(r.implementation, IMPL);
});

test("a UUPS proxy is the same slot, so it is detected as eip1967 too", async () => {
  // UUPS differs only in where upgradeTo lives (the implementation, not the proxy); the slot is
  // identical, which is exactly why no separate probe is needed.
  const r = await inspectContract(
    fakeClient({ code: withCode(PROXY, IMPL), slots: { [IMPLEMENTATION_SLOT]: word(IMPL) } }),
    PROXY, BLOCK,
  );
  assert.equal(r.architecture, "eip1967");
});

test("EIP-1967 beacon slot → beacon, implementation read through the beacon", async () => {
  const r = await inspectContract(
    fakeClient({ code: withCode(PROXY, BEACON, IMPL), slots: { [BEACON_SLOT]: word(BEACON) }, beaconImpl: IMPL }),
    PROXY, BLOCK,
  );
  assert.equal(r.architecture, "beacon");
  assert.equal(r.monitorAs, "beacon");
  assert.equal(r.implementation, IMPL);
});

test("pre-EIP-1967 OpenZeppelin slot → zeppelinos (the USDC pattern)", async () => {
  const r = await inspectContract(
    fakeClient({ code: withCode(PROXY, IMPL), slots: { [ZEPPELINOS_IMPLEMENTATION_SLOT]: word(IMPL) } }),
    PROXY, BLOCK,
  );
  assert.equal(r.architecture, "zeppelinos");
  assert.equal(r.monitorAs, "zeppelinos");
  assert.equal(r.implementation, IMPL);
});

test("the pre-EIP-1967 slot is keccak256(label) with no -1, unlike EIP-1967", () => {
  assert.equal(ZEPPELINOS_IMPLEMENTATION_SLOT, keccak256(toHex("org.zeppelinos.proxy.implementation")));
  assert.notEqual(ZEPPELINOS_IMPLEMENTATION_SLOT, IMPLEMENTATION_SLOT);
});

test("a diamond's loupe → diamond, with no single implementation", async () => {
  const r = await inspectContract(
    fakeClient({ code: withCode(PROXY), facets: [{ facetAddress: IMPL, functionSelectors: ["0x11111111"] }] }),
    PROXY, BLOCK,
  );
  assert.equal(r.architecture, "diamond");
  assert.equal(r.monitorAs, "diamond");
});

test("a Safe proxy's singleton in slot 0 → safe", async () => {
  const r = await inspectContract(
    fakeClient({ code: { [PROXY.toLowerCase()]: "0x6080604052" + "00".repeat(100), [IMPL.toLowerCase()]: ORDINARY_CODE }, slots: { [SAFE_SINGLETON_SLOT]: word(IMPL) } }),
    PROXY, BLOCK,
  );
  assert.equal(r.architecture, "safe");
  assert.equal(r.monitorAs, "safe");
  assert.equal(r.implementation, IMPL);
});

/* ------------------------------------------------------------------ EIP-1167 */

test("canonical EIP-1167 runtime yields the embedded implementation", () => {
  const code = `0x363d3d373d3d3d363d73${IMPL.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  assert.equal(eip1167Implementation(code), IMPL.toLowerCase());
});

test("a non-canonical 1167 variant is NOT guessed at", () => {
  // One byte short of the canonical runtime: refusing to guess which 20 bytes are an address is
  // the point. A variant must come back as a proxy Argos cannot read, never as a wrong address.
  const code = `0x363d3d373d3d3d363d73${IMPL.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf`;
  assert.equal(eip1167Implementation(code), null);
});

test("an EIP-1167 clone is reported immutable and monitored by codehash", async () => {
  const code = `0x363d3d373d3d3d363d73${IMPL.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
  const r = await inspectContract(fakeClient({ code: { [PROXY.toLowerCase()]: code } }), PROXY, BLOCK);
  assert.equal(r.architecture, "eip1167");
  assert.equal(r.monitorAs, "none"); // codehash of the clone itself
  assert.equal(getAddress(r.implementation), IMPL);
  assert.match(r.reason, /cannot be upgraded/);
});

/* ------------------------------------------------------------------ not a proxy */

test("an ordinary contract → none, with a reason listing what was probed", async () => {
  const r = await inspectContract(fakeClient({ code: withCode(PROXY) }), PROXY, BLOCK);
  assert.equal(r.architecture, "none");
  assert.equal(r.monitorAs, "none");
  assert.match(r.reason, /EIP-1967 implementation and beacon slots are empty/);
});

test("DELEGATECALL in a large contract is NOT proxy evidence", async () => {
  // Regression guard: WETH and LINK both contain a DELEGATECALL on mainnet and neither is a
  // proxy, so presence alone must never promote a contract out of "none".
  const big = `0x6080604052${"00".repeat(500)}f4${"00".repeat(500)}`;
  assert.equal(hasDelegatecall(big), true);
  const r = await inspectContract(fakeClient({ code: { [PROXY.toLowerCase()]: big } }), PROXY, BLOCK);
  assert.equal(r.architecture, "none");
});

test("DELEGATECALL bytes hidden inside a PUSH operand are not read as an opcode", () => {
  assert.equal(hasDelegatecall("0x61f4f4"), false); // PUSH2 0xf4f4
  assert.equal(hasDelegatecall("0x60f4"), false); // PUSH1 0xf4
  assert.equal(hasDelegatecall("0xf4"), true);
});

test("no code at all → no-code, not 'not a proxy'", async () => {
  const r = await inspectContract(fakeClient({}), PROXY, BLOCK);
  assert.equal(r.architecture, "no-code");
  assert.equal(r.monitorAs, null);
  assert.match(r.reason, /different network/);
});

test("an EIP-7702 delegated EOA is reported as such, not as a contract", async () => {
  const r = await inspectContract(
    fakeClient({ code: { [PROXY.toLowerCase()]: `0xef0100${IMPL.slice(2).toLowerCase()}` } }),
    PROXY, BLOCK,
  );
  assert.equal(r.architecture, "delegated-eoa");
  assert.equal(r.monitorAs, null);
  assert.match(r.reason, /externally owned account/);
});

/* ------------------------------------------------------- proxies Argos cannot read */

test("a forwarder-sized contract with DELEGATECALL and no readable target → unsupported-proxy", async () => {
  const r = await inspectContract(fakeClient({ code: { [PROXY.toLowerCase()]: FORWARDER_CODE } }), PROXY, BLOCK);
  assert.equal(r.architecture, "unsupported-proxy");
  assert.equal(r.monitorAs, null);
  assert.match(r.reason, /forwards calls/);
});

test("EIP-1822 PROXIABLE with code → unsupported-proxy, and says why it is not monitored", async () => {
  const r = await inspectContract(
    fakeClient({ code: withCode(PROXY, IMPL), slots: { [EIP1822_PROXIABLE_SLOT]: word(IMPL) } }),
    PROXY, BLOCK,
  );
  assert.equal(r.architecture, "unsupported-proxy");
  assert.match(r.reason, /withdrawn in favour of EIP-1967/);
});

test("a 1967 slot pointing at an empty address is a broken proxy, never 'not a proxy'", async () => {
  const r = await inspectContract(
    fakeClient({ code: withCode(PROXY), slots: { [IMPLEMENTATION_SLOT]: word(IMPL) } }), // IMPL has no code
    PROXY, BLOCK,
  );
  assert.equal(r.architecture, "unsupported-proxy");
  assert.equal(r.implementation, IMPL);
  assert.match(r.reason, /nothing is deployed there/);
});

test("a beacon whose implementation() reverts → unsupported-proxy, not beacon", async () => {
  const r = await inspectContract(
    fakeClient({ code: withCode(PROXY, BEACON), slots: { [BEACON_SLOT]: word(BEACON) }, beaconImpl: "revert" }),
    PROXY, BLOCK,
  );
  assert.equal(r.architecture, "unsupported-proxy");
  assert.match(r.reason, /does not answer implementation\(\)/);
});

/* ------------------------------------------------------------------ we don't know */

test("a node that declines a slot read throws, and does not answer 'not a proxy'", async () => {
  // The original bug: getStorageAt resolving to undefined became zeroHash became kind "none".
  await assert.rejects(
    () => inspectContract(fakeClient({ code: withCode(PROXY), slotMissing: [IMPLEMENTATION_SLOT] }), PROXY, BLOCK),
    (err: unknown) => err instanceof InspectionError && err.probe === "eip1967.implementation",
  );
});

test("a node that errors on a slot read throws rather than classifying", async () => {
  await assert.rejects(
    () => inspectContract(fakeClient({ code: withCode(PROXY), slotFails: [BEACON_SLOT] }), PROXY, BLOCK),
    (err: unknown) => err instanceof InspectionError && err.probe === "eip1967.beacon",
  );
});

test("a failed eth_getCode throws rather than classifying", async () => {
  const broken = { async getCode() { throw new Error("rpc down"); } } as never;
  await assert.rejects(
    () => inspectContract(broken, PROXY, BLOCK),
    (err: unknown) => err instanceof InspectionError && err.probe === "eth_getCode",
  );
});

test("readAddressSlot distinguishes a zero slot from an unanswered one", async () => {
  const zero = fakeClient({ slots: {} });
  assert.equal(await readAddressSlot(zero, PROXY, IMPLEMENTATION_SLOT, BLOCK), "0x0000000000000000000000000000000000000000");
  const missing = fakeClient({ slotMissing: [IMPLEMENTATION_SLOT] });
  await assert.rejects(() => readAddressSlot(missing, PROXY, IMPLEMENTATION_SLOT, BLOCK), SlotReadError);
});

/* ------------------------------------------------------------------ the narrow API */

test("classifyContract folds unreadable proxies into 'none', as documented", async () => {
  // The importer stores one string per deployment and only cares whether a contract is watchable.
  // This is why anything user-facing must use inspectContract instead.
  const { kind } = await classifyContract(fakeClient({ code: { [PROXY.toLowerCase()]: FORWARDER_CODE } }), PROXY, BLOCK);
  assert.equal(kind, "none");
  const empty = await classifyContract(fakeClient({}), PROXY, BLOCK);
  assert.equal(empty.kind, "no-code");
});
