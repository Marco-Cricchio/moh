import { basename, dirname, extname, join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { projectSlug } from "../session-store";
import { MpmStore } from "./store";
import { mapFile, MPM_MAX_FILE_SIZE } from "./extractor";
import type { MpmFileRecord, MpmProvenance } from "./types";

/** Default storage quotas (#617): files and total mapped bytes. */
export const MPM_DEFAULT_MAX_FILES = 20_000;
export const MPM_DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

/** Read one file's content+size for refresh; null when missing/unreadable. */
function readCurrent(abs: string): { content: string; size: number } | null {
  try {
    if (!existsSync(abs) || !statSync(abs).isFile()) return null;
    const size = statSync(abs).size;
    if (size > MPM_MAX_FILE_SIZE) return null;
    return { content: readFileSync(abs, "utf8"), size };
  } catch {
    return null;
  }
}

/** #617: storage budget for the projection (partial coverage is fine). */
export interface MpmQuota {
  maxFiles?: number;
  maxTotalBytes?: number;
}

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

export type MpmStatus = "ready" | "updating" | "unavailable";

/** The projection directory for one project: `<home>/projects/<slug>/project-map/`. */
export function projectMapDir(home: string, cwd: string): string {
  return join(home, "projects", projectSlug(cwd, dirname(home)), "project-map");
}

export class MpmService {
  readonly #store: MpmStore;
  #records: Map<string, MpmFileRecord> | null = null;
  /** Inverse index: symbol name → paths declaring it. */
  #bySymbol: Map<string, Set<string>> | null = null;
  /** Inverse index: relation target → paths importing/referencing it. */
  #byTarget: Map<string, Set<string>> | null = null;
  /**
   * #617: LRU clock over mapped paths — bumped on every record() touch so
   * quota eviction drops cold entries first.
   */
  #lruClock = 0;
  #lastTouched: Map<string, number> = new Map();
  /** #617: true while a background refresh has work outstanding. */
  #updating = false;

  constructor(dir: string) {
    this.#store = new MpmStore(dir);
  }

  get status(): MpmStatus {
    if (this.#records === null) return "unavailable";
    return this.#updating ? "updating" : "ready";
  }

  /** #617: honest background-work flag; set/cleared by the lifecycle. */
  setUpdating(updating: boolean): void {
    this.#updating = updating;
  }

  get fileCount(): number {
    return this.#records?.size ?? 0;
  }

  /** The mapped record for an exact path, or null (#616: freshness checks). */
  record(path: string): MpmFileRecord | null {
    if (this.#records?.has(path)) this.#lastTouched.set(path, ++this.#lruClock);
    return this.#records?.get(path) ?? null;
  }

  /**
   * #617: targeted incremental refresh — re-extract one file against the
   * full mapped set, then atomically update live state and journal. Missing
   * or oversize content removes the path (rename/delete). A no-op when the
   * content hash is unchanged. `reader` supplies content so tests and
   * callers can control freshness; the default reads from disk. Never throws.
   */
  refresh(
    root: string,
    path: string,
    reader: (abs: string) => { content: string; size: number } | null = readCurrent,
  ): void {
    if (this.#records === null) return;
    const current = reader(join(root, path));
    if (current === null || current.size > MPM_MAX_FILE_SIZE) {
      this.remove(path);
      return;
    }
    const record = mapFile(root, path, current.content, current.size, new Set(this.#records.keys()));
    const previous = this.#records.get(path);
    if (previous && previous.hash === record.hash) return; // content unchanged
    this.upsert(record);
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
   * #617: bound the projection to the quota by evicting least-recently-used
   * mapped files first (access via record()/query() protects hot entries).
   * Returns the evicted paths. A successful eviction series is persisted as
   * a whole-projection write so the manifest stays the single entry point.
   */
  enforceQuota(quota: MpmQuota = {}): string[] {
    const maxFiles = quota.maxFiles ?? MPM_DEFAULT_MAX_FILES;
    const maxTotalBytes = quota.maxTotalBytes ?? MPM_DEFAULT_MAX_TOTAL_BYTES;
    if (!this.#records) return [];
    const evicted: string[] = [];
    const totalBytes = () => {
      let sum = 0;
      for (const r of this.#records!.values()) sum += r.size;
      return sum;
    };
    while (this.#records.size > maxFiles || totalBytes() > maxTotalBytes) {
      // Pick the coldest entry: oldest lastTouched clock, ties by insertion.
      let coldest: string | null = null;
      let coldestClock = Infinity;
      for (const path of this.#records.keys()) {
        const clock = this.#lastTouched.get(path) ?? 0;
        if (clock < coldestClock) {
          coldestClock = clock;
          coldest = path;
        }
        // Already cold: no need to keep scanning for a colder entry.
        if (clock === 0) break;
      }
      if (coldest === null) break;
      this.remove(coldest);
      evicted.push(coldest);
    }
    if (evicted.length > 0) {
      // Persist: shards+manifest flip atomically, journal becomes obsolete.
      this.#store.writeProjection(this.#records);
    }
    return evicted;
  }

  /** All mapped records (scan/diff iteration; callers must not mutate). */
  *allRecords(): IterableIterator<MpmFileRecord> {
    if (!this.#records) return;
    yield* this.#records.values();
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
    this.#lastTouched = new Map();
    this.#lruClock = 0;
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
    // Incremental index update (#617): a refresh touches one file, so the
    // inverse indexes are patched in place — a full rebuild per refresh
    // would make sweeps O(N·files) and wipe the LRU protection.
    const records = (this.#records ??= new Map());
    const bySymbol = (this.#bySymbol ??= new Map());
    const byTarget = (this.#byTarget ??= new Map());
    const previous = records.get(path);
    if (previous) {
      for (const sym of previous.symbols) {
        const set = bySymbol.get(sym.name);
        if (set) {
          set.delete(path);
          if (set.size === 0) bySymbol.delete(sym.name);
        }
      }
      for (const rel of previous.relations) {
        const set = byTarget.get(rel.target);
        if (set) {
          set.delete(path);
          if (set.size === 0) byTarget.delete(rel.target);
        }
      }
    }
    if (record === null) {
      records.delete(path);
      this.#lastTouched.delete(path);
      return;
    }
    records.set(path, record);
    this.#lastTouched.set(path, ++this.#lruClock);
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
