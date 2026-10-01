/**
 * The one shared secret-redaction module (ADR-0058, #1105).
 *
 * Two complementary layers, one heuristic, every redacted seam:
 *
 * 1. **Key-based** — keys whose normalized form is exactly a secret-shaped
 *    name (`apiKey`, `token`, `authorization`, …) have their value replaced,
 *    wherever they appear in the event structure. Extends the ADR-0032
 *    extension-event heuristic; exact match on purpose, so `tokens` and
 *    `tokenCount` survive.
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

/** Nesting depth the key-based walk covers (deeper values pass through). */
export const REDACT_DEPTH = 6;

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

/** Returns a structurally-redacted copy (ADR-0032 layer). Cycles safe. */
export function redactKeys(value: unknown, depth = 0): unknown {
  if (depth > REDACT_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => redactKeys(v, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEYS.has(normalizeKey(k)) ? REDACTED : redactKeys(v, depth + 1);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Pattern layer: high-confidence secret shapes in free text
// ---------------------------------------------------------------------------

/** Key vocabulary of the credential-assignment pattern (shared with the
 * lookalike detector). Bare `token` included; `tokens`/`tokenCount`
 * survive via `\b`. */
const CREDENTIAL_KEYS =
  "api[_-]?key|secret[_-]?key|auth[_-]?token|token|password|passwd|api[_-]?token|access[_-]?token";

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
  // PASSWORD="…", etc. Only when the value looks opaque (long enough).
  {
    category: "credential-assignment",
    re: new RegExp(
      `\\b(?:${CREDENTIAL_KEYS})\\b(\\s*[:=]\\s*|\\s+)(["']?)[A-Za-z0-9._~+/=-]{12,}\\2`,
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
}

/**
 * The combined pass: key-based masking and pattern-based free-text
 * masking in one structural walk, plus lookalike detection on the
 * strings that passed unmasked. Never mutates the input.
 */
export function redactValue(value: unknown, depth = 0): RedactionResult {
  const misses: RedactionMiss[] = [];
  const walk = (v: unknown, d: number): unknown => {
    if (d > REDACT_DEPTH) return v;
    if (typeof v === "string") {
      const redacted = redactString(v);
      if (redacted === v) {
        for (const m of detectSecretLookalikes(v)) misses.push(m);
        return v;
      }
      return redacted;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, d + 1));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        out[k] = REDACTED_KEYS.has(normalizeKey(k)) ? REDACTED : walk(x, d + 1);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, depth), misses };
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
