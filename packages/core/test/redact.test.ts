import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, redactSecrets } from "../src/redact.ts";

test("access keys in Arkiv RPC URLs are redacted", () => {
  const s = "URL: https://rpc.rabdi.db-chain.testnet.arkiv.network/ark_live_AbC-123_xyz";
  assert.equal(redactSecrets(s), "URL: https://rpc.rabdi.db-chain.testnet.arkiv.network/ark_live_[REDACTED]");
});

test("describeError keeps status + short message and drops the URL", () => {
  const err = { shortMessage: "Transaction failed", cause: { status: 413, shortMessage: "HTTP request failed.", message: "URL: https://x/ark_live_SECRET" } };
  const d = describeError(err);
  assert.match(d, /HTTP 413/);
  assert.doesNotMatch(d, /SECRET/);
});

test("tx hashes are not redacted", () => {
  const h = "tx 0x" + "ab".repeat(32);
  assert.equal(redactSecrets(h), h);
});
