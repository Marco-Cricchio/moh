/**
 * S0.1/B2 normalizer (00-safety-net § 2 B2). Deterministic text-level
 * passes over the recorded artifacts. Exactly what the plan allows:
 *
 * - ULID-shaped ids (event `id`/`parentId`, branch refs) → `<ulid:N>`
 *   ordinal tokens in order of first appearance, so the tree shape and
 *   every aliasing relation survive;
 * - `hash`/`prevHash` chain values (derived from the random ids) →
 *   `<hash:N>` tokens, same rule — chain linkage stays checkable;
 * - ISO timestamps (full and date-only) and `*Ms` duration numbers →
 *   placeholders;
 * - session ids (`20261013T…Z-xxxxxxxx.jsonl` / bare) and the
 *   `…-xxxxxxxx` uuid suffixes they embed → `<session:N>` tokens;
 * - the run's temp home/cwd prefixes (and the OS tmpdir root) →
 *   `<HOME>`/`<CWD>`/`<TMP>`;
 * - the current pid → `<PID>`.
 *
 * Nothing else: file modes, byte sizes, promptVersion, model refs, tool
 * names, message text, field order — all stay byte-for-byte.
 */
import { tmpdir } from "node:os";

const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const HASH_KEY_RE = /("(?:hash|prevHash)":")([0-9a-f]{64})(")/g;
const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b/g;
const CLOCK_RE = /\b\d{2}:\d{2}(?::\d{2})? UTC\b/g;
const MS_KEY_RE = /("[A-Za-z0-9_]+Ms)":(-?\d+(?:\.\d+)?)/g;
/** Durations in rendered prose (`wall 77ms`, `· 0s`). */
const PROSE_DURATION_RE = /\b\d+(?:\.\d+)?(ms|s)\b/g;
const SESSION_FILE_RE = /\b\d{8}T\d{6}\d{3}Z-([0-9a-f]{8})\b/g;
const SESSION_ID_RE = /\bsession-([0-9a-f]{8})\b/g;
const SUBAGENT_CALL_RE = /\bsubagent-([0-9a-f]{8})\b/g;
/** promptVersion hashes the system prompt, which legitimately embeds the
 * session-notes path (temp home) — so the raw value differs per run even
 * for byte-identical prompts modulo the allowed normalizations. Tokenized
 * like the chain hashes: equal prompts → equal tokens, a changed prompt
 → a new token; the full prompt text itself stays compared in
 * requests.json. */
const PROMPT_VERSION_RE = /("promptVersion":")([0-9a-f]{16})(")/g;
const UUID_FULL_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;
const UUID8_RE = /\b[0-9a-f]{8}\b(?=-)/g;
/** The path-derived project slug (`project-` + 16 hex of the cwd's
 * realpath hash) differs per temp cwd; one project per scenario, so a
 * constant placeholder keeps the shape. */
const SLUG_RE = /\bproject-[0-9a-f]{16}\b/g;
/** The status row's project path (the harness's temp cwd, elided by width):
 * `▣ <path> ◉` — UI glyphs frame it, so nothing else can match. */
const IDENTITY_PATH_RE = /(▣ )[^◉]*(◉)/g;
/** The same row when a modal covers its left part: only the elided path
 * tail and the trailing glyph survive (`│wd-XXXXXXXX ◉ dev`). */
const IDENTITY_TAIL_RE = /\b[a-z]{0,5}-[A-Za-z0-9_]{8}(?= ◉)/g;
/** The elided tail of the harness's temp dirs (`…y-home-XXXXXXXX`). */
const PTY_DIR_RE = /y-(home|cwd)-[a-z0-9]{8}\b/g;
/** `session started prompt <8 hex>` — a session id. */
const PROMPT_ID_RE = /\bprompt ([0-9a-f]{8})\b/g;

export interface NormalizerOptions {
  home: string;
  cwd: string;
}

/** Token bookkeeping shared across the passes of ONE artifact. Reused
 * across artifacts would couple their namespaces for no gain: each file
 * is diffed on its own. */
export class Normalizer {
  readonly #home: string;
  readonly #cwd: string;
  readonly #pid: string;
  readonly #tokens = new Map<string, string>();
  readonly #prefixOrder: string[] = [];

  constructor(options: NormalizerOptions) {
    this.#home = options.home;
    this.#cwd = options.cwd;
    this.#pid = String(process.pid);
  }

  #token(prefix: string, value: string): string {
    const key = `${prefix}\u0000${value}`;
    let token = this.#tokens.get(key);
    if (!token) {
      token = `<${prefix}:${this.#tokens.size}>`;
      this.#tokens.set(key, token);
    }
    return token;
  }

  /** Normalizes one artifact's text (events line, serialized JSON, file
   * content). String passes in fixed order; each is idempotent. */
  text(input: string): string {
    let out = input;
    // Longest/most-specific first: absolute paths before their tmpdir
    // prefix, session-file ids before the bare uuid8, ISO before date.
    out = out.split(this.#home).join("<HOME>");
    out = out.split(this.#cwd).join("<CWD>");
    out = out.split(tmpdir()).join("<TMP>");
    out = out.split(this.#pid).join("<PID>");
    out = out.replace(PROMPT_VERSION_RE, (_m, pre: string, pv: string, post: string) => pre + this.#token("pv", pv) + post);
    out = out.replace(HASH_KEY_RE, (_m, pre: string, hash: string, post: string) => pre + this.#token("hash", hash) + post);
    out = out.replace(ULID_RE, (ulid) => this.#token("ulid", ulid));
    out = out.replace(UUID_FULL_RE, (u) => this.#token("uuid", u));
    out = out.replace(SESSION_FILE_RE, (sid) => this.#token("session", sid));
    out = out.replace(SESSION_ID_RE, (sid) => this.#token("session", sid));
    out = out.replace(SUBAGENT_CALL_RE, (sc) => this.#token("subagent", sc));
    out = out.replace(SLUG_RE, () => "<slug>");
    out = out.replace(IDENTITY_PATH_RE, (_m, pre: string, post: string) => `${pre}<path>${post}`);
    out = out.replace(IDENTITY_TAIL_RE, () => "<path>");
    out = out.replace(PTY_DIR_RE, (_m, which: string) => `<pty-${which}>`);
    out = out.replace(PROMPT_ID_RE, () => "prompt <prompt-id>");
    out = out.replace(UUID8_RE, (u) => this.#token("uuid8", u));
    out = out.replace(ISO_RE, () => "<iso>");
    out = out.replace(DATE_RE, () => "<date>");
    out = out.replace(CLOCK_RE, () => "<clock>");
    out = out.replace(MS_KEY_RE, (_m, key: string) => `${key}":<ms>`);
    out = out.replace(PROSE_DURATION_RE, () => "<dur>");
    return out;
  }

  /** Normalizes a relative path (fs.json keys): session file names inside
   * get the same `<session:N>` tokens the events see. */
  path(rel: string): string {
    return this.text(rel);
  }
}
