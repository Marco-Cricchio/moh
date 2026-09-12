import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { discoverWorkspace, MPM_MAX_FILE_SIZE } from "./discover";
import type { MpmQuota, MpmService } from "./service";

/**
 * MPM background lifecycle (#617): session-lifetime low-priority change
 * observation and incremental refresh. Watches the workspace cheaply
 * (debounced polling sweeps — no fs.watch handle storm), reacts to external
 * edits, accepts targeted refreshes enqueued by successful moh edits, and
 * yields to foreground work: an active turn pauses map work at every unit
 * boundary, so an ordinary turn never waits for MPM. All budgets are
 * adaptive and conservative — partial useful coverage always beats
 * unbounded work. Never throws; every failure degrades to less coverage.
 */

export interface MpmLifecycleOptions {
  service: MpmService;
  /** Workspace root the projection maps. */
  root: string;
  /** True while an agent turn is active — map work yields immediately. */
  isBusy?: () => boolean;
  /** Storage quota for the projection (files / bytes). */
  quota?: MpmQuota;
  /** #618: user/project exclusion patterns for discovery sweeps. */
  exclude?: string[];
  /** Debounce window for external edits (ms). */
  debounceMs?: number;
  /** Max files re-extracted per sweep before the sweep reschedules. */
  maxFilesPerSweep?: number;
  /** Max wall-clock milliseconds per sweep slice. */
  maxSweepMs?: number;
  /** Max re-extractions per sweep when the process is busy. */
  maxFilesWhenBusy?: number;
  /** Poll interval override (tests). */
  pollMs?: number;
  /** Timer controls (tests: inject fake timers / sync pumps). */
  timers?: {
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    now(): number;
  };
}

const DEFAULTS = {
  debounceMs: 1_500,
  maxFilesPerSweep: 200,
  maxSweepMs: 25,
  maxFilesWhenBusy: 0,
  pollMs: 10_000,
};

interface PendingEdit {
  path: string;
  at: number;
}

/**
 * Drives MPM freshness for one session. Owned by the session; started on
 * construction and disposed with the session. Status flows through the
 * service (`updating` while sweeps have outstanding work).
 */
export class MpmLifecycle {
  readonly #service: MpmService;
  readonly #root: string;
  readonly #isBusy: () => boolean;
  readonly #quota: MpmQuota;
  readonly #exclude: string[];
  readonly #opts: typeof DEFAULTS & { maxFilesWhenBusy: number };
  readonly #timers: NonNullable<MpmLifecycleOptions["timers"]>;
  #timer: unknown = null;
  #disposed = false;
  /** External paths seen changed, awaiting debounce. */
  #dirty = new Map<string, number>();
  /** Successful moh edits (highest priority — fresh work just happened). */
  #editQueue: PendingEdit[] = [];
  /** mtime snapshot from the last periodic scan (first-sight adopt). */
  #mtimeCache = new Map<string, number>();
  /** In-progress incremental sweep: remaining candidates and cursor. */
  #sweepCursor: { files: string[]; index: number } | null = null;

  constructor(options: MpmLifecycleOptions) {
    this.#service = options.service;
    this.#root = options.root;
    this.#isBusy = options.isBusy ?? (() => false);
    this.#quota = options.quota ?? {};
    this.#exclude = options.exclude ?? [];
    this.#opts = {
      debounceMs: options.debounceMs ?? DEFAULTS.debounceMs,
      maxFilesPerSweep: options.maxFilesPerSweep ?? DEFAULTS.maxFilesPerSweep,
      maxSweepMs: options.maxSweepMs ?? DEFAULTS.maxSweepMs,
      maxFilesWhenBusy: options.maxFilesWhenBusy ?? DEFAULTS.maxFilesWhenBusy,
      pollMs: options.pollMs ?? DEFAULTS.pollMs,
    };
    this.#timers = options.timers ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      now: () => Date.now(),
    };
    this.#timer = this.#timers.setInterval(() => this.#tick(), this.#opts.pollMs);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) {
      this.#timers.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * A successful moh edit of `path`: enqueue a targeted refresh with the
   * highest priority — the content the model just produced is the most
   * valuable thing to remap.
   */
  noteEdit(path: string): void {
    if (this.#disposed) return;
    this.#editQueue = this.#editQueue.filter((e) => e.path !== path);
    this.#editQueue.push({ path, at: this.#timers.now() });
  }

  /** External change notification (e.g. from a shared watcher). */
  noteExternalChange(path: string): void {
    if (this.#disposed) return;
    this.#dirty.set(path, this.#timers.now());
  }

  /** Paths currently awaiting debounced refresh (diagnostics/tests). */
  get pendingCount(): number {
    return this.#dirty.size + this.#editQueue.length;
  }

  /** Pump the debounce window and run at most one sweep slice. */
  #tick(): void {
    if (this.#disposed) return;
    const now = this.#timers.now();
    // Fire edits immediately; debounce externals.
    const ready: string[] = this.#editQueue.map((e) => e.path);
    this.#editQueue = [];
    for (const [path, at] of this.#dirty) {
      if (now - at >= this.#opts.debounceMs) {
        ready.push(path);
        this.#dirty.delete(path);
      }
    }
    if (ready.length > 0) {
      this.#service.setUpdating(true);
      this.#runSlice(ready);
    } else if (this.#sweepCursor !== null) {
      this.#service.setUpdating(true);
      this.#continueSweep();
    } else {
      // Periodic freshness scan: cheap hash+stat diff of the workspace
      // against the projection, then an incremental sweep of the diffs.
      this.#scanAndDiff();
    }
  }

  /**
   * One bounded slice of refresh work. Priority order: explicit edits and
   * debounced externals first, then a partial discovery sweep. Yields at
   * every unit boundary when a turn is active.
   */
  #runSlice(paths: string[]): void {
    const budget = this.#isBusy() ? this.#opts.maxFilesWhenBusy : this.#opts.maxFilesPerSweep;
    const deadline = this.#timers.now() + this.#opts.maxSweepMs;
    for (let i = 0; i < paths.length; i++) {
      if (i >= budget || this.#timers.now() >= deadline) {
        // Defer the remainder as external work (immediate retry next tick).
        for (const p of paths.slice(i)) this.#dirty.set(p, 0);
        return;
      }
      this.#refreshOne(paths[i]!);
    }
    this.#afterWork();
  }

  #continueSweep(): void {
    const cursor = this.#sweepCursor;
    if (!cursor) return;
    const budget = this.#isBusy() ? this.#opts.maxFilesWhenBusy : this.#opts.maxFilesPerSweep;
    const deadline = this.#timers.now() + this.#opts.maxSweepMs;
    let done = 0;
    while (cursor.index < cursor.files.length) {
      if (done >= budget || this.#timers.now() >= deadline) return; // resume next tick
      const path = cursor.files[cursor.index++];
      // Only remap candidates the projection knows or discovery adds fresh.
      this.#refreshOne(path);
      done++;
    }
    this.#sweepCursor = null;
    this.#afterWork();
  }

  /** Refresh one path against the projection; remove on delete/rename. */
  #refreshOne(path: string): void {
    try {
      this.#service.refresh(this.#root, path);
    } catch {
      // Never fatal: the freshness checks at query time still guard plans.
    }
  }

  /**
   * Cheap periodic diff: discover the candidate set (metadata only) and
   * compare on-disk mtime/size against a per-session snapshot taken at the
   * previous scan. Only drifted paths get a hash check and a refresh, so
   * idle cost is one directory walk + stat calls — never a full re-extract.
   */
  #scanAndDiff(): void {
    let files: string[];
    try {
      files = discoverWorkspace(this.#root, this.#exclude);
    } catch {
      return;
    }
    const changed: string[] = [];
    const nextMtimes = new Map<string, number>();
    for (const path of files) {
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = statSync(join(this.#root, path));
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue; // vanished between discovery and stat
      }
      if (size > MPM_MAX_FILE_SIZE) continue;
      nextMtimes.set(path, mtimeMs);
      const prevMtime = this.#mtimeCache.get(path);
      const known = this.#service.record(path) !== null;
      if (!known) {
        // New file: map it when the projection already has useful coverage.
        if (this.#service.fileCount > 0) changed.push(path);
      } else if (prevMtime === undefined) {
        // First sight this session: adopt without a hash pass.
        this.#mtimeCache.set(path, mtimeMs);
      } else if (prevMtime !== mtimeMs) {
        // mtime drifted: a hash check decides (avoids spurious rewrites).
        if (this.#hashMatches(path)) this.#mtimeCache.set(path, mtimeMs);
        else changed.push(path);
      }
    }
    // Missing mapped paths (deletes/renames discovered from the other side).
    const present = new Set(files);
    for (const record of this.#service.allRecords()) {
      if (!present.has(record.path)) changed.push(record.path);
    }
    this.#mtimeCache = nextMtimes;
    if (changed.length > 0) {
      this.#service.setUpdating(true);
      this.#sweepCursor = { files: changed, index: 0 };
      this.#continueSweep();
    } else {
      this.#service.setUpdating(false);
    }
    // Storage bound: evict LRU entries after any growth.
    this.#service.enforceQuota(this.#quota);
  }

  /** Targeted hash check (reads one file) used only on mtime drift. */
  #hashMatches(path: string): boolean {
    const record = this.#service.record(path);
    if (!record) return false;
    try {
      const content = readFileSync(join(this.#root, path), "utf8");
      // Same composition as the extractor: sha256 over the file content.
      return createHash("sha256").update(content).digest("hex") === record.hash;
    } catch {
      return false;
    }
  }

  #afterWork(): void {
    this.#service.enforceQuota(this.#quota);
    if (this.#sweepCursor === null && this.#dirty.size === 0 && this.#editQueue.length === 0) {
      this.#service.setUpdating(false);
    }
  }
}
