import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_SLOT, BEACON_SLOT, IMPLEMENTATION_SLOT } from "../src/slots.ts";
import { codeIdentityHash, diffIdentity, emptyIdentity, type CodeIdentity } from "../src/identity.ts";
import { facetsHash } from "../src/read.ts";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";

// Reference values from EIP-1967 and OpenZeppelin ERC1967Utils (v5.6.1).
test("EIP-1967 slots match the spec values", () => {
  assert.equal(IMPLEMENTATION_SLOT, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
  assert.equal(ADMIN_SLOT, "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103");
  assert.equal(BEACON_SLOT, "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50");
});

test("identity hash changes with the implementation, and diff names the field", () => {
  const a: CodeIdentity = { ...emptyIdentity("eip1967"), implementation: A };
  const b: CodeIdentity = { ...a, implementation: B };
  assert.notEqual(codeIdentityHash(a), codeIdentityHash(b));
  assert.deepEqual(diffIdentity(a, b), ["implementation"]);
  assert.equal(codeIdentityHash(a), codeIdentityHash({ ...b, implementation: A }));
});

test("facetsHash ignores facet and selector order", () => {
  const x = facetsHash([
    { facetAddress: A, functionSelectors: ["0x11111111", "0x22222222"] },
    { facetAddress: B, functionSelectors: ["0x33333333"] },
  ]);
  const y = facetsHash([
    { facetAddress: B, functionSelectors: ["0x33333333"] },
    { facetAddress: A, functionSelectors: ["0x22222222", "0x11111111"] },
  ]);
  assert.equal(x, y);
});
