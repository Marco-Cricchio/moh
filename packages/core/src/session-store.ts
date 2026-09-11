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
import { declaredId, identitySlug, legacyProjectSlug, resolveProjectIdentity, identityFileFor } from "./project-identity";
import { readUserConfigFile, userConfigFile } from "./user-config";
import type { AgentEvent, Message } from "./types";
import { CANCELLED_TOOL_OUTPUT, SCHEMA_VERSION } from "./types";
import { renderMentionAttachment } from "./mentions";
import { isUlid, newUlid } from "./session/ulid";
import { activePath } from "./session/event-log";

/**
 * #575 (format decision 8): a read-only bridge value referencing a
 * pre-tree event by its 1-based line number. It only ever appears as the
 * value of `parentId`/`upToId` pointing at events already in the file —
 * new events never carry one (they have ULIDs).
 */
export function lineRef(n: number): string {
  return `line:${n}`;
}

/** Parses a `line:N` reference; null when `ref` is not one. */
export function parseLineRef(ref: string): number | null {
  const m = /^line:([1-9]\d*)$/.exec(ref);
  return m ? Number(m[1]) : null;
}

/**
 * #575: resolves an event reference — a ULID present in the log, or a
 * `line:N` bridge into the given events — to the referenced event, or
 * null when the reference dangles (corruption/truncation: readers fall
 * back visibly, never silently to the wrong branch). For a `line:N` bridge
 * the returned clone carries `parentId: "line:N"` (the referenced value —
 * the bridge only ever appears as a parent/upTo reference, format d8);
 * the underlying file is never rewritten, and the clone must never be
 * re-appended as an event of its own.
 */
export function resolveEventRef(
  ref: string,
  events: ReadonlyArray<AgentEvent>,
): AgentEvent | null {
  const line = parseLineRef(ref);
  if (line !== null) {
    const event = events[line - 1];
    return event ? { ...event, parentId: ref } : null;
  }
  if (!isUlid(ref)) return null;
  const found = events.find((e) => e.id === ref);
  return found ?? null;
}

/**
 * #575: stamps identity onto an event for direct appends to a session
 * file that bypass the EventLog (fork, rename). `parentId` defaults to
 * the id of the file's last identified event — the head (format d3: no
 * `branch_switched` yet, the head is the last event); on a purely legacy
 * tail the field is simply absent (the degenerate linear tree, same rule
 * as EventLog.append). An explicitly supplied parent is preserved. The
 * `id` is always fresh.
 */
function stampEvent(event: AgentEvent, file: string): AgentEvent {
  let head: string | undefined;
  let store: SessionStore | null = null;
  try {
    // Probe without registering: a previous open probe's dispose must
    // never unregister the caller's own live registration (#478).
    store = SessionStore.open(file, { register: false });
    head = resolveHead(store.load()).head;
  } catch {
    // unreadable log: stamp with no parent rather than refusing to write
  } finally {
    store?.dispose();
  }
  return {
    ...event,
    id: newUlid(),
    ...(event.parentId !== undefined
      ? { parentId: event.parentId }
      : head !== undefined
        ? { parentId: head }
        : {}),
  };
}

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
// #575: re-exported so `@moh/core` can surface the identity helpers.
export { isUlid } from "./session/ulid";
// #576: branch-aware head resolution, re-exported here so clients read the
// whole session-tree read/write surface from one module.
export { resolveHead, activePath } from "./session/event-log";
import { resolveHead } from "./session/event-log";

// #591: process-local open-session registry, shared with the identity
// resolver so a slug switch mid-session cannot orphan an open file.
// Function-level indirection breaks the module cycle (session-store →
// project-identity → session-store): the binding is resolved at call time.
const openSessionFiles = new Set<string>();

/** Whether any session file under `dir` is open in this process. */
export function anyOpenSessionInDir(dir: string): boolean {
  for (const file of openSessionFiles) {
    if (file.startsWith(dir.endsWith("/") ? dir : `${dir}/`)) return true;
  }
  return false;
}

/**
 * Whether this exact session file is currently open in this process —
 * the same registry `deleteSession` guards on (#478). The CLI `sessions
 * switch` refuses on it (#582, spec §5): moving the head under a live
 * writer belongs to the TUI, which switches through its own session
 * instance. Cross-process "open elsewhere" is unsupported (#400).
 */
export function isSessionOpen(file: string): boolean {
  return openSessionFiles.has(file);
}

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
  /** Whether THIS instance registered the file in the open-session
   * registry (#478). A register:false probe must not unregister a live
   * registration held by another instance on dispose. */
  #holdsRegistration: boolean = false;
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
    const store = new SessionStore(file);
    store.#holdsRegistration = true;
    return store;
  }

  /** Reopens an existing session file for appending. `register: false`
   * probes without touching the open-session registry (#478) — used by
   * `stampEvent`, whose dispose would otherwise unregister a store the
   * caller still holds open (its own `create`/`open` registration). */
  static open(file: string, opts: { register?: boolean } = {}): SessionStore {
    if (!isAbsolute(file))
      throw new Error(`session file path must be absolute: ${file}`);
    if (opts.register !== false) registerOpenSession(file);
    const store = new SessionStore(file);
    store.#holdsRegistration = opts.register !== false;
    return store;
  }

  /** Releases this store's open-session registration (#478 delete guard).
   * Only removes the file when this instance actually registered it — a
   * register:false probe never unregisters a live writer's entry. */
  dispose(): void {
    if (this.#holdsRegistration) unregisterOpenSession(this.#file);
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
   * Spawn-free twin of `list()` for React startup gates (#595): lists the
   * session files under the uuid-declared slug when `.moh/project.json`
   * exists, else the legacy path-derived slug. Never resolves the remote
   * identity — that path spawns `git remote get-url` and is unsafe inside
   * a passive effect. A remote-slug directory a cold project might own is
   * out of scope by construction: a project with a usable origin has
   * `.git`, and the cold-directory gate already returned false before
   * listing.
   */
  static listSpawnFree(cwd: string, home = homedir()): SessionStore[] {
    const projects = join(home, ".moh", "projects");
    const declared = identityFileFor(cwd);
    const uuidId = declaredId(declared);
    const slug = uuidId ? identitySlug(uuidId) : legacyProjectSlug(cwd);
    const dir = join(projects, slug);
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
    // #575: events arriving through the session's EventLog are already
    // identity-stamped (the log is the single stamping point for the live
    // loop) and pass through untouched — the file never diverges from the
    // in-memory history. Only direct, unstamped events (fork's
    // `session_resumed`, legacy hand-crafted appends) get stamped here:
    // fresh ULID, parent = the file's head (bridged via `line:N` on a
    // legacy tail — read-only, never written as an id).
    const line = JSON.stringify(event.id === undefined ? stampEvent(event, this.#file) : event) + "\n";
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

/** The on-path compaction projection replay builds its context from
 * (#578, core spec d4–d6). */
export interface CompactionProjection {
  summary: string;
  /** Position on the given array (the projection — spec d1: replay is
   * always fed the active-path array) of the first uncovered event. */
  upToIndex: number;
  /** True when the marker's `upToId` did not resolve on the path (d6):
   * replay restarts from the path start and surfaces a visible warning. */
  dangling: boolean;
}

/**
 * Resolves the newest compaction marker on the given (active-path)
 * array (#578): last-marker-on-path-wins. `upToId` is resolved by id on
 * the projection, then clamped at the marker's own position (a pointer
 * past the marker cannot erase events appended after compaction —
 * same clamp semantics as the legacy numeric form). Legacy markers
 * (`upTo: N`) resolve positionally via the `line:N` bridge rule.
 */
export function compactionProjection(
  path: ReadonlyArray<AgentEvent>,
): CompactionProjection | undefined {
  let markerIndex = -1;
  let marker: Extract<AgentEvent, { type: "compaction" }> | undefined;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path[i]!.type === "compaction") {
      markerIndex = i;
      marker = path[i] as Extract<AgentEvent, { type: "compaction" }>;
      break;
    }
  }
  if (!marker) return undefined;
  const line = marker.upToId !== undefined ? parseLineRef(marker.upToId) : null;
  let upToIndex: number | null = null;
  if (marker.upToId !== undefined) {
    if (line !== null) {
      upToIndex = line - 1;
    } else {
      upToIndex = path.findIndex((e) => e.id === marker!.upToId);
    }
  } else if (marker.upTo !== undefined) {
    // Legacy numeric pointer (pre-tree log): positional by contract.
    upToIndex = marker.upTo;
  }
  // Dangling pointer (d6): restart from the path start, visibly.
  if (upToIndex === null || upToIndex < 0) {
    return { summary: marker.summary, upToIndex: 0, dangling: true };
  }
  // Clamp at the marker's own position.
  upToIndex = Math.min(upToIndex, markerIndex);
  return { summary: marker.summary, upToIndex, dangling: false };
}

/** Visible warning lines for the replay context (spec d6): emitted when
 * the newest on-path marker's pointer did not resolve — the context
 * restarts from the path start rather than silently mis-replaying. */
export function replayWarnings(path: ReadonlyArray<AgentEvent>): string[] {
  const p = compactionProjection(path);
  if (!p?.dangling) return [];
  const marker = [...path].reverse().find((e) => e.type === "compaction") as
    | Extract<AgentEvent, { type: "compaction" }>
    | undefined;
  return [
    `[warning: the compaction pointer (${marker?.upToId ?? marker?.upTo}) does not resolve on this session's active path — context restarted from the session start]`,
  ];
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
  // #578 (core spec d4/d5): markers resolve on the active path — the
  // newest marker ON THIS PATH wins; a marker on an abandoned sibling
  // branch is invisible to context and reactivates when that branch is
  // active again. The pointer is `upToId` (format d7); legacy numeric
  // `upTo` markers read as `line:N` and resolve positionally. The
  // covered prefix is clamped at the marker's own position (a pointer
  // past the marker cannot erase events appended after compaction); a
  // dangling pointer (corruption, truncation) restarts context from the
  // path start with a visible warning — never silent mis-replay.
  const warnings = replayWarnings(events);
  for (const text of warnings) {
    messages.push({ role: "user", parts: [{ kind: "text", text }] });
  }
  const projection = compactionProjection(events);
  if (projection && !projection.dangling) {
    messages.push({
      role: "user",
      parts: [
        { kind: "text", text: `[Compaction summary]\n${projection.summary}` },
      ],
    });
  }
  const replayEvents = projection && !projection.dangling ? events.slice(projection.upToIndex) : events;
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
            // #488/vision note 4: persisted attachments ride the rebuilt
            // user message exactly as the live turn saw them — images as
            // typed image parts, everything else as text blocks.
            ...(event.attachments ?? []).map((a) =>
              a.kind === "image"
                ? ({ kind: "image", mime: a.mime, base64: a.content } as const)
                : ({ kind: "text", text: renderMentionAttachment(a) } as const),
            ),
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
  const events: AgentEvent[] = [];
  let title: string | null = null;
  let displayName: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let event: AgentEvent;
    try {
      event = JSON.parse(line) as AgentEvent;
    } catch {
      break; // corrupt tail: stop at the first bad line
    }
    if (event.type === "user_message" && title === null) {
      const text = event.text.replace(/\s+/g, " ").trim();
      title = text.length > 60 ? text.slice(0, 57) + "…" : text || "(empty session)";
    }
    // #477: the LAST `session_renamed` wins; an empty name is the explicit
    // reset — the override clears and the derived title shows again.
    if (event.type === "session_renamed") {
      displayName = event.name === "" ? null : event.name;
    }
    events.push(event);
  }
  // #577 (core spec d8): the consumption predicate runs on the active-path
  // projection — an abandoned branch's turn no longer consumes the head.
  // Same predicate, new array: consumed iff the last `session_resumed` on
  // the path comes after the last turn event on the path.
  const path = activePath(events);
  let lastTurnIdx = -1;
  let lastResumedIdx = -1;
  for (let i = 0; i < path.length; i++) {
    const event = path[i]!;
    if (event.type === "user_message" || event.type === "done" || event.type === "error" || event.type === "cancelled") {
      lastTurnIdx = i;
    }
    if (event.type === "session_resumed") lastResumedIdx = i;
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
  appendFileSync(file, JSON.stringify(stampEvent({ type: "session_renamed", name: trimmed }, file)) + "\n");
}

/**
 * #576 (head semantics d8): the last event whose bytes end at or before
 * `bytes` in the file — the local writer's tip at divergence-detection
 * time (the #400 `expectedBytes` baseline). The foreign tail lives after
 * those bytes. Null when the prefix cannot be read/parsed or holds no
 * identified event (a legacy tail has no tip to name).
 */
export function localTipAt(file: string, bytes: number): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let tip: string | null = null;
  let offset = 0;
  for (const line of raw.split("\n")) {
    // Buffer.byteLength accounts for multi-byte characters; the newline
    // belongs to this line's span.
    const span = Buffer.byteLength(line, "utf8") + 1;
    if (offset + span > bytes) break;
    offset += span;
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line) as AgentEvent;
      if (event.id !== undefined) tip = event.id;
    } catch {
      break; // corrupt prefix: stop at the first bad line
    }
  }
  return tip;
}

/**
 * #576: the file's actual tail — the last identified event id in the whole
 * file, regardless of byte windows. Used by the live writer to name the
 * foreign tip of a #400 divergence (the in-memory log stops at the
 * writer's own last append, so it cannot see the foreign tail). Null on a
 * purely legacy tail or an unreadable file.
 */
export function fileTailId(file: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let tip: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line) as AgentEvent;
      if (event.id !== undefined) tip = event.id;
    } catch {
      break; // corrupt tail: stop at the first bad line
    }
  }
  return tip;
}

/**
 * #576 (head semantics d2): moves the head by appending one validated
 * `branch_switched { to }` chrome event — the same discipline as
 * `renameSession`: validate the file, append a single JSON line
 * immediately, last-wins. No open session required, no turn-boundary
 * buffering (a buffered switch would be lost if the process died before
 * the boundary). `to` must reference a node already in the file — a ULID
 * present in the log or a read-only `line:N` bridge to a pre-tree event;
 * anything else is refused at write time so the log never learns to dangle
 * from its own writer. Switching to an interior node makes subsequent
 * appends split implicitly (format decision 5). Also the adoption action
 * for #400 divergence (head semantics d9: "take my tail" is a plain
 * switch to the local tip).
 *
 * Returns the id of the appended switch event. Rejection is an error:
 * callers (TUI /tree, CLI) surface it, never a silent no-op.
 */
/**
 * #576/#579 shared write-time validation for the file-based tree writers
 * (`switchBranch`, `bookmarkNode`): the file must exist and be a session
 * file, and `to` must reference a node already in it (ULID present, or a
 * `line:N` bridge to a pre-tree event). The log never learns to dangle
 * from its own writer — dangling references can only come from external
 * truncation/corruption, which readers warn about (head semantics d10).
 * The open probe is always disposed (the #478 registry stays clean).
 */
function validateWriterTarget(file: string, fn: string, to: string): void {
  if (!existsSync(file)) {
    throw new Error(`${fn}: session file not found: ${file}`);
  }
  if (!isSessionFile(basename(file))) {
    throw new Error(`${fn}: not a session file: ${basename(file)}`);
  }
  let store: SessionStore | null = null;
  let events: AgentEvent[];
  try {
    store = SessionStore.open(file);
    events = store.load();
  } catch (err) {
    throw new Error(
      `${fn}: cannot validate target against ${basename(file)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    store?.dispose();
  }
  if (resolveEventRef(to, events) === null) {
    throw new Error(`${fn}: target event not found in session: ${to}`);
  }
}

export function switchBranch(file: string, to: string): string {
  validateWriterTarget(file, "switchBranch", to);
  const stamped = stampEvent({ type: "branch_switched", to }, file);
  appendFileSync(file, JSON.stringify(stamped) + "\n");
  return stamped.id!;
}

/**
 * #579 (spec §4): bookmarks a node by appending a `tree_bookmarked
 * { to, name? }` chrome event to the session's log — same append
 * discipline as `renameSession`/`switchBranch` (resume, fork and
 * compaction carry it for free through the copied/compacted log).
 * `to` must reference a node already in the file: a ULID present in the
 * log, or a `line:N` bridge to a pre-tree event (bookmarking a legacy
 * turn works). With a non-empty (trimmed) `name` the bookmark is set or
 * renamed; with an empty/whitespace name the bookmark is cleared — the
 * explicit reset event appends, keeping the log append-only (last-wins:
 * the LAST `tree_bookmarked` for a node is its state). Omitting `name`
 * sets an unnamed bookmark. Chrome only: never provider context,
 * never compaction input; counted for topology. Returns the id of the
 * appended event. Rejection is an error: callers surface it, never a
 * silent no-op. Concurrent bookmark while open elsewhere is out of scope
 * (#400) — the live-writer path is `session.bookmarkNode()`.
 */
export function bookmarkNode(file: string, to: string, name?: string): string {
  validateWriterTarget(file, "bookmarkNode", to);
  const trimmed = name?.trim() ?? "";
  const event: AgentEvent =
    name === undefined
      ? { type: "tree_bookmarked", to }
      : trimmed === ""
        ? { type: "tree_bookmarked", to, name: "" }
        : { type: "tree_bookmarked", to, name: trimmed };
  const stamped = stampEvent(event, file);
  appendFileSync(file, JSON.stringify(stamped) + "\n");
  return stamped.id!;
}

// ---------------------------------------------------------------------------
// #580: the client-facing tree projection (spec §1)
// ---------------------------------------------------------------------------

/** One row of the TreeView: a turn (user→…→tail block) or a chrome event,
 * in file order, with precomputed depth, active-path membership, derived
 * label and last bookmark state (spec §4). */
export interface TreeNode {
  id: string | `line:${number}`;
  parentId: string | null;
  depth: number;
  onActivePath: boolean;
  kind: "turn" | "chrome";
  /** First user message of the turn (truncated), else the event kind. */
  label: string;
  /** Last bookmark state for this node; absent when never bookmarked
   * (a cleared bookmark removes the entry — the clear event is a reset,
   * same discipline as `session_renamed`). */
  bookmark?: { name?: string };
}

export interface TreeView {
  /** Nodes in file order, depth precomputed (clients never re-walk). */
  nodes: TreeNode[];
  /** Current head: a node id, or `line:N` when the head is the last
   * event of a purely legacy (identity-less) tail. */
  headId: string | `line:${number}`;
}

/** Turn-tail event types: they close the turn node opened by a
 * `user_message` (every other event type is its own chrome node). */
const TURN_TAIL = new Set(["done", "error", "cancelled"]);

const MAX_LABEL = 60;

function truncateLabel(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > MAX_LABEL ? t.slice(0, MAX_LABEL - 1) + "…" : t || "(empty)";
}

/**
 * #580 (spec §1): the client-facing projection of a session file — the
 * single seam both the TUI `/tree` panel and the CLI renderer consume,
 * built and tested headless.
 *
 * One node per turn: a `user_message` opens it and its turn tail (the
 * last `done`/`error`/`cancelled` before the next boundary) anchors the
 * node's id — the turn's identity is the event the head points at, so
 * bookmarks and `branch_switched` targets on any event of the turn
 * resolve to the same row. Every other event is a chrome node of its own
 * (format d4: chrome counts for topology). Depth is the node distance
 * from the root along `parentId` chains (`line:N` bridges resolve
 * positionally). `onActivePath` is certified by the same `activePath`
 * projection replay uses — the on-path nodes are exactly the path the
 * model context sees. Bookmark state rides the last `tree_bookmarked`
 * per node (§4 last-wins; a clear removes it).
 *
 * Returns `{ error }` on an unreadable, corrupt or empty log — never
 * throws, never a silent fallback (ADR-0005 discipline).
 */
export function sessionTree(file: string): TreeView | { error: string } {
  let events: AgentEvent[];
  try {
    // Read-only probe: dispose immediately (the #478 open registry must
    // never record a mere view — same discipline as renameSession).
    const store = SessionStore.open(file);
    try {
      events = store.load();
    } finally {
      store.dispose();
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (events.length === 0) return { error: `empty session log ${file}` };

  // Path membership: the active-path projection, matched by reference.
  const onPath = new Set(activePath(events));

  // Last-wins bookmark state per node reference (§4).
  const bookmarks = new Map<string, { name?: string }>();
  for (const e of events) {
    if (e.type !== "tree_bookmarked") continue;
    if (e.name === "") bookmarks.delete(e.to);
    else bookmarks.set(e.to, e.name === undefined ? {} : { name: e.name });
  }

  // Node id of an event: its ULID, else the `line:N` bridge (legacy tail).
  const lineOf = new Map<AgentEvent, number>();
  events.forEach((e, i) => lineOf.set(e, i + 1));
  const byId = new Map<string, AgentEvent>();
  for (const e of events) {
    if (e.id !== undefined) byId.set(e.id, e);
  }
  const idOf = (e: AgentEvent): string => e.id ?? lineRef(lineOf.get(e)!);

  const nodes: (TreeNode & { openerId?: string; openerOnPath?: boolean })[] = [];

  // Depth semantics: depth(parent node) + 1, root node at 0 — the
  // indentation clients draw. (The spec precomputes depth but does not
  // fix its unit; this projection's unit is the visible row.) Interior
  // turn events (assistant deltas, tool calls, the tail) are NOT nodes:
  // they resolve to the turn node's depth, so a turn's children (the
  // next turn, a chrome event after it) sit exactly one level below it.
  // A turn node's depth is fixed at its opener; the tail re-anchor
  // changes only the node's id/parentId. Legacy identity-less events all
  // have depth 0 (no parentId chains to walk). A dangling parent (out-
  // of-range `line:N`, unknown id) resolves to root depth: display-only
  // projection, not certified input — visible-warning machinery like
  // replayWarnings is reserved for replay, not the view.
  const nodeDepth = new Map<AgentEvent, number>();
  const depthOf = (e: AgentEvent): number => {
    const known = nodeDepth.get(e);
    if (known !== undefined) return known;
    if (e.parentId === undefined) return 0; // root anchor
    const line = parseLineRef(e.parentId);
    const parent = line !== null ? events[line - 1] : byId.get(e.parentId!);
    if (parent === undefined) return 0; // dangling parent: root depth
    return (nodeDepth.get(parent) ?? depthOf(parent)) + 1;
  };

  /** The turn currently being assembled: user_message opener → tail. */
  let turn: { openerId: string; node: TreeNode & { openerId?: string; openerOnPath?: boolean } } | null = null;
  /** Events owned by a turn node (opener, interior, tail). */
  const turnOwners = new Map<AgentEvent, TreeNode & { openerId?: string; openerOnPath?: boolean }>();

  for (const e of events) {
    const id = idOf(e);
    if (e.type === "user_message") {
      const depth = depthOf(e);
      const node = {
        id,
        parentId: e.parentId ?? null,
        depth,
        onActivePath: onPath.has(e),
        kind: "turn" as const,
        label: truncateLabel(e.text),
        openerId: id,
        openerOnPath: onPath.has(e),
      };
      nodes.push(node);
      turn = { openerId: id, node };
      nodeDepth.set(e, depth);
      turnOwners.set(e, node);
      continue;
    }
    if (turn && TURN_TAIL.has(e.type)) {
      // Turn tail: the node re-anchors at the tail event (the id the head
      // points at); the depth stays the opener's (one node, one level).
      turn.node.id = id;
      turn.node.parentId = e.parentId ?? null;
      turn.node.onActivePath = onPath.has(e) || (turn.node.openerOnPath ?? false);
      nodeDepth.set(e, turn.node.depth);
      turnOwners.set(e, turn.node);
      turn = null;
      continue;
    }
    if (turn) {
      // Interior of the open turn: not a node; resolves to the turn's
      // depth for any later event chained to it.
      nodeDepth.set(e, turn.node.depth);
      turnOwners.set(e, turn.node);
      continue;
    }
    // Chrome node: one per event (format d4: chrome counts for topology).
    const depth = depthOf(e);
    nodeDepth.set(e, depth);
    nodes.push({
      id,
      parentId: e.parentId ?? null,
      depth,
      onActivePath: onPath.has(e),
      kind: "chrome",
      label: e.type,
    });
    turn = null;
  }

  /** Bookmark state (§4): the node's own id, or any event of the turn
   * span (opener, interior, tail — all own the row). */
  /** All events owned by each node id (turn spans own their row). */
  const ownedBy = new Map<string, Set<string>>();
  for (const [event, owner] of turnOwners) {
    if (event.id === undefined) continue;
    const set = ownedBy.get(owner.id) ?? new Set<string>();
    set.add(event.id);
    ownedBy.set(owner.id, set);
  }
  const bookmarkOn = (ref: string): { name?: string } | undefined => {
    const direct = bookmarks.get(ref);
    if (direct !== undefined) return direct;
    const owned = ownedBy.get(ref);
    if (owned === undefined) return undefined;
    for (const id of owned) {
      const b = bookmarks.get(id);
      if (b !== undefined) return b;
    }
    return undefined;
  };
  const finalNodes: TreeNode[] = nodes.map((n) => {
    const b = bookmarkOn(n.id) ?? (n.openerId !== undefined ? bookmarkOn(n.openerId) : undefined);
    const { openerId: _o, openerOnPath: _p, ...rest } = n;
    return b !== undefined ? { ...rest, bookmark: b } : rest;
  });

  const head = resolveHead(events).head;
  // Map the head to a node id: the head may point at any event of a turn
  // (opener, interior, tail) or a chrome event — resolve it to the row
  // that owns it so the client can mark it.
  let headId: string | `line:${number}`;
  if (head === undefined) {
    headId = idOf(events.at(-1)!);
  } else if (byId.has(head)) {
    const headEvent = byId.get(head)!;
    const owner = turnOwners.get(headEvent) ?? nodes.find((n) => n.id === head);
    headId = owner ? owner.id : head;
  } else {
    headId = head;
  }

  return { nodes: finalNodes, headId };
}

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
