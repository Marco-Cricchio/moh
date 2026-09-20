import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve as pathResolve } from "node:path";

export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionTier = "builtin" | "config" | "runtime";
export type RuleEffect = "allow" | "deny";
export type SessionMode = "normal" | "auto-accept" | "yolo";
/**
 * #377: the filesystem reach of built-in path tools, derived from the
 * session mode — "yolo" lifts the project-root containment (SEC-03's
 * canonical resolution still applies; only the final containment check
 * is gated on scope). "project" for every other mode.
 */
export type FilesystemScope = "project" | "unrestricted";

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
  /**
   * #775 (ADR-0007 third argspec semantic): URL glob for browser rules.
   * The `tool` carries the action scope (`browser:click`); scheme+host+path
   * matched against the page URL at action time.
   */
  url?: string;
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
  /**
   * #775: canonical browser rules, URL-glob scoped (`browser:click
   * https://app.example.com/**`) or global (`browser:fill`). The string
   * is the ADR-0007 grammar; parseRule decodes it.
   */
  browserAllow?: string[];
  browserDeny?: string[];
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

/** Formats one rule in the canonical grammar (`bash:git status`, `write:src/**`, `bash`,
 * or #775's URL-glob form `browser:click https://app.example.com/**`). */
export function formatRule(rule: PermissionRule): string {
  if (rule.tokens) return `${rule.tool}:${rule.tokens.map(quoteToken).join(" ")}`;
  if (rule.url) return `${rule.tool} ${rule.url}`;
  if (rule.path) return `${rule.tool}:${rule.path}`;
  return rule.tool;
}

/**
 * Parses one rule string from the canonical grammar. Bare tools become
 * tool-level rules; `bash:` prefixes become token-prefix rules; browser
 * action rules (`browser:<action> <url-glob>`) become URL rules (ADR-0007
 * third semantic); any other `tool:rest` becomes a path-glob rule
 * (matcher shared by all path tools).
 */
export function parseRule(str: string, effect: RuleEffect, tier: PermissionTier = "config"): PermissionRule {
  if (str === "") throw new RuleError(`empty ${effect} rule`);
  const colon = str.indexOf(":");
  if (colon === -1) {
    return { tier, tool: str, effect };
  }
  const tool = str.slice(0, colon);
  if (!tool) throw new RuleError(`invalid rule "${str}": missing tool`);
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
  // #775: `browser:<action> [url-glob]` — the URL-glob argspec. A glob
  // always carries a scheme (`://`); the action-only form (`browser:click`)
  // is the global form. Anything else on a browser rule is not a URL rule
  // and falls through to the path-glob reading.
  if (tool === "browser" && /^[a-z_]+$/.test(rest)) {
    return { tier, tool: `browser:${rest}`, effect };
  }
  if (tool === "browser" && rest.includes("://")) {
    const sp = rest.indexOf(" ");
    const action = sp === -1 ? rest.trim() : rest.slice(0, sp).trim();
    const glob = sp === -1 ? undefined : rest.slice(sp + 1).trim();
    if (!action || !/^[a-z_]+$/.test(action)) {
      throw new RuleError(`invalid browser rule "${str}": expected browser:<action> [url-glob]`);
    }
    if (glob !== undefined && !isValidUrlGlob(glob)) {
      throw new RuleError(`invalid browser rule "${str}": "${glob}" is not a scheme+host URL glob`);
    }
    return { tier, tool: `browser:${action}`, effect, ...(glob ? { url: glob } : {}) };
  }
  // Path-glob rule scoped to `tool`; overridesFromFlags widens it to the
  // shared pathAllow/pathDeny lists (the resolver's `*` semantics).
  return { tier, tool, effect, path: rest };
}

/**
 * True when `glob` is a well-formed URL glob: parseable scheme://host
 * (port optional, path optional or glob). Never thrown-on — used both by
 * parseRule (reject) and by the matcher (fail closed to "no match").
 */
export function isValidUrlGlob(glob: string): boolean {
  try {
    const u = new URL(glob.replace(/^\*\*/, "/").replace("/**", "/"));
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * #775: URL-glob matching (ADR-0007 third argspec semantic). Scheme and
 * host must match exactly (no implicit subdomain match; a glob port
 * matches any page port — localhost dev servers move around); the path
 * is a glob where `**` spans path segments and `*` stays within one.
 * Malformed input on either side never matches.
 */
export function urlGlobMatches(glob: string, pageUrl: string): boolean {
  let g: URL;
  let p: URL;
  try {
    const norm = glob.includes("**") || glob.split("/").length > 3 ? glob : `${glob}/`;
    g = new URL(norm);
    p = new URL(pageUrl);
  } catch {
    return false;
  }
  if (g.protocol !== p.protocol) return false;
  if (g.hostname !== p.hostname) return false;
  if (g.port !== "" && g.port !== p.port) return false;
  const pattern = `${g.pathname}${g.search}`.replace(/\/+$/, "");
  const actual = `${p.pathname}${p.search}`.replace(/\/+$/, "") || "/";
  return new Bun.Glob(pattern === "" ? "/" : pattern).match(actual);
}

/** Builds full overrides from repeatable `--allow`/`--deny` flag values (CLI seam over the core grammar). */
export function overridesFromFlags(allow: string[], deny: string[]): PermissionOverrides {
  const merged: PermissionOverrides = {};
  const absorb = (str: string, effect: RuleEffect): void => {
    const rule = parseRule(str, effect);
    if (rule.tokens) {
      const key = effect === "allow" ? "bashAllow" : "bashDeny";
      (merged[key] ??= []).push(rule.tokens);
    } else if (rule.tool.startsWith("browser:") && !rule.path) {
      // #775: browser rules ride their own buckets, rule string intact
      // (URL-glob or global form).
      const key = effect === "allow" ? "browserAllow" : "browserDeny";
      (merged[key] ??= []).push(formatRule(rule));
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
  // #663 (ADR-0028): read-only over projection metadata.
  mpm_query: "allow",
  // #775 (ADR-0029): browser read tier defaults live in BROWSER_READ_ACTIONS
  // (builtin `browser:<action>` allow rules); the act tier asks (no rule).
  tracker_claim: "ask",
};

/** #775 (ADR-0029): read-tier browser actions — allowed by default. */
export const BROWSER_READ_ACTIONS = ["navigate", "snapshot", "read_text", "screenshot", "close"] as const;
/** #775 (ADR-0029): act-tier browser actions — ask by default. */
export const BROWSER_ACT_ACTIONS = [
  "click",
  "fill",
  "select",
  "scroll",
  "press_key",
  "wait_for",
  "upload",
  "eval_js",
] as const;

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
    // A bare newline terminates a shell command just like `;`; treating it
    // as whitespace would let `bash:git status` cover `git status\nrm -rf /`.
    if (c === "\n" || c === "\r") {
      pushSegment();
      i += 1;
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

/**
 * SEC-04: true when the command contains shell metacharacters that a
 * token-prefix allow rule cannot see — unquoted `$(`, `$VAR`, backticks,
 * process substitution `<(`, herestrings `<<<`, input redirect `<` or
 * redirection `>`/`>>` (single-quoted text is literal and excluded;
 * double quotes are not, since they still expand; a leading `~` expands
 * to the home directory). Such commands are forced to "ask" even when a
 * token-prefix rule matches: the covered tokens describe the command, but
 * the metacharacters smuggle side effects the rule never saw.
 */
export function hasUncoveredShellMetachars(command: string): boolean {
  let i = 0;
  let wordStart = true; // true when the previous char ended a word
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") {
      // Single-quoted span: literal, skip to the closing quote.
      i += 1;
      while (i < command.length && command[i] !== "'") i += 1;
      i += 1;
      wordStart = false;
      continue;
    }
    if (c === "$" && (command[i + 1] === "(" || /\w/.test(command[i + 1] ?? ""))) return true;
    if (c === "`") return true;
    if (c === "<") return true; // <, <<, <<< (herestring), <( process subst
    if (c === ">") return true; // > and >> (any redirection, 2> included)
    if (c === "~" && wordStart) return true;
    wordStart = /\s/.test(c);
    i += 1;
  }
  return false;
}

function ruleSpecificity(rule: PermissionRule): number {
  if (rule.tokens) return rule.tokens.length + 1;
  // #775: URL-scoped rules beat the global form within a tier.
  if (rule.url) return 2;
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
  #mode: SessionMode;
  readonly cwd: string;
  readonly #rules: PermissionRule[];
  /** Bare tool-level "allow" rule for bash (no token matcher) exists. */
  #hasBareAllow = false;

  constructor(opts: PermissionResolverOptions) {
    this.#mode = opts.mode ?? "normal";
    this.cwd = realpathOf(opts.cwd);
    const rules: PermissionRule[] = [];
    for (const [tool, decision] of Object.entries(opts.defaults)) {
      if (decision === "allow" || decision === "deny") {
        rules.push({ tier: "builtin", tool, effect: decision });
      } // "ask" = no rule: unmatched invocations fall through to ask
    }
    // #775 (ADR-0029): browser read tier allow / act tier ask as builtin
    // `browser:<action>` rules, so config and runtime rules slot into the
    // same most-specific-wins ladder.
    for (const action of BROWSER_READ_ACTIONS) {
      rules.push({ tier: "builtin", tool: `browser:${action}`, effect: "allow" });
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
    // #775: browser rules arrive as canonical strings (URL-glob or global form).
    for (const str of ov.browserAllow ?? []) rules.push(parseRule(str, "allow"));
    for (const str of ov.browserDeny ?? []) rules.push(parseRule(str, "deny"));
    for (const rule of opts.runtimeRules ?? []) rules.push({ ...rule, tier: "runtime" });
    this.#rules = rules;
    this.#hasBareAllow = rules.some((r) => r.tool === "bash" && r.effect === "allow" && !r.tokens && !r.path);
  }

  /**
   * The session's permission mode, live: #849 made it runtime-mutable
   * (`setSessionMode`), so every consumer must read it at decision time
   * rather than capture its construction-time value.
   */
  get mode(): SessionMode {
    return this.#mode;
  }

  /** #849: rotates the mode in-session; the session appends the chrome event. */
  setMode(mode: SessionMode): void {
    this.#mode = mode;
  }

  /** All active rules (snapshot), e.g. for debugging or replay. */
  get rules(): PermissionRule[] {
    return [...this.#rules];
  }

  /** Stores a rule granted by an "always" answer (tier forced to runtime). */
  addRuntimeRule(rule: Omit<PermissionRule, "tier"> & Partial<Pick<PermissionRule, "tier">>): void {
    const { tier: _ignored, ...rest } = rule;
    this.#rules.push({ ...rest, tier: "runtime" });
    if (rest.tool === "bash" && rest.effect === "allow" && !rest.tokens && !rest.path) {
      this.#hasBareAllow = true;
    }
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
      let prefixMatchedOnly = false;
      for (const tokens of segments) {
        const decision = this.#best(toolName, tokens, undefined);
        if (decision === "deny") return "deny";
        if (decision !== "allow") uncovered = true;
        else {
          // Which rule won? A bare `bash: allow` (tool-level) covers the
          // whole command semantics by user intent; only token-prefix
          // rules need the SEC-04 metacharacter guard.
          if (!this.#hasBareAllow) prefixMatchedOnly = true;
        }
      }
      if (uncovered) return "ask";
      // SEC-04: when coverage comes only from token-prefix rules, any
      // unquoted shell metacharacter in the command forces an ask.
      if (prefixMatchedOnly && hasUncoveredShellMetachars(args.command)) return "ask";
      return "allow";
    }
    // #777: browser `upload` carries a local source path — containment
    // runs FIRST and the action rides `browser:<action>` URL rules, not
    // the generic path-rule branch below. An out-of-root source is a
    // per-occurrence ask, never a rule match, never persistable.
    if (toolName === "browser" && args?.action === "upload" && typeof args?.path === "string") {
      if (this.relativeInRoot(args.path) === null) return "ask"; // out-of-root source
      const pageUrl = typeof args?.pageUrl === "string" ? args.pageUrl : undefined;
      return this.#best(`${toolName}:${args.action}`, undefined, undefined, pageUrl);
    }
    if (typeof args?.path === "string") {
      const rel = this.relativeInRoot(args.path);
      if (rel === null) return "ask"; // out-of-root: always ask, never persistable
      return this.#best(toolName, undefined, rel);
    }
    // #775 (ADR-0029, action-aware gate): the browser tool's rules match
    // `browser:<action> [url-glob]` — the action rides the rule's tool
    // (`browser:click`), the URL glob matches the page URL at action
    // time. A bare `browser` rule covers every action. URL-scoped rules
    // need a page URL: without one they never match (default ask).
    if (toolName === "browser" && typeof args?.action === "string") {
      // #775: navigate matches URL rules against its own target URL.
      const pageUrl =
        typeof args?.pageUrl === "string" ? args.pageUrl
        : args?.action === "navigate" && typeof args?.url === "string" ? args.url
        : undefined;
      return this.#best(`${toolName}:${args.action}`, undefined, undefined, pageUrl);
    }
    return this.#best(toolName, undefined, undefined);
  }

  /** False when persisting an "always" rule would be unsound (out-of-root path,
   * or #777's out-of-root browser upload source — per-occurrence only). */
  persistable(toolName: string, args: any): boolean {
    if (toolName === "browser" && args?.action === "upload" && typeof args?.path === "string") {
      return this.relativeInRoot(args.path) !== null;
    }
    if (typeof args?.path !== "string") return true;
    return this.relativeInRoot(args.path) !== null;
  }

  /** Builds a runtime rule from an "always" answer for the given invocation. */
  runtimeRuleFor(toolName: string, args: any): Omit<PermissionRule, "tier"> | null {
    if (toolName === "bash" && typeof args?.command === "string") {
      // SEC-04: a compound command cannot become one flat token prefix —
      // flattening yields a never-matching list ("git status && rm x" →
      // ["git","status","rm","x"] covers nothing). One segment: one rule.
      // Compounds: refuse — the "always" answer applies to this session's
      // runtime rule set only via explicit per-segment rules, so the user
      // re-approves each segment the first time it runs.
      const segments = splitCommandSegments(args.command);
      if (segments.length !== 1) return null;
      const tokens = segments[0]!;
      if (tokens.length === 0) return null;
      return { tool: "bash", effect: "allow", tokens };
    }
    if (typeof args?.path === "string" && !(toolName === "browser" && args?.action === "upload")) {
      const rel = this.relativeInRoot(args.path);
      if (rel === null) return null;
      return { tool: toolName, effect: "allow", path: rel };
    }
    // #777: an in-root browser upload "always" writes the same
    // site-scoped URL rule as any other browser act action — never a
    // path rule (the upload gate matches `browser:<action>` + page URL,
    // so a path rule could never match: a dead rule and an ask loop).
    if (toolName === "browser" && typeof args?.path === "string") {
      if (this.relativeInRoot(args.path) === null) return null; // out-of-root: per-occurrence only
      const pageUrl = typeof args?.pageUrl === "string" ? args.pageUrl : undefined;
      if (!pageUrl) return null; // no page URL: no sound site scope — ask again next time
      let origin: string;
      try {
        origin = new URL(pageUrl).origin;
      } catch {
        return null;
      }
      return { tool: `browser:${args.action}`, effect: "allow", url: `${origin}/**` };
    }
    // #775: "always for this site" — a runtime `browser:<action> <url-glob>`
    // rule scoped to the page's origin. Never persisted (PermissionGate
    // routes browser rules away from moh.json); lost at session close.
    if (toolName === "browser" && typeof args?.action === "string") {
      const pageUrl = typeof args?.pageUrl === "string" ? args.pageUrl : undefined;
      if (!pageUrl) return null; // no page URL: no sound site scope — ask again next time
      let origin: string;
      try {
        origin = new URL(pageUrl).origin;
      } catch {
        return null;
      }
      return { tool: `browser:${args.action}`, effect: "allow", url: `${origin}/**` };
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
  #best(
    toolName: string,
    tokens: string[] | undefined,
    relPath: string | undefined,
    pageUrl?: string,
  ): PermissionDecision {
    let best: PermissionRule | null = null;
    let bestKey = -1;
    for (const rule of this.#rules) {
      if (rule.tool !== toolName && rule.tool !== "*" && !toolName.startsWith(`${rule.tool}:`)) continue;
      if (rule.tokens) {
        // Token rules only apply to bash-style segment matching.
        if (!(toolName === "bash" && tokens !== undefined && isTokenPrefix(rule.tokens, tokens))) continue;
      } else if (rule.url) {
        // #775: URL-scoped rules match the page URL at action time; no
        // page URL in the args means they never match (ask, fail closed).
        if (pageUrl === undefined || !urlGlobMatches(rule.url, pageUrl)) continue;
      } else if (rule.path) {
        if (relPath === undefined) continue;
        if (!(rule.path === relPath || new Bun.Glob(rule.path).match(relPath))) continue;
      }
      // Bare tool-level rules match every invocation of the tool.
      const key = TIER_RANK[rule.tier] * 1000 + ruleSpecificity(rule);
      // Equal specificity: deny wins (fail-safe tie-break, #699).
      if (key > bestKey || (key === bestKey && best !== null && best.effect !== "deny" && rule.effect === "deny")) {
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
