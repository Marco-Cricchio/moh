import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, Message, Provider, ReasoningStreamEvent, SendOptions, SkillPrompt, Tool, TurnResult } from "../types";
import { SCHEMA_VERSION } from "../types";
import type { SessionConfig } from "./config";
import { resolveProviderRef, defaultRegistry, type FrozenProviderRegistry, type RouteResolutionOptions } from "../provider-registry";
import { DEFAULT_TOOL_PERMISSIONS, PermissionResolver, runtimeRulesFromEvents, type PermissionRule, type SessionMode } from "../permissions";
import { persistMcpTrust } from "../config";
import { McpRuntime } from "../mcp";
import { PromptComposer, type AssembledPrompt, type SkillIndexEntry } from "../prompt-composer";
import { discoverSkills } from "../skills";
import { ExtensionRuntime } from "../extensions";
import { EventLog } from "./event-log";
import { PermissionGate } from "./permission-gate";
import { ToolRunner } from "./tool-runner";
import { TurnQueue } from "./turn-queue";
import { AgentLoop } from "./agent-loop";
import { SubagentHost } from "../subagents";
import { replayMessages } from "../session-store";
import { MemoryRunner, MemoryStore, createMaintenanceExtractor } from "../memory";
import { resolveEndpointThinking } from "../thinking-preferences";

const DEFAULT_MAX_ITERATIONS = 50;

/**
 * One conversation instance. The append-only event log *is* the session:
 * streaming, history and (later) persistence are projections of it.
 *
 * Thin director (#92): all turn machinery lives in the internal
 * collaborators — TurnQueue (send/preempt pump), AgentLoop (one turn),
 * ToolRunner, PermissionGate, EventLog, MemoryRunner — wired here.
 */
export class AgentSession {
  /** #166: mutable — switchModel replaces it for the next turn. */
  #provider: Provider;
  /** #166: merged endpoint profiles, what switchModel resolves against. */
  readonly #endpoints: import("../config").EndpointProfile[];
  /** Registry snapshot frozen at creation; later registrations never reach it. */
  readonly #registry: FrozenProviderRegistry | undefined;
  #tools: Record<string, Tool>;
  readonly #cwd: string;
  /** 1-based live-run turn sequence, bumped when each turn starts (#196). */
  #turnSeq = 0;
  /** Current turn, surfaced to tools via ToolContext (read ledger scope). */
  readonly #turn = (): number => this.#turnSeq;
  readonly #permissions: PermissionResolver;
  readonly #onAskUser: SessionConfig["onAskUser"] | undefined;
  /** The permission gate (#90): 3-tier check + "always" persistence. */
  readonly #gate: PermissionGate;
  /** Same-turn tool execution (#91): parallel run + gated execution. */
  readonly #toolRunner: ToolRunner;
  readonly #extensions: ExtensionRuntime | undefined;
  /** The append-only event log (#89): storage, sink, listeners, dispatch. */
  readonly #eventLog: EventLog;
  /** The send queue + steering pump (#92): preempt semantics unchanged. */
  readonly #queue: TurnQueue;
  /** One agent turn (#92): model calls, streaming, usage rollup (#83). */
  readonly #loop: AgentLoop;
  #lastPrompt: AssembledPrompt | null = null;
  #disposed = false;
  readonly #promptComposer: PromptComposer;
  #skills: SkillIndexEntry[];
  #skillDirs: string[];
  readonly #mohHome: string;
  readonly #routeResolutionOptions: RouteResolutionOptions;
  readonly #firstParty: "include" | "exclude";
  /** MCP tool sources (#15): lazy start, crash tracking, session-end shutdown. */
  readonly #mcp: McpRuntime | undefined;
  #promptVersion = "";
  readonly #messages: Message[];
  /** Memory (#38): the post-turn trigger collaborator (see memory.ts). */
  readonly #sessionId = `session-${randomUUID().slice(0, 8)}`;
  #memory: MemoryRunner | null = null;
  /** ADR-0011: turn-scoped skill prompt — set by the send that carries
   * it, cleared when that turn settles. Null for every ordinary turn. */
  #skillPrompt: SkillPrompt | null = null;

  constructor(config: SessionConfig) {
    this.#registry = config.registry?.freeze();
    this.#endpoints = config.endpoints ?? [];
    this.#mohHome = config.mohHome ?? join(homedir(), ".moh");
    // Init-order note (#243): #mohHome must be assigned before
    // #routeResolutionOptions — its thinkingForTarget lambda resolves
    // endpoint preferences against <mohHome>/config on every target.
    this.#routeResolutionOptions = config.thinking === undefined
      ? {
          thinkingForTarget: (target) =>
            resolveEndpointThinking(
              `${target.endpoint.name}/${target.modelId}`,
              this.#endpoints,
              join(this.#mohHome, "config"),
            ),
        }
      : {};
    this.#provider =
      typeof config.provider === "string"
        ? resolveProviderRef(
            config.provider,
            this.#registry ?? defaultRegistry.freeze(),
            this.#endpoints,
            this.#routeResolutionOptions,
          )
        : config.provider;
    const maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
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
    this.#onAskUser = config.onAskUser;
    this.#eventLog = new EventLog({ sink: config.sink, extensions: config.extensions });
    this.#gate = new PermissionGate({
      permissions: this.#permissions,
      extensions: config.extensions,
      onPermissionRequest: config.onPermissionRequest,
      cwd: this.#cwd,
      append: (event) => this.#append(event),
    });
    this.#toolRunner = new ToolRunner({
      tools: () => this.#allTools(),
      gate: this.#gate,
      parallel: () => this.#provider.capabilities?.parallelToolCalls !== false,
      cwd: this.#cwd,
      skillDirs: () => this.#skillDirs,
      turn: this.#turn,
      ...(this.#onAskUser ? { onAskUser: this.#onAskUser } : {}),
      append: (event) => this.#append(event),
    });
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
        defaultProvider: config.subagents.provider ?? (() => this.#provider),
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
    this.#firstParty = config.firstParty ?? "include";
    const discovered = discoverSkills({ mohHome: this.#mohHome, projectDir: this.#cwd, firstParty: this.#firstParty });
    this.#skills = config.skills ?? discovered.map((s) => ({ name: s.name, description: s.description, path: s.file }));
    this.#skillDirs = [...new Set(discovered.map((s) => s.dir))];
    this.#messages = [];
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
    this.#loop = new AgentLoop({
      provider: () => this.#provider,
      maxIterations,
      tools: () => this.#allTools(),
      toolRunner: this.#toolRunner,
      ...(this.#extensions ? { extensions: this.#extensions } : {}),
      ...(this.#mcp ? { mcp: this.#mcp } : {}),
      messages: this.#messages,
      assemblePrompt: () => this.#assemblePrompt(),
      lastPrompt: () => this.#lastPrompt,
      append: (event) => this.#append(event),
      // #253: live reasoning relay (ephemeral — never stored or sunk).
      emitLive: (event) => this.#eventLog.emitLive(event),
      // #240/#242: the neutral thinking-level request. An explicit config
      // (static or getter) wins; otherwise endpoint-scoped preferences are
      // resolved per call against the *live* provider ref (model switches
      // included), so a persisted preference change is immediate.
      thinking: () => {
        if (config.thinking !== undefined) {
          return typeof config.thinking === "function" ? config.thinking() : config.thinking;
        }
        return resolveEndpointThinking(this.#provider.name, this.#endpoints, join(this.#mohHome, "config"));
      },
      ...(this.#memory ? { onTurnSettled: (result) => this.#maybeExtractMemory(result) } : {}),
    });
    this.#queue = new TurnQueue({
      execute: (text, controller) => {
        this.#turnSeq += 1;
        return this.#loop.run(text, controller);
      },
      onTurnSettled: () => {
        // ADR-0011: a turn-scoped skill prompt lives exactly one turn.
        // Dropped when the turn's promise settles and before the queue
        // re-pumps, so the next turn composes the ordinary skills index.
        if (this.#skillPrompt) {
          this.#skillPrompt = null;
          this.#assemblePrompt();
        }
      },
      onTurnStart: (attachment) => {
        // Applied at turn start, not enqueue time: a steering send that
        // waited out a cancelled turn keeps its prompt (the settling
        // turn's cleanup runs before this).
        const prompt = attachment as SkillPrompt;
        this.#skillPrompt = prompt;
        this.#append({ type: "skill_invoked", name: prompt.name });
        this.#assemblePrompt();
      },
    });
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

  /** #253: live (ephemeral) reasoning lifecycle — delivered while the
   * model thinks, never persisted (the completed block still lands in
   * `events` as the `reasoning` AgentEvent at call settlement).
   * Returns an unsubscribe function. */
  onLiveEvent(listener: (event: ReasoningStreamEvent) => void): () => void {
    return this.#eventLog.onLive(listener);
  }

  /** True while a turn is in flight (including one being steered away). */
  pending(): boolean {
    return this.#queue.pending();
  }

  /** Snapshot of the append-only event log. */
  history(): AgentEvent[] {
    return this.#eventLog.history();
  }

  /** Cumulative usage tokens reported by the provider, where exposed. */
  get usage(): { inputTokens: number; outputTokens: number } {
    return this.#loop.usage;
  }

  /** Cancels the active turn (the loop appends the `cancelled` event). No-op if idle. */
  abort(): void {
    this.#queue.abort();
  }

  /** Registry snapshot this session was created with (frozen). */
  get registry(): FrozenProviderRegistry | undefined {
    return this.#registry;
  }

  /** The active model ref (`endpoint/model-id`, or a provider name). #166. */
  get activeModel(): string {
    return this.#provider.name;
  }

  /** The provider type of the active endpoint (#166): feeds /model's
   * catalog list. Undefined when the provider is a pre-built instance
   * or a bare registered id — the command then skips the list. Derived
   * from the session's own endpoint profiles, never re-read from disk. */
  get activeEndpointType(): string | undefined {
    const ref = this.#provider.name;
    const slash = ref.indexOf("/");
    if (slash === -1) return undefined;
    return this.#endpoints.find((e) => e.name === ref.slice(0, slash))?.type;
  }

  /** The session's merged endpoint profiles (#181 follow-up): read-only
   * copy — feeds the /model modal's every-endpoint model list. Session-
   * owned, never re-read from disk (same posture as activeEndpointType). */
  get endpointProfiles(): import("../config").EndpointProfile[] {
    return this.#endpoints.map((e) => ({ ...e }));
  }

  /**
   * In-session model switch (#166): re-resolves `ref` ("mock", a
   * registered id, or "endpoint/model-id") against the session's frozen
   * registry and merged endpoint profiles, appends a `model_switched`
   * chrome event, and serves subsequent turns from the new provider.
   * The event log stays intact — same session, no re-numbering. Takes
   * effect from the **next** turn: the running turn keeps its provider
   * (read once per turn, never mid-stream). A route with a declared
   * fallback chain is not silently rewritten — switching replaces the
   * active provider ref wholesale; re-declare chains in config.
   */
  switchModel(ref: string): { ok: true; model: string } | { ok: false; error: string } {
    const trimmed = ref.trim();
    if (!trimmed) return { ok: false, error: "empty model reference" };
    try {
      const next = resolveProviderRef(
        trimmed,
        this.#registry ?? defaultRegistry.freeze(),
        this.#endpoints,
        this.#routeResolutionOptions,
      );
      const from = this.#provider.name;
      if (next.name === from) return { ok: true, model: from }; // no-op: same ref, no chrome
      this.#provider = next;
      this.#append({ type: "model_switched", from, to: next.name });
      return { ok: true, model: next.name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
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
  send(text: string, options?: SendOptions): Promise<TurnResult> {
    // ADR-0011: a turn-scoped skill prompt is attached before the turn
    // starts (the loop reassembles the prompt before every model call,
    // so the skills section picks it up) and recorded as chrome in the
    // log — the user_message stays the clean text.
    return this.#queue.send(text, options?.prompt);
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
      ...(this.#skillPrompt ? { skillPrompt: this.#skillPrompt } : {}),
      memory: this.#memory?.excerpt(),
      extensionNotes: this.#extensions?.notes(),
    });
    this.#promptVersion = assembled.version;
    this.#lastPrompt = assembled;
    const systemMessage: Message = { role: "system", parts: [{ kind: "text", text: assembled.system }] };
    if (this.#messages[0]?.role === "system") this.#messages[0] = systemMessage;
    else this.#messages.unshift(systemMessage);
  }

  /** Runtime permission rules active in this session (snapshot). */
  get permissionRules(): PermissionRule[] {
    return this.#permissions.rules;
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
