import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MpmService } from "./service";
import type { MpmProvenance } from "./types";

/**
 * MPM targeted orientation plans (#616, spec #613): a small, source-cited,
 * advisory plan for relevant codebase tasks, rendered into the prompt's
 * `mpm` section.
 *
 * Eligibility is conservative and purely local — no pre-call LLM classifier.
 * Every ranked entry is extracted (present in the projection) and fresh
 * (the file's current content hash still matches the mapped hash), cited
 * with path, coordinate where available, relation, and a concise reason.
 * A plan is never a tool restriction: the model explores and verifies
 * against source as usual. Plans never contain copied source excerpts.
 */

/** Max entries in one plan (adaptive: shrinks under the character budget). */
const MAX_ENTRIES = 8;
/** Hard character budget for the rendered plan. */
const PLAN_BUDGET_CHARS = 1500;
/** Longest path-like token considered a seed — avoids hashes and prose. */
const MAX_TOKEN_LEN = 200;

/** A path-like token: relative paths and dotted file names. */
const PATH_TOKEN = /[A-Za-z0-9_@./-]+\.[A-Za-z][A-Za-z0-9]{1,11}/g;

interface PlanEntry {
  path: string;
  coordinate?: string;
  reason: string;
}

export interface MpmOrientationOptions {
  /** The loaded projection service (read-only queries). */
  service: MpmService;
  /** Workspace root; freshness checks resolve against it. */
  root: string;
  /** Entry cap override (tests). */
  maxEntries?: number;
  /** Character budget override (tests). */
  budgetChars?: number;
}

/** Hash the file like the extractor does, to verify the projection is fresh. */
function currentHash(absPath: string): string | null {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Builds orientation plans from an MPM projection. All decisions are local
 * and deterministic; any uncertainty yields no plan.
 */
export class MpmOrientation {
  readonly #service: MpmService;
  readonly #root: string;
  readonly #maxEntries: number;
  readonly #budgetChars: number;

  constructor(options: MpmOrientationOptions) {
    this.#service = options.service;
    this.#root = options.root;
    this.#maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.#budgetChars = options.budgetChars ?? PLAN_BUDGET_CHARS;
  }

  /**
   * A rendered orientation plan for the task text, or null when the task is
   * ineligible, the projection is unavailable, or no fresh seed survives.
   */
  planFor(text: string): string | null {
    const seeds = this.#seeds(text);
    if (seeds.length === 0) return null;
    const entries: PlanEntry[] = [];
    const seen = new Set<string>();
    const consider = (path: string, reason: string, line?: number) => {
      if (seen.has(path) || entries.length >= this.#maxEntries) return;
      if (!this.#fresh(path)) return;
      seen.add(path);
      entries.push(line !== undefined ? { path, reason, coordinate: `line ${line}` } : { path, reason });
    };

    for (const seed of seeds) {
      // A stale seed is dropped outright — its relations are proven against
      // content that no longer exists, so they are not trustworthy.
      if (!this.#fresh(seed)) continue;
      const result = this.#service.query(seed);
      if (!result) continue;
      result.paths.forEach((path, i) => {
        const prov: MpmProvenance = result.provenance[i]!;
        consider(path, this.#reasonFor(seed, path), prov.line);
      });
    }
    return this.#render(entries) ?? null;
  }

  /** Mapped paths directly named in the task text. */
  #seeds(text: string): string[] {
    if (this.#service.status !== "ready" || this.#service.fileCount === 0) return [];
    const tokens = text.match(PATH_TOKEN) ?? [];
    const seeds: string[] = [];
    const seen = new Set<string>();
    for (const raw of tokens) {
      if (raw.length > MAX_TOKEN_LEN) continue;
      // Candidate forms of one token: strip a leading `@/`, leading `./`/`/`,
      // and trailing punctuation; also try without the first directory.
      const stripped = raw.replace(/^[./@]+/, "").replace(/[.,;:)]+$/, "");
      const candidates = [stripped, stripped.includes("/") ? stripped.slice(stripped.indexOf("/") + 1) : stripped];
      const match = candidates.find((c) => c.length > 0 && this.#service.record(c) !== null);
      if (match && !seen.has(match)) {
        seen.add(match);
        seeds.push(match);
      }
    }
    return seeds;
  }

  /** A mapped path is usable only when unchanged since mapping. */
  #fresh(path: string): boolean {
    const record = this.#service.record(path);
    if (!record) return false;
    return currentHash(join(this.#root, path)) === record.hash;
  }

  #reasonFor(seed: string, path: string): string {
    if (path === seed) return "the task names this file";
    if (path.startsWith(seed) || seed.startsWith(path.replace(/\.test\.[^.]+$/, ""))) return `in the same module as ${seed}`;
    return `related to ${seed}`;
  }

  #render(entries: PlanEntry[]): string | null {
    const lines: string[] = ["## Project map orientation (advisory — verify against source)", ""];
    // +~60 reserved for the trailing note and budget slack.
    let used = lines.join("\n").length + 60;
    const kept: string[] = [];
    for (const e of entries) {
      const where = e.coordinate ? ` at ${e.coordinate}` : "";
      const line = `- ${e.path}${where} — ${e.reason}`;
      if (used + line.length + 1 > this.#budgetChars) break;
      used += line.length + 1;
      kept.push(line);
    }
    if (kept.length === 0) return null;
    lines.push(...kept, "", "Start near these files; explore and verify as usual.");
    return lines.join("\n");
  }
}
