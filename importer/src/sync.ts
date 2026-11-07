/**
 * Keeping the Arkiv mirror in step with the upstream ERC-7730 registry.
 *
 * WHAT WAS MISSING. `import.ts` is idempotent and resumable, and it has always been able to bring
 * the mirror up to a commit — but it takes a *local checkout* as an argument, so running it meant
 * a person cloning the registry and typing a path. There was no way for the mirror to notice that
 * upstream had moved. The mirror on Arkiv was therefore a one-time import that happened to still
 * be current, not a synchronisation.
 *
 * WHAT THIS ADDS. One command that can run unattended:
 *
 *   npm run sync -w importer -- --check          # report drift, write nothing, exit 0/1
 *   npm run sync -w importer -- --apply          # fetch, then import what changed
 *   npm run sync -w importer -- --apply --swarm  # and put new descriptor content on Swarm
 *
 * It resolves upstream's current commit with `git ls-remote` (one request, no clone), compares it
 * with the commit the mirror's rows carry, and only then does any work. `--check` is what a cron
 * entry or a CI job runs; it exits non-zero when the mirror is behind, so drift is detectable
 * without granting anything write access.
 *
 * IDEMPOTENT BY CONSTRUCTION. The actual writing is still `import.ts`: it reads every row the
 * writer already published and creates only what is missing, patching what changed. So running
 * this twice, or running it while it is already running, converges on the same rows — a changed
 * file becomes a new row (new file_sha / descriptor_hash) and the old row stays as history with
 * the last commit it was seen in.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { asc } from "@arkiv-network/sdk/query";
import { http } from "viem";
import { DescriptorSchema, TRUSTED_CREATORS, describeError } from "@driftguard/core";

export const REGISTRY_URL = "https://github.com/ethereum/clear-signing-erc7730-registry";
/** Where the checkout lives. Under .cache, which .gitignore already excludes. */
const CHECKOUT = fileURLToPath(new URL("../../.cache/clear-signing-erc7730-registry", import.meta.url));

const log = (msg: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...data }));

/** The commit upstream's default branch points at, without cloning anything. */
export function upstreamCommit(url = REGISTRY_URL): string {
  const out = execFileSync("git", ["ls-remote", url, "HEAD", "refs/heads/main", "refs/heads/master"], { encoding: "utf8" });
  const line = out.trim().split("\n").find((l) => /\bHEAD$/.test(l)) ?? out.trim().split("\n")[0];
  const sha = line?.split(/\s+/)[0];
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not read a commit from git ls-remote: ${out.slice(0, 200)}`);
  return sha;
}

/**
 * The commit the mirror's rows carry — the one most of them were last seen in.
 *
 * Taken from the rows rather than from a local file, because the rows are the mirror: a state
 * file could disagree with what was actually published, and then "in sync" would be a guess.
 */
export async function mirrorCommit(env = process.env): Promise<{ commit: string; rows: number; byCommit: Record<string, number> }> {
  const pub = createPublicClient({ chain: rabdi({ accessKey: env.ARKIV_ACCESS_KEY ?? "" }), transport: http() });
  const counts: Record<string, number> = {};
  let rows = 0;
  for (let offset = 0; ; ) {
    const page = await pub
      .select({ $key: true, registry_commit: true })
      .from(DescriptorSchema)
      .createdBy(TRUSTED_CREATORS.writer)
      .orderBy(asc("$key"))
      .limit(100)
      .offset(offset)
      .fetch();
    for (const r of page.entities) {
      counts[r.registry_commit.value] = (counts[r.registry_commit.value] ?? 0) + 1;
      rows++;
    }
    const covered = page.entities.length + page.skipped;
    if (covered < 100) break;
    offset += covered;
  }
  const commit = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  return { commit, rows, byCommit: counts };
}

export interface DriftReport {
  upstream: string;
  mirror: string;
  rows: number;
  inSync: boolean;
  byCommit: Record<string, number>;
}

export async function checkDrift(env = process.env): Promise<DriftReport> {
  const upstream = upstreamCommit();
  const { commit: mirror, rows, byCommit } = await mirrorCommit(env);
  return { upstream, mirror, rows, inSync: mirror === upstream && rows > 0, byCommit };
}

/**
 * Clones or fast-forwards the checkout to `commit`.
 *
 * `core.autocrlf=false` because `registry.ts` refuses a file containing CR bytes — a descriptor's
 * hash is over its exact bytes, so a line-ending rewrite would change every hash in the mirror.
 */
export function fetchRegistry(commit: string): string {
  mkdirSync(fileURLToPath(new URL("../../.cache/", import.meta.url)), { recursive: true });
  const git = (args: string[], cwd?: string) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
    return r.stdout.trim();
  };
  if (!existsSync(`${CHECKOUT}/.git`)) {
    log("cloning the registry", { url: REGISTRY_URL, into: CHECKOUT });
    git(["clone", "--config", "core.autocrlf=false", "--filter=blob:none", REGISTRY_URL, CHECKOUT]);
  }
  git(["config", "core.autocrlf", "false"], CHECKOUT);
  git(["fetch", "--depth", "1", "origin", commit], CHECKOUT);
  git(["checkout", "--force", commit], CHECKOUT);
  const at = git(["rev-parse", "HEAD"], CHECKOUT);
  if (at !== commit) throw new Error(`checkout is at ${at}, expected ${commit}`);
  return CHECKOUT;
}

/** Runs the importer (and optionally the Swarm upload) against the checkout, inheriting stdio. */
export function runImport(root: string, opts: { swarm?: boolean; dry?: boolean }): void {
  const node = process.execPath;
  const envFile = fileURLToPath(new URL("../../.env", import.meta.url));
  const run = (script: string, args: string[]) => {
    const r = spawnSync(node, [`--env-file-if-exists=${envFile}`, fileURLToPath(new URL(script, import.meta.url)), root, ...args], {
      stdio: "inherit",
    });
    if (r.status !== 0) throw new Error(`${script} exited with ${r.status}`);
  };
  run("./import.ts", opts.dry ? ["--dry"] : []);
  // Swarm is a separate step on purpose: it costs postage and the importer must have created the
  // rows the upload patches. Only run when asked.
  if (opts.swarm) run("./swarm.ts", opts.dry ? ["--dry"] : []);
}

/* --------------------------------------------------------------------- CLI */

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dry = args.includes("--dry");
  const swarm = args.includes("--swarm");

  try {
    const drift = await checkDrift();
    log("drift", {
      upstream: drift.upstream.slice(0, 7),
      mirror: drift.mirror.slice(0, 7) || "(no rows)",
      descriptorRows: drift.rows,
      inSync: drift.inSync,
      commitsPresent: Object.fromEntries(Object.entries(drift.byCommit).map(([c, n]) => [c.slice(0, 7), n])),
    });

    if (drift.inSync) {
      log("mirror is current", { commit: drift.upstream.slice(0, 7), descriptorRows: drift.rows });
      process.exit(0);
    }

    if (!apply) {
      // Non-zero so a cron entry or a CI job can use this as the drift check itself, with no
      // credentials and no write access.
      log("mirror is BEHIND upstream", {
        upstream: drift.upstream,
        mirror: drift.mirror,
        hint: "run with --apply to fetch the new commit and import what changed",
      });
      process.exit(1);
    }

    const root = fetchRegistry(drift.upstream);
    log("checkout ready", { root, commit: drift.upstream.slice(0, 7) });
    runImport(root, { swarm, dry });

    if (dry) {
      log("dry run: nothing was written");
      process.exit(0);
    }
    const after = await checkDrift();
    log(after.inSync ? "sync complete" : "sync did not fully converge", {
      upstream: after.upstream.slice(0, 7),
      mirror: after.mirror.slice(0, 7),
      descriptorRows: after.rows,
      inSync: after.inSync,
    });
    process.exit(after.inSync ? 0 : 1);
  } catch (err) {
    log("sync failed", { error: describeError(err) });
    process.exit(1);
  }
}
