/**
 * Where ERC-7730 descriptors come from, behind one interface, so the UI never changes when the
 * storage does:
 *
 *  - SwarmFirstSource: the resolved descriptor (RFC 8785 JCS bytes) by the swarm_ref on the
 *    writer's Arkiv row, verified against that row's ERC-8176 descriptor_hash. If Swarm can't
 *    be reached, it falls back to the registry (labelled). A hash mismatch is never a fallback:
 *    tampered bytes are rejected.
 *  - RegistryFallbackSource: files at the pinned registry commit, fetched through the selected
 *    transport, each checked against the keccak256 (file_sha) on Arkiv or in the bundled
 *    manifest. A mismatch is an error, never a silent pass.
 */
import type { DescriptorResolver, RegistryIndex } from "@ethereum-sourcify/clear-signing";
import { keccak256, toHex } from "viem";
import { SWARM_GATEWAY } from "./config.ts";
import { viteEnvOr } from "./env.ts";

export interface RegistryManifest {
  source: string;
  license: string;
  commit: string;
  rawBase: string;
  generatedAt: string;
  calldataIndex: Record<string, string>;
  files: Record<string, string>;
  descriptors: Record<string, { entity: string; owner: string; attested: boolean; deployments: number; descriptorHash: string | null }>;
  /** path → Swarm reference + ERC-8176 hash, for rows the writer marked storage_mode = "swarm" */
  swarm?: Record<string, { ref: string; descriptorHash: string; arkivKey: string }>;
}

/** One verified file fetch, for the UI's provenance panel. */
export interface FetchRecord {
  path: string;
  url: string;
  expectedHash: string;
  ok: boolean;
  error?: string;
  /** where the bytes came from */
  via: "swarm" | "registry";
  /** set when a Swarm fetch failed (network) and the registry was used instead */
  fellBack?: boolean;
}

export interface DescriptorSource {
  readonly kind: "registry" | "swarm";
  /** e.g. "registry ef582c2 (hash-checked)" */
  describe(): string;
  /** Returns parsed, integrity-checked descriptor JSON for a registry path. */
  fetchDescriptor(path: string): Promise<unknown>;
}

export class DescriptorIntegrityError extends Error {}

export class RegistryFallbackSource implements DescriptorSource {
  readonly kind = "registry" as const;
  readonly log: FetchRecord[] = [];
  private readonly cache = new Map<string, unknown>();
  private readonly manifest: RegistryManifest;
  /** Demo only: modify this file's bytes after download, to show the hash check rejecting it. */
  private readonly tamperPath: string | null;
  constructor(manifest: RegistryManifest, opts: { tamperPath?: string | null } = {}) {
    this.manifest = manifest;
    this.tamperPath = opts.tamperPath ?? null;
  }

  describe(): string {
    return `registry @ ${this.manifest.commit.slice(0, 7)}, each file hash-checked`;
  }

  async fetchDescriptor(path: string): Promise<unknown> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const expectedHash = this.manifest.files[path];
    const url = this.manifest.rawBase + path;
    if (!expectedHash) {
      this.log.push({ path, url, expectedHash: "", ok: false, error: "not in the pinned manifest", via: "registry" });
      throw new DescriptorIntegrityError(`${path} is not in the pinned registry manifest`);
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
      if (path === this.tamperPath) bytes = tamper(bytes);
      const got = keccak256(toHex(bytes));
      if (got !== expectedHash) throw new DescriptorIntegrityError(`hash mismatch for ${path}: got ${got}, expected ${expectedHash}`);
      const json = JSON.parse(new TextDecoder().decode(bytes));
      this.cache.set(path, json);
      this.log.push({ path, url, expectedHash, ok: true, via: "registry" });
      return json;
    } catch (err) {
      this.log.push({ path, url, expectedHash, ok: false, error: err instanceof Error ? err.message : String(err), via: "registry" });
      throw err;
    }
  }
}

/**
 * Swarm first: GET {gateway}/bytes/{swarm_ref} through the selected transport, then
 * keccak256(bytes) must equal the ERC-8176 descriptor_hash from the writer's Arkiv row. The bytes
 * are the JCS form of the *resolved* descriptor, so includes are already merged in.
 * Network failure or timeout → registry fallback (recorded as fellBack). Hash mismatch → reject.
 */
export class SwarmFirstSource implements DescriptorSource {
  readonly kind = "swarm" as const;
  readonly log: FetchRecord[];
  private readonly cache = new Map<string, unknown>();
  private readonly manifest: RegistryManifest;
  private readonly fallback: RegistryFallbackSource;
  private readonly tamperPath: string | null;
  constructor(manifest: RegistryManifest, opts: { tamperPath?: string | null } = {}) {
    this.manifest = manifest;
    this.tamperPath = opts.tamperPath ?? null;
    this.fallback = new RegistryFallbackSource(manifest, opts);
    this.log = this.fallback.log; // one shared, ordered log for the provenance panel
  }

  describe(): string {
    return `Swarm (${Object.keys(this.manifest.swarm ?? {}).length} refs on Arkiv), registry fallback`;
  }

  async fetchDescriptor(path: string): Promise<unknown> {
    const cached = this.cache.get(path);
    if (cached) return cached;
    const entry = this.manifest.swarm?.[path];
    if (!entry) return this.fallback.fetchDescriptor(path);
    const url = `${SWARM_GATEWAY}/bytes/${entry.ref}`;
    let bytes: Uint8Array;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.push({ path, url, expectedHash: entry.descriptorHash, ok: false, error: `Swarm unreachable (${reason}); using the registry`, via: "swarm", fellBack: true });
      return this.fallback.fetchDescriptor(path);
    }
    if (path === this.tamperPath) bytes = tamper(bytes);
    const got = keccak256(toHex(bytes));
    if (got !== entry.descriptorHash) {
      const msg = `hash mismatch for ${path}: got ${got}, expected ${entry.descriptorHash}`;
      this.log.push({ path, url, expectedHash: entry.descriptorHash, ok: false, error: msg, via: "swarm" });
      throw new DescriptorIntegrityError(msg);
    }
    const json = JSON.parse(new TextDecoder().decode(bytes));
    this.cache.set(path, json);
    this.log.push({ path, url, expectedHash: entry.descriptorHash, ok: true, via: "swarm" });
    return json;
  }
}

/** Adapts any DescriptorSource to the clear-signing library's resolver shape. */
export function makeResolver(manifest: RegistryManifest, source: DescriptorSource): DescriptorResolver {
  const index: RegistryIndex = { calldataIndex: manifest.calldataIndex, typedDataIndex: {} };
  return {
    index,
    fetchDescriptor: (path: string) => source.fetchDescriptor(path) as ReturnType<DescriptorResolver["fetchDescriptor"]>,
  };
}

let manifestPromise: Promise<RegistryManifest> | null = null;
/** The committed manifest ships with the app (same origin), so loading it reveals nothing. */
export function loadManifest(): Promise<RegistryManifest> {
  manifestPromise ??= fetch(`${viteEnvOr("BASE_URL", "/")}registry-index.json`).then((r) => {
    if (!r.ok) throw new Error(`registry manifest: HTTP ${r.status}`);
    return r.json();
  });
  return manifestPromise;
}

export function descriptorFor(manifest: RegistryManifest, chainId: number, address: string) {
  const path = manifest.calldataIndex[`eip155:${chainId}:${address.toLowerCase()}`];
  return path ? { path, ...manifest.descriptors[path]! } : null;
}

/**
 * Demo tampering: prefix the first intent with "TAMPERED " (what an attacker who controls the
 * mirror or the network might do to change what the user is shown). Falls back to appending a
 * byte if the file has no intent string.
 */
export function tamper(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const changed = text.replace(/"intent"\s*:\s*"/, (m) => `${m}TAMPERED `);
  return new TextEncoder().encode(changed === text ? `${text} ` : changed);
}
