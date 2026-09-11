import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  MPM_FORMAT_VERSION,
  type MpmFileRecord,
  type MpmJournalEntry,
  type MpmManifest,
} from "./types";

/**
 * On-disk MPM projection (spec #613, decisions confirmed for #614): sharded
 * JSON under `<home>/.moh/projects/<slug>/project-map/` with a manifest as
 * the single entry point and a small append-only crash journal. The inverse
 * index is derived in memory, never a second on-disk source of truth.
 * Everything here is disposable: any read failure isolates the data for a
 * rebuild without touching sessions, MemoryStore, or handoff.
 */
export class MpmStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Read the manifest, or null when absent/corrupt/incompatible. */
  readManifest(): MpmManifest | null {
    let raw: string;
    try {
      raw = readFileSync(this.manifestPath(), "utf8");
    } catch {
      return null;
    }
    try {
      const m = JSON.parse(raw) as MpmManifest;
      if (m.formatVersion !== MPM_FORMAT_VERSION) return null;
      if (typeof m.builtAt !== "number" || typeof m.shards !== "object" || m.shards === null) return null;
      return m;
    } catch {
      return null;
    }
  }

  /** Read one file record from its shard; null on any failure. */
  readRecord(manifest: MpmManifest, path: string): MpmFileRecord | null {
    const shard = manifest.shards[path];
    if (!shard) return null;
    try {
      const value: unknown = JSON.parse(readFileSync(join(this.dir, shard), "utf8"));
      if (!isMpmFileRecord(value) || value.path !== path) return null;
      return value;
    } catch {
      return null;
    }
  }

  /**
   * Atomically replace the whole projection with the given records: shards
   * are written first, then the manifest flips over them, so a crash leaves
   * either the old or the new complete projection. A successful rebuild
   * truncates the journal — it is obsolete.
   */
  writeProjection(records: Map<string, MpmFileRecord>): void {
    mkdirSync(this.dir, { recursive: true });
    const shards: Record<string, string> = {};
    for (const [path, record] of records) {
      const shard = shardName(path);
      writeFileSync(join(this.dir, shard), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      shards[path] = shard;
    }
    const manifest: MpmManifest = {
      formatVersion: MPM_FORMAT_VERSION,
      builtAt: Date.now(),
      shards,
      fileCount: records.size,
    };
    const tmp = `${this.manifestPath()}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    // rename over the manifest: readers see old or new, never partial.
    renameSync(tmp, this.manifestPath());
    this.truncateJournal();
  }

  /** Append one entry to the crash journal; failures are swallowed by design. */
  appendJournal(entry: MpmJournalEntry): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.journalPath(), `${JSON.stringify(entry)}\n`);
    } catch {
      // The journal is an optimization over the rebuild path, never a
      // dependency: losing entries only costs re-extraction later.
    }
  }

  /** Read and clear the journal, returning replayable entries. */
  drainJournal(): MpmJournalEntry[] {
    const file = this.journalPath();
    if (!existsSync(file)) return [];
    const entries: MpmJournalEntry[] = [];
    try {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as MpmJournalEntry;
          if ((e.op === "upsert" || e.op === "remove") && typeof e.path === "string") entries.push(e);
        } catch {
          // A torn tail line after a crash: stop at the first bad entry.
          break;
        }
      }
    } catch {
      return [];
    }
    this.truncateJournal();
    return entries;
  }

  truncateJournal(): void {
    try {
      writeFileSync(this.journalPath(), "");
    } catch {
      // Ignore: the rebuild path does not need the journal.
    }
  }

  /**
   * Fail-safe discard: rename the projection aside (best-effort) so a
   * rebuild starts clean. Never touches sessions, memory, or handoff.
   */
  discard(): void {
    try {
      renameSync(this.dir, `${this.dir}.corrupt-${Date.now()}`);
    } catch {
      // Nothing to discard, or the rename failed: either way the rebuild
      // overwrites shard-by-shard and the manifest flip is atomic.
    }
  }

  manifestPath(): string {
    return join(this.dir, "manifest.json");
  }

  journalPath(): string {
    return join(this.dir, "journal.jsonl");
  }
}

/** Deterministic shard file name for a path. */
function shardName(path: string): string {
  return `shard-${createHash("sha256").update(path).digest("hex").slice(0, 16)}.json`;
}

/** Structural guard for untrusted shard JSON: every consumed field is checked. */
function isMpmFileRecord(value: unknown): value is MpmFileRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.path !== "string" || typeof r.hash !== "string") return false;
  if (typeof r.size !== "number" || typeof r.language !== "string") return false;
  if (!Array.isArray(r.symbols) || !Array.isArray(r.relations)) return false;
  for (const s of r.symbols) {
    if (typeof s !== "object" || s === null) return false;
    const sym = s as Record<string, unknown>;
    if (typeof sym.name !== "string" || typeof sym.kind !== "string" || typeof sym.line !== "number") return false;
  }
  for (const rel of r.relations) {
    if (typeof rel !== "object" || rel === null) return false;
    const relRec = rel as Record<string, unknown>;
    if (typeof relRec.kind !== "string" || typeof relRec.target !== "string" || typeof relRec.via !== "string" || typeof relRec.line !== "number") return false;
  }
  return true;
}
