/**
 * Compaction producer (#466): the post-turn component that writes
 * `compaction` markers — the other half of the pair replay already
 * honors (`replayMessages`, #254). Replay reads; this writes.
 *
 * Auto trigger: the last `model_call`'s measured `inputTokens` above
 * 80% of the active model's context window (`catalogEntryFor`; the TUI
 * derives the same limit). Unknown window (0) → absolute fallback of
 * 180k inputTokens. Anti-loop guard: after a marker, the last measured
 * `inputTokens` is stale — the runner stays idle until a *new*
 * `model_call` measurement arrives.
 *
 * Markers are ordinary appends: the log stays integral forever, the
 * summary covers only the past (task state, never durable facts — the
 * Memory/compaction disjunction), the tail stays verbatim, and chained
 * summaries build on the previous marker. The maintenance subagent
 * pattern applies: an in-process child session, no tools, fail-silent
 * with one retry, never reachable through `spawn`.
 */
import type { AgentEvent, Provider, TurnResult } from "./types";
import type { CompactionHookContext } from "@moh/extension";
import { catalogEntryFor } from "./model-catalog";
import { activePath } from "./session/event-log";
import { PromptComposer } from "./prompt-composer";
import { lastAssistantText } from "./session-store";

/** Turns kept verbatim after `upTo`; the summary covers only the past. */
export const DEFAULT_TAIL_TURNS = 10;
/** Fraction of the model context window that arms auto compaction. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.8;
/** Absolute inputTokens fallback when the window is unknown (0). */
export const FALLBACK_CONTEXT_WINDOW = 180_000;
/** The verbatim tail may never exceed this fraction of the context window
 * (ADR-0022: "at least 10 turns and at most ~25% of the window"). */
export const DEFAULT_TAIL_WINDOW_FRACTION = 0.25;
/** Backoff between auto-retry runs while above threshold (#466): doubling,
 * capped; unlimited retries — a success or a below-threshold stop ends it. */
export const RETRY_BACKOFF_BASE_MS = 2_000;
export const RETRY_BACKOFF_MAX_MS = 60_000;
/** Hard character cap on the transcript handed to the summarizer. */
const TRANSCRIPT_CAP_CHARS = 60_000;

/** ADR-0035: the survival floor — at least this fraction of the droppable
 * text survives, however many sections the hooks asked to drop. The floor
 * makes a catastrophic judgment a bounded event; it is a property of the
 * core, not a rule the extension is asked to respect. */
export const COMPACTION_SECTION_FLOOR = 0.6;

/** ADR-0035: the preview cap (chars) the hook's section list carries. */
export const COMPACTION_SECTION_PREVIEW_CHARS = 200;

/** ADR-0035: one droppable section — one user turn's body (the assistant
 * work and tool traffic after the message). The user message itself is
 * never a section; chrome events are not offered either (they are dense,
 * small, and the conversation's spine). Shape mirrors `@moh/extension`'s
 * `CompactionSection` without importing it (the runner is internal). */
export interface CompactionSectionView {
  readonly id: string;
  readonly kind: "assistant" | "tool_result" | "tool_call";
  readonly bytes: number;
  readonly preview: string;
}

/** One turn's rendered pieces, during segmentation. */
interface TurnBody {
  id: string;
  kind: CompactionSectionView["kind"];
  parts: string[];
}

/** The kind a turn's body is dominated by: tool traffic wins over text,
 * tool results over calls (the bulk lives in results). */
function dominantKind(body: TurnBody): CompactionSectionView["kind"] {
  if (body.parts.some((p) => p.startsWith("tool_result"))) return "tool_result";
  if (body.parts.some((p) => p.startsWith("tool "))) return "tool_call";
  return "assistant";
}

/**
 * ADR-0035: splits the covered span into one section per user turn's
 * body. `sectionIdsFor` assigns each section's opaque id (index-keyed, so
 * the id is stable per compaction run without touching the log). Chrome
 * events and user messages contribute nothing: what is absent cannot be
 * dropped. Exported for tests.
 */
export function compactionSections(
  events: ReadonlyArray<AgentEvent>,
  from: number,
  to: number,
  sectionIdsFor: (turnIndex: number) => string,
): { sections: CompactionSectionView[]; bodies: (string | null)[] } {
  const sections: CompactionSectionView[] = [];
  const bodies: (string | null)[] = [];
  let current: TurnBody | null = null;
  const close = () => {
    if (!current) return;
    const text = current.parts.join("\n").trim();
    if (text) {
      sections.push({
        id: sectionIdsFor(sections.length),
        kind: dominantKind(current),
        bytes: Buffer.byteLength(text, "utf8"),
        preview: text.length > COMPACTION_SECTION_PREVIEW_CHARS ? `${text.slice(0, COMPACTION_SECTION_PREVIEW_CHARS)}…` : text,
      });
      bodies.push(text);
    } else {
      bodies.push(null);
    }
    current = null;
  };
  const lo = Math.max(0, from);
  const hi = Math.min(to, events.length);
  for (let i = lo; i < hi; i++) {
    const event = events[i]!;
    if (event.type === "user_message") {
      close();
      bodies.push(null); // the user message: spine, never a section
      current = { id: "", kind: "assistant", parts: [] };
      continue;
    }
    if (!current) continue; // chrome / leading events before the first turn
    if (event.type === "assistant_delta") {
      current.parts.push(`assistant: ${event.text.trim()}`);
    } else if (event.type === "tool_call") {
      current.parts.push(`tool ${event.name}: ${JSON.stringify(event.args).slice(0, 200)}`);
    } else if (event.type === "tool_result") {
      current.parts.push(`tool_result ${event.callId}: ${event.ok ? "ok" : "error"}`);
    } else if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
      // turn rollups — no section content
    }
    // every other event type is chrome: skipped
  }
  close();
  return { sections, bodies };
}

/**
 * ADR-0035: applies the requested drops to the per-turn bodies, enforcing
 * the survival floor: when more than `1 - COMPACTION_SECTION_FLOOR` of
 * the droppable bytes are requested away, the *smallest* sections are
 * un-dropped first until the floor holds (so the wanted large cuts are
 * the ones preserved), and `keptByFloor` says so. Exported for tests.
 */
export function applySectionDrops(
  sections: readonly CompactionSectionView[],
  drop: readonly string[],
): { droppedIds: Set<string>; keptByFloor: boolean } {
  // The floor is measured over ALL offered sections: "at least 60% of the
  // droppable text survives" is a property of the summary input, not of
  // the extension's enthusiasm.
  const droppable = sections.filter((s) => drop.includes(s.id));
  const total = sections.reduce((sum, s) => sum + s.bytes, 0);
  const dropped = new Set(drop);
  let keptByFloor = false;
  if (total > 0) {
    const budget = total * (1 - COMPACTION_SECTION_FLOOR);
    // Largest cuts have the highest claim: admit them in descending byte
    // order while the floor's budget holds; a cut that does not fit is
    // restored (the smallest claims yield first).
    let admitted = 0;
    for (const section of [...droppable].sort((a, b) => b.bytes - a.bytes)) {
      if (admitted + section.bytes <= budget) {
        admitted += section.bytes;
      } else {
        dropped.delete(section.id);
        keptByFloor = true;
      }
    }
    // Nothing was actually reduced: the whole request fit the budget.
    if (!keptByFloor) return { droppedIds: dropped, keptByFloor: false };
  }
  return { droppedIds: dropped, keptByFloor };
}

/**
 * Renders the covered events (from `from` inclusive to `to` exclusive)
 * as a compact transcript for the summarizer: user and assistant text,
 * tool calls as one-line outcomes. Tail-capped. `omit` (ADR-0035) names
 * per-turn bodies to leave out — the user messages and chrome around
 * them still render, exactly as they would have.
 */
export function compactionTranscript(
  events: ReadonlyArray<AgentEvent>,
  from: number,
  to: number,
  omit?: (turnIndex: number) => boolean,
): string {
  const parts: string[] = [];
  let assistant = "";
  let turnIndex = -1;
  let inTurn = false;
  const flush = () => {
    if (assistant.trim()) parts.push(`assistant: ${assistant.trim()}`);
    assistant = "";
  };
  const maybeCut = () => {
    if (omit && inTurn && turnIndex >= 0 && omit(turnIndex)) parts.push(`[section dropped: turn ${turnIndex}]`);
  };
  const lo = Math.max(0, from);
  const hi = Math.min(to, events.length);
  for (let i = lo; i < hi; i++) {
    const event = events[i]!;
    if (event.type === "user_message") {
      flush();
      maybeCut();
      turnIndex += 1;
      inTurn = true;
      parts.push(`user: ${event.text.trim()}`);
    } else if (event.type === "assistant_delta") {
      assistant += event.text;
    } else if (event.type === "tool_result") {
      flush();
      if (!omit || !omit(turnIndex)) parts.push(`tool ${event.callId}: ${event.ok ? "ok" : "error"}`);
    } else if (event.type === "tool_call") {
      flush();
      if (!omit || !omit(turnIndex)) parts.push(`tool ${event.name}: ${JSON.stringify(event.args).slice(0, 200)}`);
    } else if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
      flush();
    }
  }
  flush();
  maybeCut();
  let text = parts.join("\n");
  if (text.length > TRANSCRIPT_CAP_CHARS) text = `[…earlier transcript truncated…]\n${text.slice(-TRANSCRIPT_CAP_CHARS)}`;
  return text;
}

/** The compaction child session's role prompt (also the disjunction rule). */
export const COMPACTION_PROMPT = [
  "You are moh's compaction subagent. You summarize the covered part of a coding session so the conversation can continue with less context.",
  "",
  "Rules:",
  "- Summarize TASK STATE only: the goal, decisions made, current progress, concrete next steps, and open questions.",
  "- Keep file paths, commands, identifiers and error messages that the next turn still needs.",
  "- Never record durable project facts (conventions, preferences, environment truths) — those belong to memory, and memory and compaction are disjoint stores.",
  "- Never store credentials, tokens, or personal data.",
  "- Be dense: short factual paragraphs or bullets, no preamble, no pleasantries.",
  "- Respond with ONLY the summary text.",
].join("\n");

/** Effective context window for the active model label (0 = unknown). */
export function contextWindowFor(model: string, endpointType: string | undefined): number {
  const slash = model.indexOf("/");
  if (slash < 0 || !endpointType) return 0;
  return catalogEntryFor(endpointType, model.slice(slash + 1))?.contextWindow ?? 0;
}

/** True when the covered span holds at least one conversation turn. */
function markerSpanNonEmpty(events: ReadonlyArray<AgentEvent>, from: number, to: number): boolean {
  for (let i = Math.max(0, from); i < to && i < events.length; i++) {
    if (events[i]!.type === "user_message") return true;
  }
  return false;
}

/** Input handed to a compaction summarizer. */
export interface CompactionSummarizerInput {
  /** The previous marker's summary, when one exists (chained summaries). */
  previous?: string;
  /** Rendered transcript of the covered events (previous `upTo` → new `upTo`). */
  transcript: string;
  /** Aborted when the host stops waiting (dispose budget). */
  signal?: AbortSignal;
}

/** Produces the summary text for one marker. Throws on failure. */
export type CompactionSummarizer = (input: CompactionSummarizerInput) => Promise<string>;

/** Options accepted by `createSession`. */
export interface CompactionOptions {
  /** Default true; `false` disables the runner entirely (no auto
   * trigger, no forced path). */
  enabled?: boolean;
  /** Turns kept verbatim. Default 10. */
  tailTurns?: number;
  /** Fraction of the context window arming auto compaction. Default 0.8. */
  threshold?: number;
  /** Absolute inputTokens fallback when the window is unknown. Default 180k. */
  fallbackWindowTokens?: number;
  /** Summarizer override (tests, clients). Default: the compaction subagent. */
  summarizer?: CompactionSummarizer;
  /**
   * ADR-0035: the extension seam, consulted before the summarized
   * transcript is rendered (auto and forced paths alike). Absent or
   * throwing → no drops, compaction exactly as today. The runtime's
   * dispatch returns the collected drops plus the `extension_failed`
   * events to append; the runner applies the survival floor.
   */
  sectionFilter?: (ctx: CompactionHookContext) => Promise<{
    drop: string[];
    /** ADR-0035: callbacks the runner invokes once with the applied cut. */
    onApplied?: ((applied: { keptByFloor: boolean; bytesAfter: number }) => void)[];
    errors: AgentEvent[];
  } | void>;
}

export interface CompactionRunnerOptions {
  sessionId: string;
  /** The live host provider (getter — model switches are picked up). */
  provider: () => Provider;
  /** Provider type of the active endpoint (catalog lookup); undefined for
   * pre-built/bare providers — the window is then unknown → fallback. */
  endpointType?: () => string | undefined;
  /** Appends the `compaction` marker to the session log. */
  append: (event: AgentEvent) => void;
  /** #578 (d3/d7): the path compaction covers — the session supplies the
   * projection anchored at the turn's pinned head (the branch actually
   * summarized); the runner falls back to the live log's active path. */
  pathFn?: () => ReadonlyArray<AgentEvent>;
  /** Called after a successful append (the host rebuilds its messages). */
  onCompacted: () => void;
  summarizer: CompactionSummarizer;
  sectionFilter?: CompactionOptions["sectionFilter"];
  tailTurns?: number;
  threshold?: number;
  fallbackWindowTokens?: number;
}

/**
 * The post-turn compaction trigger (#466). Fire-and-forget like the
 * MemoryRunner: never blocks the turn, one retry, fail-silent but not
 * lossy — a failed run leaves the marker unwritten, so the next new
 * `model_call` measurement simply re-arms the trigger.
 */
export class CompactionRunner {
  readonly #provider: () => Provider;
  readonly #endpointType: (() => string | undefined) | undefined;
  readonly #append: (event: AgentEvent) => void;
  readonly #pathFn: (() => ReadonlyArray<AgentEvent>) | undefined;
  readonly #onCompacted: () => void;
  readonly #summarizer: CompactionSummarizer;
  readonly #sectionFilter: CompactionOptions["sectionFilter"];
  readonly #tailTurns: number;
  readonly #threshold: number;
  readonly #fallbackWindow: number;
  /** Last `model_call` index this runner has already evaluated. */
  #lastSeenCallIndex = -1;
  #busy = false;
  #pending: Promise<void> | null = null;
  #controller: AbortController | null = null;
  /** Consecutive failed auto runs above threshold (#466): drives the
   * doubling backoff; reset on a success or a below-threshold turn. */
  #consecutiveFailures = 0;
  /** ADR-0035 §4: the dispatch of the run in flight reduced the cut to the
   * survival floor (stamped onto the marker it produces). */
  #floorApplied = false;
  /** Timer of a scheduled auto retry (cleared on cancel/dispose). */
  #retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: CompactionRunnerOptions) {
    this.#provider = opts.provider;
    this.#endpointType = opts.endpointType;
    this.#append = opts.append;
    this.#pathFn = opts.pathFn;
    this.#onCompacted = opts.onCompacted;
    this.#summarizer = opts.summarizer;
    this.#sectionFilter = opts.sectionFilter;
    this.#tailTurns = opts.tailTurns ?? DEFAULT_TAIL_TURNS;
    this.#threshold = opts.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
    this.#fallbackWindow = opts.fallbackWindowTokens ?? FALLBACK_CONTEXT_WINDOW;
  }

  /** A pending background run, if any (awaited by session dispose). */
  get pending(): Promise<void> | null {
    return this.#pending;
  }

  cancel(): void {
    this.#controller?.abort();
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
  }

  /** The newest compaction marker in the log, or undefined. `upToId` is
   * the writer's pointer form (#578); `upTo` remains for legacy logs. */
  static latestMarker(events: ReadonlyArray<AgentEvent>): { index: number; upTo?: number; upToId?: string; summary: string } | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (e.type === "compaction") return { index: i, upTo: e.upTo, upToId: e.upToId, summary: e.summary };
    }
    return undefined;
  }

  /** Absolute `upTo` for a new marker: the index of the user_message that
   * begins the (N - tail)th turn — the last `tailTurns` turns stay verbatim.
   * Combined rule (ADR-0022): the tail keeps at least 10 turns but never
   * spans more than ~25% of the context window (estimated from the
   * measured `model_call` tokens per turn). When the requested tail
   * exceeds the window fraction, it shrinks — down to the
   * `DEFAULT_TAIL_TURNS` floor, never below. */
  static upToFor(
    events: ReadonlyArray<AgentEvent>,
    tailTurns: number,
    windowTokens = 0,
  ): number | undefined {
    const turns: number[] = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i]!.type === "user_message") turns.push(i);
    }
    if (turns.length <= tailTurns) return undefined;
    if (windowTokens <= 0) return turns[turns.length - tailTurns]!;
    const cap = windowTokens * DEFAULT_TAIL_WINDOW_FRACTION;
    const start = turns.length - tailTurns;
    // Span of the requested tail, shrunk from its oldest turn while it
    // exceeds the window fraction; the 10-turn floor is a hard minimum.
    let span = 0;
    for (let k = start; k < turns.length; k++) {
      span += CompactionRunner.turnTokens(events, turns[k]!, turns[k + 1] ?? events.length);
    }
    let kept = tailTurns;
    let oldest = start;
    while (span > cap && kept > DEFAULT_TAIL_TURNS && oldest < turns.length - (DEFAULT_TAIL_TURNS - 1)) {
      span -= CompactionRunner.turnTokens(events, turns[oldest]!, turns[oldest + 1] ?? events.length);
      oldest += 1;
      kept -= 1;
    }
    return turns[oldest]!;
  }

  /** Measured input tokens attributable to one turn (its user_message up
   * to the next turn's start): the max `model_call.inputTokens` inside —
   * the largest measurement approximates the whole-turn context size. */
  static turnTokens(events: ReadonlyArray<AgentEvent>, from: number, to: number): number {
    let max = 0;
    for (let i = Math.max(0, from); i < to && i < events.length; i++) {
      const e = events[i]!;
      if (e.type === "model_call" && e.usage.inputTokens > max) max = e.usage.inputTokens;
    }
    return max;
  }

  /** Whether the last measured inputTokens crosses the auto threshold. */
  shouldAutoCompact(events: ReadonlyArray<AgentEvent>): boolean {
    const call = CompactionRunner.lastMeasuredCall(events);
    if (!call) return false;
    const model = this.#provider().name;
    const window = contextWindowFor(model, this.#endpointType?.());
    const limit = window > 0 ? window * this.#threshold : this.#fallbackWindow;
    return call.inputTokens > limit;
  }

  /** The most recent `model_call` measurement: index + measured input tokens. */
  static lastMeasuredCall(events: ReadonlyArray<AgentEvent>): { index: number; inputTokens: number } | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (e.type === "model_call") {
        return { index: i, inputTokens: e.usage.inputTokens };
      }
    }
    return undefined;
  }

  /** Fire-and-forget after each settled turn. `events` must be the host's
   * live log (same array instance) so index bookkeeping stays valid.
   * Unlimited retries with backoff while two consecutive measurements stay
   * above threshold (#466): a failure schedules the next attempt on the
   * next new measurement after a doubling delay, and emits the
   * `compaction_failed` chrome event the clients need for their sticky
   * warning. */
  maybeCompact(result: TurnResult, events: ReadonlyArray<AgentEvent>, disposed: boolean): void {
    if (result.status !== "done" || this.#busy || disposed) return;
    const call = CompactionRunner.lastMeasuredCall(events);
    // Anti-loop guard: only a *new* measurement can arm the trigger.
    if (!call || call.index <= this.#lastSeenCallIndex) return;
    this.#lastSeenCallIndex = call.index;
    if (!this.shouldAutoCompact(events)) {
      // Below threshold again: the retry chain ends, backoff resets.
      this.#consecutiveFailures = 0;
      if (this.#retryTimer !== null) {
        clearTimeout(this.#retryTimer);
        this.#retryTimer = null;
      }
      return;
    }
    this.#run(events, false);
  }

  /** Forced compaction (/compact, `moh compact`): ignores the threshold
   * and the stale-measurement guard, same tail and summarizer. */
  compactNow(events: ReadonlyArray<AgentEvent>): Promise<{ ok: true; summary: string; upTo: number; upToId?: string } | { ok: false; error: string }> {
    if (this.#busy) return Promise.resolve({ ok: false, error: "a compaction run is already in progress" });
    const call = CompactionRunner.lastMeasuredCall(events);
    if (call) this.#lastSeenCallIndex = call.index;
    return new Promise((resolve) => {
      this.#run(events, true, resolve);
    });
  }

  #run(
    events: ReadonlyArray<AgentEvent>,
    forced: boolean,
    resolve?: (r: { ok: true; summary: string; upTo: number; upToId?: string } | { ok: false; error: string }) => void,
  ): void {
    // The body is async (ADR-0035's filter dispatch awaits); `#pending`
    // below still tracks the in-flight promise, as before.
    void this.#runAsync(events, forced, resolve);
  }

  async #runAsync(
    events: ReadonlyArray<AgentEvent>,
    forced: boolean,
    resolve?: (r: { ok: true; summary: string; upTo: number; upToId?: string } | { ok: false; error: string }) => void,
  ): Promise<void> {
    const live = events as AgentEvent[];
    const window = contextWindowFor(this.#provider().name, this.#endpointType?.()) || this.#fallbackWindow;
    // #578 (core spec d3): compaction covers only the active path —
    // every index computation runs on the projected array; abandoned
    // branches are untouched. The projection is anchored at the turn's
    // pinned head (the branch actually summarized) when supplied — a
    // switch that landed during the turn moves the head only from the
    // next turn, so the marker stays a truthful node of the path it
    // describes (d7). Without a pin (direct runner tests, `moh compact`
    // on a closed file) the live log's active path is used.
    const path = this.#pathFn ? this.#pathFn() : activePath(live);
    const newUpTo = CompactionRunner.upToFor(path, this.#tailTurns, window);
    if (newUpTo === undefined) {
      resolve?.({ ok: false, error: `nothing to compact: fewer than ${this.#tailTurns + 1} turns in the log` });
      return;
    }
    const marker = CompactionRunner.latestMarker(path);
    const from = marker ? (marker.upToId !== undefined ? path.findIndex((e) => e.id === marker.upToId) : marker.upTo ?? 0) : 0;
    if (!forced && !marker && newUpTo <= 0) {
      resolve?.({ ok: false, error: "nothing to compact" });
      return;
    }
    if (!markerSpanNonEmpty(path, from, newUpTo)) {
      resolve?.({ ok: false, error: "nothing to compact: the covered span has no turns" });
      return;
    }
    // The marker's pointer: the id (or legacy `line:N` bridge for an
    // identity-less prefix) of the last covered event on the path (d5).
    const anchor = path[newUpTo - 1]!;
    const upToId = anchor.id ?? `line:${newUpTo}`;
    // ADR-0035: consult the extension seam before rendering. The section
    // ids are per-run index keys — they name sections within this one
    // dispatch, never log positions. Fail-open: any error here leaves the
    // transcript untouched and appends the recorded `extension_failed`s.
    let omit: ((turnIndex: number) => boolean) | undefined;
    this.#floorApplied = false;
    const filter = this.#sectionFilter;
    if (filter) {
      try {
        const turnCount = path
          .slice(Math.max(0, from), newUpTo)
          .filter((e) => e.type === "user_message").length;
        const approxTokens = CompactionRunner.turnTokens(path, from, newUpTo);
        const { sections } = compactionSections(path, from, newUpTo, (i) => `s${i}`);
        const result = await filter({
          sections,
          ...(approxTokens > 0 ? { approxTokens } : {}),
        });
        if (result) {
          for (const error of result.errors) this.#append(error);
          let applied = { keptByFloor: false, bytesAfter: 0 };
          if (result.drop.length > 0 && turnCount > 0) {
            const { droppedIds, keptByFloor } = applySectionDrops(sections, result.drop);
            const bytesAfter = sections.reduce(
              (sum, s) => sum + (droppedIds.has(s.id) ? 0 : s.bytes),
              0,
            );
            applied = { keptByFloor, bytesAfter };
            this.#floorApplied = keptByFloor;
            if (keptByFloor) {
              // One visible line: the cut was reduced, never silently.
              this.#append({
                type: "extension_failed",
                name: "compaction",
                reason: "section_floor",
                message: "the requested drops exceeded the survival floor and were reduced",
              });
            }
            const droppedSet = droppedIds;
            omit = (turnIndex) => droppedSet.has(`s${turnIndex}`);
          } else {
            applied = { keptByFloor: false, bytesAfter: sections.reduce((sum, s) => sum + s.bytes, 0) };
          }
          // The hook learns what was actually applied (post-floor), exactly
          // once, before the transcript renders. A throw is swallowed: the
          // extension's record must never break the compaction.
          for (const callback of result.onApplied ?? []) {
            try {
              callback(applied);
            } catch {
              /* observability only */
            }
          }
        }
      } catch {
        // Fail-open, silently: the cut is an optimization. (Hook errors
        // are already recorded by the dispatch itself; a runner-level
        // failure loses nothing that matters — no marker depends on it.)
      }
    }
    const transcript = compactionTranscript(path, from, newUpTo, omit);
    const summarizer = this.#summarizer;
    const controller = new AbortController();
    this.#controller = controller;
    this.#busy = true;
    const run = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const summary = await summarizer({
            ...(marker ? { previous: marker.summary } : {}),
            transcript,
            signal: controller.signal,
          });
          const text = summary.trim();
          if (!text) throw new Error("empty compaction summary");
          // d7: the marker is an ordinary append on the summarized
          // branch — an explicit parent pins it to the summarized
          // path's tip even if the head has already moved.
          const pathTip = [...path].reverse().find((e) => e.id !== undefined);
          this.#append({
            type: "compaction",
            summary: text,
            upToId,
            ...(pathTip?.id !== undefined ? { parentId: pathTip.id } : {}),
            // ADR-0035 §4: the marker itself records that the extension's
            // cut was reduced to the survival floor (chrome, audit only).
            ...(this.#floorApplied ? { keptByFloor: true as const } : {}),
          });
          this.#onCompacted();
          this.#consecutiveFailures = 0;
          resolve?.({ ok: true, summary: text, upTo: newUpTo, upToId });
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt === 1) {
            // Fail-silent, not lossy: no marker written. The chrome event
            // lets clients show their sticky warning; the auto path keeps
            // retrying on later turns with doubling backoff (#466).
            this.#consecutiveFailures += 1;
            this.#append({ type: "compaction_failed", reason: message });
            if (!forced) {
              const delay = Math.min(
                RETRY_BACKOFF_BASE_MS * 2 ** (this.#consecutiveFailures - 1),
                RETRY_BACKOFF_MAX_MS,
              );
              this.#retryTimer = setTimeout(() => {
                this.#retryTimer = null;
                if (this.#busy || this.#consecutiveFailures === 0) return;
                this.#run(events, false);
              }, delay);
            }
            resolve?.({ ok: false, error: message });
            return;
          }
        }
      }
    })();
    this.#pending = run.finally(() => {
      this.#busy = false;
      this.#controller = null;
      this.#pending = null;
    });
  }
}

/**
 * The default compaction summarizer (#466): the compaction child
 * session — maintenance-subagent style. No tools, no subagents (depth
 * discipline), a dedicated conversational-summary prompt (not the
 * memory fact-JSON protocol). Errors propagate to the runner's retry.
 */
export function createCompactionSummarizer(provider: Provider, cwd: string): CompactionSummarizer {
  return async (input) => {
    // Lazy import: session.ts already imports memory.ts; keep the cycle
    // impossible at load time (same pattern as createMaintenanceExtractor).
    const { AgentSession } = await import("./session/session");
    const child = new AgentSession({
      provider,
      tools: {},
      cwd,
      subagents: null,
      promptComposer: new PromptComposer({ projectDir: cwd, basePrompt: COMPACTION_PROMPT }),
    });
    input.signal?.addEventListener("abort", () => child.abort(), { once: true });
    try {
      const user = [
        input.previous ? `# Previous summary\n${input.previous}\n` : "# Previous summary\n(none — this is the first compaction)",
        "",
        "# Conversation to summarize",
        input.transcript,
        "",
        "Write the chained summary per your rules. Respond with only the summary text.",
      ].join("\n");
      const turn = await child.send(user);
      if (turn.status !== "done") throw new Error(`compaction subagent ended ${turn.status}`);
      return lastAssistantText(child.history());
    } finally {
      await child.dispose().catch(() => {});
    }
  };
}
