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
import type { ExtensionRuntime } from "../extensions";

/** The extension surface AgentLoop needs — satisfied by ExtensionRuntime. */
export type LoopExtensions = Pick<ExtensionRuntime, "dispatchBeforeModelCall" | "dispatchAfterTurn">;

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
  /** #253: live (ephemeral) reasoning relay — the stream lifecycle is
   * forwarded in real time while the model thinks, without touching the
   * persisted log (the completed block still lands there). */
  emitLive?: (event: ReasoningStreamEvent) => void;
  /** #240: the neutral thinking-level request, read once per model call
   * (session-level option; #241 wires endpoint preferences here). */
  thinking?: () => { level: ThinkingLevel } | undefined;
  /** Fire-and-forget post-turn hook (memory trigger); never blocks the turn. */
  onTurnSettled?: (result: TurnResult) => void;
}

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
  readonly #mcp: { ensureStarted(): Promise<void> } | undefined;
  readonly #messages: Message[];
  readonly #assemblePrompt: () => void;
  readonly #lastPrompt: () => AssembledPrompt | null;
  readonly #append: (event: AgentEvent) => void;
  readonly #emitLive: ((event: ReasoningStreamEvent) => void) | undefined;
  readonly #thinking: (() => { level: ThinkingLevel } | undefined) | undefined;
  readonly #onTurnSettled: ((result: TurnResult) => void) | undefined;
  /** Cumulative usage tokens reported by the provider, where exposed (#13). */
  #usage = { inputTokens: 0, outputTokens: 0 };
  /** #83: the model call currently streaming (announced by `model_call_start`).
   * #240: also buffers the call's completed reasoning (persisted with the
   * call) and the effective thinking level the provider announced. */
  #pendingCall: {
    model: string;
    usage: TokenUsage;
    thinkingLevel?: ThinkingLevel;
    reasoning: { text: string; continuation?: Record<string, unknown> }[];
  } | null = null;
  /** #83: turn rollup inputs — usage at turn start and models that served it. */
  #turnStartUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  #turnModels: string[] = [];

  constructor(options: AgentLoopOptions) {
    this.#provider = options.provider;
    this.#maxIterations = options.maxIterations;
    this.#tools = options.tools;
    this.#toolRunner = options.toolRunner;
    this.#extensions = options.extensions;
    this.#mcp = options.mcp;
    this.#messages = options.messages;
    this.#assemblePrompt = options.assemblePrompt;
    this.#lastPrompt = options.lastPrompt;
    this.#append = options.append;
    this.#emitLive = options.emitLive;
    this.#thinking = options.thinking;
    this.#onTurnSettled = options.onTurnSettled;
  }

  /** #240: one open reasoning block of the active stream (reasoning_start
   * … reasoning_end), plus the completed blocks of the current iteration —
   * they ride the iteration's assistant message parts so later calls in
   * the same turn carry the provider's continuation artifacts. */
  #reasoningText = "";
  #iterationReasoning: ReasoningPart[] = [];

  /** #240: opens the model-call buffer for a new stream announcement
   * (shared by the main and wrap-up loops). */
  #openCall(event: StreamEvent & { type: "model_call_start" }): void {
    // A second announcement before the prior call produced `finish` means
    // retry/fallback, not a finalized provider message.
    if (this.#pendingCall) this.#flushFailedModelCall();
    this.#pendingCall = {
      model: event.model,
      usage: { inputTokens: 0, outputTokens: 0 },
      ...(event.thinkingLevel ? { thinkingLevel: event.thinkingLevel } : {}),
      reasoning: [],
    };
  }

  /** #240: neutral reasoning stream bookkeeping, shared by the main and
   * wrap-up consumption loops. A call may emit several reasoning blocks;
   * each completed block is kept (never overwritten). #253: the lifecycle
   * is also relayed to the live channel as it arrives. */
  #consumeReasoningEvent(event: StreamEvent): void {
    // Type guard, not a blind cast: the live channel carries exactly the
    // reasoning lifecycle, and this keeps the invariant checked if
    // StreamEvent ever grows other text-bearing variants.
    if (event.type === "reasoning_start" || event.type === "reasoning_delta" || event.type === "reasoning_end") {
      this.#emitLive?.(event);
    }
    if (event.type === "reasoning_start") {
      this.#reasoningText = "";
    } else if (event.type === "reasoning_delta") {
      this.#reasoningText += event.text;
    } else if (event.type === "reasoning_end") {
      if (this.#reasoningText) {
        const block = { text: this.#reasoningText, ...(event.continuation ? { continuation: event.continuation } : {}) };
        this.#iterationReasoning.push({ kind: "reasoning", ...block });
        this.#pendingCall?.reasoning.push(block);
      }
      this.#reasoningText = "";
    }
  }

  /** Cumulative usage tokens reported by the provider, where exposed. */
  get usage(): { inputTokens: number; outputTokens: number } {
    return { ...this.#usage };
  }

  /** Runs one user message to completion. */
  async run(text: string, controller: AbortController): Promise<TurnResult> {
    const result = await this.#runInner(text, controller);
    if (this.#extensions) {
      for (const e of await this.#extensions.dispatchAfterTurn(result)) this.#append(e);
    }
    // Memory (#38): fire-and-forget after the reply — never blocks the turn.
    this.#onTurnSettled?.(result);
    return result;
  }

  async #runInner(text: string, controller: AbortController): Promise<TurnResult> {
    // #166: the provider is read once per turn — a mid-session switch
    // (AgentSession.switchModel) takes effect from the next turn, never
    // mid-stream.
    const provider = this.#provider();
    this.#append({ type: "user_message", text });
    // #83: turn rollup baselines.
    this.#turnStartUsage = { ...this.#usage };
    this.#turnModels = [];
    this.#messages.push({ role: "user", parts: [{ kind: "text", text }] });
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
        let wrapText = "";
        let wrapFinished = false;
        this.#iterationReasoning = [];
        try {
          for await (const event of provider.stream(this.#messages, controller.signal, [], this.#streamOptions())) {
            if (controller.signal.aborted) break;
            if (event.type === "text_delta") {
              wrapText += event.text;
              this.#append({ type: "assistant_delta", text: event.text });
            } else if (event.type === "model_call_start") {
              this.#openCall(event);
            } else if (event.type === "reasoning_start" || event.type === "reasoning_delta" || event.type === "reasoning_end") {
              this.#consumeReasoningEvent(event);
            } else if (event.type === "fallback") {
              this.#append(event);
              this.#flushFailedModelCall();
            } else if (event.type === "usage") {
              this.#usage.inputTokens += event.inputTokens;
              this.#usage.outputTokens += event.outputTokens;
              if (this.#pendingCall) {
                this.#pendingCall.usage.inputTokens += event.inputTokens;
                this.#pendingCall.usage.outputTokens += event.outputTokens;
              }
            } else if (event.type === "finish") {
              wrapFinished = true;
            }
          }
        } catch {
          // The wrap-up is best-effort: a failing final call degrades to the
          // historical cap error rather than masking it. Its partial call is
          // recorded as failed, never a resumable checkpoint (#243).
          this.#flushFailedModelCall();
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
      try {
        const toolSpecs: ToolSpec[] = Object.values(this.#tools()).map((t) => ({
          name: t.name,
          description: t.description,
          ...(t.inputSchema ? { parameters: z.toJSONSchema(t.inputSchema) as Record<string, unknown> } : {}),
        }));
        for await (const event of provider.stream(this.#messages, controller.signal, toolSpecs, this.#streamOptions())) {
          if (controller.signal.aborted) break;
          if (event.type === "text_delta") {
            assistantText += event.text;
            this.#append({ type: "assistant_delta", text: event.text });
          } else if (event.type === "tool_calls") {
            toolCalls.push(...event.calls);
          } else if (event.type === "model_call_start") {
            // A new call starts: record the previous one, then open a buffer
            // for this one (#83). Mid-stream fallbacks announce a second
            // call inside the same provider.stream — both get recorded.
            this.#openCall(event);
          } else if (event.type === "reasoning_start" || event.type === "reasoning_delta" || event.type === "reasoning_end") {
            this.#consumeReasoningEvent(event);
          } else if (event.type === "fallback") {
            // ADR-0012: the stop is chrome the log keeps — replay and the
            // TUI toast both key off it. The failed call's reasoning text
            // remains displayable, but its continuation is not a completed
            // provider message and cannot enter future context (#243).
            this.#append(event);
            this.#flushFailedModelCall();
          } else if (event.type === "usage") {
            this.#usage.inputTokens += event.inputTokens;
            this.#usage.outputTokens += event.outputTokens;
            if (this.#pendingCall) {
              this.#pendingCall.usage.inputTokens += event.inputTokens;
              this.#pendingCall.usage.outputTokens += event.outputTokens;
            }
          } else if (event.type === "finish") {
            finishReason = event.reason;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) break;
        // #240: the failed call keeps its completed reasoning text (error
        // state) and model_call audit before the error lands. Opaque
        // continuation is not checkpointed without a finalized message.
        this.#flushFailedModelCall();
        const reason = err instanceof Error && "kind" in err ? String((err as any).kind) : "provider_failure";
        const message = err instanceof Error ? err.message : String(err);
        this.#append({ type: "error", reason, message });
        return { status: "error", reason, message };
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

  /** Drops an interrupted call without checkpointing resumable context: its
   * completed reasoning text stays in the log for audit/display (no opaque
   * continuation — the provider message was never finalized), marked by a
   * failed `model_call` so replay discards its partial content (#243).
   * Unlike #settleCall("failed"), an interrupted call did not complete a
   * billable attempt, so it contributes nothing to the turn's model list. */
  #discardPendingCall(): void {
    const call = this.#pendingCall;
    this.#pendingCall = null;
    this.#reasoningText = "";
    if (!call) return;
    this.#settleReasoning(call.reasoning, false, true);
    this.#append({ type: "model_call", model: call.model, usage: { ...call.usage }, failed: true });
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
   * partial content is not a valid provider message (#243). */
  #flushFailedModelCall(): void {
    this.#settleCall("failed");
  }

  /** The single call-settlement seam (#243): "ok" checkpoints reasoning with
   * continuation and records the serving model; "failed" keeps displayable
   * reasoning text without continuation, marked failed for replay. Shared
   * reasoning bookkeeping lives here so the paths cannot diverge. */
  #settleCall(outcome: "ok" | "failed"): void {
    const call = this.#pendingCall;
    if (!call) return;
    this.#pendingCall = null;
    this.#reasoningText = "";
    this.#settleReasoning(call.reasoning, outcome === "ok", outcome === "failed");
    this.#turnModels.push(call.model);
    this.#append({
      type: "model_call",
      model: call.model,
      usage: { ...call.usage },
      ...(call.thinkingLevel ? { thinkingLevel: call.thinkingLevel } : {}),
      ...(outcome === "failed" ? { failed: true } : {}),
    });
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
