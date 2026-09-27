/**
 * ADR-0049 (door one, #986): the corpus that lets recognition grow.
 *
 * A refusal whose wording moh does not recognize teaches nothing, and the
 * session log keeps only its truncated message — so what is missing is a
 * place where unrecognized refusals *accumulate*, across providers and
 * across sessions. That place is a small diagnostic file in the user's
 * own moh directory (`~/.moh/context-refusals.log`), one JSON object per
 * line:
 *
 *     {"at":"...","last":"...","endpoint":"openrouter","model":"openrouter/x",
 *      "message":"This deployment's context capacity ...","count":3}
 *
 * Honesty rules: it carries nothing of the conversation beyond the text
 * the provider itself put in its refusal, it is **deduplicated** — the
 * same wording (numbers masked, so a different *requested* count from the
 * same provider is the same gap) increments `count` instead of appending a
 * second line — and it is **bounded**: at most
 * `CONTEXT_REFUSAL_MAX_ENTRIES` distinct wordings, the oldest-evicted
 * first. Writing it is fail-silent and can never affect a turn.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** File name inside the user's moh home. */
export const CONTEXT_REFUSALS_FILE = "context-refusals.log";
/** Distinct refusal wordings kept; beyond this the oldest (`last`) goes. */
export const CONTEXT_REFUSAL_MAX_ENTRIES = 50;
/** Chars of the provider's own text kept per entry. */
export const CONTEXT_REFUSAL_EXCERPT_CHARS = 300;

export interface ContextRefusalTraceEntry {
  /** ISO date of the first sighting. */
  at: string;
  /** ISO date of the most recent sighting. */
  last: string;
  /** Endpoint type (`openrouter`, `anthropic`, ...), when resolvable. */
  endpoint?: string;
  /** The model reference that was refused (`endpoint/model-id`). */
  model: string;
  /** Cleaned excerpt of the provider's own refusal text. */
  message: string;
  /** How many times this wording was seen. */
  count: number;
}

/** Absolute path of the trace file. */
export function contextRefusalsFile(home: string): string {
  return join(home, CONTEXT_REFUSALS_FILE);
}

/**
 * One line of the provider's text as the file keeps it: escape sequences
 * and control characters dropped, whitespace collapsed, capped — the
 * provider's wording, never a rewrite of it.
 */
export function cleanRefusalExcerpt(message: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = message.replace(/\u001b\[[0-9;]*[A-Za-z]/g, " ").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > CONTEXT_REFUSAL_EXCERPT_CHARS ? `${cleaned.slice(0, CONTEXT_REFUSAL_EXCERPT_CHARS - 1)}…` : cleaned;
}

/** Dedup key: the wording with every digit run masked. The requested
 * tokens (234666, 234690) are the same gap with a different number, and
 * the corpus is collected for its *wording*. The entry keeps the first
 * verbatim excerpt, so nothing is lost for the reader. */
function wordingKey(entry: Pick<ContextRefusalTraceEntry, "endpoint" | "model" | "message">): string {
  return `${entry.endpoint ?? ""}\u0000${entry.model}\u0000${entry.message.replace(/\d+/g, "#")}`;
}

function readEntries(file: string): ContextRefusalTraceEntry[] {
  if (!existsSync(file)) return [];
  try {
    const entries: ContextRefusalTraceEntry[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Partial<ContextRefusalTraceEntry>;
        if (typeof parsed?.message === "string" && typeof parsed?.model === "string" && typeof parsed?.count === "number") {
          entries.push({
            at: typeof parsed.at === "string" ? parsed.at : "",
            last: typeof parsed.last === "string" ? parsed.last : "",
            ...(typeof parsed.endpoint === "string" ? { endpoint: parsed.endpoint } : {}),
            model: parsed.model,
            message: parsed.message,
            count: parsed.count,
          });
        }
      } catch {
        // A torn or hand-edited line is skipped, never fatal: this file is
        // a diagnostic, and losing one line cannot lose a turn.
      }
    }
    return entries.slice(-CONTEXT_REFUSAL_MAX_ENTRIES);
  } catch {
    return [];
  }
}

/**
 * Records one refusal moh could not read a window from. Identical wording
 * increments the existing entry's count; a new wording appends one entry
 * and evicts the oldest beyond the cap. Never throws.
 */
export function noteUnrecognizedContextRefusal(input: {
  home: string;
  endpoint?: string;
  model: string;
  message: string;
  /** Injectable clock (tests). */
  now?: Date;
}): void {
  const stamp = (input.now ?? new Date()).toISOString();
  const entry = {
    endpoint: input.endpoint,
    model: input.model.trim(),
    message: cleanRefusalExcerpt(input.message),
  };
  try {
    const file = contextRefusalsFile(input.home);
    const entries = readEntries(file);
    const key = wordingKey(entry);
    const existing = entries.find((candidate) => wordingKey(candidate) === key);
    if (existing) {
      existing.count += 1;
      existing.last = stamp;
    } else {
      entries.push({
        at: stamp,
        last: stamp,
        ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
        model: entry.model,
        message: entry.message,
        count: 1,
      });
    }
    const kept = entries.length > CONTEXT_REFUSAL_MAX_ENTRIES
      ? [...entries].sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0)).slice(0, CONTEXT_REFUSAL_MAX_ENTRIES)
      : entries;
    writeEntries(file, kept);
  } catch {
    // Diagnostics never block: an unwritable home (read-only, permissions)
    // leaves the refusal in the session log, exactly as before.
  }
}

function writeEntries(file: string, entries: readonly ContextRefusalTraceEntry[]): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, body ? `${body}\n` : "", { mode: 0o600 });
  renameSync(tmp, file);
}
