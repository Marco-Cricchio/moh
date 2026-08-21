/**
 * Memory (#38): durable facts kept across sessions, per project, at
 * `~/.moh/projects/<slug>/memory/` — an `index.json` plus append-only
 * topic files. The core only ever *appends* atomically under a file
 * lock; rewriting (consolidation, newest-wins with a note) is the
 * exclusive privilege of the maintenance subagent.
 *
 * Domain rule (see CONTEXT.md): no fact is stored in both Memory and a
 * compaction summary — compaction must exclude memory-covered facts
 * (encoded in MAINTENANCE_PROMPT for when compaction lands).
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { projectSlug } from "./session-store";
import type { AgentEvent } from "./types";

/** One durable fact, filed under a short topic label. */
export interface MemoryEntry {
  /** Short topic label (e.g. "testing", "provider-routing"). */
  topic: string;
  /** The fact itself, one line, no secrets. */
  fact: string;
}

/** Input handed to a memory extractor (the maintenance subagent by default). */
export interface MemoryExtractorInput {
  /** Recent conversation text (user/assistant turns since the last extraction). */
  transcript: string;
  /** Known topic labels, so the extractor can file under existing topics. */
  topics: string[];
  /** Current memory excerpt (so covered facts are not re-suggested). */
  memory: string;
}

/** Extracts durable facts from a transcript. Runs fail-silent in the core. */
export type MemoryExtractor = (input: MemoryExtractorInput) => Promise<MemoryEntry[]>;

/** moh.json `memory` block; `memory.enabled: false` disables everything. */
export const memoryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /** Extraction every N completed turns. Default 5. */
  intervalTurns: z.number().int().positive().optional(),
  /** Hard budget for the injected section, in tokens (~4 chars each). Default 2000. */
  budgetTokens: z.number().int().positive().optional(),
});

/** Memory options accepted by `createSession`. */
export interface MemoryOptions {
  /** Default true; `false` = no writes, no section, no subagent runs. */
  enabled?: boolean;
  intervalTurns?: number;
  budgetTokens?: number;
  /** Memory directory override (tests). Default: <mohHome>/projects/<slug>/memory. */
  dir?: string;
  /** Extractor override (tests, clients). Default: the maintenance subagent. */
  extractor?: MemoryExtractor;
}

export const DEFAULT_MEMORY_INTERVAL_TURNS = 5;
export const DEFAULT_MEMORY_BUDGET_TOKENS = 2000;
/** ~4 characters per token, the usual rough conversion. */
export const CHARS_PER_TOKEN = 4;
/** Consolidation caps: entries per topic kept after newest-wins dedup. */
export const MAX_ENTRIES_PER_TOPIC = 40;

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_STALE_MS = 15_000;
const LOCK_POLL_MS = 10;

/** Max entries accepted from one extraction (protects the store). */
export const MAX_ENTRIES_PER_EXTRACTION = 25;

interface MemoryIndexEntry {
  file: string;
  entries: number;
  updated: string;
}

interface MemoryIndex {
  version: 1;
  topics: Record<string, MemoryIndexEntry>;
}

/** Topic label → safe file name (append-only `<topic>.md` files). */
export function topicFileName(topic: string): string {
  const slug = topic
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "notes"}.md`;
}

function entryLine(fact: string, now: Date, sessionId: string): string {
  return `- ${fact} (${now.toISOString().slice(0, 10)}, ${sessionId})`;
}

/** Parses one topic file into its append-only entry lines (comments dropped). */
function topicLines(raw: string): string[] {
  return raw.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("<!--"));
}

/**
 * The per-project memory store. All writes happen under a lock file
 * (best-effort cross-process; stale locks are reclaimed), the index is
 * rewritten atomically (temp + rename), and topic files only ever grow
 * — except in `consolidate`, the maintenance-subagent-only operation.
 */
export class MemoryStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** <mohHome>/projects/<slug>/memory — sibling of the session logs. */
  static forProject(cwd: string, mohHome = join(homedir(), ".moh")): MemoryStore {
    return new MemoryStore(join(mohHome, "projects", projectSlug(cwd), "memory"));
  }

  get indexFile(): string {
    return join(this.dir, "index.json");
  }

  get #lockFile(): string {
    return join(this.dir, ".lock");
  }

  /** Reads the index; a missing dir/file is the empty index. */
  readIndex(): MemoryIndex {
    try {
      const parsed = JSON.parse(readFileSync(this.indexFile, "utf8")) as MemoryIndex;
      if (parsed && parsed.version === 1 && typeof parsed.topics === "object") return parsed;
    } catch {
      // missing or corrupt index: treat as empty (append rebuilds it)
    }
    return { version: 1, topics: {} };
  }

  /** Known topic labels, most recently updated first. */
  topics(): string[] {
    return Object.entries(this.readIndex().topics)
      .sort((a, b) => (a[1].updated < b[1].updated ? 1 : -1))
      .map(([topic]) => topic);
  }

  /**
   * Appends entries atomically under the file lock: each topic file gets
   * dated, session-signed lines; the index is swapped in with a rename.
   * Never rewrites existing topic-file bytes.
   */
  async append(entries: ReadonlyArray<MemoryEntry>, sessionId: string, now = new Date()): Promise<void> {
    if (entries.length === 0) return;
    await this.#withLock(() => {
      mkdirSync(this.dir, { recursive: true });
      const index = this.readIndex();
      const byTopic = new Map<string, string[]>();
      for (const entry of entries) {
        const topic = entry.topic.trim().slice(0, 64) || "notes";
        const fact = entry.fact.trim().replace(/\s+/g, " ").slice(0, 500);
        if (!fact) continue;
        const list = byTopic.get(topic) ?? [];
        list.push(entryLine(fact, now, sessionId));
        byTopic.set(topic, list);
      }
      for (const [topic, lines] of byTopic) {
        appendFileSync(this.topicFile(topic), lines.join("\n") + "\n");
        const existing = index.topics[topic];
        index.topics[topic] = {
          file: topicFileName(topic),
          entries: (existing?.entries ?? 0) + lines.length,
          updated: now.toISOString(),
        };
      }
      this.#writeIndex(index);
    });
  }

  topicFile(topic: string): string {
    return join(this.dir, topicFileName(topic));
  }

  /**
   * Renders the memory excerpt for the system prompt, newest topic
   * first, hard-capped at `budgetChars` with a truncation note.
   * Empty string when there is nothing (the section is then omitted).
   */
  read(budgetChars: number): string {
    const index = this.readIndex();
    const topics = Object.entries(index.topics).sort((a, b) => (a[1].updated < b[1].updated ? 1 : -1));
    if (topics.length === 0) return "";
    const blocks: string[] = [];
    let used = 0;
    let truncated = false;
    for (const [topic, meta] of topics) {
      let raw: string;
      try {
        raw = readFileSync(this.topicFile(topic), "utf8");
      } catch {
        continue; // topic file vanished: skip, never throw
      }
      const lines = topicLines(raw);
      const heading = `### ${topic}`;
      if (used + heading.length + 1 > budgetChars) {
        truncated = true;
        break;
      }
      const remaining = budgetChars - used - heading.length - 1;
      const kept: string[] = [];
      let chars = 0;
      for (const line of lines) {
        if (chars + line.length + 1 > remaining) {
          truncated = true;
          break;
        }
        kept.push(line);
        chars += line.length + 1;
      }
      if (kept.length === 0 && lines.length > 0) {
        truncated = true;
        continue;
      }
      used += heading.length + 1 + chars;
      blocks.push(`${heading}\n${kept.join("\n")}`);
    }
    if (blocks.length === 0) return truncated ? "[memory truncated: budget too small]" : "";
    let text = blocks.join("\n\n");
    if (truncated) text += `\n\n[memory truncated: ${budgetChars} character budget]`;
    return text;
  }

  /**
   * Maintenance-subagent-only rewrite: newest-wins dedup of identical
   * facts (case-insensitive) plus a per-topic entry cap, with a dated
   * consolidation note recorded in each rewritten file. Returns the
   * number of lines dropped.
   */
  async consolidate(sessionId: string, now = new Date()): Promise<number> {
    return this.#withLock(() => {
      const index = this.readIndex();
      let totalDropped = 0;
      for (const [topic, meta] of Object.entries(index.topics)) {
        let raw: string;
        try {
          raw = readFileSync(this.topicFile(topic), "utf8");
        } catch {
          continue;
        }
        const lines = topicLines(raw);
        const seen = new Set<string>();
        const kept: string[] = [];
        let dropped = 0;
        for (const line of [...lines].reverse()) {
          const fact = line.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
          if (seen.has(fact)) {
            dropped += 1;
            continue;
          }
          seen.add(fact);
          kept.push(line);
        }
        kept.reverse();
        const overflow = Math.max(0, kept.length - MAX_ENTRIES_PER_TOPIC);
        const finalLines = overflow > 0 ? kept.slice(overflow) : kept;
        dropped += overflow;
        totalDropped += dropped;
        if (dropped === 0) continue;
        const note = `<!-- consolidated ${now.toISOString()} by ${sessionId}: duplicates dropped -->`;
        writeFileSync(this.topicFile(topic), `${note}\n${finalLines.join("\n")}\n`);
        index.topics[topic] = { ...meta, entries: finalLines.length, updated: now.toISOString() };
      }
      this.#writeIndex(index);
      return totalDropped;
    });
  }

  #writeIndex(index: MemoryIndex): void {
    const tmp = join(this.dir, `index.json.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(index, null, 2)}\n`);
    renameSync(tmp, this.indexFile);
  }

  async #withLock<T>(fn: () => T | Promise<T>): Promise<T> {
    await this.#acquireLock();
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(this.#lockFile);
      } catch {
        // already gone (stale reclaim race): nothing to do
      }
    }
  }

  async #acquireLock(): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      if (existsSync(this.#lockFile)) {
        try {
          if (Date.now() - statSync(this.#lockFile).mtimeMs > LOCK_STALE_MS) unlinkSync(this.#lockFile);
        } catch {
          // raced away: retry below
        }
      } else {
        try {
          closeSync(openSync(this.#lockFile, "wx"));
          return;
        } catch {
          // someone else got it
        }
      }
      if (Date.now() > deadline) throw new Error(`memory lock timeout after ${LOCK_TIMEOUT_MS}ms`);
      await Bun.sleep(LOCK_POLL_MS);
    }
  }
}

/**
 * Builds the extraction transcript from the event log since `from`:
 * user and assistant text only, newest kept when the cap applies.
 */
export function memoryTranscript(events: ReadonlyArray<AgentEvent>, from: number, capChars = 24_000): string {
  const parts: string[] = [];
  let assistant = "";
  const flush = () => {
    if (assistant.trim()) parts.push(`assistant: ${assistant.trim()}`);
    assistant = "";
  };
  for (let i = from; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === "user_message") {
      flush();
      parts.push(`user: ${event.text.trim()}`);
    } else if (event.type === "assistant_delta") {
      assistant += event.text;
      if (assistant.length > capChars) assistant = assistant.slice(-capChars);
    } else if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
      flush();
    }
  }
  flush();
  let text = parts.join("\n");
  if (text.length > capChars) text = text.slice(-capChars);
  return text;
}

/** The maintenance subagent's role prompt (also the compaction domain rule). */
export const MAINTENANCE_PROMPT = [
  "You are moh's memory maintenance subagent. You extract durable, cross-session facts from a conversation transcript and file them into project memory.",
  "",
  "Rules:",
  '- Respond with ONLY a JSON array: [{"topic": "<short label>", "fact": "<one line>"}] — an empty array when nothing qualifies.',
  "- Keep only durable facts: user preferences, project conventions, decisions, corrections. Skip transient chatter, secrets, and anything true only of this one task.",
  "- Reuse existing topic labels when they fit; keep topics short (1-3 words).",
  "- Never re-suggest a fact already present in the given memory excerpt.",
  "- Never store credentials, tokens, or personal data.",
  "- Domain rule: facts stored in memory must never also appear in compaction summaries — memory and compaction are disjoint stores.",
].join("\n");

/**
 * Parses the maintenance subagent's reply into validated entries.
 * Throws on unparseable output (the caller fails silent); accepts the
 * JSON array anywhere in the text (models add prose around it).
 */
export function parseMemoryEntries(text: string): MemoryEntry[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) throw new Error("no JSON array found in extractor output");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new Error(`invalid extractor JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(parsed)) throw new Error("extractor output is not an array");
  const entries: MemoryEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) continue;
    const topic = String((item as Record<string, unknown>).topic ?? "").trim();
    const fact = String((item as Record<string, unknown>).fact ?? "").trim();
    if (topic && fact) entries.push({ topic: topic.slice(0, 64), fact: fact.slice(0, 500) });
  }
  return entries.slice(0, MAX_ENTRIES_PER_EXTRACTION);
}

/** Convenience for tests and clients building a scripted extractor. */
export function scriptedExtractor(entries: MemoryEntry[]): MemoryExtractor {
  return async () => [...entries];
}
