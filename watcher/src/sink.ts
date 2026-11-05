import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Baseline, ChangeRecord, CurrentState } from "./types.ts";
import { contractId } from "./types.ts";

/**
 * Where baselines come from and where state goes. The Arkiv sink is the real one; the file
 * sink lets the watcher run (and Test 3 rehearse) with no network writes.
 */
export interface Sink {
  readonly name: string;
  /** All baselines signed by the trusted writer. The watcher monitors exactly these. */
  loadBaselines(): Promise<Baseline[]>;
  /** Writes a new baseline and retires the previous one. Returns the new key. */
  writeBaseline(b: Omit<Baseline, "key">): Promise<string>;
  /**
   * Upserts this cycle's current_state rows and replaces latest_change rows for contracts with a
   * newer change. A contract's two rows are written atomically (same transaction).
   */
  writeCycle(states: CurrentState[], changes: ChangeRecord[]): Promise<void>;
}

// JSON can't hold bigint; store as decimal strings.
const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

interface FileState {
  baselines: Record<string, Baseline>;
  currentStates: Record<string, CurrentState>;
  latestChanges: Record<string, ChangeRecord>;
  /** Append-only history so tests can see every write. */
  log: { at: number; kind: string; id: string }[];
}

export class FileSink implements Sink {
  readonly name = "file";
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  private read(): FileState {
    if (!existsSync(this.path)) return { baselines: {}, currentStates: {}, latestChanges: {}, log: [] };
    return JSON.parse(readFileSync(this.path, "utf8"), (k, v) =>
      ["block", "changeBlock", "checkedBlock", "lastScannedBlock"].includes(k) && typeof v === "string" ? BigInt(v) : v,
    );
  }

  private write(s: FileState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(s, replacer, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }

  async loadBaselines(): Promise<Baseline[]> {
    return Object.values(this.read().baselines);
  }

  async writeBaseline(b: Omit<Baseline, "key">): Promise<string> {
    const s = this.read();
    const id = contractId(b.chainId, b.address);
    const key = `file-baseline-${id}-${b.block}-${Date.now()}`;
    s.baselines[id] = { ...b, key, previousKey: s.baselines[id]?.key ?? "" };
    s.log.push({ at: Date.now(), kind: "baseline", id });
    this.write(s);
    return key;
  }

  async writeCycle(states: CurrentState[], changes: ChangeRecord[]): Promise<void> {
    const s = this.read();
    for (const r of changes) {
      const id = contractId(r.chainId, r.address);
      s.latestChanges[id] = r;
      s.log.push({ at: Date.now(), kind: "latest_change", id });
    }
    for (const r of states) {
      const id = contractId(r.chainId, r.address);
      s.currentStates[id] = r;
      s.log.push({ at: Date.now(), kind: "current_state", id });
    }
    this.write(s);
  }


}
