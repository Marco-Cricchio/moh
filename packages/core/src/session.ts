import type { AgentEvent, FinishReason, Message, Provider, Tool, ToolCall, ToolContext, TurnResult } from "./types";
import { SCHEMA_VERSION } from "./types";
import type { SessionConfig } from "./index";
import { DEFAULT_TOOL_PERMISSIONS, PermissionResolver, type PermissionRule, type SessionMode } from "./permissions";
import { PromptComposer } from "./prompt-composer";

const DEFAULT_MAX_ITERATIONS = 50;

/**
 * One conversation instance. The append-only event log *is* the session:
 * streaming, history and (later) persistence are projections of it.
 */
export class AgentSession {
  readonly #provider: Provider;
  readonly #maxIterations: number;
  readonly #tools: Record<string, Tool>;
  readonly #cwd: string;
  readonly #permissions: PermissionResolver;
  readonly #onPermissionRequest: SessionConfig["onPermissionRequest"];
  readonly #sink: SessionConfig["sink"] | undefined;
  readonly #promptComposer: PromptComposer;
  #promptVersion = "";
  readonly #log: AgentEvent[] = [];
  readonly #messages: Message[] = [];
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  #controller: AbortController | null = null;
  #turn: Promise<TurnResult> | null = null;
  /** Pending sends: front runs as soon as the session is idle. */
  readonly #queue: { text: string; resolve: (result: TurnResult) => void }[] = [];

  constructor(config: SessionConfig) {
    this.#provider = config.provider;
    this.#maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.#tools = config.tools ?? {};
    this.#cwd = config.cwd ?? process.cwd();
    const perms = config.permissions ?? {};
    const mode: SessionMode = perms.bypassPermissions === true
      ? "bypass"
      : perms.mode === "auto-accept" ? "auto-accept" : "normal";
    this.#permissions = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: perms.overrides,
      runtimeRules: perms.runtimeRules,
      mode,
      cwd: this.#cwd,
    });
    this.#onPermissionRequest = config.onPermissionRequest;
    this.#sink = config.sink;
    this.#promptComposer = config.promptComposer ?? new PromptComposer({ projectDir: this.#cwd });
    this.#assemblePrompt();
    this.#append({ type: "session_start", schemaVersion: SCHEMA_VERSION, promptVersion: this.#promptVersion });
    this.#append({ type: "session_mode", mode });
  }

  /** Append-only event log, replayable in memory. */
  get events(): AsyncIterable<AgentEvent> {
    let cursor = 0;
    let notify: (() => void) | null = null;
    const listener = () => notify?.();
    this.#listeners.add(listener);
    let done = false;
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<AgentEvent>> {
            if (cursor < self.#log.length) return { value: self.#log[cursor++]!, done: false };
            if (done) return { value: undefined as never, done: true };
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
            notify = null;
            if (cursor < self.#log.length) return { value: self.#log[cursor++]!, done: false };
            return { value: undefined as never, done: true };
          },
          async return() {
            self.#listeners.delete(listener);
            done = true;
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }

  /** True while a turn is in flight (including one being steered away). */
  pending(): boolean {
    return this.#turn !== null;
  }

  /** Snapshot of the append-only event log. */
  history(): AgentEvent[] {
    return [...this.#log];
  }

  /** Cancels the active turn; appends a `cancelled` event. No-op if idle. */
  abort(): void {
    this.#controller?.abort();
  }

  /** Tools registered on this session. */
  get tools(): Record<string, Tool> {
    return this.#tools;
  }

  /**
   * Sends a user message and runs the turn to completion.
   * Steering: calling send() while a turn is active aborts the in-flight
   * call (its promise resolves `{status: "cancelled"}`) and the steering
   * message starts a fresh turn as soon as the session is idle. Each send
   * resolves with the result of its own turn; there is no queued-only mode
   * — a later send always preempts the running one.
   */
  send(text: string): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      this.#queue.push({ text, resolve });
      this.#pump();
    });
  }

  /**
   * Starts the front-of-queue send when idle, or preempts the active
   * turn when sends are waiting. The finishing turn re-pumps, so a
   * steered session chains: cancelled -> steering user_message -> new turn.
   */
  #pump(): void {
    if (this.#turn !== null) {
      if (this.#queue.length > 0) this.#controller?.abort();
      return;
    }
    const item = this.#queue.shift();
    if (!item) return;
    const controller = new AbortController();
    this.#controller = controller;
    const turn = this.#executeTurn(item.text, controller).finally(() => {
      this.#turn = null;
      this.#controller = null;
      this.#pump();
    }) as Promise<TurnResult>;
    // Defensive: an unexpected rejection must still settle the caller's
    // promise instead of becoming an unhandled rejection.
    const guarded = turn.catch(
      (err): TurnResult => ({
        status: "error",
        reason: "internal",
        message: err instanceof Error ? err.message : String(err),
      }),
    ) as Promise<TurnResult>;
    this.#turn = turn;
    void guarded.then(item.resolve);
  }

  async #executeTurn(text: string, controller: AbortController): Promise<TurnResult> {
    this.#append({ type: "user_message", text });
    this.#messages.push({ role: "user", parts: [{ kind: "text", text }] });

    let iterations = 0;
    let assistantText = "";
    let finishReason: FinishReason | null = null;
    while (finishReason !== "stop") {
      if (iterations >= this.#maxIterations) {
        this.#append({ type: "error", reason: "max_iterations", message: `iteration cap of ${this.#maxIterations} reached` });
        return { status: "error", reason: "max_iterations", message: "iteration cap reached" };
      }
      iterations += 1;
      assistantText = "";
      finishReason = null;
      this.#assemblePrompt(); // reassembled every call
      const toolCalls: ToolCall[] = [];
      try {
        for await (const event of this.#provider.stream(this.#messages, controller.signal)) {
          if (controller.signal.aborted) break;
          if (event.type === "text_delta") {
            assistantText += event.text;
            this.#append({ type: "assistant_delta", text: event.text });
          } else if (event.type === "tool_calls") {
            toolCalls.push(...event.calls);
          } else if (event.type === "finish") {
            finishReason = event.reason;
          }
        }
      } catch (err) {
        if (controller.signal.aborted) break;
        const reason = err instanceof Error && "kind" in err ? String((err as any).kind) : "provider_failure";
        const message = err instanceof Error ? err.message : String(err);
        this.#append({ type: "error", reason, message });
        return { status: "error", reason, message };
      }
      if (finishReason === null) {
        // Stream ended without a finish event (e.g. aborted mid-stream).
        break;
      }
      if (finishReason !== "stop") {
        this.#messages.push({
          role: "assistant",
          parts: [
            ...(assistantText ? [{ kind: "text" as const, text: assistantText }] : []),
            ...toolCalls.map((c) => ({ kind: "tool_call" as const, ...c })),
          ],
        });
        const outcome = await this.#runTools(toolCalls, controller.signal);
        if (outcome === "aborted") break;
      }
    }

    if (controller.signal.aborted) {
      this.#append({ type: "cancelled" });
      return { status: "cancelled" };
    }
    this.#pushAssistant(assistantText);
    this.#append({ type: "done" });
    return { status: "done" };
  }

  #pushAssistant(text: string): void {
    this.#messages.push({ role: "assistant", parts: [{ kind: "text", text }] });
  }

  /** Reassembles the system prompt for the next model call (#27). */
  #assemblePrompt(): void {
    const assembled = this.#promptComposer.compose({
      cwd: this.#cwd,
      platform: process.platform,
      now: new Date(),
      model: this.#provider.name,
      tools: Object.values(this.#tools).map((t) => ({ name: t.name, description: t.description })),
      skills: [],
    });
    this.#promptVersion = assembled.version;
    const systemMessage: Message = { role: "system", parts: [{ kind: "text", text: assembled.system }] };
    if (this.#messages[0]?.role === "system") this.#messages[0] = systemMessage;
    else this.#messages.unshift(systemMessage);
  }

  /**
   * Runs same-turn tool calls in parallel (Promise.allSettled), appends
   * tool_call/tool_result events in completion order, and feeds results
   * back as a user message the model sees for self-correction.
   * Returns "aborted" if the turn was cancelled mid-execution.
   */
  async #runTools(calls: ToolCall[], signal: AbortSignal): Promise<"ok" | "aborted"> {
    if (calls.length === 0) return "ok";
    for (const call of calls) {
      this.#append({ type: "tool_call", callId: call.callId, name: call.name, args: call.args });
    }
    // Append each tool_result the moment its promise settles, so the log
    // reflects completion order; collect parts in that same order.
    const resultParts: Message["parts"] = [];
    await Promise.allSettled(
      calls.map(async (call) => {
        const result = await this.#executeTool(call, signal);
        this.#append({ type: "tool_result", callId: result.callId, ok: result.ok, output: result.output });
        resultParts.push({ kind: "tool_result", callId: result.callId, ok: result.ok, output: result.output });
      }),
    );
    this.#messages.push({ role: "user", parts: resultParts });
    return signal.aborted ? "aborted" : "ok";
  }

  /** Runtime permission rules active in this session (snapshot). */
  get permissionRules(): PermissionRule[] {
    return this.#permissions.rules;
  }

  async #executeTool(
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<{ callId: string; ok: boolean; output: string }> {
    const tool = this.#tools[call.name];
    if (!tool) {
      return { callId: call.callId, ok: false, output: `unknown tool: ${call.name}` };
    }
    let args: unknown = call.args;
    if (tool.inputSchema) {
      const parsed = tool.inputSchema.safeParse(call.args);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        return { callId: call.callId, ok: false, output: `invalid arguments for ${call.name}: ${issues}` };
      }
      args = parsed.data;
    }
    const gate = await this.#gatePermission(call.name, call.callId, args);
    if (!gate.allowed) {
      return { callId: call.callId, ok: false, output: gate.denial };
    }
    const ctx: ToolContext = {
      signal,
      cwd: this.#cwd,
      onProgress: () => {},
    };
    try {
      const output = await tool.execute(args, ctx);
      return { callId: call.callId, ok: true, output: String(output) };
    } catch (err) {
      return {
        callId: call.callId,
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Resolves and enforces the 3-tier permission gate for one tool call.
   * Returns a structured denial string on "deny"/headless-"ask" so the
   * model sees the refusal as a failed tool_result.
   */
  async #gatePermission(
    tool: string,
    callId: string,
    args: unknown,
  ): Promise<{ allowed: true } | { allowed: false; denial: string }> {
    const decision = this.#permissions.resolve(tool, args);
    if (decision === "deny") {
      this.#append({ type: "permission_denied", callId, tool, reason: "rule" });
      return { allowed: false, denial: `permission denied: ${tool} denied by permission rule` };
    }
    if (decision === "allow") return { allowed: true };

    // "ask" decisions.
    const mode = this.#permissions.mode;
    if (mode === "bypass") {
      this.#append({ type: "permission_granted", callId, tool, reason: "bypass" });
      return { allowed: true };
    }
    if (mode === "auto-accept") {
      this.#append({ type: "permission_granted", callId, tool, reason: "auto_accept" });
      return { allowed: true };
    }
    if (!this.#onPermissionRequest) {
      this.#append({ type: "permission_denied", callId, tool, reason: "headless" });
      return {
        allowed: false,
        denial: `permission denied: ${tool} requires user consent (headless mode)`,
      };
    }
    this.#append({ type: "permission_requested", callId, tool });
    const answer = await this.#onPermissionRequest(tool, args);
    if (answer === "no") {
      this.#append({ type: "permission_denied", callId, tool, reason: "user" });
      return { allowed: false, denial: `permission denied: ${tool} requires user consent` };
    }
    this.#append({ type: "permission_granted", callId, tool, reason: "user" });
    if (answer === "always" && this.#permissions.persistable(tool, args)) {
      const rule = this.#permissions.runtimeRuleFor(tool, args);
      if (rule) {
        this.#permissions.addRuntimeRule(rule);
        this.#append({ type: "permission_rule_added", rule: { ...rule, tier: "runtime" } });
      }
    }
    return { allowed: true };
  }

  #append(event: AgentEvent): void {
    this.#log.push(event);
    this.#sink?.(event);
    for (const listener of this.#listeners) listener(event);
  }
}
