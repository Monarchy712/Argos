import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { ContractCursor } from "./types.ts";

/** Everything the watcher must remember across restarts. */
export interface CursorFile {
  version: 1;
  /** chainId → last block whose events were fully scanned. */
  chains: Record<string, string>;
  /** contractId → per-contract memory. */
  contracts: Record<string, ContractCursor>;
  /**
   * contractId → events already scanned but not yet applied, because that contract's slot read
   * failed. Replayed on its next successful read so a failed read never loses an event.
   * (bigint fields stored as decimal strings.)
   */
  pending?: Record<string, { field: string; newValue: string | null; block: string; logIndex: number; txHash: string }[]>;
}

export function emptyCursor(): CursorFile {
  return { version: 1, chains: {}, contracts: {} };
}

export function loadCursor(path: string): CursorFile {
  if (!existsSync(path)) return emptyCursor();
  const parsed = JSON.parse(readFileSync(path, "utf8")) as CursorFile;
  if (parsed.version !== 1) throw new Error(`unsupported cursor version in ${path}`);
  return parsed;
}

/** Atomic save: write a temp file, then rename over the old one, so a crash never leaves half a file. */
export function saveCursor(path: string, cursor: CursorFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(cursor, null, 2));
  renameSync(tmp, path);
}
