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
import type { AppliedCut, CompactionHookContext } from "@moh/extension";
import { catalogEntryFor } from "./model-catalog";
// ADR-0050 (#974): the window is derived from the model that SERVES the
// calls, never from the selected reference a fallback left behind.
import { servingModelOf } from "./model-pair";
import type { DeclaredWindowLookup } from "./declared-window";
import { CONTEXT_FIT_RESERVE } from "./context-fit";
import { activePath } from "./session/event-log";
import { PromptComposer } from "./prompt-composer";
import { lastAssistantText } from "./session-store";

/** Turns kept verbatim after `upTo`; the summary covers only the past.
 * #949 (ADR-0022 §2 amendment): a *preference*, never a floor — the
 * window wins when the two conflict. */
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

/**
/**
 * The endpoint a window is resolved for (#1032, ADR-0049 door two): a
 * window belongs to the endpoint that serves the model — Zen is not Go,
 * and a recognized compat host has its own catalog — so the lookup takes
 * the endpoint identity, never just the provider kind. `declaredWindows`
 * is the endpoint's OWN listing (its cached live-models entry, model id
 * → tokens): the provider's last word, outranking the shipped row in
 * both directions.
 */
export interface WindowEndpoint {
  type: string;
  baseUrl?: string;
  declaredWindows?: Record<string, number>;
}

/** Effective context window for the active model label (0 = unknown).
 * ADR-0049: one resolution for every consumer, both doors — the window
 * a refusal taught this session (door one, the freshest and most
 * specific fact), then the endpoint's own listing (door two), then the
 * shipped catalog row for that endpoint, then 0 = unknown. No consumer
 * keeps a private override, so the compaction producer and the fit
 * guard cannot disagree. */
export function contextWindowFor(model: string, endpoint: WindowEndpoint | string | undefined, declared?: DeclaredWindowLookup): number {
  const learned = declared?.declaredWindowFor(model);
  if (learned !== undefined && learned > 0) return learned;
  const slash = model.indexOf("/");
  if (slash < 0 || !endpoint) return 0;
  const id = model.slice(slash + 1);
  if (typeof endpoint !== "string") {
    const declaredWindow = endpoint.declaredWindows?.[id];
    if (typeof declaredWindow === "number" && declaredWindow > 0) return declaredWindow;
    return catalogEntryFor(endpoint.type, id, endpoint.baseUrl)?.contextWindow ?? 0;
  }
  return catalogEntryFor(endpoint, id)?.contextWindow ?? 0;
}

/** True when the covered span holds at least one conversation turn. */
function markerSpanNonEmpty(events: ReadonlyArray<AgentEvent>, from: number, to: number): boolean {
  for (let i = Math.max(0, from); i < to && i < events.length; i++) {
    if (events[i]!.type === "user_message") return true;
  }
  return false;
}

/** #766: the structured facts a deterministic summarizer digests —
 * extracted from the covered span's events, no model call. Files are
 * collected from `tool_call` path arguments (`file_path`, `path`,
 * `filePath`, `notebook_path`); classification is by tool name
 * (write-ish names → modified, everything else → read). `recentErrors`
 * keeps the last few failed tool results, oldest→newest, snippets
 * capped. */
export interface CompactionFacts {
  /** Whole turns covered (user messages) in the span. */
  turns: number;
  /** The user's requests, in order (the task-state spine). */
  userMessages: string[];
  filesRead: string[];
  filesModified: string[];
  /** Per-tool traffic: calls and failed results. */
  toolCalls: { tool: string; calls: number; errors: number }[];
  recentErrors: string[];
  /** The last assistant text in the span (current progress), truncated. */
  lastAssistant: string;
}

/** The path-bearing argument keys moh recognizes across its built-in
 * tools; unknown tools that carry one of these are treated as
 * read-implications (conservative: presence implies inspection). */
const FACT_PATH_KEYS = new Set(["file_path", "filePath", "path", "notebook_path"]);
const FACT_WRITEISH = /(^|_|-)(edit|write|multiedit|apply|patch|create|move|remove|delete|notebook)/;

/** Maximum entries kept per file list and per error snippet. */
const FACT_LIST_CAP = 40;
const FACT_ERROR_CAP = 5;
const FACT_ERROR_SNIPPET_CHARS = 200;
const FACT_LAST_ASSISTANT_CHARS = 800;
const FACT_USER_MESSAGE_CHARS = 400;

/** #766: extracts `CompactionFacts` from the covered span
 * (`from` inclusive → `to` exclusive). Deterministic and side-effect
 * free; exported for tests and for clients that want to pre-render a
 * digest without running a summarizer. */
export function compactionFacts(events: ReadonlyArray<AgentEvent>, from: number, to: number): CompactionFacts {
  const userMessages: string[] = [];
  const filesRead = new Set<string>();
  const filesModified = new Set<string>();
  const toolStats = new Map<string, { calls: number; errors: number }>();
  const errorNamesByCall = new Map<string, string>();
  const recentErrors: string[] = [];
  let lastAssistant = "";
  const lo = Math.max(0, from);
  const hi = Math.min(to, events.length);
  for (let i = lo; i < hi; i++) {
    const event = events[i]!;
    if (event.type === "user_message") {
      const text = event.text.trim();
      userMessages.push(text.length > FACT_USER_MESSAGE_CHARS ? `${text.slice(0, FACT_USER_MESSAGE_CHARS)}…` : text);
    } else if (event.type === "assistant_delta") {
      lastAssistant += event.text;
    } else if (event.type === "tool_call") {
      const stats = toolStats.get(event.name) ?? { calls: 0, errors: 0 };
      stats.calls += 1;
      toolStats.set(event.name, stats);
      errorNamesByCall.set(event.callId, event.name);
      const args = event.args as Record<string, unknown> | undefined;
      for (const key of FACT_PATH_KEYS) {
        const value = args?.[key];
        if (typeof value === "string" && value.trim()) {
          const target = FACT_WRITEISH.test(event.name.toLowerCase()) ? filesModified : filesRead;
          if (target.size < FACT_LIST_CAP || target.has(value)) target.add(value);
          break;
        }
      }
    } else if (event.type === "tool_result" && !event.ok) {
      const tool = errorNamesByCall.get(event.callId) ?? "unknown";
      const stats = toolStats.get(tool) ?? { calls: 0, errors: 0 };
      stats.errors += 1;
      toolStats.set(tool, stats);
      if (recentErrors.length < FACT_ERROR_CAP * 4) {
        const snippet = event.output.replace(/\s+/g, " ").trim();
        if (snippet) {
          recentErrors.push(`${tool}: ${snippet.length > FACT_ERROR_SNIPPET_CHARS ? `${snippet.slice(0, FACT_ERROR_SNIPPET_CHARS)}…` : snippet}`);
        }
      }
    } else if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
      // turn rollups — no fact content
    }
  }
  const trimmed = lastAssistant.trim();
  return {
    turns: userMessages.length,
    userMessages,
    filesRead: [...filesRead],
    filesModified: [...filesModified],
    toolCalls: [...toolStats.entries()].map(([tool, s]) => ({ tool, ...s })),
    recentErrors: recentErrors.slice(-FACT_ERROR_CAP),
    lastAssistant: trimmed.length > FACT_LAST_ASSISTANT_CHARS ? `…${trimmed.slice(-FACT_LAST_ASSISTANT_CHARS)}` : trimmed,
  };
}

/** Input handed to a compaction summarizer. */
export interface CompactionSummarizerInput {
  /** The previous marker's summary, when one exists (chained summaries). */
  previous?: string;
  /** Rendered transcript of the covered events (previous `upTo` → new `upTo`). */
  transcript: string;
  /** #766: the span's structured facts (files, tool traffic, errors,
   * user requests) — present for every runner-invoked summarizer;
   * optional so existing custom summarizers keep their signature. */
  facts?: CompactionFacts;
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
   * #766 (ADR-0051): JSON-safe strategy selector, mirrored by moh.json
   * `compaction.summarizer`. "deterministic" selects the rule-built
   * digest summarizer — no model call, byte-stable across runs — with
   * an explicit fallback to the LLM summarizer when the digest exceeds
   * its budget (the `compaction` marker records which one served).
   * Default "llm". A `summarizer` function override wins when both are
   * given.
   */
  summarizerStrategy?: "llm" | "deterministic";
  /**
   * ADR-0035: the extension seam, consulted before the summarized
   * transcript is rendered (auto and forced paths alike). Absent or
   * throwing → no drops, compaction exactly as today. The runtime's
   * dispatch returns the collected drops plus the `extension_failed`
   * events to append; the runner applies the survival floor.
   */
  sectionFilter?: (ctx: CompactionHookContext) => Promise<{
    drop: string[];
    /** ADR-0035: callbacks the runner invokes once with the applied cut
     * (`applied: false` marks a cut the core never applied — #979). */
    onApplied?: ((applied: AppliedCut) => void)[];
    errors: AgentEvent[];
  } | void>;
}

export interface CompactionRunnerOptions {
  sessionId: string;
  /** The live host provider (getter — model switches are picked up). */
  provider: () => Provider;
  /** Provider identity of the active endpoint — kind + baseUrl + the
   * endpoint's own declared windows (#1032); undefined for pre-built/bare
   * providers — the window is then unknown → fallback. Supersedes
   * `endpointType` (kept for compatibility: a string kind, no baseUrl,
   * no declaration). */
  endpoint?: () => WindowEndpoint | undefined;
  /** Provider type of the active endpoint (catalog lookup); undefined for
   * pre-built/bare providers — the window is then unknown → fallback.
   * @deprecated Superseded by `endpoint` (#1032): a kind alone cannot
   * resolve a per-endpoint catalog or carry the endpoint's declared
   * window. Kept only for direct-runner callers not yet migrated. */
  endpointType?: () => string | undefined;
  /** ADR-0049: the session's declared windows (a getter — a refusal
   * learned mid-session is picked up by the next run). One lookup with the
   * fit guard: the declared window outranks the catalog row. */
  declaredWindows?: () => DeclaredWindowLookup | undefined;
  /** Appends the `compaction` marker to the session log. */
  append: (event: AgentEvent) => void;
  /** #578 (d3/d7): the path compaction covers — the session supplies the
   * projection anchored at the turn's pinned head (the branch actually
   * summarized); the runner falls back to the live log's active path. */
  pathFn?: () => ReadonlyArray<AgentEvent>;
  /** Called after a successful append (the host rebuilds its messages). */
  onCompacted: () => void;
  summarizer: CompactionSummarizer;
  /** #766 (ADR-0051): a getter the runner reads at marker time so the
   * marker records which summarizer actually served (a strategy wrapper
   * may degrade to the fallback mid-run). Absent → no stamp (the
   * default LLM summarizer). */
  summarizerName?: () => string | undefined;
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
  readonly #endpoint: (() => WindowEndpoint | undefined) | undefined;
  readonly #endpointType: (() => string | undefined) | undefined;
  readonly #declaredWindows: (() => DeclaredWindowLookup | undefined) | undefined;
  readonly #append: (event: AgentEvent) => void;
  readonly #pathFn: (() => ReadonlyArray<AgentEvent>) | undefined;
  readonly #onCompacted: () => void;
  readonly #summarizer: CompactionSummarizer;
  readonly #summarizerName: (() => string | undefined) | undefined;
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
    this.#endpoint = opts.endpoint;
    this.#endpointType = opts.endpointType;
    this.#declaredWindows = opts.declaredWindows;
    this.#append = opts.append;
    this.#pathFn = opts.pathFn;
    this.#onCompacted = opts.onCompacted;
    this.#summarizer = opts.summarizer;
    this.#summarizerName = opts.summarizerName;
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

  /** Absolute `upTo` for a new marker, per the #949 tail policy (ADR-0022
   * §2 amendment): one rule for the auto and the forced path — the tail
   * is a contiguous suffix, `tailTurns` (default 10) a *preference*
   * rather than a floor, and the window wins when the two conflict:
   *
   * 1. candidate = the last `tailTurns` whole turns;
   * 2. while the span exceeds 25% of the window and more than one whole
   *    turn is left, the oldest tail turn is left out;
   * 3. the last turn is protected: it stays whole while it fits
   *    `window − CONTEXT_FIT_RESERVE`, even if it alone exceeds the 25%;
   * 4. only when the last turn alone exceeds `window − reserve` is the
   *    cut taken *inside* it: the largest legal suffix under the
   *    ceiling, or the last legal boundary when none fits. A ceiling
   *    never produces a refusal.
   *
   * Returns `{ upTo, partial }` — `partial` when the cut lands inside
   * the last turn (the tail begins mid-turn, not at a `user_message`).
   * Unknown window (0) keeps the bare turn-count rule (the 25% clause
   * and the intra-turn cut need a window to be meaningful).
   */
  static upToFor(
    events: ReadonlyArray<AgentEvent>,
    tailTurns: number,
    windowTokens = 0,
  ): { upTo: number; partial: boolean } | undefined {
    if (tailTurns < 1) tailTurns = 1;
    const turns: number[] = [];
    for (let i = 0; i < events.length; i++) {
      if (events[i]!.type === "user_message") turns.push(i);
    }
    if (turns.length === 0) return undefined;
    if (windowTokens <= 0) {
      // Bare preference: the old behaviour. Fewer turns than the
      // preference → nothing foldable → a visible skip upstream.
      if (turns.length <= tailTurns) return undefined;
      return { upTo: turns[turns.length - tailTurns]!, partial: false };
    }
    const cap = windowTokens * DEFAULT_TAIL_WINDOW_FRACTION;
    const ceiling = windowTokens - CONTEXT_FIT_RESERVE;
    const tokens = (k: number) => CompactionRunner.turnTokens(events, turns[k]!, turns[k + 1] ?? events.length);
    // Candidate span: the last `tailTurns` whole turns.
    let start = Math.max(0, turns.length - tailTurns);
    let span = 0;
    for (let k = start; k < turns.length; k++) span += tokens(k);
    // Nothing foldable: the tail preference already covers every turn
    // and the whole span sits under the cap — a summary has nothing to
    // cover (the visible `compaction_skipped` fires upstream).
    if (span <= cap && start === 0) return undefined;
    // Shrink from the oldest while the cap is busted and more than one
    // whole turn is left. The last turn's own tokens are the floor the
    // loop cannot cross — (3) protects it.
    const lastTokens = tokens(turns.length - 1);
    while (span > cap && start < turns.length - 1) {
      span -= tokens(start);
      start += 1;
    }
    // (3) the last turn fits the reserve even if it busts the cap.
    if (lastTokens <= ceiling) return { upTo: turns[start]!, partial: false };
    // (4) the cut goes inside the last turn: the largest legal suffix
    // under the ceiling, anchored at a legal boundary — never a
    // `tool_result` head, never a split pair. A ceiling never refuses.
    const inside = CompactionRunner.intraTurnCut(events, turns[turns.length - 1]!, events.length, ceiling);
    return { upTo: inside, partial: true };
  }

  /** #949: the largest legal cut point inside one turn — the start of
   * the earliest event whose measured suffix (estimated proportionally
   * from the turn's own `model_call` measurements, falling back to a
   * byte-proportional estimate) still fits `ceiling`; anchored so the
   * replayed tail never begins with a `tool_result` and never splits a
   * `tool_call`/`tool_result` pair (ADR-0022 §2 amendment: a protocol
   * constraint, not policy). Returns the index of the chosen first tail
   * event; when nothing else is legal, the last legal boundary wins. */
  static intraTurnCut(events: ReadonlyArray<AgentEvent>, from: number, to: number, ceiling: number): number {
    const legal = CompactionRunner.legalBoundaries(events, from, to);
    if (legal.length === 0) return from;
    // Proportional size per event: measured turn tokens distributed by
    // byte share (exact per-event token counts are not recoverable from
    // the log — the measurement is per call, not per event).
    let bytes = 0;
    const sizes: number[] = [];
    for (let i = from; i < to; i++) {
      const s = JSON.stringify(events[i]).length;
      sizes.push(s);
      bytes += s;
    }
    const total = Math.max(CompactionRunner.turnTokens(events, from, to), 0);
    // Walk boundaries oldest→newest keeping the largest suffix ≤ ceiling
    // (a running suffix sum from the newest boundary keeps this O(N)).
    let best = legal[0]!;
    let suffixAfter = 0; // estimated tokens strictly after the boundary
    for (let i = to - 1; i >= from; i--) {
      if (events[i]!.type === "tool_result") {
        suffixAfter += (sizes[i - from]! / Math.max(bytes, 1)) * total;
        continue;
      }
      if (suffixAfter <= ceiling) best = i;
      suffixAfter += (sizes[i - from]! / Math.max(bytes, 1)) * total;
    }
    return best;
  }

  /** #949: event indices inside `[from, to)` where a replayed tail may
   * *begin*: not on a `tool_result` (an orphan result at the head would
   * reach the provider without its call — #237 repairs unanswered calls,
   * #371 filters only results of discarded calls), not between a
   * `tool_call` and its `tool_result`. Allowed first events:
   * `user_message`, `assistant_delta`, `reasoning`, `tool_call`. */
  static legalBoundaries(events: ReadonlyArray<AgentEvent>, from: number, to: number): number[] {
    const legal: number[] = [];
    for (let i = from; i < to; i++) {
      const e = events[i]!;
      if (e.type === "tool_result") continue; // never a head
      // A `tool_call` boundary keeps its pair intact only while its
      // result lies inside `[from, to)` (the producer always cuts at
      // `to = events.length`, where this holds); a boundary can never
      // fall strictly between call and result — both are event starts.
      if (e.type === "user_message" || e.type === "assistant_delta" || e.type === "reasoning" || e.type === "tool_call") {
        legal.push(i);
      }
    }
    return legal;
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
    // ADR-0050 §7: the measured tokens belong to the serving model, so the
    // threshold is computed from the window that serves — a fallback onto a
    // smaller window arms compaction that much earlier.
    const model = servingModelOf(this.#provider());
    const endpoint = this.#endpoint?.() ?? (this.#endpointType?.() ? { type: this.#endpointType!()! } : undefined);
    const window = contextWindowFor(model, endpoint, this.#declaredWindows?.());
    const limit = window > 0 ? window * this.#threshold : this.#fallbackWindow;
    return call.inputTokens > limit;
  }

  /** The most recent `model_call` measurement: index + measured input tokens.
   * #947: a failed call's `{0,0}` is not a measurement — it would mask the
   * real one (a 250k context read as 0 after a `context_length` failure). */
  static lastMeasuredCall(events: ReadonlyArray<AgentEvent>): { index: number; inputTokens: number } | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]!;
      if (e.type === "model_call" && !e.failed) {
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
    if (this.#busy || disposed) return;
    // #947: a `context_length` error is the one error the producer can act
    // on. The turn that overflowed arms it — the provider's own "does not
    // fit" outranks our threshold arithmetic (which is exactly what fails
    // on an unknown window), so the stale-measurement guard and the
    // threshold check do not apply on this path. Still the post-turn
    // producer (ADR-0022 §1): nothing compacts inline.
    const overflow = result.status === "error" && result.reason === "context_length";
    if (result.status !== "done" && !overflow) return;
    const call = CompactionRunner.lastMeasuredCall(events);
    if (!call) return;
    if (!overflow) {
      // Anti-loop guard: only a *new* measurement can arm the trigger.
      if (call.index <= this.#lastSeenCallIndex) return;
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
    }
    this.#run(events, false);
  }

  /** Forced compaction (/compact, `moh compact`): ignores the threshold
   * and the stale-measurement guard, same tail and summarizer. */
  compactNow(events: ReadonlyArray<AgentEvent>): Promise<{ ok: true; summary: string; upTo: number; upToId?: string; partial?: boolean } | { ok: false; error: string }> {
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
    resolve?: (r: { ok: true; summary: string; upTo: number; upToId?: string; partial?: boolean } | { ok: false; error: string }) => void,
  ): void {
    // The body is async (ADR-0035's filter dispatch awaits); `#pending`
    // below still tracks the in-flight promise, as before.
    void this.#runAsync(events, forced, resolve);
  }

  async #runAsync(
    events: ReadonlyArray<AgentEvent>,
    forced: boolean,
    resolve?: (r: { ok: true; summary: string; upTo: number; upToId?: string; partial?: boolean } | { ok: false; error: string }) => void,
  ): Promise<void> {
    // #949: the tail policy needs the CATALOG window (0 = unknown) — a
    // fabricated fallback must not legalize an intra-turn cut, because
    // the cut is the answer to "the provider refuses to serve the tail".
    // The fallback only arms the auto threshold (shouldAutoCompact).
    const endpoint = this.#endpoint?.() ?? (this.#endpointType?.() ? { type: this.#endpointType!()! } : undefined);
    // ADR-0050 §7: the same serving reference the auto threshold uses —
    // the tail budget belongs to the window that serves the calls.
    const window = contextWindowFor(servingModelOf(this.#provider()), endpoint, this.#declaredWindows?.());
    const live = events as AgentEvent[];
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
      // #949: a structural refusal is never silent (ADR-0022 §6) — the
      // auto path too records a visible `compaction_skipped` chrome
      // event with the numbers that justify it (one per new measurement).
      const measured = CompactionRunner.lastMeasuredCall(path)?.inputTokens ?? 0;
      this.#append({
        type: "compaction_skipped",
        reason: "too_few_turns",
        turns: path.filter((e) => e.type === "user_message").length,
        measuredTokens: measured,
        window,
      });
      resolve?.({ ok: false, error: `nothing to compact: fewer than ${this.#tailTurns + 1} turns in the log` });
      return;
    }
    const marker = CompactionRunner.latestMarker(path);
    const from = marker ? (marker.upToId !== undefined ? path.findIndex((e) => e.id === marker.upToId) : marker.upTo ?? 0) : 0;
    if (!forced && !marker && newUpTo.upTo <= 0) {
      resolve?.({ ok: false, error: "nothing to compact" });
      return;
    }
    if (!markerSpanNonEmpty(path, from, newUpTo.upTo)) {
      // #949: visible on the auto path too — a single-turn log with a
      // known window folds nothing whole (`upTo` = its only turn).
      this.#append({
        type: "compaction_skipped",
        reason: "no_covered_turns",
        turns: path.filter((e) => e.type === "user_message").length,
        measuredTokens: CompactionRunner.lastMeasuredCall(path)?.inputTokens ?? 0,
        window,
      });
      resolve?.({ ok: false, error: "nothing to compact: the covered span has no turns" });
      return;
    }
    // The marker's pointer: the id (or legacy `line:N` bridge for an
    // identity-less prefix) of the last covered event on the path (d5).
    const anchor = path[newUpTo.upTo - 1]!;
    const upToId = anchor.id ?? `line:${newUpTo.upTo}`;
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
          .slice(Math.max(0, from), newUpTo.upTo)
          .filter((e) => e.type === "user_message").length;
        const approxTokens = CompactionRunner.turnTokens(path, from, newUpTo.upTo);
        const { sections } = compactionSections(path, from, newUpTo.upTo, (i) => `s${i}`);
        const result = await filter({
          sections,
          ...(approxTokens > 0 ? { approxTokens } : {}),
        });
        if (result) {
          for (const error of result.errors) this.#append(error);
          let applied: AppliedCut = { keptByFloor: false, bytesAfter: 0, droppedIds: [] };
          if (result.drop.length > 0 && turnCount > 0) {
            const { droppedIds, keptByFloor } = applySectionDrops(sections, result.drop);
            const bytesAfter = sections.reduce(
              (sum, s) => sum + (droppedIds.has(s.id) ? 0 : s.bytes),
              0,
            );
            // #979: the *applied* ids travel with the byte total — the
            // floor restores the smallest claims, so an extension recording
            // `drop` as if it were the outcome would overstate its cut.
            applied = { keptByFloor, bytesAfter, droppedIds: [...droppedIds] };
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
            applied = {
              keptByFloor: false,
              bytesAfter: sections.reduce((sum, s) => sum + s.bytes, 0),
              droppedIds: [],
            };
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
    const transcript = compactionTranscript(path, from, newUpTo.upTo, omit);
    // #766: the span's structured facts — every summarizer gets them;
    // the deterministic strategy digests only these.
    const facts = compactionFacts(path, from, newUpTo.upTo);
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
            facts,
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
            // #949: the tail begins inside the oldest kept turn — the
            // "minimal cut cannot reach window − reserve" reading is an
            // audit flag on the marker (keptByFloor precedent), never a
            // skip warning.
            ...(newUpTo.partial ? { partialTail: true as const } : {}),
            // #766 (ADR-0051): which summarizer served (audit chrome).
            ...(this.#summarizerName?.() ? { summarizer: this.#summarizerName!() } : {}),
          });
          this.#onCompacted();
          this.#consecutiveFailures = 0;
          resolve?.({ ok: true, summary: text, upTo: newUpTo.upTo, upToId, partial: newUpTo.partial });
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

/**
 * #766 (ADR-0051): hard cap (chars) on the deterministic digest. A
 * digest over the budget would push the rebuilt context past the point
 * compaction exists to avoid — the run degrades to the fallback
 * summarizer instead, explicitly (the marker records which summarizer
 * served) and never by silently truncating the digest.
 */
export const DETERMINISTIC_DIGEST_BUDGET_CHARS = 16_000;

/** Formats one bullet list with a cap; the input lists are already
 * deduplicated and stable-ordered by the facts extractor. */
function digestList(items: readonly string[], cap = FACT_LIST_CAP): string {
  if (items.length === 0) return "- (none)";
  const shown = items.slice(0, cap);
  return shown.map((s) => `- ${s}`).join("\n") + (items.length > cap ? `\n- (…and ${items.length - cap} more)` : "");
}

/** #766: renders the deterministic digest from a summarizer input. Pure
 * function of the input — same span, same bytes, on every machine and
 * every run. No timestamps, no locale, no randomness. */
export function renderDeterministicDigest(input: CompactionSummarizerInput): string {
  const facts = input.facts;
  const sections: string[] = [];
  if (input.previous) sections.push(`## Carried from the previous summary\n\n${input.previous}`);
  if (facts) {
    sections.push(
      [
        "## Task state",
        "",
        `${facts.turns} user request(s) covered:`,
        digestList(facts.userMessages.map((m) => (m.includes("\n") ? m.replace(/\n+/g, " ") : m))),
      ].join("\n"),
    );
    sections.push(`## Files modified\n\n${digestList(facts.filesModified)}`);
    sections.push(`## Files read\n\n${digestList(facts.filesRead)}`);
    const traffic = facts.toolCalls.map((t) => `- ${t.tool}: ${t.calls} call(s)${t.errors > 0 ? `, ${t.errors} failed` : ""}`);
    sections.push(`## Tool activity\n\n${traffic.length > 0 ? traffic.join("\n") : "- (none)"}`);
    sections.push(`## Recent failures (last ${facts.recentErrors.length})\n\n${digestList(facts.recentErrors)}`);
    if (facts.lastAssistant) sections.push(`## Last assistant work (tail)\n\n${facts.lastAssistant}`);
  }
  sections.push(`## Transcript reference\n\n${input.transcript.length} chars of rendered transcript were covered.`);
  return sections.join("\n\n");
}

/**
 * #766 (ADR-0051): the deterministic summarizer — a rule-built digest
 * over the span's structured `facts`, no model call, byte-stable across
 * runs, resumes and machines. When the digest exceeds
 * `DETERMINISTIC_DIGEST_BUDGET_CHARS` and a `fallback` is supplied, the
 * run degrades to it explicitly (the fallback sees the same input,
 * `facts` included) — never by silently truncating. `strategy`, when
 * supplied, is a mutable box the runner reads back at marker time so the
 * `compaction` marker records which summarizer actually served.
 */
export function createDeterministicSummarizer(
  fallback?: CompactionSummarizer,
  strategy?: { name: string },
): CompactionSummarizer {
  return async (input) => {
    const digest = renderDeterministicDigest(input);
    if (digest.length <= DETERMINISTIC_DIGEST_BUDGET_CHARS) {
      if (strategy) strategy.name = "deterministic";
      return digest;
    }
    if (!fallback) {
      // No fallback supplied: the digest stands, oversized. The in-session
      // wiring always passes the LLM summarizer (ADR-0051 §3); a bare
      // library call that needs the hard guarantee must pass one.
      if (strategy) strategy.name = "deterministic";
      return digest;
    }
    if (strategy) strategy.name = "llm-fallback";
    return fallback(input);
  };
}
