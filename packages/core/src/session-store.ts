import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentEvent, Message } from "./types";
import { SCHEMA_VERSION } from "./types";

/**
 * Oldest schemaVersion this build can load. Logs older than this fail with
 * a clear "start a new session" error instead of mis-replaying.
 */
export const MIN_SUPPORTED_SCHEMA_VERSION = 1;

const SESSION_ID_RE = /^\d{8}T\d{6}\d{3}Z-[0-9a-f]{8}$/;

/**
 * New session id: sortable UTC timestamp (millisecond precision so ids are
 * strictly increasing within a process) + short uuid. Lexicographic order
 * of filenames equals chronological order of sessions.
 */
export function newSessionId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:.]/g, "");
  const uuid = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${ts}-${uuid}`;
}

/** Project slug: sanitized basename + short hash of the resolved cwd. */
export function projectSlug(cwd: string): string {
  const resolved = pathResolve(cwd);
  const base = basename(resolved).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/** Directory holding the project's session files: <home>/.moh/projects/<slug> */
export function projectSessionsDir(cwd: string, home = homedir()): string {
  return join(home, ".moh", "projects", projectSlug(cwd));
}

function isSessionFile(name: string): boolean {
  return name.endsWith(".jsonl") && SESSION_ID_RE.test(name.slice(0, name.length - ".jsonl".length));
}

/**
 * Append-only JSONL persistence for one session file. The store never
 * interprets events; it only makes them durable. Sessions are user data
 * and never live inside the project's `.moh/`.
 */
export class SessionStore {
  readonly #file: string;

  private constructor(file: string) {
    this.#file = file;
  }

  /** Path of the backing JSONL file. */
  get file(): string {
    return this.#file;
  }

  /** Creates a fresh session file for the project rooted at `cwd`. */
  static create(cwd: string, home = homedir()): SessionStore {
    const dir = projectSessionsDir(cwd, home);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${newSessionId()}.jsonl`);
    writeFileSync(file, "");
    return new SessionStore(file);
  }

  /** Reopens an existing session file for appending. */
  static open(file: string): SessionStore {
    if (!isAbsolute(file)) throw new Error(`session file path must be absolute: ${file}`);
    return new SessionStore(file);
  }

/**
   * The project's session files, newest first (empty array when none).
   */
  static list(cwd: string, home = homedir()): SessionStore[] {
    const dir = projectSessionsDir(cwd, home);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(isSessionFile)
      .sort()
      .reverse()
      .map((name) => new SessionStore(join(dir, name)));
  }

  /**
   * The project's latest session file (bare resume), or null when the
   * project has none yet.
   */
  static latest(cwd: string, home = homedir()): SessionStore | null {
    const dir = projectSessionsDir(cwd, home);
    if (!existsSync(dir)) return null;
    const newest = readdirSync(dir)
      .filter(isSessionFile)
      .sort()
      .at(-1);
    return newest ? new SessionStore(join(dir, newest)) : null;
  }

  /**
   * Forks this session: a new file in the same directory inheriting the
   * full history. The original file is left untouched.
   */
  fork(): SessionStore {
    const target = join(dirname(this.#file), `${newSessionId()}.jsonl`);
    copyFileSync(this.#file, target);
    return new SessionStore(target);
  }

  /** Appends one event as a single JSON line. Never rewrites existing bytes. */
  append(event: AgentEvent): void {
    appendFileSync(this.#file, JSON.stringify(event) + "\n");
  }

  /**
   * Loads and validates the log: every line parsed as JSON, first event
   * must be `session_start` with a supported `schemaVersion`.
   */
  load(): AgentEvent[] {
    const raw = readWholeFile(this.#file);
    const events: AgentEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let event: AgentEvent;
      try {
        event = JSON.parse(line) as AgentEvent;
      } catch {
        throw new Error(`corrupt session log ${this.#file}: invalid JSON line`);
      }
      events.push(event);
    }
    const first = events[0];
    if (!first || first.type !== "session_start") {
      throw new Error(`corrupt session log ${this.#file}: log does not start with session_start`);
    }
    const v = first.schemaVersion;
    if (v < MIN_SUPPORTED_SCHEMA_VERSION) {
      throw new Error(
        `session schema too old (v${v}; minimum supported v${MIN_SUPPORTED_SCHEMA_VERSION}): start a new session or fork this one`,
      );
    }
    if (v > SCHEMA_VERSION) {
      throw new Error(
        `session schema is newer than this build (v${v} > v${SCHEMA_VERSION}): upgrade moh to resume it`,
      );
    }
    return events;
  }
}

function readWholeFile(file: string): string {
  return readFileSync(file, "utf8");
}

/**
 * Reconstructs the provider-facing conversation from a session log.
 * Mirrors what AgentSession accumulates in memory: user messages as-is,
 * consecutive assistant deltas grouped into one message per turn, tool
 * calls attached to the current assistant message, and settled tool
 * results folded into a following user message.
 */
export function replayMessages(events: ReadonlyArray<AgentEvent>): Message[] {
  const messages: Message[] = [];
  let text = "";
  const toolCalls: Message["parts"] = [];
  let sawContent = false;

  const flushAssistant = () => {
    if (!sawContent) return;
    messages.push({ role: "assistant", parts: [...(text ? [{ kind: "text" as const, text }] : []), ...toolCalls] });
    text = "";
    toolCalls.length = 0;
    sawContent = false;
  };

  const results: Message["parts"] = [];
  const flushResults = () => {
    if (results.length === 0) return;
    flushAssistant();
    messages.push({ role: "user", parts: [...results] });
    results.length = 0;
  };

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        flushResults();
        flushAssistant();
        messages.push({ role: "user", parts: [{ kind: "text", text: event.text }] });
        break;
      case "assistant_delta":
        flushResults();
        text += event.text;
        sawContent = true;
        break;
      case "tool_call":
        toolCalls.push({ kind: "tool_call", callId: event.callId, name: event.name, args: event.args });
        sawContent = true;
        break;
      case "tool_result":
        results.push({ kind: "tool_result", callId: event.callId, ok: event.ok, output: event.output });
        break;
      case "done":
      case "error":
      case "cancelled":
        flushResults();
        flushAssistant();
        break;
      default:
        break; // session_start, permission_*, session_mode, compaction: not conversation content
    }
  }
  flushResults();
  flushAssistant();
  return messages;
}
