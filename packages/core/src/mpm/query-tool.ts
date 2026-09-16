import { z } from "zod";
import { join } from "node:path";
import type { Tool } from "../types";
import type { MpmService } from "./service";
import type { MpmProvenance } from "./types";
import { currentHash, type MpmOrientation } from "./orientation";

/**
 * #663 (ADR-0028): the `mpm_query` read-only tool — model-nominated
 * orientation. The model nominates one seed (an exact mapped path, a
 * unique path suffix, or a symbol name); the core resolves and validates
 * it deterministically and returns the same trusted format as the #616
 * automatic plan: path, coordinate, relation, reason, all fresh. A
 * hallucinated candidate is discarded with an honest note, never
 * invented. The full result is persisted in the event log (replay
 * fidelity); the MpmService never leaves the owning session.
 */

const MAX_ENTRIES = 8;
const BUDGET_CHARS = 1500;
const MAX_SEED_LEN = 200;

const schema = z.object({
  seed: z
    .string()
    .min(1)
    .max(MAX_SEED_LEN)
    .describe("A mapped file path, a unique path suffix (e.g. 'date.ts'), or a code symbol name (e.g. 'formatDate')."),
});

interface ResultEntry {
  path: string;
  coordinate?: string;
  reason: string;
}

export interface MpmQueryToolOptions {
  service: MpmService;
  root: string;
  /** #663 diagnostics: the orientation records that a model query succeeded. */
  orientation?: MpmOrientation;
  maxEntries?: number;
  budgetChars?: number;
}

/** Resolve one raw seed to a mapped path (or null) plus how it matched. */
function resolveSeed(
  raw: string,
  service: MpmService,
): { path: string; how: "path" | "suffix" | "symbol"; candidates: string[] } | { path: null; how: "unmapped" | "ambiguous"; candidates: string[] } {
  const stripped = normalizeSeed(raw);
  if (stripped.length === 0) return { path: null, how: "unmapped", candidates: [] };
  // Exact path first.
  if (service.record(stripped) !== null) return { path: stripped, how: "path", candidates: [stripped] };
  // Unique path-suffix match at a path-segment boundary (`/seed` or the whole
  // base name ending the path) — a mid-name substring is not a suffix.
  const candidates: string[] = [];
  for (const path of service.allPaths()) {
    if (path === stripped) continue; // already tried as exact
    if (path.endsWith(`/${stripped}`)) candidates.push(path);
  }
  if (candidates.length === 1) return { path: candidates[0]!, how: "suffix", candidates };
  if (candidates.length > 1) return { path: null, how: "ambiguous", candidates };
  // Symbol name.
  const symbols = service.pathsForSymbol(stripped);
  if (symbols.length === 1) return { path: symbols[0]!, how: "symbol", candidates };
  if (symbols.length > 1) return { path: null, how: "ambiguous", candidates: symbols };
  // #737: folded pass — case-insensitive and separator-insensitive
  // (kebab/snake/camel collapse), so "MPM-Query" resolves like
  // "mpmQuery" and "mpm-query-tool" finds the camelCase symbol.
  const foldedSeed = foldIdentity(stripped);
  if (foldedSeed.length >= 3) {
    const bySymbol = new Set<string>();
    for (const record of service.allRecords()) {
      for (const sym of record.symbols) {
        if (foldIdentity(sym.name) === foldedSeed) bySymbol.add(record.path);
      }
    }
    if (bySymbol.size === 1) return { path: [...bySymbol][0]!, how: "symbol", candidates: [...bySymbol] };
    if (bySymbol.size > 1) return { path: null, how: "ambiguous", candidates: [...bySymbol] };
    const byPath: string[] = [];
    for (const path of service.allPaths()) {
      const base = path.slice(path.lastIndexOf("/") + 1);
      if (foldIdentity(path) === foldedSeed || foldIdentity(base) === foldedSeed) byPath.push(path);
    }
    if (byPath.length === 1) return { path: byPath[0]!, how: "path", candidates: byPath };
    if (byPath.length > 1) return { path: null, how: "ambiguous", candidates: byPath };
  }
  return { path: null, how: "unmapped", candidates: [] };
}

/** Shared seed normalization (resolveSeed and suggestions must agree). */
function normalizeSeed(raw: string): string {
  return raw.trim().replace(/^[./@]+/, "").replace(/[.,;:)]+$/, "");
}

/**
 * #737: identity folding for seed matching — case and `-`/`_`/`.` are not
 * significant, so model vocabulary ("mpm_query", "MPM-Query") meets the
 * extractor's camelCase symbols and path names on equal footing.
 */
function foldIdentity(s: string): string {
  return s.toLowerCase().replace(/[-_.]/g, "");
}

/**
 * #669: fuzzy suggestions for a no-result seed, harvested from the
 * in-memory indexes only (paths from the record map, symbol names from
 * the records themselves) — no new data structures, metadata only.
 * Only candidate forms the resolver would accept on re-query are
 * suggested (full paths, base names, exact symbol names). Returns at
 * most `limit` near-misses; empty means no usable hint.
 */
export function suggestSeeds(seed: string, service: MpmService, limit = 3): string[] {
  const stripped = normalizeSeed(seed);
  if (stripped.length < 4) return [];
  const maxDist = stripped.length >= 8 ? 3 : 2;
  const scored = new Map<string, number>();
  const consider = (candidate: string) => {
    if (scored.has(candidate)) return;
    const dist = editDistance(stripped, candidate, maxDist);
    if (dist <= maxDist && dist > 0) scored.set(candidate, dist);
  };
  for (const path of service.allPaths()) {
    consider(path);
    const base = path.slice(path.lastIndexOf("/") + 1);
    if (base !== path) consider(base);
  }
  for (const record of service.allRecords()) {
    for (const sym of record.symbols) consider(sym.name);
  }
  let best = [...scored.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  // #737: fuzzy matching cannot bridge case/kebab→camel gaps. When it
  // finds nothing, fall back to folded identity: map the seed's folded
  // form onto symbols and base names that normalize identically.
  if (best.length === 0) {
    const folded = foldIdentity(stripped);
    if (folded.length >= 4) {
      const fallback: string[] = [];
      for (const record of service.allRecords()) {
        for (const sym of record.symbols) {
          if (foldIdentity(sym.name) === folded) fallback.push(sym.name);
        }
      }
      for (const path of service.allPaths()) {
        const base = path.slice(path.lastIndexOf("/") + 1);
        if (foldIdentity(base) === folded || foldIdentity(path) === folded) fallback.push(base);
      }
      return [...new Set(fallback)].sort().slice(0, limit);
    }
    return [];
  }
  return best.slice(0, limit).map(([candidate]) => candidate);
}

/** Bounded Levenshtein distance with an early exit above `max`. */
function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

export function mpmQueryTool(options: MpmQueryToolOptions): Tool<{ seed: string }> {
  const { service, root } = options;
  const maxEntries = options.maxEntries ?? MAX_ENTRIES;
  const budgetChars = options.budgetChars ?? BUDGET_CHARS;

  const fresh = (path: string): boolean => {
    const record = service.record(path);
    if (!record) return false;
    return currentHash(join(root, path)) === record.hash;
  };

  return {
    name: "mpm_query",
    description:
      "Query the project's structural map (Moh Project Map). Given one seed — a mapped file path, a unique path suffix, or a code symbol name — returns the related files (what it imports, what imports it, same-symbol files) with provenance: path, line, and why each entry is returned. " +
      "Use it when the task is described in general terms and you need to locate the right files, instead of searching with grep/glob. " +
      "Read-only; every returned entry is verified fresh against the current file content. Unmapped or ambiguous candidates are reported, never guessed. " +
      "On session resume the map may have changed — call it again rather than trusting earlier results.",
    inputSchema: schema,
    async execute(args) {
      // #737: `updating` no longer rejects — the in-memory projection is a
      // consistent snapshot mid-sweep (atomic flips + incremental journal
      // replay), so queries are served during background refreshes. Only a
      // truly unavailable (unloaded/empty) map degrades.
      if (service.status === "unavailable" || service.fileCount === 0) {
        return "project map unavailable — no data. Explore with your usual tools.";
      }
      const resolved = resolveSeed(args.seed, service);
      const lines: string[] = [];
      if (resolved.path === null) {
        if (resolved.how === "ambiguous") {
          lines.push(`Seed "${args.seed}" is ambiguous — ${resolved.candidates.length} mapped paths end with it. Did you mean one of:`, ...resolved.candidates.map((c) => `- ${c}`), "", "Re-query with the full path.");
        } else {
          const suggestions = suggestSeeds(args.seed, service);
          if (suggestions.length > 0) {
            lines.push(`Seed "${args.seed}" is not mapped in the project map. No results — suggestions (near-misses from the map):`, ...suggestions.map((s) => `- ${s}`), "", "Re-query with one of these, or explore with your usual tools.");
          } else {
            lines.push(`Seed "${args.seed}" is not mapped in the project map. No results — explore with your usual tools.`, "Accepted seed forms: a full mapped path, a unique path suffix (e.g. `query-tool.ts`), or an exact symbol name (e.g. `formatDate`).");
          }
        }
        return lines.join("\n");
      }
      const seedPath = resolved.path;
      if (!fresh(seedPath)) {
        // #737: the seed file changed after mapping (the common
        // edit→query-in-turn case, since the lifecycle defers refreshes
        // while a turn is busy). Re-extract just this one file and patch
        // its record — one read+parse, no lifecycle budgets touched —
        // then re-check freshness honestly.
        try {
          service.refresh(root, seedPath);
        } catch {
          // Never fatal: fall through to the stale rejection.
        }
        if (!fresh(seedPath)) {
          lines.push(`Seed "${seedPath}" is mapped but stale (the file changed after mapping and could not be re-extracted). No results — explore with your usual tools.`);
          return lines.join("\n");
        }
      }
      const entries: ResultEntry[] = [];
      const seen = new Set<string>();
      const consider = (path: string, reason: string, prov: MpmProvenance) => {
        if (seen.has(path) || entries.length >= maxEntries) return;
        if (!fresh(path)) return; // #737 note: only the seed is refreshed synchronously; a stale neighbor is dropped, never invented.
        seen.add(path);
        entries.push(prov.line !== undefined ? { path, reason, coordinate: `line ${prov.line}` } : { path, reason });
      };
      const result = service.query(seedPath);
      if (result) {
        result.paths.forEach((path, i) => {
          const prov = result.provenance[i]!;
          consider(path, prov.source === seedPath ? `imported by ${seedPath}` : `related to ${seedPath}`, prov);
        });
      }
      if (entries.length === 0) {
        lines.push(`No fresh related entries for "${seedPath}" in the project map.`);
      } else {
        lines.push(`## Project map results for ${seedPath} (advisory — verify against source)`, "");
        let used = lines.join("\n").length + 60;
        for (const e of entries) {
          const where = e.coordinate ? ` at ${e.coordinate}` : "";
          const line = `- ${e.path}${where} — ${e.reason}`;
          if (used + line.length + 1 > budgetChars) break;
          used += line.length + 1;
          lines.push(line);
        }
        lines.push("", "Start near these files; explore and verify as usual.");
      }
      options.orientation?.noteModelQuery();
      return lines.join("\n");
    },
  };
}
