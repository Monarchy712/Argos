/**
 * Where ERC-7730 descriptors come from, behind one interface, so the UI never changes when the
 * storage does:
 *
 *  - RegistryFallbackSource (now): files at the pinned registry commit, fetched through the
 *    selected transport (Nym by default), each checked against keccak256 in the committed
 *    manifest (web/public/registry-index.json). A mismatch is an error, never a silent pass.
 *  - Swarm source (after Test 1): resolved descriptor JSON by Swarm reference, verified against
 *    the ERC-8176 descriptor hash in the trusted Arkiv row. Implements the same interface.
 */
import type { DescriptorResolver, RegistryIndex } from "@ethereum-sourcify/clear-signing";
import { keccak256, toHex } from "viem";
import { anonAwareFetch } from "./transport.ts";

export interface RegistryManifest {
  source: string;
  license: string;
  commit: string;
  rawBase: string;
  generatedAt: string;
  calldataIndex: Record<string, string>;
  files: Record<string, string>;
  descriptors: Record<string, { entity: string; owner: string; attested: boolean; deployments: number; descriptorHash: string | null }>;
}

/** One verified file fetch, for the UI's provenance panel. */
export interface FetchRecord {
  path: string;
  url: string;
  expectedHash: string;
  ok: boolean;
  error?: string;
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
  constructor(manifest: RegistryManifest) {
    this.manifest = manifest;
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
      this.log.push({ path, url, expectedHash: "", ok: false, error: "not in the pinned manifest" });
      throw new DescriptorIntegrityError(`${path} is not in the pinned registry manifest`);
    }
    try {
      const res = await anonAwareFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const got = keccak256(toHex(bytes));
      if (got !== expectedHash) throw new DescriptorIntegrityError(`hash mismatch for ${path}: got ${got}, expected ${expectedHash}`);
      const json = JSON.parse(new TextDecoder().decode(bytes));
      this.cache.set(path, json);
      this.log.push({ path, url, expectedHash, ok: true });
      return json;
    } catch (err) {
      this.log.push({ path, url, expectedHash, ok: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
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
  manifestPromise ??= fetch(`${import.meta.env.BASE_URL}registry-index.json`).then((r) => {
    if (!r.ok) throw new Error(`registry manifest: HTTP ${r.status}`);
    return r.json();
  });
  return manifestPromise;
}

export function descriptorFor(manifest: RegistryManifest, chainId: number, address: string) {
  const path = manifest.calldataIndex[`eip155:${chainId}:${address.toLowerCase()}`];
  return path ? { path, ...manifest.descriptors[path]! } : null;
}
