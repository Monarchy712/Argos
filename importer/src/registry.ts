/**
 * Reads the ERC-7730 registry at a pinned commit and turns it into mirror rows. Pure apart from
 * reading the checkout: no network, so it is unit-tested and its output is deterministic.
 *
 * Hashes:
 *  - file_sha       = keccak256(raw file bytes as GitHub serves them). Lets anyone check a file
 *                     fetched from GitHub (or any mirror) byte for byte.
 *  - descriptor_hash = ERC-8176: keccak256(RFC 8785 JCS(fully resolved descriptor)). Computed two
 *                     ways, ours (canonicalize + keccak) and the library's computeDescriptorHash,
 *                     and the import aborts if they ever differ. For attested descriptors it is
 *                     also compared with the hash the auditor signed in sigs/.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, basename, dirname, posix } from "node:path";
import { execFileSync } from "node:child_process";
import canonicalize from "canonicalize";
import { keccak256, toHex, stringToBytes, getAddress, type Hex } from "viem";
import { computeDescriptorHash, mergeDescriptors } from "@ethereum-sourcify/clear-signing";

export type FileKind = "calldata" | "eip712" | "include";

export interface DescriptorRow {
  descriptorHash: Hex | ""; // "" for include files (not standalone descriptors)
  registryPath: string;
  entityDir: string;
  kind: FileKind;
  sizeBytes: number; // size of the JCS bytes of the resolved descriptor (raw size for includes)
  fileSha: Hex;
  schemaVersion: string;
  ownerName: string;
  attested: boolean;
  /** ERC-8176 hashes found in this descriptor's sigs/ attestations (should all equal descriptorHash) */
  attestedHashes: Hex[];
  /** valid = an attestation signs exactly descriptorHash; stale = attestations exist but for other content */
  attestation: "valid" | "stale" | "none";
  /** RFC 8785 JCS text of the resolved descriptor (what goes to Swarm); absent for include files */
  jcs?: string;
}

export interface DeploymentRow {
  chainId: number;
  address: `0x${string}`;
  descriptorHash: Hex;
  registryPath: string;
  kind: "calldata" | "eip712";
}

export interface RegistrySnapshot {
  commit: string;
  descriptors: DescriptorRow[];
  deployments: DeploymentRow[];
}

/** Truncate a string to at most `max` UTF-8 bytes (Arkiv str attributes are capped at 128 bytes). */
export function truncateBytes(s: string, max = 120): string {
  let out = s;
  while (Buffer.byteLength(out) > max) out = out.slice(0, -1);
  return out;
}

export function jcsHash(value: unknown): { hash: Hex; size: number; text: string } {
  const text = canonicalize(value);
  if (text === undefined) throw new Error("JCS: value is not serialisable");
  const bytes = stringToBytes(text);
  return { hash: keccak256(bytes), size: bytes.length, text };
}

export function readRegistry(root: string): RegistrySnapshot {
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();
  const rel = (p: string) => relative(root, p).replaceAll("\\", "/");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!/^(tests|testsv2|sigs)$/.test(e.name)) walk(p);
      } else if (e.name.endsWith(".json") && !e.name.endsWith(".tests.json")) files.push(p);
    }
  };
  for (const top of ["registry", "ercs"]) if (existsSync(join(root, top))) walk(join(root, top));

  const raw = new Map<string, { bytes: Buffer; json: Record<string, unknown> }>();
  for (const f of files) {
    const bytes = readFileSync(f);
    if (bytes.includes(13)) throw new Error(`${rel(f)} contains CR bytes: check the registry out with core.autocrlf=false`);
    raw.set(rel(f), { bytes, json: JSON.parse(bytes.toString("utf8")) });
  }

  // Resolve `includes` with the library's ERC-7730 merge (paths relative to the including file).
  const resolved = new Map<string, Record<string, unknown>>();
  const resolve = (path: string, seen: string[] = []): Record<string, unknown> => {
    const cached = resolved.get(path);
    if (cached) return cached;
    if (seen.includes(path)) throw new Error(`include cycle: ${[...seen, path].join(" → ")}`);
    const file = raw.get(path);
    if (!file) throw new Error(`missing include ${path}`);
    let out = file.json;
    const inc = file.json.includes;
    if (typeof inc === "string") {
      const target = posix.normalize(posix.join(posix.dirname(path), inc));
      out = mergeDescriptors(file.json as never, resolve(target, [...seen, path]) as never) as unknown as Record<string, unknown>;
    }
    resolved.set(path, out);
    return out;
  };

  const descriptors: DescriptorRow[] = [];
  const deployments: DeploymentRow[] = [];
  const included = new Set<string>();
  for (const [path, file] of raw) {
    if (typeof file.json.includes === "string") included.add(posix.normalize(posix.join(posix.dirname(path), file.json.includes)));
  }

  for (const [path, file] of [...raw].sort(([a], [b]) => a.localeCompare(b))) {
    const name = basename(path);
    const kind: FileKind | null = name.startsWith("calldata-") ? "calldata" : name.startsWith("eip712-") ? "eip712" : included.has(path) ? "include" : null;
    if (!kind) continue; // index files etc. that no descriptor uses
    if (Buffer.byteLength(path) > 128) throw new Error(`path longer than 128 bytes (Arkiv str limit): ${path}`);
    const fileSha = keccak256(toHex(file.bytes));
    const meta = (file.json.metadata ?? {}) as { owner?: unknown };
    const base = {
      registryPath: path,
      // registry/<protocol>/file.json → "<protocol>"; ercs/file.json → "ercs"
      entityDir: path.startsWith("registry/") ? (path.split("/")[1] ?? "") : (path.split("/")[0] ?? ""),
      kind,
      fileSha,
      schemaVersion: truncateBytes(String(file.json.$schema ?? "")),
      ownerName: truncateBytes(String(meta.owner ?? "")),
    };

    if (kind === "include") {
      descriptors.push({ ...base, descriptorHash: "", sizeBytes: file.bytes.length, attested: false, attestedHashes: [], attestation: "none" });
      continue;
    }

    const full = resolve(path);
    const ours = jcsHash(full);
    const lib = computeDescriptorHash(full as never) as Hex;
    if (ours.hash !== lib) throw new Error(`JCS hash mismatch for ${path}: ours ${ours.hash}, library ${lib}. Aborting import.`);

    // Attestations: sigs/<stem>.eip155-<chain>-<attester>.json, ERC-8176 hash in sig.message.data
    const stem = name.replace(/\.json$/, "");
    const sigsDir = join(root, dirname(path), "sigs");
    const attestedHashes: Hex[] = [];
    if (existsSync(sigsDir)) {
      for (const s of readdirSync(sigsDir)) {
        if (!s.startsWith(`${stem}.eip155-`)) continue;
        const sig = JSON.parse(readFileSync(join(sigsDir, s), "utf8"));
        const data = sig?.sig?.message?.data;
        if (typeof data === "string") attestedHashes.push(data.toLowerCase() as Hex);
      }
    }
    const attestation = attestedHashes.length === 0 ? "none" : attestedHashes.includes(lib) ? "valid" : "stale";
    descriptors.push({ ...base, descriptorHash: lib, sizeBytes: ours.size, attested: attestation === "valid", attestedHashes, attestation, jcs: ours.text });

    const ctx = (full.context ?? {}) as { contract?: { deployments?: unknown[] }; eip712?: { deployments?: unknown[] } };
    const deps = (kind === "calldata" ? ctx.contract?.deployments : ctx.eip712?.deployments) ?? [];
    for (const d of deps as { chainId?: unknown; address?: unknown }[]) {
      if (typeof d.chainId !== "number" || typeof d.address !== "string") continue;
      deployments.push({ chainId: d.chainId, address: getAddress(d.address), descriptorHash: lib, registryPath: path, kind });
    }
  }
  return { commit, descriptors, deployments: dedupeDeployments(deployments) };
}

/** One row per (chain, address, descriptor_hash). */
export function dedupeDeployments(rows: DeploymentRow[]): DeploymentRow[] {
  const seen = new Map<string, DeploymentRow>();
  for (const r of rows) {
    const k = `${r.chainId}:${r.address.toLowerCase()}:${r.descriptorHash}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return [...seen.values()];
}
