/**
 * Publishes the built web app to Swarm as a browsable collection, so the frontend survives our
 * host disappearing. Censorship resistance for the EF CROPS track.
 *
 *   npm run build                                  # produce web/dist first
 *   node scripts/publish-site.ts [--dir web/dist] [--dry] [--with-maps]
 *
 * Source maps are excluded by default: they are 3.5 MB of the 4.7 MB build, the app does not need
 * them to run, and the repo is MIT so anyone can rebuild from source. Pass --with-maps to include.
 *
 * No keys needed: the public gateway accepts a stampless upload and attaches its own postage
 * stamp (same trade-off as importer/src/swarm.ts). If BEE_API_URL and SWARM_POSTAGE_BATCH_ID are
 * set, the upload goes through that node under our own batch instead.
 *
 * Determinism: the tar is built with sorted paths and zeroed mtime/uid/gid/mode, so the archive
 * bytes — and therefore the Swarm reference — are a pure function of the file contents and names.
 * Re-running on an unchanged build must print the same reference.
 *
 * KNOWN GATEWAY LIMIT (verified 2026-11-06, not a bug in this script): the ethswarm public
 * gateways are default-deny for websites. A new reference serves non-HTML assets immediately but
 * 302s HTML to bzz.link/forbidden until a moderator approves the hash, which is their
 * anti-phishing policy. So this script verifies what the gateway will serve and reports HTML as
 * "refused by gateway policy" rather than pretending the upload failed. The content is on Swarm
 * either way: any Bee node can serve `GET /bzz/<ref>/`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_GATEWAY = process.env.SWARM_PUBLIC_GATEWAY ?? "https://api.gateway.ethswarm.org";
const INDEX = "index.html";
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const withMaps = args.includes("--with-maps");
const dirArg = args.indexOf("--dir");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dir = join(repoRoot, dirArg >= 0 ? args[dirArg + 1]! : join("web", "dist"));

const log = (msg: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

const batchId = (process.env.SWARM_POSTAGE_BATCH_ID ?? "").replace(/^0x/, "").toLowerCase();
const ownBatch = /^[0-9a-f]{64}$/.test(batchId) && !!process.env.BEE_API_URL;
const beeUrl = ownBatch ? process.env.BEE_API_URL! : PUBLIC_GATEWAY;

// ---- collect the build ------------------------------------------------------------------------
function walk(root: string, at = root): string[] {
  return readdirSync(at, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(root, join(at, e.name)) : [relative(root, join(at, e.name))]))
    .map((p) => p.split(sep).join("/"));
}

let files: string[];
try {
  files = walk(dir)
    .filter((p) => withMaps || !p.endsWith(".map"))
    .sort(); // sorted: the archive must not depend on readdir order
} catch {
  throw new Error(`no build at ${dir} — run \`npm run build\` first`);
}
if (!files.includes(INDEX)) throw new Error(`${dir} has no ${INDEX}; is this a built app?`);
const contents = new Map(files.map((p) => [p, readFileSync(join(dir, p))] as const));
const totalBytes = [...contents.values()].reduce((n, b) => n + b.length, 0);
log("build", { dir: relative(repoRoot, dir), files: files.length, bytes: totalBytes });

// ---- deterministic ustar tar -------------------------------------------------------------------
/** One 512-byte ustar header. Everything variable (mtime, ids, mode) is fixed so the bytes are
 *  reproducible; Swarm references are content addresses, so a varying mtime would change the ref. */
function header(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`path too long for ustar (>100 bytes): ${name}`);
  const h = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => h.write(s.padEnd(len, "\0").slice(0, len), off, "binary");
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8); // mode
  put(octal(0, 8), 108, 8); // uid
  put(octal(0, 8), 116, 8); // gid
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12); // mtime: fixed, for reproducibility
  h.write("        ", 148, 8, "binary"); // checksum field is spaces while summing
  h.write("0", 156, 1, "binary"); // typeflag: regular file
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "binary");
  return h;
}

const pad = (n: number) => (n % 512 === 0 ? 0 : 512 - (n % 512));
const tar = Buffer.concat([
  ...files.flatMap((p) => {
    const body = contents.get(p)!;
    return [header(p, body.length), body, Buffer.alloc(pad(body.length))];
  }),
  Buffer.alloc(1024), // two zero blocks terminate the archive
]);
log("archive", { bytes: tar.length, mode: ownBatch ? "own postage batch" : "public gateway (gateway stamp)" });

if (dry) {
  log("dry run: nothing uploaded");
  process.exitCode = 0;
} else {
  // ---- upload ----------------------------------------------------------------------------------
  const res = await fetch(`${beeUrl}/bzz`, {
    method: "POST",
    headers: {
      "content-type": "application/x-tar",
      "swarm-collection": "true",
      "swarm-index-document": INDEX,
      ...(ownBatch ? { "swarm-postage-batch-id": batchId } : {}),
    },
    body: new Uint8Array(tar),
    signal: AbortSignal.timeout(600_000),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`upload HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const ref = String(((await res.json()) as { reference?: string }).reference ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(ref)) throw new Error(`gateway returned an unexpected reference: ${ref}`);
  log("uploaded", { reference: ref, url: `${PUBLIC_GATEWAY}/bzz/${ref}/` });

  // ---- verify what the gateway will actually serve ---------------------------------------------
  // Byte-compare every file we can retrieve. HTML is expected to be refused by the public
  // gateway's default-deny website policy; that is reported, not treated as success or failure.
  let ok = 0;
  const refused: string[] = [];
  const mismatched: string[] = [];
  for (const p of files) {
    const r = await fetch(`${PUBLIC_GATEWAY}/bzz/${ref}/${p}`, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    if (r.status === 301 || r.status === 302) {
      refused.push(p);
      continue;
    }
    if (!r.ok) {
      mismatched.push(`${p} (HTTP ${r.status})`);
      continue;
    }
    const got = Buffer.from(await r.arrayBuffer());
    if (got.equals(contents.get(p)!)) ok++;
    else mismatched.push(`${p} (${got.length} B back vs ${contents.get(p)!.length} B sent)`);
  }
  log("verified", {
    reference: ref,
    identical: `${ok}/${files.length}`,
    refusedByGatewayPolicy: refused.length ? refused : undefined,
    mismatched: mismatched.length ? mismatched : undefined,
  });
  if (mismatched.length) throw new Error(`${mismatched.length} file(s) did not come back byte-identical`);
  if (refused.length) {
    log("note", {
      detail:
        "the ethswarm public gateways are default-deny for websites: HTML 302s to bzz.link/forbidden " +
        "until a moderator approves the hash. The content IS on Swarm — any Bee node serves it with " +
        `GET /bzz/${ref}/ — and every asset the gateway did serve came back byte-identical.`,
    });
  }
  log("done", { reference: ref, serveLocally: `bee: GET /bzz/${ref}/`, publicGatewayAsset: `${PUBLIC_GATEWAY}/bzz/${ref}/${files.find((f) => !f.endsWith(".html")) ?? ""}` });
}
