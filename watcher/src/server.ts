/**
 * The small HTTP surface the web app talks to, served by the watcher process.
 *
 * It exists for one reason: publishing a `dg_baseline` row needs ARKIV_WRITER_PRIVATE_KEY, and
 * the browser must never hold it. The watcher is where that key already lives, and a baseline
 * *starts* monitoring — so publishing in the same process means the next cycle picks the contract
 * up with no coordination at all.
 *
 *   POST /api/baseline   { chainId, address, rebaseline?, reason? }  → publish, verify, report
 *   GET  /api/health                                                 → is the publisher usable?
 *
 * SECRETS. Nothing here ever puts a key in a response or a log line: every error goes through
 * `describeError`, which redacts access keys and key-shaped hex (packages/core/src/redact.ts).
 * The health endpoint reports only *whether* a key is configured.
 *
 * AUTHORISATION. `ARGOS_PUBLISH_TOKEN` must be set, and callers must present it as
 * `authorization: Bearer <token>`. With no token configured the endpoint refuses every request
 * with 503 and says so, which the UI shows as a blocked publisher rather than a pending one —
 * an open write endpoint for a wallet the whole system trusts is not a sane default.
 *
 * Disabled unless ARGOS_HTTP_PORT is set, so `npm start -w watcher` keeps its current behaviour.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { describeError } from "@driftguard/core";
import type { ArkivSink } from "./arkivSink.ts";
import type { WatcherConfig } from "./config.ts";
import { publishBaseline, PUBLISHABLE_CHAINS, type PublishRequest, type PublishResult } from "./publish.ts";
import type { PublicClient } from "viem";

const MAX_BODY_BYTES = 4 * 1024;
/** Publishing costs a transaction, so the budget is deliberately small. */
const RATE_LIMIT = { windowMs: 60_000, max: 5 };

export interface ServerDeps {
  sink: ArkivSink;
  clientFor: (chainId: number) => PublicClient;
  config: WatcherConfig;
  log: (msg: string, data?: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
}

/** HTTP status per result state. `rejected` is the caller's fault; `failed` may be ours. */
const STATUS: Record<PublishResult["state"], number> = {
  published: 201,
  "already-monitored": 200,
  rejected: 422,
  unverified: 502,
  failed: 502,
};

function constantTimeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // timingSafeEqual needs equal lengths; compare lengths separately rather than leaking via throw.
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Per-IP fixed window. In-memory: one watcher process, and the limit is about cost, not security. */
function rateLimiter() {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (ip: string): boolean => {
    const now = Date.now();
    const slot = hits.get(ip);
    if (!slot || slot.resetAt <= now) {
      hits.set(ip, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
      return true;
    }
    if (slot.count >= RATE_LIMIT.max) return false;
    slot.count++;
    return true;
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error(`request body larger than ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (size === 0) throw new Error("empty request body");
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Allowed browser origins, from ARGOS_ALLOWED_ORIGINS (comma-separated). CORS is not the
 * authorisation here — the bearer token is — but a narrow list keeps a random page from making a
 * browser spend the writer's balance on someone's behalf.
 */
function originPolicy(env: NodeJS.ProcessEnv) {
  const allowed = (env.ARGOS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return (origin: string | undefined): string | null => {
    if (allowed.includes("*")) return "*";
    if (!origin) return null;
    return allowed.includes(origin) ? origin : null;
  };
}

export function createPublishServer(deps: ServerDeps) {
  const env = deps.env ?? process.env;
  const token = env.ARGOS_PUBLISH_TOKEN ?? "";
  const allowOrigin = originPolicy(env);
  const allow = rateLimiter();

  const send = (res: ServerResponse, status: number, body: unknown, origin: string | undefined) => {
    const ok = allowOrigin(origin);
    res.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...(ok ? { "access-control-allow-origin": ok, vary: "origin" } : {}),
    });
    res.end(JSON.stringify(body));
  };

  return createServer((req, res) => {
    void (async () => {
      const origin = req.headers.origin;
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "OPTIONS") {
        const ok = allowOrigin(origin);
        res.writeHead(ok ? 204 : 403, {
          ...(ok ? { "access-control-allow-origin": ok, vary: "origin" } : {}),
          "access-control-allow-methods": "POST, GET, OPTIONS",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-max-age": "600",
        });
        res.end();
        return;
      }

      if (url.pathname === "/api/health" && req.method === "GET") {
        // Booleans only: whether a key exists, never any part of it.
        send(res, 200, {
          service: "argos-watcher",
          publisher: token ? "configured" : "not-configured",
          writerKey: deps.sink.canWriteBaselines ? "configured" : "missing",
          chains: PUBLISHABLE_CHAINS,
          at: new Date().toISOString(),
        }, origin);
        return;
      }

      if (url.pathname !== "/api/baseline" || req.method !== "POST") {
        send(res, 404, { error: "not-found" }, origin);
        return;
      }

      // ---- authorisation ---------------------------------------------------------------------
      if (!token) {
        send(res, 503, {
          state: "blocked",
          code: "publisher-not-configured",
          message: "This Argos deployment has no ARGOS_PUBLISH_TOKEN, so the baseline publisher is disabled. No baseline can be published until an operator configures it.",
        }, origin);
        return;
      }
      if (!deps.sink.canWriteBaselines) {
        send(res, 503, {
          state: "blocked",
          code: "writer-key-missing",
          message: "This Argos deployment has no ARKIV_WRITER_PRIVATE_KEY, so it cannot sign a dg_baseline row.",
        }, origin);
        return;
      }
      const presented = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!constantTimeEqual(presented, token)) {
        send(res, 401, { state: "rejected", code: "unauthorized", message: "A valid publish token is required." }, origin);
        return;
      }
      if (origin !== undefined && allowOrigin(origin) === null) {
        send(res, 403, { state: "rejected", code: "origin-not-allowed", message: "This origin is not allowed to publish baselines." }, origin);
        return;
      }

      const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
      if (!allow(ip)) {
        send(res, 429, { state: "rejected", code: "rate-limited", message: `At most ${RATE_LIMIT.max} publications per minute. Each one costs a transaction.` }, origin);
        return;
      }

      // ---- publish ---------------------------------------------------------------------------
      let body: PublishRequest;
      try {
        const parsed = await readJsonBody(req);
        if (typeof parsed !== "object" || parsed === null) throw new Error("body must be a JSON object");
        body = parsed as PublishRequest;
      } catch (err) {
        send(res, 400, { state: "rejected", code: "bad-request", message: describeError(err) }, origin);
        return;
      }

      try {
        const result = await publishBaseline(
          { chainId: Number(body.chainId), address: String(body.address ?? ""), rebaseline: body.rebaseline === true, reason: typeof body.reason === "string" ? body.reason : undefined },
          deps,
        );
        send(res, STATUS[result.state], result, origin);
      } catch (err) {
        // publishBaseline returns a result for every expected outcome, so anything thrown here is
        // a bug. Report it without detail beyond the redacted message, and log it.
        deps.log("publish handler failed", { error: describeError(err) });
        send(res, 500, { state: "failed", message: describeError(err) }, origin);
      }
    })().catch(() => {
      try {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ state: "failed", message: "internal error" }));
      } catch {
        /* response already sent */
      }
    });
  });
}

/**
 * Resolves the port the publisher should listen on, or 0 to stay off.
 *
 * Off unless ARGOS_HTTP_PORT says otherwise: this is a write endpoint, and a deployment that
 * never asked for one should not acquire it by being deployed somewhere that happens to set
 * PORT.
 *
 * `ARGOS_HTTP_PORT=auto` is the platform case. Railway (and Render, Fly, Heroku) injects PORT
 * and routes external traffic *only* there, so a hardcoded number binds a port nothing reaches —
 * the service looks healthy and every publish attempt times out. "auto" keeps the opt-in explicit
 * while letting the platform choose the number.
 */
export function resolvePublishPort(env: NodeJS.ProcessEnv): number {
  const raw = (env.ARGOS_HTTP_PORT ?? "").trim();
  if (!raw) return 0;
  if (raw.toLowerCase() === "auto") return Number(env.PORT ?? 0);
  return Number(raw) || 0;
}

/** Starts the server when ARGOS_HTTP_PORT is set. Returns null when it is not. */
export function startPublishServer(deps: ServerDeps) {
  const env = deps.env ?? process.env;
  const port = resolvePublishPort(env);
  if (!port) {
    // "auto" with no PORT is a misconfiguration, not a choice to disable. Say so, because the
    // symptom otherwise is a silently absent endpoint.
    if ((env.ARGOS_HTTP_PORT ?? "").trim().toLowerCase() === "auto") {
      deps.log("publish server NOT started", { reason: "ARGOS_HTTP_PORT=auto but the platform set no PORT" });
    }
    return null;
  }
  const server = createPublishServer(deps);
  server.listen(port, () => {
    deps.log("publish server listening", {
      port,
      publisher: env.ARGOS_PUBLISH_TOKEN ? "configured" : "not-configured (will refuse every request)",
      origins: env.ARGOS_ALLOWED_ORIGINS ?? "(none configured; browsers will be refused)",
    });
  });
  return server;
}
