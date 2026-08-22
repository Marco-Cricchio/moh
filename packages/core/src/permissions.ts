import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve as pathResolve } from "node:path";

export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionTier = "builtin" | "config" | "runtime";
export type RuleEffect = "allow" | "deny";
export type SessionMode = "normal" | "auto-accept" | "bypass";

/**
 * A single permission rule. Argument matchers are optional:
 * - bash: `tokens` is a shell-word prefix (["git","status"] covers "git status --short").
 * - write/edit (and any tool with a `path` arg): `path` is a glob anchored to the project root.
 * Rules without a matcher apply to every invocation of `tool`.
 */
export interface PermissionRule {
  tier: PermissionTier;
  tool: string;
  effect: RuleEffect;
  tokens?: string[];
  path?: string;
}

/** moh.json `permissions.overrides` schema (tier 2). */
export interface PermissionOverrides {
  /** Tool-level decisions. */
  tools?: Record<string, "allow" | "ask" | "deny">;
  /** Bash allow rules as shell-word token prefixes. */
  bashAllow?: string[][];
  /** Bash deny rules as shell-word token prefixes. Deny beats allow when at least as specific. */
  bashDeny?: string[][];
  /** Allow globs for path tools, anchored to the project root. */
  pathAllow?: string[];
  /** Deny globs for path tools, anchored to the project root. */
  pathDeny?: string[];
}

export class RuleError extends Error {}

/**
 * Canonical permission-rule string grammar (ADR-0007):
 * `tool` (bare), `bash:<command prefix>` (shell-word tokens), or
 * `<tool>:<path glob>` for write/edit and any path-arg tool. This is the
 * ONE writable-and-reparseable form: shared by CLI flags, moh.json docs
 * and the TUI's rule previews.
 */

/** Quotes a token containing shell-significant characters for `formatRule`. */
function quoteToken(token: string): string {
  if (!/[\s"'&|;]/.test(token)) return token;
  // Prefer double quotes unless the token itself contains one the segment
  // splitter can't escape; the grammar has no escaping (documented limit).
  if (token.includes('"')) return `'${token}'`;
  return `"${token}"`;
}

/** Formats one rule in the canonical grammar (`bash:git status`, `write:src/**`, `bash`). */
export function formatRule(rule: PermissionRule): string {
  if (rule.tokens) return `${rule.tool}:${rule.tokens.map(quoteToken).join(" ")}`;
  if (rule.path) return `${rule.tool}:${rule.path}`;
  return rule.tool;
}

/**
 * Parses one rule string from the canonical grammar. Bare tools become
 * tool-level rules; `bash:` prefixes become token-prefix rules; any other
 * `tool:rest` becomes a path-glob rule (matcher shared by all path tools).
 */
export function parseRule(str: string, effect: RuleEffect, tier: PermissionTier = "config"): PermissionRule {
  if (str === "") throw new RuleError(`empty ${effect} rule`);
  const colon = str.indexOf(":");
  if (colon === -1) {
    return { tier, tool: str, effect };
  }
  const tool = str.slice(0, colon);
  const rest = str.slice(colon + 1).trim();
  if (tool === "bash") {
    const segments = splitCommandSegments(rest);
    const tokens = segments[0];
    if (!tokens || segments.length > 1) {
      throw new RuleError(
        `invalid bash rule "${str}": expected a single command prefix (compound commands need one --allow per segment)`,
      );
    }
    return { tier, tool: "bash", effect, tokens };
  }
  if (tool !== "bash" && !rest) throw new RuleError(`invalid rule "${str}": missing argument matcher`);
  // Path-glob rule scoped to `tool`; overridesFromFlags widens it to the
  // shared pathAllow/pathDeny lists (the resolver's `*` semantics).
  return { tier, tool, effect, path: rest };
}

/** Builds full overrides from repeatable `--allow`/`--deny` flag values (CLI seam over the core grammar). */
export function overridesFromFlags(allow: string[], deny: string[]): PermissionOverrides {
  const merged: PermissionOverrides = {};
  const absorb = (str: string, effect: RuleEffect): void => {
    const rule = parseRule(str, effect);
    if (rule.tokens) {
      const key = effect === "allow" ? "bashAllow" : "bashDeny";
      (merged[key] ??= []).push(rule.tokens);
    } else if (rule.path) {
      const key = effect === "allow" ? "pathAllow" : "pathDeny";
      (merged[key] ??= []).push(rule.path);
    } else {
      (merged.tools ??= {})[rule.tool] = effect;
    }
  };
  for (const str of allow) absorb(str, "allow");
  for (const str of deny) absorb(str, "deny");
  return merged;
}

/** Tier 1: built-in defaults. Read-only tools are allowed; mutating ones ask. */
export const DEFAULT_TOOL_PERMISSIONS: Record<string, PermissionDecision> = {
  read: "allow",
  ask_user: "allow",
  glob: "allow",
  grep: "allow",
  todo: "allow",
  write: "ask",
  edit: "ask",
  bash: "ask",
  fetch: "ask",
  // Subagents (#13): spawning a child is delegation — ask by default.
  spawn: "ask",
  // Tracker tools (#36): reads are free, claiming is a mutation.
  tracker_list: "allow",
  tracker_claim: "ask",
};

const TIER_RANK: Record<PermissionTier, number> = { builtin: 0, config: 1, runtime: 2 };

/**
 * Splits a compound command into token lists, one per ;/&&/||/| segment.
 * Quote-aware: separators inside quotes are literal characters.
 */
export function splitCommandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let cur = "";
  let started = false;
  let i = 0;
  const pushWord = () => {
    if (started) {
      words.push(cur);
      cur = "";
      started = false;
    }
  };
  const pushSegment = () => {
    pushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  while (i < command.length) {
    const c = command[i]!;
    if (c === '"' || c === "'") {
      const quote = c;
      i += 1;
      while (i < command.length && command[i] !== quote) {
        cur += command[i]!;
        i += 1;
      }
      i += 1; // closing quote (or end of string)
      started = true;
      continue;
    }
    if (c === "|" || c === "&" || c === ";") {
      const isDouble = (c === "|" || c === "&") && command[i + 1] === c;
      pushSegment();
      i += isDouble ? 2 : 1;
      continue;
    }
    if (/\s/.test(c)) {
      pushWord();
      i += 1;
      continue;
    }
    cur += c;
    started = true;
    i += 1;
  }
  pushSegment();
  return segments;
}

/** True if `prefix` is a token-prefix of `tokens`. */
function isTokenPrefix(prefix: string[], tokens: string[]): boolean {
  if (prefix.length === 0 || prefix.length > tokens.length) return false;
  return prefix.every((t, i) => t === tokens[i]);
}

function ruleSpecificity(rule: PermissionRule): number {
  if (rule.tokens) return rule.tokens.length + 1;
  if (rule.path) return rule.path.includes("*") || rule.path.includes("?") ? 1 : 2;
  return 0;
}

export interface PermissionResolverOptions {
  defaults: Record<string, PermissionDecision>;
  overrides?: PermissionOverrides;
  runtimeRules?: PermissionRule[];
  mode?: SessionMode;
  cwd: string;
}

/**
 * Most-specific-wins resolver over three tiers:
 * built-in defaults < moh.json overrides < in-session runtime rules.
 * Higher tier wins; within/below that, argument matchers beat tool-level
 * rules, and longer token prefixes beat shorter ones.
 */
export class PermissionResolver {
  readonly mode: SessionMode;
  readonly cwd: string;
  readonly #rules: PermissionRule[];

  constructor(opts: PermissionResolverOptions) {
    this.mode = opts.mode ?? "normal";
    this.cwd = realpathOf(opts.cwd);
    const rules: PermissionRule[] = [];
    for (const [tool, decision] of Object.entries(opts.defaults)) {
      if (decision === "allow" || decision === "deny") {
        rules.push({ tier: "builtin", tool, effect: decision });
      } // "ask" = no rule: unmatched invocations fall through to ask
    }
    const ov = opts.overrides ?? {};
    for (const [tool, decision] of Object.entries(ov.tools ?? {})) {
      if (decision === "allow" || decision === "deny") {
        rules.push({ tier: "config", tool, effect: decision });
      }
    }
    for (const tokens of ov.bashAllow ?? []) rules.push({ tier: "config", tool: "bash", effect: "allow", tokens });
    for (const tokens of ov.bashDeny ?? []) rules.push({ tier: "config", tool: "bash", effect: "deny", tokens });
    for (const path of ov.pathAllow ?? []) rules.push({ tier: "config", tool: "*", effect: "allow", path });
    for (const path of ov.pathDeny ?? []) rules.push({ tier: "config", tool: "*", effect: "deny", path });
    for (const rule of opts.runtimeRules ?? []) rules.push({ ...rule, tier: "runtime" });
    this.#rules = rules;
  }

  /** All active rules (snapshot), e.g. for debugging or replay. */
  get rules(): PermissionRule[] {
    return [...this.#rules];
  }

  /** Stores a rule granted by an "always" answer (tier forced to runtime). */
  addRuntimeRule(rule: Omit<PermissionRule, "tier"> & Partial<Pick<PermissionRule, "tier">>): void {
    const { tier: _ignored, ...rest } = rule;
    this.#rules.push({ ...rest, tier: "runtime" });
  }

  /**
   * Resolves the decision for one tool invocation. Out-of-root paths and
   * partially-covered compound commands resolve to "ask".
   */
  resolve(toolName: string, args: any): PermissionDecision {
    if (toolName === "bash" && typeof args?.command === "string") {
      const segments = splitCommandSegments(args.command);
      if (segments.length === 0) return "ask";
      let uncovered = false;
      for (const tokens of segments) {
        const decision = this.#best(toolName, tokens, undefined);
        if (decision === "deny") return "deny";
        if (decision !== "allow") uncovered = true;
      }
      return uncovered ? "ask" : "allow";
    }
    if (typeof args?.path === "string") {
      const rel = this.relativeInRoot(args.path);
      if (rel === null) return "ask"; // out-of-root: always ask, never persistable
      return this.#best(toolName, undefined, rel);
    }
    return this.#best(toolName, undefined, undefined);
  }

  /** False when persisting an "always" rule would be unsound (out-of-root path). */
  persistable(_toolName: string, args: any): boolean {
    if (typeof args?.path !== "string") return true;
    return this.relativeInRoot(args.path) !== null;
  }

  /** Builds a runtime rule from an "always" answer for the given invocation. */
  runtimeRuleFor(toolName: string, args: any): Omit<PermissionRule, "tier"> | null {
    if (toolName === "bash" && typeof args?.command === "string") {
      const tokens = splitCommandSegments(args.command).flat();
      if (tokens.length === 0) return null;
      return { tool: "bash", effect: "allow", tokens };
    }
    if (typeof args?.path === "string") {
      const rel = this.relativeInRoot(args.path);
      if (rel === null) return null;
      return { tool: toolName, effect: "allow", path: rel };
    }
    return { tool: toolName, effect: "allow" };
  }

  /**
   * Path resolution against the project root. Returns the root-relative
   * path (realpath-resolved when the file exists), or null when the path
   * escapes the root.
   */
  relativeInRoot(path: string): string | null {
    const abs = isAbsolute(path) ? path : pathResolve(this.cwd, path);
    const real = realpathOf(abs);
    const rel = relative(this.cwd, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel;
  }

  /**
   * Picks the most-specific matching rule's effect: higher tier wins;
   * then argument specificity; then token length. Returns "ask" when no
   * rule matches.
   */
  #best(toolName: string, tokens: string[] | undefined, relPath: string | undefined): PermissionDecision {
    let best: PermissionRule | null = null;
    let bestKey = -1;
    for (const rule of this.#rules) {
      if (rule.tool !== toolName && rule.tool !== "*") continue;
      if (rule.tokens) {
        // Token rules only apply to bash-style segment matching.
        if (!(toolName === "bash" && tokens !== undefined && isTokenPrefix(rule.tokens, tokens))) continue;
      } else if (rule.path) {
        if (relPath === undefined) continue;
        if (!(rule.path === relPath || new Bun.Glob(rule.path).match(relPath))) continue;
      }
      // Bare tool-level rules match every invocation of the tool.
      const key = TIER_RANK[rule.tier] * 1000 + ruleSpecificity(rule);
      if (key > bestKey) {
        best = rule;
        bestKey = key;
      }
    }
    if (!best) return "ask";
    return best.effect;
  }
}

function realpathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Rebuilds runtime rules from a replayed event log: every
 * `permission_rule_added` event carries a replayable rule.
 */
export function runtimeRulesFromEvents(
  events: ReadonlyArray<{ type: string; rule?: PermissionRule }>,
): PermissionRule[] {
  const rules: PermissionRule[] = [];
  for (const event of events) {
    if (event.type === "permission_rule_added" && event.rule) {
      rules.push({ ...event.rule, tier: "runtime" });
    }
  }
  return rules;
}
