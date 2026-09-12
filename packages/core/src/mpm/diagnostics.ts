/**
 * MPM diagnostics (#618, spec #613): the read-only, metadata-only
 * projection clients (TUI #619, CLI) render. It reports status, coverage
 * per declared capability, freshness, pending background work, budgets,
 * exclusions, eviction counts, and fallback reasons — never source
 * content, never prompt text, never code snippets. Paths are relative to
 * the workspace root (the same form the projection itself stores).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MPM_DEFAULT_MAX_FILES, MPM_DEFAULT_MAX_TOTAL_BYTES, MpmService, type MpmQuota, type MpmStatus } from "./service";
import { capabilityForPath, MPM_CAPABILITIES } from "./capabilities";
import { MpmStore } from "./store";
import type { MpmEffectiveConfig } from "./config";
import type { MpmFallbackReason } from "./types";

/** Per-language coverage: mapped files and symbols per capability name. */
export interface MpmLanguageCoverage {
  /** Capability name (e.g. "typescript", "python") or "unsupported". */
  language: string;
  files: number;
  symbols: number;
}

export interface MpmDiagnostics {
  status: MpmStatus;
  /** True when config disables MPM for this project. */
  disabled: boolean;
  /** Why MPM is off (or null). "user" beats "project" per precedence. */
  disabledReason: MpmEffectiveConfig["disabledReason"];
  /** Total mapped files across all languages. */
  fileCount: number;
  /** Total mapped symbols. */
  symbolCount: number;
  /** Coverage per language, sorted by file count then name. */
  coverage: MpmLanguageCoverage[];
  /** Declared capability families the extractors support, by name. */
  capabilities: { language: string; relations: string[] }[];
  /** Manifest build time of the live projection (epoch ms), or null. */
  builtAt: number | null;
  /** Mapped files whose on-disk content no longer matches (sampled head). */
  staleCount: number;
  /** Paths awaiting a background refresh (external + edit queues). */
  pendingWork: number;
  /** Storage budget in effect: resolved defaults when config is absent. */
  budget: Required<MpmQuota>;
  /** Exclusion patterns in effect (user ∪ project). */
  exclusions: string[];
  /** Paths evicted by the LRU quota policy this process (bounded head). */
  evictions: number;
  /** Why the last orientation lookup produced no plan, when it did. */
  fallbackReason: MpmFallbackReason;
}

/** How many mapped paths to hash-check for the stale estimate. */
const FRESHNESS_SAMPLE = 200;

export interface MpmDiagnosticsOptions {
  service: MpmService;
  root: string;
  config: MpmEffectiveConfig;
  /** Pending background work and eviction counts from the lifecycle. */
  pendingWork?: number;
  evictions?: number;
  fallbackReason?: MpmFallbackReason;
}

/**
 * Build the diagnostics projection for one project. Never throws: any
 * read failure degrades the field it fed, it never fails the client.
 */
export function mpmDiagnostics(options: MpmDiagnosticsOptions): MpmDiagnostics {
  const { service, root, config } = options;
  const budget: Required<MpmQuota> = {
    maxFiles: config.quota.maxFiles ?? MPM_DEFAULT_MAX_FILES,
    maxTotalBytes: config.quota.maxTotalBytes ?? MPM_DEFAULT_MAX_TOTAL_BYTES,
  };
  if (!config.enabled) {
    return {
      status: "unavailable",
      disabled: true,
      disabledReason: config.disabledReason,
      fileCount: 0,
      symbolCount: 0,
      coverage: [],
      capabilities: declaredCapabilities(),
      builtAt: null,
      staleCount: 0,
      pendingWork: 0,
      budget,
      exclusions: config.exclude,
      evictions: options.evictions ?? 0,
      fallbackReason: "disabled",
    };
  }

  const byLanguage = new Map<string, MpmLanguageCoverage>();
  let symbolCount = 0;
  const stalePaths: string[] = [];
  let sampled = 0;
  for (const record of service.allRecords()) {
    let entry = byLanguage.get(record.language);
    if (!entry) byLanguage.set(record.language, (entry = { language: record.language, files: 0, symbols: 0 }));
    entry.files += 1;
    symbolCount += record.symbols.length;
    // Freshness sampling: hash-check a bounded head so diagnostics cost
    // stays O(sample), never O(workspace).
    if (sampled < FRESHNESS_SAMPLE) {
      sampled += 1;
      if (currentHash(join(root, record.path)) !== record.hash) stalePaths.push(record.path);
    }
  }

  let builtAt: number | null = null;
  try {
    const manifest = new MpmStore(service.dir).readManifest();
    builtAt = manifest?.builtAt ?? null;
  } catch {
    builtAt = null;
  }

  return {
    status: service.status,
    disabled: false,
    disabledReason: null,
    fileCount: service.fileCount,
    symbolCount,
    coverage: [...byLanguage.values()].sort((a, b) => b.files - a.files || a.language.localeCompare(b.language)),
    capabilities: declaredCapabilities(),
    builtAt,
    staleCount: stalePaths.length,
    pendingWork: options.pendingWork ?? 0,
    budget,
    exclusions: config.exclude,
    evictions: options.evictions ?? 0,
    fallbackReason: options.fallbackReason ?? null,
  };
}

/** Declared capability list, deterministic by language name. */
function declaredCapabilities(): { language: string; relations: string[] }[] {
  return [...MPM_CAPABILITIES]
    .map((cap) => ({ language: cap.name, relations: [...cap.families].sort() }))
    .sort((a, b) => a.language.localeCompare(b.language));
}

/** Hash one file like the extractor does; null when missing/unreadable. */
function currentHash(absPath: string): string | null {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}
