/**
 * The demo registry's identity test. The point is that a demo contract is recognised by network
 * and normalised address — never by its name, because a real user could pick the same name.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMO_CONTRACTS, DEMO_PROXY, GUARD_DEMO, demoContractInfo, isDemoContract } from "../src/lib/demo.ts";

test("both documented demo proxies are in the registry", () => {
  assert.equal(DEMO_CONTRACTS.length, 4);
  assert.ok(isDemoContract(11155111, "0xb8E5525eF80cEEC29Bf8598e303F71077361BFF5"));
  assert.ok(isDemoContract(11155111, "0x3c93e603bbeD9Dc2Af817BC2D98Bc1D35CF1D669"));
  assert.ok(isDemoContract(11155111, "0x319480a00314B03453d1f43b96eCc9F1C4f6EF1d"));
});

test("matching ignores address case", () => {
  assert.ok(isDemoContract(DEMO_PROXY.chainId, DEMO_PROXY.address.toLowerCase()));
  assert.ok(isDemoContract(DEMO_PROXY.chainId, DEMO_PROXY.address.toUpperCase().replace("0X", "0x")));
  assert.ok(isDemoContract(GUARD_DEMO.chainId, GUARD_DEMO.proxy.toLowerCase()));
});

test("the same address on another network is NOT a demo contract", () => {
  // A demo address is an identity on Sepolia only; someone could deploy to the same address on
  // mainnet, and that contract is theirs.
  assert.equal(isDemoContract(1, DEMO_PROXY.address), false);
  assert.equal(isDemoContract(1, GUARD_DEMO.proxy), false);
});

test("a user's contract that shares a demo's NAME is not filtered", () => {
  // The regression this guards: filtering by label would hide a real monitored contract whose
  // owner happens to be called "Argos demo proxy".
  const usersOwn = { chainId: 1, address: "0x00000000000000000000000000000000000000aa", label: DEMO_PROXY.label };
  assert.equal(isDemoContract(usersOwn.chainId, usersOwn.address), false);
  assert.equal(demoContractInfo(usersOwn.chainId, usersOwn.address), null);
});

test("an ordinary monitored contract is not a demo", () => {
  assert.equal(isDemoContract(1, "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"), false); // Aave v3 Pool
});

test("every registry entry explains why Argos deployed it", () => {
  for (const d of DEMO_CONTRACTS) {
    assert.ok(d.why.length > 20, `${d.label} needs a reason`);
    assert.match(d.address, /^0x[0-9a-fA-F]{40}$/);
  }
});

test("the guard demo's proxy and guard are different addresses", () => {
  // The guard is the contract that performs the check; the proxy is what it checks. Confusing the
  // two would point the demonstration at itself.
  assert.notEqual(GUARD_DEMO.proxy.toLowerCase(), GUARD_DEMO.guard.toLowerCase());
  assert.equal(isDemoContract(GUARD_DEMO.chainId, GUARD_DEMO.guard), false);
});
