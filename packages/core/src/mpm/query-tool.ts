import { z } from "zod";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Tool } from "../types";
import type { MpmService } from "./service";
import type { MpmProvenance } from "./types";
import type { MpmOrientation } from "./orientation";

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

/** Hash the file like the extractor/orientation do, to verify freshness. */
function currentHash(absPath: string): string | null {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
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
): { path: string; how: "path" | "suffix" | "symbol" } | { path: null; how: "unmapped" } {
  const stripped = raw.trim().replace(/^[./@]+/, "").replace(/[.,;:)]+$/, "");
  if (stripped.length === 0) return { path: null, how: "unmapped" };
  // Exact path first.
  if (service.record(stripped) !== null) return { path: stripped, how: "path" };
  // Unique path suffix (any mapped path ending with `/seed` or matching the base name exactly once).
  const candidates = new Set<string>();
  for (const path of service.allPaths()) {
    if (path === stripped) continue; // already tried as exact
    const idx = path.indexOf(stripped);
    if (idx > 0 && (idx + stripped.length === path.length)) candidates.add(path);
  }
  if (candidates.size === 1) return { path: [...candidates][0]!, how: "suffix" };
  if (candidates.size > 1) return { path: null, how: "unmapped" };
  // Symbol name.
  const symbols = service.pathsForSymbol(stripped);
  if (symbols.length === 1) return { path: symbols[0]!, how: "symbol" };
  return { path: null, how: "unmapped" };
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
      if (service.status !== "ready" || service.fileCount === 0) {
        return "project map unavailable — no data. Explore with your usual tools.";
      }
      const resolved = resolveSeed(args.seed, service);
      const lines: string[] = [];
      if (resolved.path === null) {
        lines.push(`Seed "${args.seed}" is not mapped in the project map (unmapped or ambiguous). No results — explore with your usual tools.`);
        return lines.join("\n");
      }
      const seedPath = resolved.path;
      if (!fresh(seedPath)) {
        lines.push(`Seed "${seedPath}" is mapped but stale (the file changed after mapping). No results — explore with your usual tools.`);
        return lines.join("\n");
      }
      const entries: ResultEntry[] = [];
      const seen = new Set<string>();
      const consider = (path: string, reason: string, prov: MpmProvenance) => {
        if (seen.has(path) || entries.length >= maxEntries) return;
        if (!fresh(path)) return;
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
