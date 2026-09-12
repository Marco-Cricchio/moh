import { basename, extname } from "node:path";
import { MpmStore } from "./store";
import type { MpmFileRecord, MpmProvenance } from "./types";

/**
 * The single headless MPM service for one project (#614). Headless and
 * Core-owned: it loads (or rebuilds) the disposable projection and answers
 * small read-only structural queries with provenance. It never touches
 * sessions, MemoryStore, the event log, or handoff, and never stores or
 * returns source-file content.
 */
export interface MpmQueryResult {
  /** Ranked candidate paths matching the query seed. */
  paths: string[];
  /** Provenance per returned path: where the claim came from. */
  provenance: MpmProvenance[];
}

export type MpmStatus = "ready" | "unavailable";

export class MpmService {
  readonly #store: MpmStore;
  #records: Map<string, MpmFileRecord> | null = null;
  /** Inverse index: symbol name → paths declaring it. */
  #bySymbol: Map<string, Set<string>> | null = null;
  /** Inverse index: relation target → paths importing/referencing it. */
  #byTarget: Map<string, Set<string>> | null = null;

  constructor(dir: string) {
    this.#store = new MpmStore(dir);
  }

  get status(): MpmStatus {
    return this.#records !== null ? "ready" : "unavailable";
  }

  get fileCount(): number {
    return this.#records?.size ?? 0;
  }

  /** The mapped record for an exact path, or null (#616: freshness checks). */
  record(path: string): MpmFileRecord | null {
    return this.#records?.get(path) ?? null;
  }

  /**
   * Load the projection, failing safe: missing data rebuilds to an empty
   * projection; corrupt, unreadable, or incompatible data is discarded and
   * rebuilt. Never throws.
   */
  load(): void {
    const manifest = this.#store.readManifest();
    if (manifest === null) {
      // Missing or incompatible: start from a clean, empty projection.
      this.#store.discard();
      this.#finishLoad(new Map(), this.#store.drainJournal());
      return;
    }
    const records = new Map<string, MpmFileRecord>();
    let corrupt = false;
    for (const path of Object.keys(manifest.shards)) {
      const record = this.#store.readRecord(manifest, path);
      if (record === null) {
        corrupt = true;
        break;
      }
      records.set(path, record);
    }
    if (corrupt) {
      this.#store.discard();
      this.#finishLoad(new Map(), this.#store.drainJournal());
      return;
    }
    this.#finishLoad(records, this.#store.drainJournal());
  }

  /**
   * Replace the whole projection (a rebuild). The rebuild is authoritative:
   * the journal is truncated with the write, and the in-memory view is
   * rebuilt from the given records.
   */
  rebuild(records: Map<string, MpmFileRecord>): void {
    this.#store.writeProjection(records);
    this.#finishLoad(records, []);
  }

  /** Record a targeted change in the crash journal (and live state). */
  upsert(record: MpmFileRecord): void {
    this.#store.appendJournal({ op: "upsert", path: record.path, record, at: Date.now() });
    if (this.#records) this.#apply(record.path, record);
  }

  remove(path: string): void {
    this.#store.appendJournal({ op: "remove", path, at: Date.now() });
    if (this.#records) this.#apply(path, null);
  }

  /**
   * Read-only structural query: given a seed path, return related paths
   * (things it imports or is imported/referenced by) plus symbol matches,
   * ranked deterministically, each with provenance.
   */
  query(seedPath: string): MpmQueryResult | null {
    if (!this.#records) return null;
    const seed = this.#records.get(seedPath);
    const scores = new Map<string, { score: number; prov: MpmProvenance }>();
    const add = (path: string, score: number, prov: MpmProvenance) => {
      const prev = scores.get(path);
      if (!prev || prev.score < score) scores.set(path, { score, prov });
    };

    if (seed) {
      // Outgoing relations: seed → target (strongest, exact coordinate).
      for (const rel of seed.relations) {
        if (this.#records.has(rel.target)) {
          add(rel.target, 100, { source: seedPath, line: rel.line, extractor: extractorName(seed) });
        }
      }
    }
    // Incoming relations: who points at the seed.
    const incoming = this.#byTarget?.get(seedPath);
    if (incoming) {
      for (const src of incoming) {
        const rec = this.#records.get(src);
        if (!rec) continue;
        const rel = rec.relations.find((r) => r.target === seedPath);
        add(src, 80, { source: src, line: rel?.line, extractor: extractorName(rec) });
      }
    }
    // Symbol-name matches derived from the seed's own file name.
    const stem = symbolStem(seedPath);
    if (stem) {
      for (const path of this.#bySymbol?.get(stem) ?? []) {
        if (path !== seedPath) {
          const rec = this.#records.get(path)!;
          add(path, 50, { source: path, extractor: extractorName(rec) });
        }
      }
    }

    const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    return {
      paths: ranked.map(([p]) => p),
      provenance: ranked.map(([, v]) => v.prov),
    };
  }

  #finishLoad(records: Map<string, MpmFileRecord>, journal: ReturnType<MpmStore["drainJournal"]>): void {
    // Replay the journal newest-last so later ops win.
    for (const entry of journal) {
      if (entry.op === "upsert" && entry.record) records.set(entry.path, entry.record);
      else if (entry.op === "remove") records.delete(entry.path);
    }
    this.#records = records;
    const bySymbol = new Map<string, Set<string>>();
    const byTarget = new Map<string, Set<string>>();
    for (const [path, record] of records) {
      for (const sym of record.symbols) {
        let set = bySymbol.get(sym.name);
        if (!set) bySymbol.set(sym.name, (set = new Set()));
        set.add(path);
      }
      for (const rel of record.relations) {
        let set = byTarget.get(rel.target);
        if (!set) byTarget.set(rel.target, (set = new Set()));
        set.add(path);
      }
    }
    this.#bySymbol = bySymbol;
    this.#byTarget = byTarget;
  }

  #apply(path: string, record: MpmFileRecord | null): void {
    // Live-state mirror of a journal op; a full reload rebuilds indexes.
    this.#records = this.#records ?? new Map();
    this.#finishLoad(this.#records, [{ op: record ? "upsert" : "remove", path, record: record ?? undefined, at: Date.now() }]);
  }
}

function extractorName(record: MpmFileRecord): string {
  return `mpm/${record.language}`;
}

/** `src/utils/date-fmt.ts` → `date-fmt`, `index.ts` → null. */
function symbolStem(path: string): string | null {
  const base = basename(path, extname(path));
  if (!base || base === "index" || base === "mod") return null;
  return base.toLowerCase();
}
