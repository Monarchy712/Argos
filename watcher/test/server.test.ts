/**
 * Which port the baseline publisher binds, and whether it binds at all.
 *
 * This is deployment-shaped, not cosmetic. A write endpoint must not switch itself on just
 * because a host sets PORT, and on a host that routes only to its own PORT a hardcoded number
 * means the endpoint exists but nothing can reach it — the service reports healthy while every
 * publish times out.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePublishPort } from "../src/server.ts";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

test("off by default: no ARGOS_HTTP_PORT means no publisher", () => {
  assert.equal(resolvePublishPort(env({})), 0);
});

test("a platform PORT alone never switches the write endpoint on", () => {
  assert.equal(resolvePublishPort(env({ PORT: "8080" })), 0, "deploying somewhere must not grant a publisher");
});

test("an explicit port is used as given", () => {
  assert.equal(resolvePublishPort(env({ ARGOS_HTTP_PORT: "5399" })), 5399);
});

test("an explicit port wins over the platform's PORT", () => {
  assert.equal(resolvePublishPort(env({ ARGOS_HTTP_PORT: "5399", PORT: "8080" })), 5399);
});

test("'auto' takes the platform's PORT, which is the only port Railway routes to", () => {
  assert.equal(resolvePublishPort(env({ ARGOS_HTTP_PORT: "auto", PORT: "8080" })), 8080);
});

test("'auto' is case- and whitespace-insensitive, since it is typed into a dashboard", () => {
  assert.equal(resolvePublishPort(env({ ARGOS_HTTP_PORT: " AUTO ", PORT: "8080" })), 8080);
});

test("'auto' with no PORT stays off rather than binding something arbitrary", () => {
  assert.equal(resolvePublishPort(env({ ARGOS_HTTP_PORT: "auto" })), 0);
});

test("a non-numeric value stays off instead of binding port 0 (which means 'any free port')", () => {
  assert.equal(resolvePublishPort(env({ ARGOS_HTTP_PORT: "yes" })), 0);
  assert.equal(resolvePublishPort(env({ ARGOS_HTTP_PORT: "0" })), 0);
});

test("an empty or whitespace value is treated as unset, not as a request to bind", () => {
  assert.equal(resolvePublishPort(env({ ARGOS_HTTP_PORT: "" })), 0);
  assert.equal(resolvePublishPort(env({ ARGOS_HTTP_PORT: "   " })), 0);
});
