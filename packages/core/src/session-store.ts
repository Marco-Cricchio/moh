import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve as pathResolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentEvent, Message } from "./types";
import { CANCELLED_TOOL_OUTPUT, SCHEMA_VERSION } from "./types";

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
    // Only newly created artifacts are tightened: existing user-owned paths
    // retain their modes. `mode` is also applied to every missing parent.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${newSessionId()}.jsonl`);
    writeFileSync(file, "", { mode: 0o600 });
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
    // copyFile preserves the source mode, which may be a legacy session log.
    // This target is freshly created, so tightening it does not alter a
    // pre-existing user-owned path.
    chmodSync(target, 0o600);
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
  // The newest marker is the active compaction projection. Its summary
  // replaces only the pointed-to prefix; the append-only log remains
  // integral and the recent tail (including reasoning metadata) replays
  // normally. Clamp corrupt pointers at the marker so they cannot erase
  // events that were appended after compaction.
  let compactionIndex = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.type === "compaction") {
      compactionIndex = i;
      break;
    }
  }
  let replayEvents = events;
  if (compactionIndex >= 0) {
    const compaction = events[compactionIndex] as Extract<AgentEvent, { type: "compaction" }>;
    const upTo = Math.min(Math.max(0, compaction.upTo), compactionIndex);
    messages.push({
      role: "user",
      parts: [{ kind: "text", text: `[Compaction summary]\n${compaction.summary}` }],
    });
    replayEvents = events.slice(upTo);
  }
  let text = "";
  const toolCalls: Message["parts"] = [];
  let sawContent = false;
  let completedCall = false;

  const flushAssistant = () => {
    if (!sawContent) {
      reasoningParts.length = 0; // #240: reasoning of a call that never
      // produced assistant content (failed/interrupted) never forms a
      // valid assistant message — the block stays in the log only.
      completedCall = false;
      return;
    }
    messages.push({ role: "assistant", parts: [...reasoningParts, ...(text ? [{ kind: "text" as const, text }] : []), ...toolCalls] });
    text = "";
    toolCalls.length = 0;
    reasoningParts.length = 0;
    sawContent = false;
    completedCall = false;
  };

  const results: Message["parts"] = [];
  // #240: completed reasoning blocks of the calls whose deltas follow —
  // attached to the assistant message built from those deltas.
  const reasoningParts: Message["parts"] = [];
  const discardAssistant = () => {
    text = "";
    toolCalls.length = 0;
    reasoningParts.length = 0;
    sawContent = false;
    completedCall = false;
  };
  // Call ids whose tool_result has already been folded into `results` —
  // used to spot orphan tool_calls (aborted turn, crash mid-tool) and
  // repair them at the next flush with a synthetic failed tool_result.
  // Without the repair, replaying the log produces an assistant message
  // with an unanswered tool_call and every later provider request fails
  // with `invalid_request: Tool result is missing` (#237).
  const settled = new Set<string>();
  const flushResults = () => {
    const orphans = toolCalls.flatMap((c) =>
      c.kind === "tool_call" && !settled.has(c.callId)
        ? [{ kind: "tool_result" as const, callId: c.callId, ok: false, output: CANCELLED_TOOL_OUTPUT }]
        : [],
    );
    const all = [...results, ...orphans];
    results.length = 0;
    if (all.length === 0) return;
    flushAssistant();
    messages.push({ role: "user", parts: all });
  };

  for (const event of replayEvents) {
    switch (event.type) {
      case "user_message":
        flushResults();
        flushAssistant();
        messages.push({ role: "user", parts: [{ kind: "text", text: event.text }] });
        break;
      case "reasoning":
        // #240: completed reasoning is logged after its call's deltas (it
        // lands when the call flushes) — it attaches to those deltas.
        // Pending tool results mark an iteration boundary: flush the
        // previous call's message before opening the next call's reasoning.
        flushResults();
        reasoningParts.push({ kind: "reasoning", text: event.text, ...(event.continuation ? { continuation: event.continuation } : {}) });
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
        settled.add(event.callId);
        results.push({ kind: "tool_result", callId: event.callId, ok: event.ok, output: event.output });
        break;
      case "model_call":
        if (event.failed) {
          // #243: an unfinalized call (interrupted, failed, or superseded
          // by a retry/fallback) is log-only — its partial reasoning/text
          // never becomes provider context.
          discardAssistant();
        } else {
          completedCall = true;
        }
        break;
      case "fallback":
        // The failed stop remains visible in the integral log (its
        // reasoning + failed `model_call` follow this marker so the TUI can
        // label the block), but none of its partial provider message
        // becomes context for the successful stop or a later resume.
        discardAssistant();
        break;
      case "done":
        flushResults();
        flushAssistant();
        break;
      case "error":
        flushResults();
        // A failed call never finalized a provider message: even deltas that
        // streamed before the error are not a valid assistant reply.
        discardAssistant();
        break;
      case "cancelled":
        // Unlike error, an abort can land *after* a call finalized (deltas +
        // model_call + finish, then the user pressed esc during tool wrap-up):
        // that completed call stays valid context; only the unfinalized tail
        // is dropped (#243).
        flushResults();
        if (completedCall) flushAssistant();
        else discardAssistant();
        break;
      default:
        break; // session_start, permission_*, session_mode, compaction: not conversation content
    }
  }
  flushResults();
  flushAssistant();
  return messages;
}

/** The final assistant text of the last turn: deltas after the last user_message. */
export function lastAssistantText(events: ReadonlyArray<AgentEvent>): string {
  let text = "";
  for (const event of events) {
    if (event.type === "user_message") text = "";
    else if (event.type === "assistant_delta") text += event.text;
  }
  return text;
}
