/**
 * Serves the built web app over HTTP. Used by the Railway "web" service.
 *
 *   node scripts/serve-static.ts            # serves web/dist on $PORT (default 8080)
 *
 * Zero dependencies on purpose: the app is a static bundle, and adding a server framework to
 * ship five files would undercut the claim that Argos needs no backend. This process serves
 * files and nothing else -- it has no keys, reads no chain, and holds no state. Everything the
 * app shows still comes from Arkiv, Swarm and the user's own RPC reads, in their browser.
 *
 * NOTE for the privacy table in README: when the app is served from a host rather than from a
 * local `npm run dev`, that host sees visitor IP addresses and which paths they fetch. It does
 * NOT see which contract they check -- that is a direct browser-to-RPC call (over Nym by
 * default) and a bulk, contract-independent Arkiv read.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../web/dist", import.meta.url)));
const PORT = Number(process.env.PORT ?? 8080);

if (!existsSync(join(ROOT, "index.html"))) {
  throw new Error(`no build at ${ROOT} — run \`npm run build\` first`);
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  // normalize() collapses ".." before we join, so a crafted path cannot escape ROOT.
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
  let file = join(ROOT, rel);
  if (!file.startsWith(ROOT + sep) && file !== ROOT) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(ROOT, "index.html");

  const ext = extname(file).toLowerCase();
  const immutable = file.includes(`${sep}assets${sep}`); // vite fingerprints these
  res.writeHead(200, {
    "content-type": TYPES[ext] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    // The app talks to Arkiv, Swarm and public RPCs from the browser, and boots the Nym worker
    // in a sandboxed null-origin iframe. No framing of this page by anyone else.
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
  });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(JSON.stringify({ msg: "serving", root: ROOT, port: PORT })));
