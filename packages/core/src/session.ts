import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentEvent, FinishReason, Message, Provider, TokenUsage, Tool, ToolCall, ToolContext, ToolSpec, TurnResult } from "./types";
import { SCHEMA_VERSION } from "./types";
import type { SessionConfig } from "./index";
import { resolveProviderRef, defaultRegistry, type FrozenProviderRegistry } from "./provider-registry";
import { DEFAULT_TOOL_PERMISSIONS, PermissionResolver, runtimeRulesFromEvents, type PermissionRule, type SessionMode } from "./permissions";
import { persistMcpTrust, persistToolAllow } from "./config";
import { McpRuntime, type McpRuntimeOptions } from "./mcp";
import { PromptComposer, type AssembledPrompt, type SkillIndexEntry } from "./prompt-composer";
import { discoverSkills } from "./skills";
import { ExtensionRuntime } from "./extensions";
import { EventLog } from "./session/event-log";
import { SubagentHost, type SubagentOptions } from "./subagents";
import { replayMessages, lastAssistantText } from "./session-store";
import {
  MemoryRunner,
  MemoryStore,
  createMaintenanceExtractor,
  type MemoryOptions,
} from "./memory";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_ITERATIONS = 50;

/**
 * One conversation instance. The append-only event log *is* the session:
 * streaming, history and (later) persistence are projections of it.
 */
export class AgentSession {
  readonly #provider: Provider;
  /** Registry snapshot frozen at creation; later registrations never reach it. */
  readonly #registry: FrozenProviderRegistry | undefined;
  readonly #maxIterations: number;
  #tools: Record<string, Tool>;
  readonly #cwd: string;
  readonly #permissions: PermissionResolver;
  readonly #onPermissionRequest: SessionConfig["onPermissionRequest"];
  readonly #onAskUser: SessionConfig["onAskUser"] | undefined;
  readonly #extensions: ExtensionRuntime | undefined;
  /** The append-only event log (#89): storage, sink, listeners, dispatch. */
  readonly #eventLog: EventLog;
  #lastPrompt: AssembledPrompt | null = null;
  #disposed = false;
  readonly #promptComposer: PromptComposer;
  #skills: SkillIndexEntry[];
  #skillDirs: string[];
  readonly #mohHome: string;
  readonly #firstParty: "include" | "exclude";
  /** MCP tool sources (#15): lazy start, crash tracking, session-end shutdown. */
  readonly #mcp: McpRuntime | undefined;
  #promptVersion = "";
  readonly #messages: Message[] = [];
  #controller: AbortController | null = null;
  /** Cumulative usage tokens reported by the provider, where exposed (#13). */
  #usage = { inputTokens: 0, outputTokens: 0 };
  /** #83: the model call currently streaming (announced by `model_call_start`). */
  #pendingCall: { model: string; usage: TokenUsage } | null = null;
  /** #83: turn rollup inputs — usage at turn start and models that served it. */
  #turnStartUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  #turnModels: string[] = [];
  #turn: Promise<TurnResult> | null = null;
  /** Pending sends: front runs as soon as the session is idle. */
  readonly #queue: { text: string; resolve: (result: TurnResult) => void }[] = [];
  /** Memory (#38): the post-turn trigger collaborator (see memory.ts). */
  readonly #sessionId = `session-${randomUUID().slice(0, 8)}`;
  #memory: MemoryRunner | null = null;

  constructor(config: SessionConfig) {
    this.#registry = config.registry?.freeze();
    this.#provider =
      typeof config.provider === "string"
        ? resolveProviderRef(config.provider, this.#registry ?? defaultRegistry.freeze(), [])
        : config.provider;
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
    this.#onAskUser = config.onAskUser;
    this.#eventLog = new EventLog({ sink: config.sink, extensions: config.extensions });
    // Subagents (#13): the spawn tool creates in-process child sessions.
    // Depth 1 by construction — children are created without this option.
    if (config.subagents) {
      const host = new SubagentHost({
        cwd: this.#cwd,
        parentTools: () => this.#allTools(),
        onEvent: (event) => this.#append(event),
        permissions: config.permissions,
        runtimeRules: () => this.#permissions.rules,
        onPermissionRequest: config.onPermissionRequest,
        registry: config.registry,
        defaultProvider: config.subagents.provider ?? this.#provider,
        presets: config.subagents.presets,
        maxConcurrency: config.subagents.maxConcurrency,
        home: config.subagents.home,
      });
      this.#tools = { ...this.#tools, spawn: host.spawnTool() };
    }
    this.#extensions = config.extensions;
    // Extension load results (including hot-reload outcomes) land in the log.
    this.#extensions?.onLoadEvent((event) => this.#append(event));
    this.#promptComposer = config.promptComposer ?? new PromptComposer({ projectDir: this.#cwd });
    // Skills (#30): discovered from ~/.moh/skills + .moh/skills at creation;
    // an explicit config wins (tests, clients). No auto-triggering.
    this.#mohHome = config.mohHome ?? join(homedir(), ".moh");
    this.#firstParty = config.firstParty ?? "include";
    const discovered = discoverSkills({ mohHome: this.#mohHome, projectDir: this.#cwd, firstParty: this.#firstParty });
    this.#skills = config.skills ?? discovered.map((s) => ({ name: s.name, description: s.description, path: s.file }));
    this.#skillDirs = [...new Set(discovered.map((s) => s.dir))];
    // Memory (#38): enabled by default when `memory` options are given;
    // `memory.enabled: false` means no store, no section, no subagent runs.
    const mem = config.memory;
    if (mem && (mem.enabled ?? true)) {
      this.#memory = new MemoryRunner({
        store: new MemoryStore(mem.dir ?? MemoryStore.forProject(this.#cwd, this.#mohHome).dir),
        sessionId: this.#sessionId,
        intervalTurns: mem.intervalTurns,
        budgetTokens: mem.budgetTokens,
        extractor: mem.extractor ?? createMaintenanceExtractor(this.#provider, this.#cwd),
        append: (event) => this.#append(event),
        onUpdated: () => this.#assemblePrompt(),
      });
    }
    if (config.mcp) {
      // Startup validation: duplicate server names are a hard config error.
      McpRuntime.validate(config.mcp.servers);
      this.#mcp = new McpRuntime({
        ...config.mcp,
        cwd: this.#cwd,
        onEvent: (event) => this.#append(event),
        onTrust: config.mcp.onTrust ?? ((server) => persistMcpTrust(join(this.#cwd, "moh.json"), server)),
        // Trusted servers (user scope or persisted "always") never ask again.
        onTrustedTools: (toolNames) => {
          for (const tool of toolNames) this.#permissions.addRuntimeRule({ tool, effect: "allow" });
        },
      });
    }
    if (config.resume?.events.length) {
      // Resume (#31): the log continues in a new AgentSession over the same
      // persisted history. Seeded events are never re-appended (the file
      // already has them); only new events reach the sink.
      this.#eventLog.seed(config.resume.events);
      this.#messages.splice(0, 0, ...replayMessages(config.resume.events));
      for (const rule of runtimeRulesFromEvents(config.resume.events)) {
        this.#permissions.addRuntimeRule(rule);
      }
      this.#flushExtensionEvents();
      // Extensions missing on resume: a previously enabled extension that
      // the current runtime did not load produces a warning, nothing more.
      if (this.#extensions) {
        const enabled = new Set(
          config.resume.events
            .filter((e) => e.type === "extension_loaded")
            .map((e) => (e as { name: string }).name),
        );
        const present = new Set(this.#extensions.instances.map((i) => i.def.name));
        for (const name of enabled) {
          if (!present.has(name)) {
            this.#append({
              type: "extension_failed",
              name,
              reason: "missing_on_resume",
              message: "extension enabled in the resumed session was not loaded; continuing without it",
            });
          }
        }
      }
      this.#assemblePrompt();
      // A mode change across resume is auditable like any startup flag.
      const lastMode = [...config.resume.events].reverse().find((e) => e.type === "session_mode");
      if (!lastMode || lastMode.mode !== mode) this.#append({ type: "session_mode", mode });
      return;
    }
    this.#assemblePrompt();
    this.#append({ type: "session_start", schemaVersion: SCHEMA_VERSION, promptVersion: this.#promptVersion });
    this.#append({ type: "session_mode", mode });
    this.#flushExtensionEvents();
    // Fire-and-forget: construction is sync, the session is not yet running.
    void this.#extensions?.dispatchSessionStart().then((errors) => {
      for (const e of errors) this.#append(e);
    });
  }

  /**
   * Re-runs skill discovery (workflow mode toggled mid-session, #36):
   * the next model call picks up the new index. Explicit config-level
   * skill lists are replaced by fresh discovery — mid-session toggles
   * are a TUI concern, not a headless one.
   */
  refreshSkills(options: { firstParty?: "include" | "exclude" } = {}): void {
    const firstParty = options.firstParty ?? this.#firstParty;
    const discovered = discoverSkills({ mohHome: this.#mohHome, projectDir: this.#cwd, firstParty });
    this.#skills = discovered.map((s) => ({ name: s.name, description: s.description, path: s.file }));
    this.#skillDirs = [...new Set(discovered.map((s) => s.dir))];
    this.#assemblePrompt();
  }

  /**
   * Registers extra tools mid-session (workflow-mode toggle, #36). The
   * tools run under the same permission spine as the built-ins: their
   * tier-1 defaults come from DEFAULT_TOOL_PERMISSIONS and moh.json
   * overrides apply as usual.
   */
  addTools(tools: Record<string, Tool>): void {
    this.#tools = { ...this.#tools, ...tools };
  }

  /** Drains buffered extension load events (failed loads = warnings) into the log. */
  #flushExtensionEvents(): void {
    for (const event of this.#extensions?.consumeLoadEvents() ?? []) this.#append(event);
  }

  /** Replays the append-only log, then streams new events. */
  get events(): AsyncIterable<AgentEvent> {
    return this.#eventLog.events;
  }

  /** True while a turn is in flight (including one being steered away). */
  pending(): boolean {
    return this.#turn !== null;
  }

  /** Snapshot of the append-only event log. */
  history(): AgentEvent[] {
    return this.#eventLog.history();
  }

  /** Cumulative usage tokens reported by the provider, where exposed. */
  get usage(): { inputTokens: number; outputTokens: number } {
    return { ...this.#usage };
  }

  /** Cancels the active turn; appends a `cancelled` event. No-op if idle. */
  abort(): void {
    this.#controller?.abort();
  }

  /** Registry snapshot this session was created with (frozen). */
  get registry(): FrozenProviderRegistry | undefined {
    return this.#registry;
  }

  /** Tools registered on this session, including connected MCP tools. */
  get tools(): Record<string, Tool> {
    return this.#allTools();
  }

  /** MCP runtime owning external tool sources, when configured. */
  get mcp(): McpRuntime | undefined {
    return this.#mcp;
  }

  #allTools(): Record<string, Tool> {
    return this.#mcp ? { ...this.#tools, ...this.#mcp.tools } : this.#tools;
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
    const result = await this.#executeTurnInner(text, controller);
    if (this.#extensions) {
      for (const e of await this.#extensions.dispatchAfterTurn(result)) this.#append(e);
    }
    // Memory (#38): fire-and-forget after the reply — never blocks the turn.
    this.#maybeExtractMemory(result);
    return result;
  }

  async #executeTurnInner(text: string, controller: AbortController): Promise<TurnResult> {
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
    while (finishReason !== "stop") {
      if (iterations >= this.#maxIterations) {
        this.#append({ type: "error", reason: "max_iterations", message: `iteration cap of ${this.#maxIterations} reached` });
        return { status: "error", reason: "max_iterations", message: "iteration cap reached" };
      }
      iterations += 1;
      assistantText = "";
      finishReason = null;
      this.#assemblePrompt(); // reassembled every call
      if (this.#extensions && this.#lastPrompt) {
        const errors = await this.#extensions.dispatchBeforeModelCall({
          prompt: {
            sections: this.#lastPrompt.sections,
            system: this.#lastPrompt.system,
            version: this.#lastPrompt.version,
          },
          messages: this.#messages,
        });
        for (const e of errors) this.#append(e);
      }
      const toolCalls: ToolCall[] = [];
      try {
        const toolSpecs: ToolSpec[] = Object.values(this.#allTools()).map((t) => ({
          name: t.name,
          description: t.description,
          ...(t.inputSchema ? { parameters: z.toJSONSchema(t.inputSchema) as Record<string, unknown> } : {}),
        }));
        for await (const event of this.#provider.stream(this.#messages, controller.signal, toolSpecs)) {
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
            this.#flushModelCall();
            this.#pendingCall = { model: event.model, usage: { inputTokens: 0, outputTokens: 0 } };
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
        const reason = err instanceof Error && "kind" in err ? String((err as any).kind) : "provider_failure";
        const message = err instanceof Error ? err.message : String(err);
        this.#append({ type: "error", reason, message });
        return { status: "error", reason, message };
      }
      // The provider stream ended: this model call is complete — record
      // it (usage is reported at finish, so the event can only close now).
      this.#flushModelCall();
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

  /** Append the completed model call to the log, if one is open (#83). */
  #flushModelCall(): void {
    const call = this.#pendingCall;
    if (!call) return;
    this.#pendingCall = null;
    this.#turnModels.push(call.model);
    this.#append({ type: "model_call", model: call.model, usage: { ...call.usage } });
  }

  #pushAssistant(text: string): void {
    this.#messages.push({ role: "assistant", parts: [{ kind: "text", text }] });
  }

  /**
   * Post-turn memory trigger (#38): delegated to the MemoryRunner
   * collaborator (memory.ts) — every N completed turns, one discreet
   * `memory_updated` event on success, silence otherwise.
   */
  #maybeExtractMemory(result: TurnResult): void {
    this.#memory?.maybeExtract(result, this.#eventLog.live(), this.#disposed);
  }

  /** Reassembles the system prompt for the next model call (#27). */
  #assemblePrompt(): void {
    const assembled = this.#promptComposer.compose({
      cwd: this.#cwd,
      platform: process.platform,
      now: new Date(),
      model: this.#provider.name,
      tools: Object.values(this.#allTools()).map((t) => ({ name: t.name, description: t.description })),
      skills: this.#skills,
      memory: this.#memory?.excerpt(),
      extensionNotes: this.#extensions?.notes(),
    });
    this.#promptVersion = assembled.version;
    this.#lastPrompt = assembled;
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
    const run = async (call: ToolCall) => {
      const result = await this.#executeTool(call, signal);
      this.#append({ type: "tool_result", callId: result.callId, ok: result.ok, output: result.output });
      resultParts.push({ kind: "tool_result", callId: result.callId, ok: result.ok, output: result.output });
    };
    // Capability downgrade: endpoints without parallelToolCalls run calls sequentially.
    if (this.#provider.capabilities?.parallelToolCalls === false) {
      for (const call of calls) await run(call);
    } else {
      await Promise.allSettled(calls.map(run));
    }
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
    const tool = this.#allTools()[call.name];
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
      skillDirs: this.#skillDirs,
      ...(this.#onAskUser ? { askUser: this.#onAskUser } : {}),
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
    // Extension veto first (#34): veto > user rules > defaults, and it applies
    // even in bypass mode — extensions can only restrict, never grant.
    if (this.#extensions) {
      const veto = await this.#extensions.checkToolVeto({ callId, name: tool, args });
      for (const e of veto.errors) this.#append(e);
      if (veto.veto) {
        this.#append({ type: "permission_denied", callId, tool, reason: "extension" });
        return {
          allowed: false,
          denial: `permission denied: ${tool} vetoed by extension${veto.by ? ` ${veto.by}` : ""}${veto.reason ? ` (${veto.reason})` : ""}`,
        };
      }
    }
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
      // MCP tools: "always" also persists to moh.json for future sessions (#15).
      if (tool.startsWith("mcp__")) {
        try {
          persistToolAllow(join(this.#cwd, "moh.json"), tool);
        } catch {
          // no writable moh.json: the runtime rule still covers this session
        }
      }
    }
    return { allowed: true };
  }

  #append(event: AgentEvent): void {
    this.#eventLog.append(event);
  }

  /** Ends the session: flushes a pending memory run, shuts down MCP servers, dispatches onSessionEnd hooks. Idempotent. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#memory?.pending?.catch(() => {});
    await this.#mcp?.shutdown();
    if (!this.#extensions) return;
    for (const e of await this.#extensions.dispatchSessionEnd("disposed")) this.#append(e);
    // The end-of-session events were just queued: let the dispatch drain
    // settle before the session is considered disposed.
    await this.#eventLog.idle();
  }
}
