/**
 * Moh Project Map (MPM) — Core foundation types (#614, spec #613).
 *
 * MPM is a disposable, rebuildable structural projection of one project
 * workspace. It is derived data only: never MemoryStore content, never
 * session event-log content, never handoff payload. It stores metadata
 * (paths, hashes, symbols, relations) — never source-file content.
 */

/** Storage format version. Incompatible data is discarded, not migrated (V1). */
export const MPM_FORMAT_VERSION = 1;

/** One mapped source or configuration file: metadata only, no content. */
export interface MpmFileRecord {
  /** Workspace-root-relative, POSIX-separated path. */
  path: string;
  /** SHA-256 of the file content at mapping time. */
  hash: string;
  /** Byte size at mapping time. */
  size: number;
  /** Declared capability level of the extractor that mapped it. */
  language: string;
  /** Symbols declared by this file (names only, with locations). */
  symbols: MpmSymbol[];
  /** Provable outgoing relations from this file. */
  relations: MpmRelation[];
}

export interface MpmSymbol {
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const" | "other";
  /** 1-based line of the declaration. */
  line: number;
}

export interface MpmRelation {
  kind: "imports" | "references" | "config-links";
  /** Workspace-root-relative target path, when resolved to a file. */
  target: string;
  /** The raw specifier the relation was proven from (e.g. import path). */
  via: string;
  /** 1-based line the relation was proven at. */
  line: number;
}

/** The manifest is the single entry point into the on-disk projection. */
export interface MpmManifest {
  formatVersion: number;
  /** Written when the projection was (re)built; epoch millis. */
  builtAt: number;
  /** Root-relative path → shard file name under the projection dir. */
  shards: Record<string, string>;
  /** Number of mapped files; kept for cheap diagnostics. */
  fileCount: number;
}

/** Append-only crash journal entry, replayed on top of a rebuilt manifest. */
export interface MpmJournalEntry {
  op: "upsert" | "remove";
  path: string;
  record?: MpmFileRecord;
  at: number;
}

/** Provenance carried by every query result so callers can verify claims. */
export interface MpmProvenance {
  /** Path the fact was extracted from (workspace-root-relative). */
  source: string;
  /** 1-based line, when the extractor recorded one. */
  line?: number;
  /** Which extractor proved the relation. */
  extractor: string;
}

/** Why a task got no orientation plan — the last computed fallback reason. */
export type MpmFallbackReason = "disabled" | "unavailable" | "stale" | "no-eligible-seed" | null;
