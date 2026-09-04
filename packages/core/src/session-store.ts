import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { legacyProjectSlug, resolveProjectIdentity } from "./project-identity";
import { readUserConfigFile, userConfigFile } from "./user-config";
import type { AgentEvent, Message } from "./types";
import { CANCELLED_TOOL_OUTPUT, SCHEMA_VERSION } from "./types";
import { renderMentionAttachment } from "./mentions";

/** #400: observed external growth of a session file, as reported to the
 * session (and the `session_file_growth` chrome event) at an append boundary. */
export interface SessionFileGrowth {
  file: string;
  expectedBytes: number;
  actualBytes: number;
}

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
 *
 * Same-millisecond creations would tie-break on the random uuid, making
 * file order arbitrary on fast machines (#364 flake family): the stamp is
 * forced monotonic within the process instead.
 */
let lastStampMs = 0;

export function newSessionId(now = new Date()): string {
  let ms = now.getTime();
  if (ms <= lastStampMs) ms = lastStampMs + 1;
  lastStampMs = ms;
  const ts = new Date(ms).toISOString().replace(/[-:.]/g, "");
  const uuid = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${ts}-${uuid}`;
}

/** Project slug. A declared identity wins; legacy path-derived slugs remain readable. */
export function projectSlug(cwd: string, home = homedir()): string {
  return resolveProjectIdentity(cwd, home).slug;
}

/** Directory holding the project's session files: <home>/.moh/projects/<slug> */
export function projectSessionsDir(cwd: string, home = homedir()): string {
  return join(home, ".moh", "projects", projectSlug(cwd, home));
}

export { legacyProjectSlug, resolveProjectIdentity };

function isSessionFile(name: string): boolean {
  return (
    name.endsWith(".jsonl") &&
    SESSION_ID_RE.test(name.slice(0, name.length - ".jsonl".length))
  );
}

/**
 * Append-only JSONL persistence for one session file. The store never
 * interprets events; it only makes them durable. Sessions are user data
 * and never live inside the project's `.moh/`.
 */
export class SessionStore {
  readonly #file: string;
  /** #400: size of the file as this writer last saw it, snapshotted at
   * open/create time and updated after every append. Growth beyond it
   * between appends means someone else wrote to the file. */
  #expectedSize: number;

  private constructor(file: string) {
    this.#file = file;
    try {
      this.#expectedSize = statSync(file).size;
    } catch {
      this.#expectedSize = 0;
    }
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
    registerOpenSession(file);
    return new SessionStore(file);
  }

  /** Reopens an existing session file for appending. */
  static open(file: string): SessionStore {
    if (!isAbsolute(file))
      throw new Error(`session file path must be absolute: ${file}`);
    registerOpenSession(file);
    return new SessionStore(file);
  }

  /** Releases this store's open-session registration (#478 delete guard). */
  dispose(): void {
    unregisterOpenSession(this.#file);
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
    const newest = readdirSync(dir).filter(isSessionFile).sort().at(-1);
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
    const forked = new SessionStore(target);
    // ADR-0021: forks are born consumed — one `session_resumed` in the new
    // file keeps the fork out of the pertinent-session banner (it is not a
    // suggestion; the original it was forked from stays untouched).
    forked.append({ type: "session_resumed" });
    return forked;
  }

  /**
   * #400: observes whether the file grew beyond what this writer last
   * appended. Consuming: a reported growth is acknowledged (the baseline
   * moves to the observed size), so one incident yields exactly one
   * warning — the caller reports it before appending on the tail. Null
   * when it did not (or the file cannot be stat'ed — the guard is
   * best-effort and never blocks writes).
   */
  externalGrowth(): { expectedBytes: number; actualBytes: number } | null {
    let actual: number;
    try {
      actual = statSync(this.#file).size;
    } catch {
      return null;
    }
    if (actual <= this.#expectedSize) return null;
    const expectedBytes = this.#expectedSize;
    this.#expectedSize = actual;
    return { expectedBytes, actualBytes: actual };
  }

  /** Appends one event as a single JSON line. Never rewrites existing bytes.
   * Single-writer guard (#400): callers pair this with `externalGrowth()`
   * (checked immediately before) to detect that another writer (another
   * machine over a sync channel, a second process) grew the file between
   * appends. The append itself always proceeds on the tail: the local
   * writer's appends stay intact; interleaving is surfaced, never silent.
   * The new expectation is computed arithmetically, never re-stat'ed, so
   * foreign bytes landing between write and measure are never silently
   * absorbed into the baseline. */
  append(event: AgentEvent): void {
    const line = JSON.stringify(event) + "\n";
    appendFileSync(this.#file, line);
    this.#expectedSize += Buffer.byteLength(line);
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
      throw new Error(
        `corrupt session log ${this.#file}: log does not start with session_start`,
      );
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
 * results folded into a following user message. Tool protocol invariants
 * are repaired in-memory only: unanswered tool_calls get a synthetic
 * failed tool_result (#237), and tool_results whose assistant call was
 * discarded never reach the provider (#371).
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
    const compaction = events[compactionIndex] as Extract<
      AgentEvent,
      { type: "compaction" }
    >;
    const upTo = Math.min(Math.max(0, compaction.upTo), compactionIndex);
    messages.push({
      role: "user",
      parts: [
        { kind: "text", text: `[Compaction summary]\n${compaction.summary}` },
      ],
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
    messages.push({
      role: "assistant",
      parts: [
        ...reasoningParts,
        ...(text ? [{ kind: "text" as const, text }] : []),
        ...toolCalls,
      ],
    });
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
  // Call ids whose assistant tool_call was discarded by a failed/
  // cancelled/fallback path — their (possibly already settled) results
  // must never reach the provider conversation (#371).
  const droppedCalls = new Set<string>();
  const discardAssistant = () => {
    for (const c of toolCalls) {
      if (c.kind === "tool_call") droppedCalls.add(c.callId);
    }
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
        ? [
            {
              kind: "tool_result" as const,
              callId: c.callId,
              ok: false,
              output: CANCELLED_TOOL_OUTPUT,
            },
          ]
        : [],
    );
    const all = [
      // #371: results of discarded calls never reach the provider — they
      // would be orphan tool outputs with no matching assistant tool_call.
      ...results.filter(
        (r) => !(r.kind === "tool_result" && droppedCalls.has(r.callId)),
      ),
      ...orphans,
    ];
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
        messages.push({
          role: "user",
          // #488: persisted mention attachments ride the rebuilt user
          // message exactly as the live turn saw them.
          parts: [
            { kind: "text", text: event.text },
            ...(event.attachments ?? []).map((a) => ({ kind: "text" as const, text: renderMentionAttachment(a) })),
          ],
        });
        break;
      case "reasoning":
        // #240: completed reasoning is logged after its call's deltas (it
        // lands when the call flushes) — it attaches to those deltas.
        // Pending tool results mark an iteration boundary: flush the
        // previous call's message before opening the next call's reasoning.
        flushResults();
        reasoningParts.push({
          kind: "reasoning",
          text: event.text,
          ...(event.continuation ? { continuation: event.continuation } : {}),
        });
        break;
      case "assistant_delta":
        flushResults();
        text += event.text;
        sawContent = true;
        break;
      case "tool_call":
        toolCalls.push({
          kind: "tool_call",
          callId: event.callId,
          name: event.name,
          args: event.args,
        });
        sawContent = true;
        break;
      case "tool_result":
        settled.add(event.callId);
        results.push({
          kind: "tool_result",
          callId: event.callId,
          ok: event.ok,
          output: event.output,
        });
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

/** One row of a session listing (#401). */
export interface SessionSummary {
  /** Absolute JSONL path. */
  file: string;
  id: string;
  /** First user message, trimmed; placeholder when absent/unreadable. */
  title: string;
  /** #477: the derived first-user_message title, kept so clients can
   * double-match search against both the display name and the original. */
  derivedTitle: string;
  /** Modification time (ms). */
  mtimeMs: number;
  /**
   * ADR-0021: consumed iff the last `session_resumed` index is greater than
   * the index of the last turn's last event (index comparison, no
   * timestamps). Re-openable: work after a resume makes the session
   * suggestible again.
   */
  consumed: boolean;
}

/**
 * Lists the project's persisted sessions, newest first, with a summary
 * title peeked from the log's first user_message. An unreadable file
 * degrades to a placeholder title — listings never crash on user data.
 * One seam for every client (TUI home screen, `moh run --resume`).
 */
export function listSessionSummaries(
  cwd: string,
  home = homedir(),
): SessionSummary[] {
  return SessionStore.list(cwd, home)
    .map((store) => {
      let title = "(unreadable session)";
      let displayName: string | null = null;
      try {
        const peek = peekSession(store.file);
        title = peek.title;
        displayName = peek.displayName;
      } catch {
        // keep placeholder
      }
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(store.file).mtimeMs;
      } catch {
        // keep 0
      }
      let consumed = false;
      try {
        consumed = peekSession(store.file).consumed;
      } catch {
        // unreadable: keep false (placeholder title keeps it out of the banner)
      }
      return {
        file: store.file,
        id: basename(store.file, ".jsonl"),
        // #477: display name (rename override) when present, else derived.
        title: displayName ?? title,
        derivedTitle: title,
        mtimeMs,
        consumed,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Result of the full-line parse of one session file (ADR-0021 read seam). */
interface SessionPeek {
  /** Display name: the last `session_renamed` name, or null when never renamed/reset. */
  displayName: string | null;
  title: string;
  consumed: boolean;
}

/**
 * Parses every line (no early-exit) tracking the first `user_message` as
 * title and the indexes needed for the consumption predicate (ADR-0021):
 * consumed iff the last `session_resumed` sits after the last turn's last
 * event. The turn tail is the last of `user_message`/`done`/`error`/
 * `cancelled` — chrome appended outside a turn (session_mode,
 * permission_rules_restored, session_resumed itself) never counts, so a
 * resumed-then-closed session is consumed while resumed-then-worked-on
 * flips back to suggestible. Index comparison only: no timestamps.
 */
function peekSession(file: string): SessionPeek {
  const raw = readFileSync(file, "utf8");
  let title: string | null = null;
  let displayName: string | null = null;
  let lastTurnIdx = -1;
  let lastResumedIdx = -1;
  let idx = -1;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let event: AgentEvent;
    try {
      event = JSON.parse(line) as AgentEvent;
    } catch {
      break; // corrupt tail: stop at the first bad line
    }
    idx++;
    if (event.type === "user_message" && title === null) {
      const text = event.text.replace(/\s+/g, " ").trim();
      title = text.length > 60 ? text.slice(0, 57) + "…" : text || "(empty session)";
    }
    // #477: the LAST `session_renamed` wins; an empty name is the explicit
    // reset — the override clears and the derived title shows again.
    if (event.type === "session_renamed") {
      displayName = event.name === "" ? null : event.name;
    }
    if (event.type === "user_message" || event.type === "done" || event.type === "error" || event.type === "cancelled") {
      lastTurnIdx = idx;
    }
    if (event.type === "session_resumed") lastResumedIdx = idx;
  }
  return {
    displayName,
    title: title ?? "(empty session)",
    consumed: lastResumedIdx > lastTurnIdx,
  };
}

/**
 * #477: renames a session by appending a `session_renamed` chrome event to
 * its log — the log is the session, so resume, fork (the name rides the
 * copied history) and compaction (nothing is deleted) all carry it for
 * free. An empty/whitespace name is the explicit reset: it appends an
 * empty-name event that clears the override, keeping the log append-only.
 * `file` must be an existing session file. Display names never touch
 * slugs or file names. Concurrent rename while open elsewhere is out of
 * scope (#400).
 */
export function renameSession(file: string, name: string): void {
  if (!existsSync(file)) {
    throw new Error(`renameSession: session file not found: ${file}`);
  }
  if (!isSessionFile(basename(file))) {
    throw new Error(`renameSession: not a session file: ${basename(file)}`);
  }
  const trimmed = name.trim();
  appendFileSync(file, JSON.stringify({ type: "session_renamed", name: trimmed }) + "\n");
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

// ---------------------------------------------------------------------------
// Session trash (#478)
// ---------------------------------------------------------------------------

/** Default retention window for trashed sessions, in days. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

/**
 * Directory holding the project's trashed session files:
 * <home>/.moh/trash/projects/<slug> — the same directory structure as the
 * live project dir, so restore is trivial and ids never collide.
 */
export function projectTrashDir(cwd: string, home = homedir()): string {
  return join(home, ".moh", "trash", "projects", projectSlug(cwd, home));
}

/** One row of the trash listing. */
export interface TrashedSessionSummary {
  /** Absolute JSONL path inside the trash. */
  file: string;
  id: string;
  /** Title peeked from the log (placeholder when unreadable). */
  title: string;
  /** Modification time (ms) — when the file was trashed or last touched. */
  mtimeMs: number;
  /** Whole days left before the lazy prune removes it. */
  daysRemaining: number;
}

/**
 * Retention window from the user config (`sessionTrash.retentionDays`,
 * guardian-owned `~/.moh/config`). Tolerant: missing/corrupt values fall
 * back to the 30-day default; a value < 1 falls back too.
 */
export function trashRetentionDays(home = homedir()): number {
  try {
    const section = readUserConfigFile(userConfigFile(home)).sessionTrash as
      | { retentionDays?: unknown }
      | undefined;
    const days = section?.retentionDays;
    return typeof days === "number" && Number.isFinite(days) && days >= 1
      ? Math.floor(days)
      : DEFAULT_TRASH_RETENTION_DAYS;
  } catch {
    return DEFAULT_TRASH_RETENTION_DAYS;
  }
}

/**
 * Sessions currently open in this process (open-session guard for delete).
 * The #400 seam is per-writer size probing; cross-process "open elsewhere"
 * is unsupported (#400), so a process-local registry covers the real case:
 * the TUI deleting its own open session.
 */
const openSessionFiles = new Set<string>();

// Registrar hooks for SessionStore.create/open/dispose.
function registerOpenSession(file: string): void {
  openSessionFiles.add(file);
}
function unregisterOpenSession(file: string): void {
  openSessionFiles.delete(file);
}

/**
 * #478: deletes a session by moving its file into the project trash
 * (`~/.moh/trash/projects/<slug>/`). Only the `.jsonl` file moves — forks
 * are independent files and project memory is untouched. Refuses when the
 * session file is currently open in this process. Runs the lazy prune
 * afterwards (retention checked at delete and listing time only — no
 * background job).
 */
export function deleteSession(file: string, cwd: string, home = homedir()): void {
  const name = basename(file);
  if (!existsSync(file)) {
    throw new Error(`deleteSession: session file not found: ${file}`);
  }
  if (!isSessionFile(name)) {
    throw new Error(`deleteSession: not a session file: ${name}`);
  }
  if (openSessionFiles.has(file)) {
    throw new Error(`deleteSession: session is currently open: ${name}`);
  }
  const trashDir = projectTrashDir(cwd, home);
  mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  moveIntoTrash(file, join(trashDir, name));
  pruneTrash(cwd, home);
}

/** rename when possible (atomic, same volume), copy+unlink across devices. */
function moveIntoTrash(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/**
 * Lists the project's trashed sessions, newest first. Runs the lazy prune
 * first: this listing is one of the two retention touch points.
 */
export function listTrashedSessions(cwd: string, home = homedir()): TrashedSessionSummary[] {
  pruneTrash(cwd, home);
  const dir = projectTrashDir(cwd, home);
  if (!existsSync(dir)) return [];
  const retentionMs = trashRetentionDays(home) * 24 * 3600 * 1000;
  const now = Date.now();
  return readdirSync(dir)
    .filter(isSessionFile)
    .sort()
    .reverse()
    .map((name) => {
      const file = join(dir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        // keep 0
      }
      let title = "(unreadable session)";
      try {
        title = peekSession(file).title;
      } catch {
        // keep placeholder
      }
      const ageMs = Math.max(0, now - mtimeMs);
      return {
        file,
        id: name.slice(0, name.length - ".jsonl".length),
        title,
        mtimeMs,
        daysRemaining: Math.max(0, Math.ceil((retentionMs - ageMs) / (24 * 3600 * 1000))),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * #478: restores a trashed session file back into its project directory.
 * Refuses when a live session with the same id already exists — no silent
 * overwrite of user data.
 */
export function restoreSession(file: string, cwd: string, home = homedir()): string {
  const name = basename(file);
  if (!isSessionFile(name)) {
    throw new Error(`restoreSession: not a trashed session file: ${name}`);
  }
  if (!existsSync(file)) {
    throw new Error(`restoreSession: trashed file not found: ${file}`);
  }
  const target = join(projectSessionsDir(cwd, home), name);
  if (existsSync(target)) {
    throw new Error(`restoreSession: a live session with this id already exists: ${name} — delete it first or remove the trash entry`);
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  moveIntoTrash(file, target);
  return target;
}

/**
 * Lazy prune: removes trashed files older than the retention window.
 * Called at `deleteSession` and trash listing time; no background job.
 */
export function pruneTrash(cwd: string, home = homedir()): void {
  const dir = projectTrashDir(cwd, home);
  if (!existsSync(dir)) return;
  const retentionMs = trashRetentionDays(home) * 24 * 3600 * 1000;
  const cutoff = Date.now() - retentionMs;
  for (const name of readdirSync(dir)) {
    if (!isSessionFile(name)) continue;
    const file = join(dir, name);
    try {
      if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
    } catch {
      // best-effort prune: never crash a listing/delete on user data
    }
  }
}
