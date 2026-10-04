/**
 * The one shared secret-redaction module (ADR-0058, #1105).
 *
 * Two complementary layers, one heuristic, every redacted seam:
 *
 * 1. **Key-based** — keys whose normalized form is secret-shaped (the
 *    ADR-0032 exact set, extended by the audit-v3 RED-2 suffix rule for
 *    long env-var forms: `*_API_KEY`, `*_ACCESS_KEY`, `*_TOKEN`, any name
 *    containing `secret`) have their value replaced, wherever they appear
 *    in the event structure. Suffixes only, so `tokens` and `tokenCount`
 *    survive.
 *
 * 2. **Pattern-based** — high-confidence secret *shapes* in free text
 *    (sk-style keys, Bearer headers, AWS/GitHub/Slack/Google tokens,
 *    `api_key=`/`token=` params and quoted env-assignments, credentials in
 *    URLs, PEM private-key blocks). Precision over recall: the patterns must
 *    not corrupt legitimate code in tool output.
 *
 * Every masked value becomes the fixed `[redacted]` placeholder — no hash,
 * no partial masking (ADR-0058). The module never mutates its input; the
 * in-memory context stays untouched and the redaction exists only at
 * persistence.
 *
 * A lookalike that *passed* unmasked (a looser detector saw a secret-shaped
 * string the high-confidence patterns did not mask) leaves a bounded,
 * deduplicated, content-free line in a diagnostic file in the user's moh
 * dotdir (`secret-redaction-misses.log`) — the ADR-0049 corpus precedent:
 * the evidence the next pattern is written from, never its content.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The fixed placeholder every masked value becomes (ADR-0058). */
export const REDACTED = "[redacted]";

/** Nesting depth the copy-and-scan walk covers in one pass. Below it the
 * deep pass still scans (and masks when needed) down to DEEP_SCAN_DEPTH;
 * deeper still, a depth-cut miss line is the tripwire. */
export const REDACT_DEPTH = 6;

/** How far below REDACT_DEPTH the deep pass scans (audit-v3 RED-1): the
 * scan is read-only, so the bound is stack safety, not coverage — the
 * combined 6+100 reach dwarfs any real event payload. */
export const DEEP_SCAN_DEPTH = 100;

/** The ADR-0032 secret-shaped key set: EXACT normalized match only. */
const REDACTED_KEYS = new Set([
  "apikey",
  "apitoken",
  "accesstoken",
  "refreshtoken",
  "token",
  "secret",
  "clientsecret",
  "password",
  "passwd",
  "authorization",
  "credentials",
  "privatekey",
  "sessionkey",
]);

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/**
 * audit-v3 RED-2: the exact set above misses common long env-var forms.
 * A normalized name is secret-shaped when it ends in `apikey`,
 * `accesskey` or `token`, or contains `secret`. Suffixes only —
 * `tokens`, `tokenCount` and `apiKeyId` keep surviving.
 */
function isSecretKey(normalized: string): boolean {
  return (
    REDACTED_KEYS.has(normalized) ||
    /api_?key$/.test(normalized) ||
    /access_?key$/.test(normalized) ||
    /token$/.test(normalized) ||
    normalized.includes("secret")
  );
}

/** Returns a structurally-redacted copy (ADR-0032 layer). Cycles safe. */
export function redactKeys(value: unknown, depth = 0): unknown {
  return walkValue(value, depth, (v) => v);
}

/**
 * The one structural walk both layers share: visits every node up to
 * REDACT_DEPTH, masking secret-shaped keys, and hands each string to
 * `onString` (identity for the keys-only layer, the pattern pass for the
 * combined one). A node deeper than REDACT_DEPTH goes to `deepPass`
 * (audit-v3 RED-1) instead of passing through. Cycles safe; never mutates.
 */
function walkValue(value: unknown, depth: number, onString: (s: string) => string, cut?: { depthCut: boolean }): unknown {
  if (depth > REDACT_DEPTH) return deepPass(value, onString, cut);
  if (typeof value === "string") return onString(value);
  if (Array.isArray(value)) return value.map((v) => walkValue(v, depth + 1, onString, cut));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(normalizeKey(k)) ? REDACTED : walkValue(v, depth + 1, onString, cut);
    }
    return out;
  }
  return value;
}

/**
 * audit-v3 RED-1: what sits below REDACT_DEPTH. A read-only scan — no
 * copies — answers "does anything here need masking?"; only then is the
 * subtree rebuilt with the same masking rules, down to DEEP_SCAN_DEPTH.
 * A clean deep payload costs a scan, not a copy, and raises no miss
 * line; past the bound `cut.depthCut` is raised so the dedup report
 * keeps its tripwire. Cycle-safe (shared subgraphs are scanned once and
 * only their first occurrence rebuilt — real event payloads are trees).
 */
function deepPass(value: unknown, onString: (s: string) => string, cut?: { depthCut: boolean }): unknown {
  // One cycle guard per phase: the scan marks every node it visited, so
  // the mask walk must carry its own set or it would skip everything.
  const scanSeen = new Set<object>();
  const maskSeen = new Set<object>();
  let overflow = false;
  const scan = (v: unknown, d: number): boolean => {
    if (d > DEEP_SCAN_DEPTH) {
      overflow = true;
      return false;
    }
    if (typeof v === "string") return onString(v) !== v;
    if (Array.isArray(v)) {
      if (scanSeen.has(v)) return false;
      scanSeen.add(v);
      return v.some((x) => scan(x, d + 1));
    }
    if (v !== null && typeof v === "object") {
      if (scanSeen.has(v)) return false;
      scanSeen.add(v);
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (isSecretKey(normalizeKey(k))) return true;
        if (scan(x, d + 1)) return true;
      }
    }
    return false;
  };
  if (!scan(value, 0)) {
    if (overflow && cut) cut.depthCut = true;
    return value;
  }
  const mask = (v: unknown, d: number): unknown => {
    if (d > DEEP_SCAN_DEPTH) return v; // scan already raised the cut
    if (typeof v === "string") return onString(v);
    if (Array.isArray(v)) {
      if (maskSeen.has(v)) return v;
      maskSeen.add(v);
      return v.map((x) => mask(x, d + 1));
    }
    if (v !== null && typeof v === "object") {
      if (maskSeen.has(v)) return v;
      maskSeen.add(v);
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] = isSecretKey(normalizeKey(k)) ? REDACTED : mask(x, d + 1);
      }
      return out;
    }
    return v;
  };
  return mask(value, 0);
}

// ---------------------------------------------------------------------------
// Pattern layer: high-confidence secret shapes in free text
// ---------------------------------------------------------------------------

/** Key vocabulary of the credential-assignment pattern (shared with the
 * lookalike detector). Bare `token` included; `tokens`/`tokenCount`
 * survive via `\b`. A word prefix is allowed in front of the vocab
 * (audit-v3 RED-2), so compound env-var names — `ANTHROPIC_API_KEY`,
 * `AWS_SECRET_ACCESS_KEY` — match; the trailing `\b` keeps `tokens` out. */
const CREDENTIAL_KEYS =
  "api[_-]?key|secret[_-]?key|auth[_-]?token|token|password|passwd|api[_-]?token|access[_-]?token|access[_-]?key";

interface SecretPattern {
  category: string;
  re: RegExp;
  replace: (match: string) => string;
}

/** Bounded quantifiers everywhere: no catastrophic backtracking on the
 * write seam's hot path. Length floors keep the false-positive rate off
 * legitimate code (short identifiers, hex checksums are addressed by the
 * lookalike detector below, not by masking). */
const SECRET_PATTERNS: SecretPattern[] = [
  // `sk-` style provider keys (openai/openrouter-style prefixes).
  { category: "sk-key", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: () => REDACTED },
  // Bearer auth headers and assignments (the word survives, the value goes).
  {
    category: "bearer",
    re: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: (m) => `${m.split(/\s+/)[0]} ${REDACTED}`,
  },
  // AWS access key id.
  { category: "aws-key", re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => REDACTED },
  // GitHub tokens (classic + fine-grained + app).
  { category: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b/g, replace: () => REDACTED },
  // Slack tokens.
  { category: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => REDACTED },
  // Google API key.
  { category: "google-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => REDACTED },
  // Query params and key=value assignments: api_key=…, token: '…',
  // PASSWORD="…", ANTHROPIC_API_KEY=…, etc. Only when the value looks
  // opaque (long enough).
  {
    category: "credential-assignment",
    re: new RegExp(
      `\\b[A-Za-z0-9_-]*?(?:${CREDENTIAL_KEYS})\\b(\\s*[:=]\\s*|\\s+)(["']?)[A-Za-z0-9._~+/=-]{12,}\\2`,
      "gi",
    ),
    replace: (m) =>
      m.replace(
        /([:=]\s*|\s+)(["']?)[A-Za-z0-9._~+/=-]{12,}(["']?)$/,
        (_full, sep: string, q1: string, q2: string) => `${sep}${q1}${REDACTED}${q2}`,
      ),
  },
  // Credentials embedded in URLs: scheme://user:password@host — the
  // scheme and user survive, the password half is masked.
  {
    category: "url-credentials",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/gi,
    replace: (m) => m.replace(/:([^/:@]+)@/, `:${REDACTED}@`),
  },
  // PEM private key blocks, any key type.
  {
    category: "private-key",
    re: /-----BEGIN (?:[A-Z ]*)PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z ]*)PRIVATE KEY(?: BLOCK)?-----/g,
    replace: () => REDACTED,
  },
];

/**
 * Masks high-confidence secret shapes in one string. Never mutates.
 * The patterns use bounded quantifiers, so a long line costs linearly;
 * there is no length cutoff — a secret has no minimum document size.
 */
export function redactString(text: string): string {
  let out = text;
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * The looser evidence detector (ADR-0049-style corpus): strings that
 * *look* secret-shaped but were not masked by the high-confidence layer —
 * generic key=value assignments with long opaque values, and long opaque
 * token-shaped words. Their *category and length* only ever leave the
 * process (one dedup line in the miss-report); never the content.
 */
export function detectSecretLookalikes(text: string): { category: string; length: number }[] {
  const hits: { category: string; length: number }[] = [];
  // Generic assignment with a long opaque value (any key name).
  const assignment = /\b([A-Za-z][A-Za-z0-9_-]{1,40})\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{24,})["']?/g;
  const credentialKey = new RegExp(`^(?:${CREDENTIAL_KEYS})$`, "i");
  for (const m of text.matchAll(assignment)) {
    const key = m[1]!.toLowerCase();
    if (credentialKey.test(key)) continue; // masked by the pattern layer
    // Hash-looking values of neutral names (checksum, sha, hash) are not
    // credentials — but the corpus, not a heuristic, settles that: report
    // them under an explicit category and let the evidence decide.
    const category = /^(sha|hash|checksum|md5|digest|commit|etag|signature)/.test(key)
      ? "hash-like-assignment"
      : "opaque-assignment";
    hits.push({ category, length: m[2]!.length });
  }
  // Long opaque words that look like raw tokens (deliberately loose; this
  // is the recall half of the detector).
  const opaque = /\b[A-Za-z0-9_-]{40,}\b/g;
  for (const m of text.matchAll(opaque)) {
    hits.push({ category: "opaque-word", length: m[0].length });
  }
  return hits.slice(0, 8);
}

export interface RedactionMiss {
  category: string;
  length: number;
}

/** Result of the combined pass over one value. */
export interface RedactionResult {
  value: unknown;
  /** Content-free lookalike reports (key names are not included). */
  misses: RedactionMiss[];
  /** True when part of the structure sat deeper than REDACT_DEPTH and
   * passed unscanned. The depth cap is a performance bound, not an
   * exemption: whatever it cut is reported so a real secret hiding below
   * it leaves evidence (never silence). */
  depthCut: boolean;
}

/**
 * The combined pass: key-based masking and pattern-based free-text
 * masking in one structural walk, plus lookalike detection on the
 * strings that passed unmasked. Never mutates the input.
 */
export function redactValue(value: unknown, depth = 0): RedactionResult {
  const misses: RedactionMiss[] = [];
  let depthCut = false;
  const value2 = walkValue(
    value,
    depth,
    (s) => {
      const redacted = redactString(s);
      if (redacted === s) {
        // Deliberate asymmetry ("precision over recall"): the lookalike
        // detector runs only on strings the pattern layer left untouched —
        // a string with one masked secret plus one unmasked lookalike
        // reports nothing, because the dominant shape was caught.
        for (const m of detectSecretLookalikes(s)) misses.push(m);
        return s;
      }
      return redacted;
    },
    { get depthCut() { return depthCut; }, set depthCut(v: boolean) { depthCut = v; } },
  );
  return { value: value2, misses, depthCut };
}

// ---------------------------------------------------------------------------
// Miss-report: the ADR-0049-style evidence file
// ---------------------------------------------------------------------------

/** File name inside the user's moh home. */
export const SECRET_REDACTION_MISSES_FILE = "secret-redaction-misses.log";
/** Distinct shapes kept; beyond this the oldest goes. */
export const SECRET_REDACTION_MAX_ENTRIES = 50;

export interface SecretRedactionMissEntry {
  at: string;
  last: string;
  /** Content-free shape descriptor (e.g. `opaque-assignment:24`). */
  shape: string;
  count: number;
}

/** Absolute path of the miss-report file. */
export function secretRedactionMissesFile(home: string): string {
  return join(home, SECRET_REDACTION_MISSES_FILE);
}

function readMissEntries(file: string): SecretRedactionMissEntry[] {
  if (!existsSync(file)) return [];
  try {
    const entries: SecretRedactionMissEntry[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        entries.push(JSON.parse(trimmed) as SecretRedactionMissEntry);
      } catch {
        break;
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Records one content-free lookalike report. Identical shapes increment
 * the entry's count; new shapes append and the oldest evicts beyond the
 * cap. Never throws — diagnostics never block a write.
 */
export function noteSecretRedactionMiss(input: {
  home: string;
  shape: string;
  now?: Date;
}): void {
  const stamp = (input.now ?? new Date()).toISOString();
  try {
    const file = secretRedactionMissesFile(input.home);
    const entries = readMissEntries(file);
    const existing = entries.find((e) => e.shape === input.shape);
    if (existing) {
      existing.count += 1;
      existing.last = stamp;
    } else {
      entries.push({ at: stamp, last: stamp, shape: input.shape, count: 1 });
    }
    const kept =
      entries.length > SECRET_REDACTION_MAX_ENTRIES
        ? [...entries]
            .sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0))
            .slice(0, SECRET_REDACTION_MAX_ENTRIES)
        : entries;
    const dir = dirname(file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Diagnostics never block.
  }
}

/**
 * Records the misses of one redaction pass as deduplicated, content-free
 * shape lines (`category:length`). One call per written event at most.
 */
export function noteSecretRedactionMisses(home: string, misses: RedactionMiss[]): void {
  const seen = new Set<string>();
  for (const m of misses) {
    const shape = `${m.category}:${m.length}`;
    if (seen.has(shape)) continue;
    seen.add(shape);
    noteSecretRedactionMiss({ home, shape });
  }
}

/** The shape line a depth cut writes (once per pass, content-free). */
export const DEPTH_CUT_MISS_SHAPE = "depth-cut";

/**
 * Records the misses of one redaction pass as deduplicated, content-free
 * shape lines (`category:length`). A depth cut — structure that sat
 * deeper than the walk's ceiling and passed unscanned — is itself a
 * reported miss: the cap is a performance bound, never silent silence.
 */
export function noteRedactionResult(home: string, result: RedactionResult): void {
  if (result.depthCut) noteSecretRedactionMiss({ home, shape: DEPTH_CUT_MISS_SHAPE });
  noteSecretRedactionMisses(home, result.misses);
}
