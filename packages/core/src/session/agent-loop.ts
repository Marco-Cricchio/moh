import { z } from "zod";
import type {
  AgentEvent,
  FinishReason,
  Message,
  Provider,
  ReasoningPart,
  ReasoningStreamEvent,
  StreamEvent,
  StreamOptions,
  ThinkingLevel,
  TokenUsage,
  Tool,
  ToolCall,
  ToolSpec,
  TurnResult,
} from "../types";
import type { AssembledPrompt } from "../prompt-composer";
import type { TurnConfirmOutcome } from "@moh/extension";
import { resolveTurnConfirm, type BeforeTurnDispatch, type ExtensionRuntime } from "../extensions";
import { assembleMentions, renderMentionAttachment, type MentionAttachment } from "../mentions";
import { EMPTY_REASONING_PARTS, foldReasoningParts, type ReasoningParts } from "../reasoning-parts";
import { servingModelOf, selectedModelOf } from "../model-pair";
import { declaredWindowOf } from "../declared-window";
import { normalizeProviderError } from "../provider-errors";
import { PRICING_SNAPSHOT } from "../pricing";
import { newUlid } from "./ulid";
import { endpointIdentity, ProviderError } from "../types";
import type { AttemptTelemetry, EndpointIdentity, UsageProvenance } from "../types";
import { quotaEventsFromProviderError, quotaRecoveryEvent, scopeKeyFor } from "../quota/telemetry";

/** #1100: the ProviderError kinds that are quota-class — the loop records
 * an observation plus an episode boundary for each failed attempt carrying
 * one. Every other error kind teaches nothing about quota state. */
const QUOTA_ERROR_KINDS = new Set(["rate_limited", "quota_exhausted"]);

/**
 * ADR-0059: the ProviderError kinds the Route itself handles (fallback
 * chain, recovery probes). A failure carrying one of these never reaches
 * the `onModelError` seam — the Route's own ordering is unchanged — and
 * neither does `aborted`.
 */
const ROUTE_HANDLED_ERROR_KINDS = new Set(["quota_exhausted", "rate_limited", "network", "overloaded"]);

/** ADR-0059: the maximum model-error consultations one turn gets. A
 * proposed ref that fails the same way consumes budget; an exhausted
 * budget ends the turn exactly as a consultation without an answer.
 * Four: #1110's routing pool budget (up to 4 same-tier candidates) must
 * be spendable within one turn. */
export const MAX_MODEL_ERROR_RETRIES = 4;

/**
 * #1099: a detail field is counted only when it is a finite number —
 * anything else a provider yields is unreported, never garbage in the log.
 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** #1099: best-effort sanitized endpoint identity for providers that do
 * not announce one on `model_call_start` — the endpoint prefix of the
 * ref, the instance's baseUrl when it carries one. Same sanitizer as the
 * announced shape, so the log holds one identity format. */
function endpointIdentityOf(provider: Provider): EndpointIdentity {
  const slash = provider.name.indexOf("/");
  const kind = slash === -1 ? provider.name : provider.name.slice(0, slash);
  return endpointIdentity(kind || "unknown", (provider as { baseUrl?: string }).baseUrl);
}

/** The extension surface AgentLoop needs — satisfied by ExtensionRuntime. */
export type LoopExtensions = Pick<ExtensionRuntime, "dispatchBeforeModelCall">;
/**
 * ADR-0033: the turn-start seam. `dispatch` runs the extensions'
 * `beforeTurn` hooks (once per user send, before the provider is read);
 * `applyModel` resolves and applies a returned ref exactly like the manual
 * `/model` switch, which the session owns (it appends the `model_switched`
 * chrome). The loop never invents a model: an unresolvable ref is a
 * visible `extension_failed`, and the turn proceeds on the active model.
 */
export interface LoopBeforeTurn {
  dispatch(text: string, turnIndex: number, model: string): Promise<BeforeTurnDispatch>;
  applyModel(ref: string): { ok: true; model: string } | { ok: false; error: string; reason?: "context_length" };
  /**
   * ADR-0033 §4: the pre-send confirmation. Asks the client whether the
   * turn may be sent, given the extension's reason. Absent = no client can
   * ask (headless): the turn is refused, never silently sent.
   */
  confirm?: (request: { reason: string; by: string; text: string }) => Promise<TurnConfirmOutcome>;
}

/**
 * ADR-0059: the retry-on-model-error seam. `dispatch` consults the
 * extensions' `onModelError` hooks after a provider call failed with an
 * error the Route does not already handle; `applyModel` resolves and
 * applies a proposed ref exactly like the manual `/model` switch, which
 * the session owns (it appends the `model_switched` / `switch_refused`
 * chrome). Absent = no extension can keep a failing turn alive.
 */
export interface LoopModelRetry {
  dispatch(ctx: { model: string; errorKind: string; message: string }): Promise<{
    model?: string;
    by?: string;
    errors: AgentEvent[];
  }>;
  applyModel(ref: string): { ok: true; model: string } | { ok: false; error: string; reason?: "context_length" };
}


/** Default per-turn iteration cap (#190), used when `maxIterations` is absent. */
export const DEFAULT_MAX_ITERATIONS = 50;
/** #498: `maxIterations: 0` means no cap (unlimited) — the user explicitly
 * disables the anti-runaway safety net. Any other value is a finite cap. */
export const MAX_ITERATIONS_UNLIMITED = 0;

/**
 * #498: resolve a configured `maxIterations` (or undefined) into the
 * numeric cap the loop guard compares against. Absent → 50; the `0`
 * sentinel → `Infinity` (the guard never fires); finite → itself.
 */
export function resolveMaxIterations(configured?: number): number {
  if (configured === undefined) return DEFAULT_MAX_ITERATIONS;
  if (configured === MAX_ITERATIONS_UNLIMITED) return Infinity;
  return configured;
}

/** The tool-execution surface AgentLoop needs — satisfied by ToolRunner (#91). */
export interface LoopToolRunner {
  run(
    calls: ToolCall[],
    signal: AbortSignal,
  ): Promise<{ outcome: "ok" | "aborted"; parts: Message["parts"] }>;
}

export interface AgentLoopOptions {
  provider: () => Provider;
  /** Iteration cap per turn. */
  maxIterations: number;
  /** All registered tools, including MCP ones (live accessor). */
  tools: () => Record<string, Tool>;
  /** Same-turn tool execution (ToolRunner). */
  toolRunner: LoopToolRunner;
  /** Extension hooks; absent in headless sessions. */
  extensions?: LoopExtensions;
  /**
   * ADR-0033: the turn-start hook seam. Absent = no extension can
   * influence which model serves a turn (the historical behavior).
   */
  beforeTurn?: LoopBeforeTurn;
  /**
   * ADR-0059: the retry-on-model-error seam. Absent = a non-Route
   * provider failure ends the turn exactly as it always has.
   */
  modelRetry?: LoopModelRetry;
  /** 1-based live-run turn sequence, for the `beforeTurn` context. */
  turnIndex?: () => number;
  /** Lazy MCP start, when configured. */
  mcp?: { ensureStarted(): Promise<void> };
  /** The conversation so far — mutated in place by each turn. */
  messages: Message[];
  /** Reassembles the system prompt; called before every model call. */
  assemblePrompt: () => void;
  /** The most recently assembled prompt, for beforeModelCall dispatch. */
  lastPrompt: () => AssembledPrompt | null;
  /** Log append callback — the loop owns its event emission. */
  append: (event: AgentEvent) => void;
  /** #488: mention expansion config — `@path` tokens in user messages
   * become structured attachments riding the turn. Absent disables it. */
  /** #488: mention expansion config — `@path` tokens in user messages
   * become structured attachments riding the turn. Absent disables it.
   * Vision note 4: `imageCapable` is the capability seam — a zero-arg
   * probe of the *serving* model so mid-session switches are honored.
   * Absent = assumed capable (custom/mock providers that always wire
   * their own truth); the session always resolves it from the catalog. */
  mentions?: { cwd: string; canRead?: (absPath: string) => boolean; imageCapable?: () => boolean };
  /** #253: live (ephemeral) reasoning relay — the stream lifecycle is
   * forwarded in real time while the model thinks, without touching the
   * persisted log (the completed block still lands there). */
  emitLive?: (event: ReasoningStreamEvent) => void;
  /** #240: the neutral thinking-level request, read once per model call
   * (session-level option; #241 wires endpoint preferences here). */
  thinking?: () => { level: ThinkingLevel } | undefined;
  /** Fire-and-forget post-turn hook (memory trigger); never blocks the turn. */
  onTurnSettled?: (result: TurnResult) => void;
  /**
   * ADR-0049 (door one, #986): the provider refused this call as too long
   * (`context_length`). The session owns what happens next — adopting the
   * window the refusal declares, or leaving a trace when no shipped
   * formula matched its wording. Fired only for a real refusal, and only
   * after the failure is logged, so the log reads in the order it
   * happened.
   */
  onContextRefusal?: (modelRef: string, err: unknown) => void;
}

/** ADR-0049: the `ProviderError` kind a thrown failure carries, when it
 * carries one — the reader both error paths gate learning on. */
function refusalKind(err: unknown): string | undefined {
  return err instanceof Error && "kind" in err ? String((err as { kind: unknown }).kind) : undefined;
}


/** #1099: the failure facts an attempt record can carry — either the plain
 * subset (when only the kind is known: fallback stops, empty completions)
 * or a normalized ProviderError (kind + sanitized transport details). */
type AttemptFailure = { errorKind: string; httpStatus?: number; retryAfterMs?: number } | ProviderError;

function failureFacts(failure: AttemptFailure | undefined): { errorKind: string; httpStatus?: number; retryAfterMs?: number } | undefined {
  if (!failure) return undefined;
  return failure instanceof ProviderError
    ? { errorKind: failure.kind, ...(failure.details?.httpStatus !== undefined ? { httpStatus: failure.details.httpStatus } : {}), ...(failure.details?.retryAfterMs !== undefined ? { retryAfterMs: failure.details.retryAfterMs } : {}) }
    : failure;
}

/** #1099: the open model-call buffer — attempt audit fields captured at
 * open, usage detail folded in as it streams, settled on the event. */
type PendingCall = {
  model: string;
  usage: TokenUsage;
  thinkingLevel?: ThinkingLevel;
  reasoning: { text: string; continuation?: Record<string, unknown> }[];
  attemptId: string;
  retryIndex: number;
  startedAt: number;
  endpoint?: EndpointIdentity;
  wire?: string;
  consumedUsage: boolean;
  /** #1101: wall-clock ms of the attempt's first streamed text delta
   * ("useful content" — reasoning deltas do not count); undefined until
   * one arrives (absent ttfc, never zero). */
  firstContentAt?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  usageProvenance?: UsageProvenance;
};

/**
 * One agent turn (#92): model calls, streaming deltas, `model_call`
 * buffering and turn usage rollup (#83), the max-iterations cap, the
 * abort/cancelled path, and extension beforeModelCall/afterTurn
 * dispatch. Session-cumulative usage lives here too — the session
 * exposes it as a projection.
 */
export class AgentLoop {
  readonly #provider: () => Provider;
  readonly #maxIterations: number;
  readonly #tools: () => Record<string, Tool>;
  readonly #toolRunner: LoopToolRunner;
  readonly #extensions: LoopExtensions | undefined;
  readonly #beforeTurn: LoopBeforeTurn | undefined;
  readonly #modelRetry: LoopModelRetry | undefined;
  readonly #turnIndex: (() => number) | undefined;
  readonly #mcp: { ensureStarted(): Promise<void> } | undefined;
  readonly #messages: Message[];
  readonly #assemblePrompt: () => void;
  readonly #lastPrompt: () => AssembledPrompt | null;
  readonly #append: (event: AgentEvent) => void;
  readonly #emitLive: ((event: ReasoningStreamEvent) => void) | undefined;

  readonly #thinking: (() => { level: ThinkingLevel } | undefined) | undefined;
  readonly #onTurnSettled: ((result: TurnResult) => void) | undefined;
  readonly #onContextRefusal: ((modelRef: string, err: unknown) => void) | undefined;
  /** #488: mention expansion config (see AgentLoopOptions.mentions). */
  readonly #mentions: AgentLoopOptions["mentions"];
  /** Cumulative usage tokens reported by the provider, where exposed (#13). */
  #usage = { inputTokens: 0, outputTokens: 0 };
  /** #83: the model call currently streaming (announced by `model_call_start`).
   * #240: also buffers the call's completed reasoning (persisted with the
   * call) and the effective thinking level the provider announced. */
  #pendingCall: PendingCall | null = null;
  /** #1099: correlation ids — one per turn, one per logical call (one
   * agent-loop iteration; retries and fallback restarts of the same
   * iteration are attempts of one logical call). */
  #turnId = "";
  #callId = "";
  /** #1099: attempt ordinal within the current logical call. */
  #attemptIndex = 0;
  /** ADR-0059: model-error consultations spent in the current turn. */
  #modelRetriesThisTurn = 0;
  /** #83: turn rollup inputs — usage at turn start and models that served it. */
  #turnStartUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  #turnModels: string[] = [];
  /** #1100: still-open quota blocks by scope key, in block order. A
   * successful settlement closes the blocks its endpoint/model scope
   * covers (recovery boundary, observed wait, fallback flag); blocks of
   * other scopes stay open — honest unknown. */
  #quotaBlocks: {
    scopeKey: string;
    endpoint: EndpointIdentity;
    servingModel?: string;
    startedAt: string;
    endedAtMs: number;
    retryAfterMs?: number;
    callId: string;
    attemptId: string;
  }[] = [];

  constructor(options: AgentLoopOptions) {
    this.#provider = options.provider;
    this.#maxIterations = options.maxIterations;
    this.#tools = options.tools;
    this.#toolRunner = options.toolRunner;
    this.#extensions = options.extensions;
    this.#beforeTurn = options.beforeTurn;
    this.#modelRetry = options.modelRetry;
    this.#turnIndex = options.turnIndex;
    this.#mcp = options.mcp;
    this.#messages = options.messages;
    this.#assemblePrompt = options.assemblePrompt;
    this.#lastPrompt = options.lastPrompt;
    this.#append = options.append;
    this.#mentions = options.mentions;
    this.#emitLive = options.emitLive;
    this.#thinking = options.thinking;
    this.#onTurnSettled = options.onTurnSettled;
    this.#onContextRefusal = options.onContextRefusal;
  }

  /** ADR-0049 (door one): the reference that was *serving* the failed call
   * — read while the call is still open, because a fallback restart inside
   * one stream names a different model, and the refusal's subject is the
   * model that refused. */
  #refusingRef(): string {
    return this.#pendingCall?.model ?? this.#provider().name;
  }

  /** #240: the open reasoning part of the active stream (`reasoning_start`
   * … `reasoning_end`), plus the completed blocks of the current iteration —
   * they ride the iteration's assistant message parts so later calls in
   * the same turn carry the provider's continuation artifacts. The lifecycle
   * folds through the shared `foldReasoningParts` rule (#993): the live
   * channel of every client applies the very same fold. */
  #reasoning: ReasoningParts = EMPTY_REASONING_PARTS;
  #iterationReasoning: ReasoningPart[] = [];

  /** #240: opens the model-call buffer for a new stream announcement
   * (shared by the main and wrap-up loops). */
  #openCall(event: StreamEvent & { type: "model_call_start" }): void {
    // A second announcement before the prior call produced `finish` means
    // retry/fallback, not a finalized provider message.
    if (this.#pendingCall) this.#flushFailedModelCall();
    // #1099: a new logical call gets a fresh correlation id; retries and
    // fallback restarts within the same iteration keep it and increment
    // the attempt ordinal.
    if (!this.#callId) this.#callId = newUlid();
    this.#pendingCall = {
      model: event.model,
      usage: { inputTokens: 0, outputTokens: 0 },
      ...(event.thinkingLevel ? { thinkingLevel: event.thinkingLevel } : {}),
      reasoning: [],
      attemptId: newUlid(),
      retryIndex: this.#attemptIndex++,
      startedAt: Date.now(),
      ...(event.endpoint ? { endpoint: event.endpoint } : {}),
      ...(event.wire ? { wire: event.wire } : {}),
      consumedUsage: false,
    };
  }

  /** #1099: folds one usage stream event into the open attempt — detail
   * fields sum (absent stays absent, never zero-filled), `"provider"`
   * provenance sticks once anything provider-reported arrives and is never
   * downgraded by a later unavailable event, and the attempt counts as
   * having consumed usage only when the provider actually reported
   * consumption (tokens or detail) — unavailable zeros never do. */
  #consumeUsage(event: Extract<StreamEvent, { type: "usage" }>): void {
    this.#usage.inputTokens += event.inputTokens;
    this.#usage.outputTokens += event.outputTokens;
    if (this.#pendingCall) {
      this.#pendingCall.usage.inputTokens += event.inputTokens;
      this.#pendingCall.usage.outputTokens += event.outputTokens;
      const cacheRead = finiteNumber(event.cacheReadTokens);
      const cacheWrite = finiteNumber(event.cacheWriteTokens);
      const reasoning = finiteNumber(event.reasoningTokens);
      // #1099: malformed detail fields (non-finite numbers, wrong types)
      // are treated as unreported — never summed as garbage.
      if (cacheRead !== undefined) this.#pendingCall.cacheReadTokens = (this.#pendingCall.cacheReadTokens ?? 0) + cacheRead;
      if (cacheWrite !== undefined) this.#pendingCall.cacheWriteTokens = (this.#pendingCall.cacheWriteTokens ?? 0) + cacheWrite;
      if (reasoning !== undefined) this.#pendingCall.reasoningTokens = (this.#pendingCall.reasoningTokens ?? 0) + reasoning;
      const reported =
        finiteNumber(event.inputTokens)! > 0 ||
        finiteNumber(event.outputTokens)! > 0 ||
        cacheRead !== undefined ||
        cacheWrite !== undefined ||
        reasoning !== undefined;
      if (reported || event.provenance === "provider") {
        this.#pendingCall.usageProvenance = "provider";
        this.#pendingCall.consumedUsage = true;
      } else if (this.#pendingCall.usageProvenance === undefined) {
        this.#pendingCall.usageProvenance = event.provenance ?? "unavailable";
      }
    }
  }

  /** #1101: folds the first streamed text delta of the open attempt into
   * the TTFC stamp — the first call wins; reasoning deltas never count. */
  #noteFirstContent(): void {
    if (this.#pendingCall && this.#pendingCall.firstContentAt === undefined) {
      this.#pendingCall.firstContentAt = Date.now();
    }
  }

  /** #1099: builds the attempt record of a settled pending call — timing,
   * sanitized identity, outcome and normalized failure facts. The chain
   * index comes from the provider's own chain when it is a route (0
   * otherwise). */
  #attemptTelemetry(
    call: PendingCall,
    outcome: AttemptTelemetry["outcome"],
    failure?: { errorKind: string; httpStatus?: number; retryAfterMs?: number }): AttemptTelemetry {
    const endedAt = Date.now();
    const provider = this.#provider();
    const chain = (provider as { chain?: readonly string[] }).chain;
    return {
      callId: this.#callId,
      attemptId: call.attemptId,
      turnId: this.#turnId,
      retryIndex: call.retryIndex,
      // #1099: position on the serving chain; a serving model the chain
      // does not name (custom/re-registered provider mid-flight) records
      // -1 — unknown, never conflated with the primary stop (0).
      chainIndex: Array.isArray(chain) ? chain.indexOf(call.model) : 0,
      selectedModel: selectedModelOf(provider),
      servingModel: call.model,
      endpoint: call.endpoint ?? endpointIdentityOf(provider),
      ...(call.wire ? { wire: call.wire } : {}),
      startedAt: new Date(call.startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: Math.max(0, endedAt - call.startedAt),
      outcome,
      ...(failure?.errorKind !== undefined ? { errorKind: failure.errorKind } : {}),
      ...(failure?.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure?.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
      // #1101: time to first streamed text content; absent when the
      // attempt produced none — unknown, never zero.
      ...(call.firstContentAt !== undefined ? { ttfcMs: Math.max(0, call.firstContentAt - call.startedAt) } : {}),
      consumedUsage: call.consumedUsage,
      pricingVersion: PRICING_SNAPSHOT.version,
    };
  }

  /** #240: neutral reasoning stream bookkeeping, shared by the main and
   * wrap-up consumption loops. A call may emit several reasoning blocks;
   * each completed block is kept (never overwritten). #253: the lifecycle
   * is also relayed to the live channel as it arrives. The fold is the
   * channel's one rule (#993, `reasoning-parts.ts`) — an empty part is
   * dropped, which is what keeps a client's live buffer identical to the
   * text this method persists. */
  #consumeReasoningEvent(event: StreamEvent): void {
    // Type guard, not a blind cast: the live channel carries exactly the
    // reasoning lifecycle, and this keeps the invariant checked if
    // StreamEvent ever grows other text-bearing variants.
    if (event.type === "reasoning_start" || event.type === "reasoning_delta" || event.type === "reasoning_end") {
      this.#emitLive?.(event);
      const open = this.#reasoning.open;
      this.#reasoning = foldReasoningParts(this.#reasoning, event);
      if (event.type === "reasoning_end" && open) {
        const block = { text: open, ...(event.continuation ? { continuation: event.continuation } : {}) };
        this.#iterationReasoning.push({ kind: "reasoning", ...block });
        this.#pendingCall?.reasoning.push(block);
      }
    }
  }

  /** Cumulative usage tokens reported by the provider, where exposed. */
  get usage(): { inputTokens: number; outputTokens: number } {
    return { ...this.#usage };
  }

  /** Runs one user message to completion. */
  async run(text: string, controller: AbortController): Promise<TurnResult> {
    return this.#run(text, controller, false);
  }

  /**
   * ADR-0037: one synthetic turn — same loop, same tools, same usage
   * rollup, but no `beforeTurn` dispatch (machine-composed text is never
   * re-routed or re-checked) and the `user_message` carries the
   * `synthetic` marker so replay and the transcript can tell it from a
   * human-typed turn.
   */
  async runSynthetic(text: string, controller: AbortController): Promise<TurnResult> {
    return this.#run(text, controller, true);
  }

  async #run(text: string, controller: AbortController, synthetic: boolean): Promise<TurnResult> {
    const result = await this.#runInner(text, controller, synthetic);
    // Memory (#38): fire-and-forget after the reply — never blocks the turn.
    this.#onTurnSettled?.(result);
    return result;
  }

  async #runInner(text: string, controller: AbortController, synthetic: boolean): Promise<TurnResult> {
    // ADR-0033: the turn-start decision point — once per user send, before
    // the provider is read and before anything is logged. A model named
    // here serves *this* turn; the hook is the only seam that can do so
    // (#166 reads the provider once per turn, below). A confirmation the
    // user cancelled stops the turn right here: no `user_message`, no
    // turn — the composer gets its text back (the client's job).
    // ADR-0037: a synthetic turn skips the dispatch entirely — re-routing
    // and re-checking machine-composed text adds cost and chain risk for
    // no benefit.
    if (!synthetic && !(await this.#dispatchBeforeTurn(text))) return { status: "cancelled" };
    // #166: the provider is read once per turn — a mid-session switch
    // (AgentSession.switchModel) takes effect from the next turn, never
    // mid-stream. The one exception is ADR-0059's retry seam below: a
    // switch applied to recover a failed call is re-read immediately,
    // because the failed call never produced a serving turn.
    let provider = this.#provider();
    // #1099: one correlation id per turn; logical-call ids and attempt
    // ordinals reset per call below.
    this.#turnId = newUlid();
    this.#callId = "";
    this.#attemptIndex = 0;
    // ADR-0059: the turn-scoped retry budget.
    this.#modelRetriesThisTurn = 0;
    // #363: a Route may probe its selected target once at a user-turn
    // boundary. Follow-up calls after tools keep the serving target.
    if ("beginTurn" in provider && typeof provider.beginTurn === "function") provider.beginTurn();
    // #488: assemble mention attachments before anything is logged so the
    // `user_message` event carries the snapshots the model will see.
    let attachments: MentionAttachment[] | undefined;
    if (this.#mentions && /\s@|"@|^\@/.test(text) === true) {
      const assembled = await assembleMentions(text, {
        cwd: this.#mentions.cwd,
        ...(this.#mentions.canRead ? { canRead: this.#mentions.canRead } : {}),
      });
      if (assembled.attachments.length > 0) attachments = assembled.attachments;
      if (assembled.warnings.length > 0) {
        this.#append({ type: "mention_warnings", warnings: assembled.warnings });
      }
    }
    this.#append({
      type: "user_message",
      text,
      ...(synthetic ? { synthetic: true as const } : {}),
      ...(attachments ? { attachments } : {}),
    });
    // #83: turn rollup baselines.
    this.#turnStartUsage = { ...this.#usage };
    this.#turnModels = [];
    // #488: the attachment snapshots ride the turn as additional parts
    // appended to the user message — the text itself stays as typed.
    // Vision note 4: an image attachment becomes a typed image part when
    // the serving model declares image input; otherwise the reference
    // chip stays in the text flow and a visible warning fires — never a
    // silent drop and never a turn error.
    const userParts: Message["parts"] = [{ kind: "text", text }];
    if (attachments) {
      for (const attachment of attachments) {
        if (attachment.kind === "image" && this.#mentions?.imageCapable?.() !== false) {
          userParts.push({ kind: "image", mime: attachment.mime, base64: attachment.content });
        } else {
          if (attachment.kind === "image") {
            this.#append({
              type: "mention_warnings",
              warnings: [{ path: attachment.path, reason: "provider/model does not support images — attachment skipped" }],
            });
          }
          userParts.push({ kind: "text", text: renderMentionAttachment(attachment) });
        }
      }
    }
    this.#messages.push({ role: "user", parts: userParts });
    // MCP (#15): lazy start on first use — the first turn connects the
    // declared servers (consent-gated) so the prompt lists their tools.
    if (this.#mcp) await this.#mcp.ensureStarted();

    let iterations = 0;
    let assistantText = "";
    let finishReason: FinishReason | null = null;
    // #190: the cap is a budget boundary, not a dead end. When reached, one
    // final no-tools call lets the model deliver its work-in-progress state
    // (what's done, what remains, the next step) instead of dropping the
    // turn with a bare error.
    const WRAP_UP =
      "You have reached the per-turn tool-call iteration cap. You may NOT call any more tools. " +
      "Reply now, concisely: (1) what you completed so far, (2) what remains, (3) the exact next step to continue.";
    while (finishReason !== "stop") {
      if (iterations >= this.#maxIterations) {
        this.#messages.push({ role: "user", parts: [{ kind: "text", text: WRAP_UP }] });
        this.#assemblePrompt();
        // #1099: the wrap-up is its own logical call.
        this.#callId = "";
        this.#attemptIndex = 0;
        let wrapText = "";
        let wrapFinished = false;
        this.#iterationReasoning = [];
        try {
          for await (const event of provider.stream(this.#messages, controller.signal, [], this.#streamOptions())) {
            if (controller.signal.aborted) break;
            if (event.type === "text_delta") {
              wrapText += event.text;
              this.#noteFirstContent();
              this.#append({ type: "assistant_delta", text: event.text });
            } else if (event.type === "model_call_start") {
              this.#openCall(event);
            } else if (event.type === "reasoning_start" || event.type === "reasoning_delta" || event.type === "reasoning_end") {
              this.#consumeReasoningEvent(event);
            } else if (event.type === "fallback") {
              this.#append(event);
              this.#flushFailedModelCall({ errorKind: event.reason });
            } else if (event.type === "route_serving") {
              this.#append(event);
            } else if (event.type === "usage") {
              this.#consumeUsage(event);
            } else if (event.type === "finish") {
              wrapFinished = true;
            }
          }
        } catch (err) {
          // The wrap-up is best-effort: a failing final call degrades to the
          // historical cap error rather than masking it. Its partial call is
          // recorded as failed, never a resumable checkpoint (#243).
          // ADR-0049: a refusal is a refusal whichever call hit it — the
          // wrapper still ends the turn as the cap error, but the window
          // the provider declared is learned here too.
          const refusing = this.#refusingRef();
          this.#flushFailedModelCall(normalizeProviderError(err));
          if (refusalKind(err) === "context_length" || declaredWindowOf(err) !== undefined) {
            this.#onContextRefusal?.(refusing, err);
          }
          this.#append({ type: "error", reason: "max_iterations", message: `iteration cap of ${this.#maxIterations} reached` });
          return { status: "error", reason: "max_iterations", message: "iteration cap reached" };
        }
        if (!wrapFinished) {
          // #243: the wrap-up stream ended without a finalized provider
          // message (abort or premature end) — nothing is checkpointed.
          this.#discardPendingCall();
          this.#append({ type: "cancelled" });
          return { status: "cancelled" };
        }
        this.#flushModelCall();
        assistantText = wrapText;
        finishReason = "stop";
        continue;
      }
      iterations += 1;
      assistantText = "";
      this.#iterationReasoning = [];
      finishReason = null;
      // #1099: each iteration is one logical call — attempts of a retry or
      // fallback restart inside it share the id, the ordinal increments.
      this.#callId = "";
      this.#attemptIndex = 0;
      this.#assemblePrompt(); // reassembled every call
      const lastPrompt = this.#lastPrompt();
      if (this.#extensions && lastPrompt) {
        const errors = await this.#extensions.dispatchBeforeModelCall({
          prompt: {
            sections: lastPrompt.sections,
            system: lastPrompt.system,
            version: lastPrompt.version,
          },
          messages: this.#messages,
        });
        for (const e of errors) this.#append(e);
      }
      const toolCalls: ToolCall[] = [];
      // #853: a bare (non-routed) provider's empty completion must end
      // the turn as a classified error, never a silent empty done — the
      // route layer cannot see it, so the loop classifies here. Routed
      // providers never reach this: the route itself throws
      // empty_completion (fallback-worthy) before ending the stream.
      let sawText = false;
      let sawToolCalls = false;
      let sawUsage = false;
      // ADR-0059: the consumption loop. A non-Route provider failure may
      // consult the `onModelError` seam and restart the call on the
      // proposed model within this same iteration (same logical call, new
      // attempt); without a proposal the catch ends the turn exactly as
      // it always has.
      for (;;) {
        sawText = false;
        sawToolCalls = false;
        sawUsage = false;
        assistantText = "";
        finishReason = null;
        toolCalls.length = 0;
        try {
          const toolSpecs: ToolSpec[] = Object.values(this.#tools()).map((t) => ({
            name: t.name,
            description: t.description,
            ...(t.inputSchema ? { parameters: z.toJSONSchema(t.inputSchema) as Record<string, unknown> } : {}),
          }));
          for await (const event of provider.stream(this.#messages, controller.signal, toolSpecs, this.#streamOptions())) {
            if (controller.signal.aborted) break;
            if (event.type === "text_delta") {
              if (event.text) sawText = true;
              this.#noteFirstContent();
              assistantText += event.text;
              this.#append({ type: "assistant_delta", text: event.text });
            } else if (event.type === "tool_calls") {
              if (event.calls.length > 0) sawToolCalls = true;
              toolCalls.push(...event.calls);
            } else if (event.type === "model_call_start") {
              // A new call starts: record the previous one, then open a buffer
              // for this one (#83). Mid-stream fallbacks announce a second
              // call inside the same provider.stream — both get recorded.
              this.#openCall(event);
            } else if (event.type === "reasoning_start" || event.type === "reasoning_delta" || event.type === "reasoning_end") {
              this.#consumeReasoningEvent(event);
            } else if (event.type === "fallback") {
              // Detailed durable fallback record; route_serving below is the
              // user-visible transition once a fallback actually succeeds.
              this.#append(event);
              this.#flushFailedModelCall({ errorKind: event.reason });
            } else if (event.type === "route_serving") {
              this.#append(event);
            } else if (event.type === "usage") {
              // #853: zero tokens is the shape of an empty completion, never
              // evidence of a real call.
              if (event.inputTokens > 0 || event.outputTokens > 0) sawUsage = true;
              this.#consumeUsage(event);
            } else if (event.type === "finish") {
              finishReason = event.reason;
            }
          }
          break;
        } catch (err) {
          if (controller.signal.aborted) break;
          // #240: the failed call keeps its completed reasoning text (error
          // state) and model_call audit before the error lands. Opaque
          // continuation is not checkpointed without a finalized message.
          const refusing = this.#refusingRef();
          this.#flushFailedModelCall(normalizeProviderError(err));
          // ADR-0059: consult the seam before anything terminal is logged —
          // a proposal that applies turns the failure into a retry (the
          // failed `model_call` and the switch chrome record it); a refusal
          // or silence falls through to the historical path, byte-identical.
          if ((await this.#consultModelRetry(refusing, err)) !== null) {
            // ADR-0049 (door one, #986): a real refusal still teaches the
            // window it declared, before the call is retried elsewhere.
            if (refusalKind(err) === "context_length" || declaredWindowOf(err) !== undefined) this.#onContextRefusal?.(refusing, err);
            provider = this.#provider();
            continue;
          }
          const reason = refusalKind(err) ?? "provider_failure";
          const message = err instanceof Error ? err.message : String(err);
          this.#append({ type: "error", reason, message });
          // ADR-0049 (door one, #986): only a real refusal teaches — the
          // provider just said what its window is by rejecting a larger
          // request. A failure teaches when it classified as `context_length`
          // (the session then learns or traces) or when its own wording
          // carries a window formula moh reads (the refusal proves itself,
          // and the refusal still keeps the kind it had: the taxonomy is
          // untouched). Everything else is exactly as it was.
          if (reason === "context_length" || declaredWindowOf(err) !== undefined) this.#onContextRefusal?.(refusing, err);
          return { status: "error", reason, message };
        }
      }
      // The provider stream ended: only a finalized model call is recorded.
      // An abort or an iterator ending after reasoning_end but before finish
      // still leaves partial provider-message state; neither may become a
      // resumable checkpoint (#243).
      if (finishReason === null) {
        this.#discardPendingCall();
        if (controller.signal.aborted) break;
        this.#append({ type: "cancelled" });
        return { status: "cancelled" };
      }
      // #853: an empty completion on a bare provider is a failed call —
      // classified error, failed model_call record, never a silent done.
      if (!sawText && !sawToolCalls && !sawUsage) {
        this.#flushFailedModelCall({ errorKind: "empty_completion" });
        // ADR-0050: name the model that served this call — for a route that
        // is the serving stop, not the selected reference.
        const message = `${servingModelOf(provider)} returned an empty completion (no content, no tool calls, no usage)`;
        this.#append({ type: "error", reason: "empty_completion", message });
        return { status: "error", reason: "empty_completion", message };
      }
      if (controller.signal.aborted) this.#discardPendingCall();
      else this.#flushModelCall();
      if (finishReason !== "stop") {
        this.#messages.push({
          role: "assistant",
          parts: [
            ...this.#iterationReasoning,
            ...(assistantText ? [{ kind: "text" as const, text: assistantText }] : []),
            ...toolCalls.map((c) => ({ kind: "tool_call" as const, ...c })),
          ],
        });
        const { outcome, parts } = await this.#toolRunner.run(toolCalls, controller.signal);
        this.#messages.push({ role: "user", parts });
        if (outcome === "aborted") break;
      }
    }

    if (controller.signal.aborted) {
      this.#append({ type: "cancelled" });
      return { status: "cancelled" };
    }
    this.#messages.push({ role: "assistant", parts: [...this.#iterationReasoning, { kind: "text", text: assistantText }] });
    // Turn rollup (#83): this turn's usage totals and the models that
    // served it. Session totals = sum of model_call events across the log.
    this.#append({
      type: "done",
      usage: {
        inputTokens: this.#usage.inputTokens - this.#turnStartUsage.inputTokens,
        outputTokens: this.#usage.outputTokens - this.#turnStartUsage.outputTokens,
      },
      models: [...new Set(this.#turnModels)],
    });
    return { status: "done" };
  }

  /**
   * ADR-0033: runs the extensions' `beforeTurn` hooks and applies the
   * model ref they name. Never a turn error: hook failures and invalid
   * refs are visible chrome, and the turn proceeds on the active model.
   *
   * Returns false when a `confirm` was answered with anything but "send":
   * the caller then returns before logging the `user_message`, so a turn
   * the user cancelled (or a headless refusal) leaves no trace of a turn
   * that never happened — the extension that asked records the outcome
   * through its own `onResolved` callback.
   */
  async #dispatchBeforeTurn(text: string): Promise<boolean> {
    const seam = this.#beforeTurn;
    if (!seam) return true;
    const outcome = await seam.dispatch(text, this.#turnIndex?.() ?? 1, this.#provider().name);
    for (const event of outcome.errors) this.#append(event);
    if (outcome.confirm) {
      // The model, if any, is applied only once the turn is allowed: a
      // cancelled confirmation discards the switch with it (nothing
      // switched for a turn that never ran).
      const decision = seam.confirm
        ? await seam.confirm({ reason: outcome.confirm.reason, by: outcome.confirm.by, text })
        : "refuse";
      resolveTurnConfirm(outcome.confirm, decision);
      if (decision !== "send") return false;
    }
    if (outcome.model === undefined) return true;
    const applied = seam.applyModel(outcome.model);
    if (applied.ok) return true; // same ref = silent no-op; new ref = the session's chrome
    // #948: a context-fit refusal already appended its own `switch_refused`
    // chrome event (the session's guard) — exactly one visible record, so
    // the extension skip channel stays silent for this case.
    if (applied.reason === "context_length") return true;
    this.#append({
      type: "extension_failed",
      name: outcome.modelBy ?? "extension",
      reason: "invalid_model",
      message: `${outcome.model}: ${applied.error}`,
    });
    return true;
  }

  /**
   * ADR-0059: consults the `onModelError` seam for a failed provider call.
   * Returns null — no retry — when the seam is absent, the error kind is
   * Route-handled (`fallback` already moved the call down the chain) or
   * `aborted`, the turn's consultation budget is spent, no hook answers,
   * or the proposal cannot be applied — including a ref that resolves to
   * the currently serving provider (#1111: a no-op switch never retries,
   * and the budget is not spent on it). An applicable proposal applies the
   * ref exactly like the manual `/model` switch (the session's guard
   * records `switch_refused` for a fit refusal) and returns the proposal.
   */
  async #consultModelRetry(refusing: string, err: unknown): Promise<{ model: string } | null> {
    const seam = this.#modelRetry;
    if (!seam) return null;
    const kind = refusalKind(err);
    if (kind === undefined || kind === "aborted" || ROUTE_HANDLED_ERROR_KINDS.has(kind)) return null;
    if (this.#modelRetriesThisTurn >= MAX_MODEL_ERROR_RETRIES) return null;
    const message = err instanceof Error ? err.message : String(err);
    // #1111: the provider serving the failed call, captured before any
    // application — `applyModel` moves the session state in place.
    const servingProviderName = this.#provider().name;
    const outcome = await seam.dispatch({ model: refusing, errorKind: kind, message });
    for (const e of outcome.errors) this.#append(e);
    if (outcome.model === undefined || outcome.model === refusing) return null;
    const applied = seam.applyModel(outcome.model);
    if (applied.ok) {
      // #1111: `switchModel` treats a ref that resolves to the currently
      // serving provider as a silent no-op (`{ ok: true }`, no chrome) —
      // an alias or the bare endpoint name while its model is serving.
      // Retrying on it would re-read the same failing provider and pay
      // for the call, so the proposal counts as refused: no retry, and
      // the budget is not spent on a consultation that moves nothing.
      if (applied.model === servingProviderName) return null;
      this.#modelRetriesThisTurn += 1;
      return { model: applied.model };
    }
    // #948: a context-fit refusal already appended its own `switch_refused`
    // chrome event (the session's guard) — exactly one visible record.
    if (applied.reason === "context_length") return null;
    this.#append({
      type: "extension_failed",
      name: outcome.by ?? "extension",
      reason: "invalid_model",
      message: `${outcome.model}: ${applied.error}`,
    });
    return null;
  }

  /** Drops an interrupted call without checkpointing resumable context: its
   * completed reasoning text stays in the log for audit/display (no opaque
   * continuation — the provider message was never finalized), marked by a
   * failed `model_call` so replay discards its partial content (#243).
   * Unlike #settleCall("failed"), an interrupted call did not complete a
   * billable attempt, so it contributes nothing to the turn's model list. */
  #discardPendingCall(): void {
    const call = this.#pendingCall;
    this.#pendingCall = null;
    this.#reasoning = EMPTY_REASONING_PARTS;
    if (!call) return;
    this.#settleReasoning(call.reasoning, false, true);
    // #1099: an interrupted call is an aborted attempt — reconstructable
    // in the chain, never counted as a provider failure.
    this.#appendModelCall(call, this.#attemptTelemetry(call, "aborted"), { failed: true });
  }

  /** #240: the neutral per-call stream options; undefined when no thinking
   * level is configured — providers then receive no invented field. */
  #streamOptions(): StreamOptions | undefined {
    const thinking = this.#thinking?.();
    return thinking ? { thinking } : undefined;
  }

  /** Records a failed call for audit/display without treating its reasoning
   * or opaque metadata as completed provider context. The failed marker on
   * the `model_call` also lets replay drop same-target retry attempts whose
   * partial content is not a valid provider message (#243). #1099: the
   * failure's normalized facts (kind, sanitized transport details) ride the
   * attempt record — pass `normalizeProviderError(err)`, or a plain
   * `{ errorKind }` when only the kind is known (fallback, empty completion). */
  #flushFailedModelCall(failure?: AttemptFailure): void {
    this.#settleCall("failed", failure);
  }

  /** The one `model_call` event literal (#83/#1099): every settlement —
   * completed, failed, aborted — renders through here, so the aggregate
   * usage, the provider-reported detail with its provenance and the
   * attempt audit record cannot diverge between the paths. */
  #appendModelCall(
    call: {
      model: string;
      usage: TokenUsage;
      thinkingLevel?: ThinkingLevel;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      reasoningTokens?: number;
      consumedUsage: boolean;
      usageProvenance?: UsageProvenance;
    },
    attempt: AttemptTelemetry,
    options: { failed?: boolean },
  ): void {
    this.#append({
      type: "model_call",
      model: call.model,
      usage: { ...call.usage },
      ...(call.thinkingLevel ? { thinkingLevel: call.thinkingLevel } : {}),
      ...(options.failed ? { failed: true } : {}),
      ...(call.cacheReadTokens !== undefined ? { cacheReadTokens: call.cacheReadTokens } : {}),
      ...(call.cacheWriteTokens !== undefined ? { cacheWriteTokens: call.cacheWriteTokens } : {}),
      ...(call.reasoningTokens !== undefined ? { reasoningTokens: call.reasoningTokens } : {}),
      usageProvenance: call.consumedUsage ? (call.usageProvenance ?? "provider") : "unavailable",
      attempt,
    });
  }

  /** The single call-settlement seam (#243): "ok" checkpoints reasoning with
   * continuation and records the serving model; "failed" keeps displayable
   * reasoning text without continuation, marked failed for replay. Shared
   * reasoning bookkeeping lives here so the paths cannot diverge.
   * #1099: the settled `model_call` carries the attempt audit record
   * (correlation, timing, sanitized identity, outcome) and the provider-
   * reported usage detail with its provenance. */
  #settleCall(outcome: "ok" | "failed", failure?: AttemptFailure): void {
    const call = this.#pendingCall;
    if (!call) return;
    this.#pendingCall = null;
    this.#reasoning = EMPTY_REASONING_PARTS;
    this.#settleReasoning(call.reasoning, outcome === "ok", outcome === "failed");
    this.#turnModels.push(call.model);
    const facts = outcome === "failed" ? failureFacts(failure) : undefined;
    this.#appendModelCall(call, this.#attemptTelemetry(call, outcome === "ok" ? "completed" : "failed", facts), {
      failed: outcome === "failed",
    });
    // #1100: quota-class failures record an observation + a block boundary
    // linked to the attempt; a later successful settlement closes the
    // blocks its scope covers (recovery, observed wait, fallback flag).
    const endedAtMs = Date.now();
    if (outcome === "failed" && facts && QUOTA_ERROR_KINDS.has(facts.errorKind)) {
      const endpoint = call.endpoint ?? endpointIdentityOf(this.#provider());
      const scopeKey = scopeKeyFor(endpoint, { model: call.model });
      // The block's `startedAt` is the failed attempt's settlement — the
      // moment the refusal became a recorded fact (the attempt's own
      // start/end live on the #1099 attempt record).
      const startedAt = new Date(endedAtMs).toISOString();
      const [observation, boundary] = quotaEventsFromProviderError({
        endpoint,
        errorKind: facts.errorKind as "rate_limited" | "quota_exhausted",
        servingModel: call.model,
        retryAfterMs: facts.retryAfterMs,
        observedAt: startedAt,
        callId: this.#callId,
        attemptId: call.attemptId,
      });
      this.#append(observation);
      this.#append(boundary);
      this.#quotaBlocks.push({
        scopeKey,
        endpoint,
        servingModel: call.model,
        startedAt,
        endedAtMs,
        ...(facts.retryAfterMs !== undefined ? { retryAfterMs: facts.retryAfterMs } : {}),
        callId: this.#callId,
        attemptId: call.attemptId,
      });
    } else if (outcome === "ok" && this.#quotaBlocks.length > 0) {
      const endpoint = call.endpoint ?? endpointIdentityOf(this.#provider());
      const modelScope = scopeKeyFor(endpoint, { model: call.model });
      const endpointScope = scopeKeyFor(endpoint);
      const closed: { scopeKey: string; endpoint: EndpointIdentity; servingModel?: string; startedAt: string; endedAtMs: number; retryAfterMs?: number; callId: string; attemptId: string }[] = [];
      this.#quotaBlocks = this.#quotaBlocks.filter((block) => {
        if (block.scopeKey === modelScope || block.scopeKey === endpointScope) {
          closed.push(block);
          return false;
        }
        return true;
      });
      for (const block of closed) {
        this.#append(
          quotaRecoveryEvent({
            scopeKey: block.scopeKey,
            endpoint: block.endpoint,
            servingModel: call.model,
            blockedStartedAt: block.startedAt,
            waitMs: Math.max(0, call.startedAt - block.endedAtMs),
            usedFallback: block.servingModel !== call.model,
            callId: this.#callId,
            endedAt: new Date(endedAtMs).toISOString(),
          }),
        );
      }
    }
  }

  /** Appends a settled call's reasoning blocks; `removeFromIteration`
   * (failed/discarded only) also drops them from the live turn message — a
   * successful call keeps them there so the next in-turn call carries the
   * provider its continuation artifacts. `withContinuation` is false unless
   * the provider message finalized (#240 decision 11, #243). */
  #settleReasoning(
    reasoning: { text: string; continuation?: Record<string, unknown> }[],
    withContinuation = false,
    removeFromIteration = false,
  ): void {
    if (removeFromIteration && reasoning.length) {
      this.#iterationReasoning.splice(-reasoning.length, reasoning.length);
    }
    for (const block of reasoning) {
      this.#append({
        type: "reasoning",
        text: block.text,
        ...(withContinuation && block.continuation ? { continuation: block.continuation } : {}),
      });
    }
  }

  /** Append the completed model call to the log, if one is open (#83).
   * #240: a completed reasoning block is persisted first — one `reasoning`
   * event per call, before its `model_call`, with opaque continuation only
   * for a finalized provider message. Failed calls keep displayable text;
   * aborted calls never form a valid assistant message. */
  #flushModelCall(): void {
    this.#settleCall("ok");
  }
}
