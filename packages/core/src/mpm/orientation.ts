import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MpmService } from "./service";
import type { MpmFallbackReason, MpmProvenance, MpmSeedStats, MpmSeedTier } from "./types";

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
 *
 * #759: three seed sources, descending confidence, each labeled in the
 * rendered plan — task paths (high), exact task symbols (medium), and
 * identifiers extracted from persisted prior-call provider reasoning
 * (low, recency-weighted, suppressed after a successful `mpm_query`).
 * Identifiers are tokenized from text only; the map is never updated
 * from reasoning content and no fuzzy/semantic matching ever runs.
 */

/** Max entries in one plan (adaptive: shrinks under the character budget). */
const MAX_ENTRIES = 8;
/** Hard character budget for the rendered plan. */
const PLAN_BUDGET_CHARS = 1500;
/** Longest path-like token considered a seed — avoids hashes and prose. */
const MAX_TOKEN_LEN = 200;
/** #759: a seed resolving to more files than this is discarded entirely. */
export const AMBIGUITY_THRESHOLD = 5;
/** #759: reasoning seeds below this recency weight never enter the plan. */
const MIN_REASONING_WEIGHT = 0.5;

/** A path-like token: relative paths and dotted file names. */
const PATH_TOKEN = /[A-Za-z0-9_@./-]+\.[A-Za-z][A-Za-z0-9]{1,11}/g;
/** #759: a syntactically valid identifier — camelCase or snake_case. Never
 * a bare English word (a lone lowercase run with no case/underscore marker
 * is prose; single letters are noise). */
const IDENT_TOKEN = /\b[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b|\b[a-z]+(?:_[a-z0-9]+)+\b|\b[A-Z][A-Za-z0-9]{2,}\b/g;

interface PlanEntry {
  path: string;
  coordinate?: string;
  reason: string;
  /** #759: the entry's tier — low entries render visually subordinate. */
  tier: "high" | "medium" | "low";
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

/** Hash the file like the extractor does, to verify the projection is fresh.
 * Shared with the #663 query tool so the freshness definition cannot drift. */
export function currentHash(absPath: string): string | null {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/** #759: extract valid identifiers from a text, in order of appearance. */
export function extractIdentifiers(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.match(IDENT_TOKEN) ?? []) {
    if (raw.length > MAX_TOKEN_LEN) continue;
    if (!seen.has(raw)) {
      seen.add(raw);
      out.push(raw);
    }
  }
  return out;
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
  /** #618: why the most recent plan lookup produced no plan (diagnostics). */
  #lastFallback: MpmFallbackReason = null;
  /** #759: cumulative per-session seed statistics (metadata only). */
  #stats: MpmSeedStats = { pathPlans: 0, symbolPlans: 0, reasoningPlans: 0, overThreshold: 0 };

  constructor(options: MpmOrientationOptions) {
    this.#service = options.service;
    this.#root = options.root;
    this.#maxEntries = options.maxEntries ?? MAX_ENTRIES;
    this.#budgetChars = options.budgetChars ?? PLAN_BUDGET_CHARS;
  }

  /**
   * A rendered orientation plan for the task text, or null when the task is
   * ineligible, the projection is unavailable, or no fresh seed survives.
   * Every null outcome records a #618 fallback reason (metadata only).
   *
   * #759: `reasoning` (when given) is the persisted reasoning text of the
   * previous model call; its identifiers seed a low-tier, recency-weighted
   * plan — but only when the previous call produced no successful
   * `mpm_query` (the model already oriented itself; `noteModelQuery`).
   */
  planFor(text: string, reasoning?: string): string | null {
    // #759 non-redundancy: when a successful `mpm_query` already ran since
    // the last turn start, the reasoning source stands down — the model
    // oriented itself; a low-tier echo would be redundant.
    if (this.#modelQueryNoted) reasoning = undefined;
    const seeds = this.#pathSeeds(text);
    const symbolSeeds = this.#symbolSeeds(text);
    if (seeds.length === 0 && symbolSeeds.length === 0 && !reasoning) {
      this.#lastFallback =
        this.#service.status !== "ready" ? "unavailable" : "no-eligible-seed";
      return null;
    }
    const entries: PlanEntry[] = [];
    const seen = new Set<string>();
    const consider = (path: string, reason: string, tier: MpmSeedTier, line?: number) => {
      if (seen.has(path) || entries.length >= this.#maxEntries) return;
      if (!this.#fresh(path)) return;
      seen.add(path);
      entries.push(line !== undefined ? { path, reason, coordinate: `line ${line}`, tier } : { path, reason, tier });
    };

    let staleSeed = false;
    let overThreshold = false;
    /** #759: resolves a seed to a queryable mapped path (or paths) plus its
     * tier reason. A seed resolving to more than AMBIGUITY_THRESHOLD files
     * is discarded entirely — ambiguity is noise, never guessed. */
    const resolve = (
      seed: string,
      paths: string[],
      reasonFor: (path: string) => string,
      tier: MpmSeedTier,
    ): boolean => {
      if (paths.length > AMBIGUITY_THRESHOLD) {
        overThreshold = true;
        return false;
      }
      if (paths.length === 1 && !this.#fresh(paths[0]!)) {
        staleSeed = true;
        return false;
      }
      let any = false;
      for (const path of paths) {
        const result = this.#service.query(path);
        if (!result) continue;
        if (result.paths.length > AMBIGUITY_THRESHOLD) {
          overThreshold = true;
          continue;
        }
        any = true;
        result.paths.forEach((p, i) => {
          const prov: MpmProvenance = result.provenance[i]!;
          consider(p, reasonFor(p), tier, prov.line);
        });
      }
      return any;
    };
    const topTier: MpmSeedTier = seeds.length > 0 ? "high" : "medium";
    for (const seed of seeds) {
      if (!this.#fresh(seed)) {
        staleSeed = true;
        continue;
      }
      resolve(seed, [seed], (path) => this.#reasonFor(seed, path), topTier);
    }
    for (const seed of symbolSeeds) {
      resolve(seed, this.#service.pathsForSymbol(seed), (path) => `matches symbol \`${seed}\``, "medium");
    }
    // #759 low tier: recency-weighted identifiers from persisted prior-call
    // reasoning — suppressed entirely when the previous call produced a
    // successful `mpm_query` (the model already oriented itself).
    if (reasoning) {
      for (const { seed } of this.#reasoningSeeds(reasoning)) {
        if (entries.length >= this.#maxEntries) break;
        resolve(seed, this.#service.pathsForSymbol(seed), () => "mentioned in recent reasoning (advisory)", "low");
      }
    }
    if (entries.length > 0) {
      // A plan rendered: record the decisive tier's stats. The decisive
      // tier is the highest one present — high beats medium beats low.
      if (entries.some((e) => e.tier === "high")) {
        this.#stats.pathPlans += 1;
        this.#lastFallback = null;
      } else if (entries.some((e) => e.tier === "medium")) {
        this.#stats.symbolPlans += 1;
        this.#lastFallback = null;
      } else {
        this.#stats.reasoningPlans += 1;
        this.#lastFallback = "reasoning-seeded";
      }
      return this.#render(entries);
    }
    if (staleSeed) this.#lastFallback = "stale";
    else if (overThreshold) {
      this.#lastFallback = "over-threshold";
      this.#stats.overThreshold += 1;
    } else this.#lastFallback = "no-eligible-seed";
    return null;
  }

  /** #618: why the most recent plan lookup produced no plan (or null). */
  get lastFallbackReason(): MpmFallbackReason {
    return this.#lastFallback;
  }

  /** #759: cumulative per-session seed statistics (metadata only). */
  get seedStats(): MpmSeedStats {
    return { ...this.#stats };
  }

  /**
   * #663 (ADR-0028): a model-nominated `mpm_query` succeeded this turn.
   * When the automatic plan produced nothing, diagnostics report
   * `model-seeded` instead of a plain failure — the orientation style was
   * model-nominated, not absent. Metadata only.
   *
   * #759: the signal also suppresses the reasoning seed source until the
   * next send — the model just oriented itself; a low-tier echo would be
   * redundant.
   */
  noteModelQuery(): void {
    this.#modelQueryNoted = true;
    if (this.#lastFallback !== null) this.#lastFallback = "model-seeded";
  }
  /** #759: cleared at every send, with the turn-scoped plan. */
  #modelQueryNoted = false;

  /** #759: session lifecycle — a new send resets the model-query gate. */
  beginTurn(): void {
    this.#modelQueryNoted = false;
  }


  /** Mapped paths directly named in the task text. */
  #pathSeeds(text: string): string[] {
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

  /** #759: task-text identifiers that resolve exactly in the symbol index.
   * Generic English words are never seeds (the identifier shape gate plus
   * the exact-match requirement keep prose out). */
  #symbolSeeds(text: string): string[] {
    if (this.#service.status !== "ready" || this.#service.fileCount === 0) return [];
    const seeds: string[] = [];
    for (const token of extractIdentifiers(text)) {
      if (seeds.includes(token)) continue;
      const paths = this.#service.pathsForSymbol(token);
      // Exact resolution: any file count is kept here — the ambiguity
      // threshold (>5) decides downstream; a 2-file symbol is actionable.
      seeds.push(token);
    }
    return seeds;
  }

  /**
   * #759: identifiers from persisted prior-call reasoning that resolve
   * exactly in the symbol index, weighted positionally — the tail of a
   * reasoning trace states the chosen direction, the head lists discarded
   * alternatives. Deterministic tokenization only; no linguistic parsing.
   * Seeds above the weight threshold are returned, strongest first.
   */
  #reasoningSeeds(reasoning: string): { seed: string; weight: number }[] {
    const ids = extractIdentifiers(reasoning);
    if (ids.length === 0) return [];
    const weighted: { seed: string; weight: number }[] = [];
    const seen = new Set<string>();
    const n = ids.length;
    for (let i = 0; i < n; i++) {
      const token = ids[i]!;
      if (seen.has(token)) continue;
      // Positional weight: tail (last token) = 1, head → 0. Reasoning
      // converges, so what the model settled on outweighs what it skimmed.
      const weight = n <= 1 ? 1 : i / (n - 1);
      if (weight < MIN_REASONING_WEIGHT) continue;
      if (this.#service.pathsForSymbol(token).length === 0) continue;
      seen.add(token);
      weighted.push({ seed: token, weight });
    }
    // Strongest (tail-most) first.
    return weighted.sort((a, b) => b.weight - a.weight);
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
      // #759: low-tier entries render visually subordinate — a quieter
      // bullet, never reading as pressure away from exploration tools.
      const line =
        e.tier === "low"
          ? `  · ${e.path}${where} — ${e.reason}`
          : `- ${e.path}${where} — ${e.reason}`;
      if (used + line.length + 1 > this.#budgetChars) break;
      used += line.length + 1;
      kept.push(line);
    }
    if (kept.length === 0) return null;
    lines.push(...kept, "", "Start near these files; explore and verify as usual.");
    return lines.join("\n");
  }
}
