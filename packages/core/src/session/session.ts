import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentEvent, ExtensionStatus, Message, Provider, ReasoningStreamEvent, SendOptions, SkillPrompt, Tool, TurnResult } from "../types";
import { SCHEMA_VERSION } from "../types";
import type { ExtensionLiveInfo } from "../extensions-screen";
import { normalizeTaskId, taskDeclaredEvent, taskOutcomeEvent, taskVerificationEvent } from "../task/telemetry";
import { newUlid } from "./ulid";
import { substituteSkillArgs } from "../skill-args";
import { localTipAt, fileTailId, resolveEventRef } from "../session-store";
import { activePath, pathTo, resolveHead } from "./event-log";
import type { SessionConfig } from "./config";
import { resolveProviderRef, defaultRegistry, type FrozenProviderRegistry, type RouteResolutionOptions } from "../provider-registry";
import { contextFitFor } from "../context-fit";
// ADR-0050 (#974): the selected/serving pair — one formatter, one accessor
// pair, shared by every surface that states or derives from the model in use.
import { formatModelPair, selectedModelOf, servingModelOf } from "../model-pair";
import { CompactionRunner, createCompactionSummarizer, createDeterministicSummarizer, contextWindowFor } from "../compaction";
import { DEFAULT_TOOL_PERMISSIONS, PermissionResolver, formatRule, runtimeRulesFromEvents, type PermissionRule, type FilesystemScope, type SessionMode } from "../permissions";
import { persistProjectMcpTrust } from "../mcp/types";
import { McpRuntime } from "../mcp";
import { PromptComposer, type AssembledPrompt, type SkillIndexEntry } from "../prompt-composer";
import { discoverSkills } from "../skills";
import { ExtensionRuntime, type ExtensionUIRefusal, type ActiveExtensionOverlay } from "../extensions";
import { EventLog } from "./event-log";
import { commercialDeclarationEvent, observationsFromQuotaReport } from "../quota/telemetry";
import { endpointIdentity } from "../types";
import { PermissionGate, type ToolHookChecker } from "./permission-gate";
import { ToolRunner, type ToolResultHookChecker } from "./tool-runner";
import { TurnQueue } from "./turn-queue";
import { AgentLoop } from "./agent-loop";
import { SubagentHost, type SubagentSpawnRequester, type SubagentSpawnLimits } from "../subagents";
import { replayMessages, replayWarnings } from "../session-store";
import { MemoryRunner, MemoryStore, createMaintenanceExtractor } from "../memory";
import type { CompactionHookContext } from "@moh/extension";
import { resolveEndpointThinking } from "../thinking-preferences";
import { catalogEntryFor, modelSupportsImages } from "../model-catalog";
import { HandoffRunner } from "../handoff";
import { resolveMaxIterations } from "./agent-loop";
import { MpmService, projectMapDir, type MpmStatus } from "../mpm/service";
import type { MpmSeedStats } from "../mpm/types";
import { MpmLifecycle } from "../mpm/lifecycle";
import { MpmOrientation, type MpmOrientationOptions } from "../mpm/orientation";
import { mpmQueryTool } from "../mpm/query-tool";
import { mpmDiagnostics, type MpmDiagnostics } from "../mpm/diagnostics";
import { readMpmUserConfig, resolveMpmConfig, type MpmEffectiveConfig } from "../mpm/config";
import { isOnWindowsMount } from "../windows-mount";
import { userConfigFile } from "../user-config";
import { DeclaredWindows, declaredWindowOf } from "../declared-window";
import { noteUnrecognizedContextRefusal } from "../context-refusal-trace";

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
  /** #1032 (door two): per-endpoint declared windows (the endpoints'
   * own cached listings) — the provider's window outranks the shipped
   * row. Door one (refusal-learned) is #declaredWindows below. */
  readonly #endpointDeclaredWindows: Record<string, Record<string, number>>;
  /** #488: the config's image-capability pin (tests/custom providers).
   * Absent = the catalog's declared modalities answer (ADR-0050 §7:
   * resolved against the model that serves, not the selected one). */
  readonly #images: SessionConfig["images"];
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
  readonly #onConfirmTurn: SessionConfig["onConfirmTurn"] | undefined;
  /** #774: browser reap seam, awaited at dispose. */
  #onDispose: (() => Promise<void>) | undefined;
  /** The permission gate (#90): 3-tier check + "always" persistence. */
  readonly #gate: PermissionGate;
  /** Same-turn tool execution (#91): parallel run + gated execution. */
  readonly #toolRunner: ToolRunner;
  readonly #extensions: ExtensionRuntime | undefined;
  /**
   * #944 (ADR-0047): the runtime this session borrows hooks from when it
   * owns none (a subagent child) — the object whose dispatches are scoped
   * to *this* session, so an extension's `appendEvent` lands in this
   * session's log and not in the owner's.
   */
  readonly #borrowedHooks: ExtensionRuntime | undefined;
  /** #834: are load events still held until the session's start chrome is in? */
  #extensionsHeld = false;
  /** #834: the load events held, in delivery order (= the load order). */
  readonly #heldExtensionEvents: AgentEvent[] = [];
  /** ADR-0032: a client with a consent seam renders statuses itself; a
   * headless one gets the single stderr line instead. */
  readonly #hasConsentSeam: boolean;
  /** ADR-0032: the last status text announced on stderr (null after a clear). */
  #announcedStatus: string | null = null;
  /** The resumed history's active-path projection, seeded at construction. */
  #resumeProjection: AgentEvent[] | undefined;
  /** Startup chrome (#774 / #784), appended once the session's own start
   * events are in — the file's first line stays `session_start`. */
  #startupDiagnostics: readonly string[] = [];
  #startupNotes: readonly string[] = [];
  /** The append-only event log (#89): storage, sink, listeners, dispatch. */
  readonly #eventLog: EventLog;
  /** The send queue + steering pump (#92): preempt semantics unchanged. */
  readonly #queue: TurnQueue;
  /** One agent turn (#92): model calls, streaming, usage rollup (#83). */
  readonly #loop: AgentLoop;
  #lastPrompt: AssembledPrompt | null = null;
  #disposed = false;
  readonly #promptComposer: PromptComposer;
  /** ADR-0055 (#1127): the spawn host, when subagents are on — the stop
   * control and the live-children listing read it. */
  #subagentHost: SubagentHost | null = null;
  /** ADR-0055 (#1127): who is asking for spawns right now. */
  #spawnRequester: () => SubagentSpawnRequester = () => ({ kind: "model" });
  #skills: SkillIndexEntry[];
  #skillDirs: string[];
  readonly #mohHome: string;
  readonly #routeResolutionOptions: RouteResolutionOptions;
  readonly #firstParty: "include" | "exclude";
  /** MCP tool sources (#15): lazy start, crash tracking, session-end shutdown. */
  readonly #mcp: McpRuntime | undefined;
  /** JSONL file the sink appends to (from-config path); undefined when
   * the session was built without a file store. */
  readonly #sessionFile: string | undefined;
  /** #400: external-growth probe (from-config: `SessionStore.externalGrowth`). */
  readonly #externalGrowth: (() => { expectedBytes: number; actualBytes: number } | null) | undefined;
  /**
   * #918: does the project root resolve under `/mnt/` (a Windows drive
   * mounted into WSL)? Resolved once, here — the root never changes
   * mid-session, so no client ever re-probes it per turn or per render.
   */
  readonly #rootOnWindowsMount: boolean;
  /**
   * #576: this writer's own last-appended event id (ULID). While divergence
   * (#400) is unresolved, appends carry an explicit local-tip parent (head
   * semantics d7) — the head never moves on its own.
   */
  #localTip: string | undefined;
  /** #576: set when a `session_file_growth` is observed, cleared by an
   * explicit `switchBranch` (the adoption action, head semantics d9). */
  #diverged = false;
  /**
   * #576 (head semantics d6): the running turn's current parent tip.
   * Captured at send time from the resolved head (or the local tip while
   * diverged) and advanced only by the turn's own events — a mid-turn
   * switch never moves it, so a turn is never split across branches.
   * Null outside a turn (chrome appends follow the live head).
   */
  #turnHead: string | undefined;
  #promptVersion = "";
  readonly #messages: Message[];
  /** Memory (#38): the post-turn trigger collaborator (see memory.ts). */
  readonly #sessionId = `session-${randomUUID().slice(0, 8)}`;
  #memory: MemoryRunner | null = null;
  /** Compaction (#466): the post-turn marker producer collaborator. */
  #compaction: CompactionRunner | null = null;
  /**
   * ADR-0049 (door one, #986): the context windows providers declared in
   * their own overflow refusals this session, keyed by the model reference
   * that was refused. Rebuilt from the log at resume-open (`fromEvents`) —
   * the `declared_window` chrome event IS the store, so no second file and
   * no replay divergence.
   */
  #declaredWindows = new DeclaredWindows();
  /** #1101: task ids declared in this session (or its resumed log). */
  #declaredTasks = new Set<string>();
  /** Session handoff (#434): the raw post-turn artifact runner. */
  #handoff: HandoffRunner | null = null;
  /** A successful bash `git push` occurred in the active turn (#437). */
  #gitPushPending = false;
  /** ADR-0011: turn-scoped skill prompt — set by the send that carries
   * it, cleared when that turn settles. Null for every ordinary turn. */
  #skillPrompt: SkillPrompt | null = null;
  /** #616: turn-scoped MPM orientation plan — computed per send, cleared
   * when that turn settles. Null when MPM is off or the task is ineligible. */
  #mpmOrientation: MpmOrientation | null = null;
  /** #788: the per-turn eligibility gate an active classifier contributes. */
  #mpmTurnGate: (() => boolean | undefined) | undefined;
  /** #790/#826: the rerank hook an active bundled extension contributes. */
  #mpmRerank: MpmOrientationOptions["rerank"] | undefined;
  #mpmLifecycle: MpmLifecycle | null = null;
  #mpmPlan: string | null = null;
  /** #759: the task text of the active turn — the plan recomputes at every
   * prompt assembly (reasoning from call N can seed call N+1, including
   * mid-turn after a tool result). */
  #mpmTaskText: string | null = null;
  /** #759: identifiers source — reasoning text persisted by the previous
   * model call of the active turn; null when none or suppressed. */
  #mpmReasoningText: string | null = null;
  /** #759: successful exploratory tool calls this turn (orientation field
   * validation); the mpm_query suppression itself lives in the orientation
   * via noteModelQuery(). */
  #mpmExploratoryCalls = 0;
  /** #619: live projection service, held for the client-facing status and
   * diagnostics seams. Null when MPM is off or activation failed. */
  #mpmService: MpmService | null = null;
  #mpmRoot: string | null = null;
  #mpmQuota: import("../mpm/service").MpmQuota | undefined;
  #mpmExclude: string[] | undefined;

  constructor(config: SessionConfig) {
    this.#registry = config.registry?.freeze();
    this.#endpoints = config.endpoints ?? [];
    // #1032 (ADR-0049 door two): the endpoints' own declared windows —
    // one map, every window consumer funnels through it.
    this.#endpointDeclaredWindows = config.endpointDeclaredWindows ?? {};
    this.#images = config.images;
    this.#mohHome = config.mohHome ?? join(homedir(), ".moh");
    // Init-order note (#243): #mohHome must be assigned before
    // #routeResolutionOptions — its thinkingForTarget lambda resolves
    // endpoint preferences against <mohHome>/config on every target.
    this.#routeResolutionOptions = {
      // #948 + #1032: the fallback chain skips stops whose window cannot
      // hold the measured context — the same lookup the guard enforces.
      ...(Object.keys(this.#endpointDeclaredWindows).length > 0
        ? { endpointDeclaredWindows: this.#endpointDeclaredWindows }
        : {}),
      ...(config.thinking === undefined
        ? {
            thinkingForTarget: (target) =>
              resolveEndpointThinking(
                `${target.endpoint.name}/${target.modelId}`,
                this.#endpoints,
                join(this.#mohHome, "config"),
              ),
          }
        : {}),
    };
    this.#provider =
      typeof config.provider === "string"
        ? resolveProviderRef(
            config.provider,
            this.#registry ?? defaultRegistry.freeze(),
            this.#endpoints,
            this.#routeResolutionOptions,
          )
        : config.provider;
    const maxIterations = resolveMaxIterations(config.maxIterations);
    this.#tools = config.tools ?? {};
    this.#cwd = config.cwd ?? process.cwd();
    // #918: the `/mnt` fact is environment information, not a validation —
    // it can never fail the session, and every construction path
    // (`sessionFromConfig`, `createSession`) passes through here, so no
    // client can forget to ask for it.
    this.#rootOnWindowsMount = isOnWindowsMount(this.#cwd);
    const perms = config.permissions ?? {};
    // #849: the mode is the session's live source of truth — construction
    // seeds it from the config (or the launch flag), and `setSessionMode`
    // rotates it in-session. Never persisted: only the event log records it.
    this.#permissions = new PermissionResolver({
      defaults: DEFAULT_TOOL_PERMISSIONS,
      overrides: perms.overrides,
      runtimeRules: perms.runtimeRules,
      mode: perms.unrestrictedTools === true
        ? "yolo"
        : perms.mode === "auto-accept" ? "auto-accept" : "normal",
      cwd: this.#cwd,
    });
    this.#onAskUser = config.onAskUser;
    this.#onConfirmTurn = config.onConfirmTurn;
    this.#eventLog = new EventLog({ sink: config.sink, extensions: config.extensions });
    // Resume (#31): the persisted history seeds the log here, before anything
    // else can append. Registration of a bundled extension resolves on a
    // microtask — which Bun may run inside a synchronous child-process spawn
    // (ADR-0024) — so an `extension_loaded` landing before the history would
    // reorder the log and, on a legacy (identity-less) file, leave the
    // recorded history off the active path.
    this.#resumeProjection = config.resume?.events.length ? activePath(config.resume.events) : undefined;
    if (this.#resumeProjection) this.#eventLog.seed(this.#resumeProjection);
    this.#sessionFile = config.sessionFile;
    this.#externalGrowth = config.externalGrowth;
    const toolHookSource = config.extensions ?? config.toolHooks;
    const toolHookChecker: ToolHookChecker | undefined =
      typeof toolHookSource?.checkToolHooks === "function"
        ? {
            checkToolHooks: (call) => this.#scopedDispatch(() => toolHookSource.checkToolHooks(call)),
          }
        : undefined;
    this.#gate = new PermissionGate({
      permissions: this.#permissions,
      // #784 spec §5: a subagent child owns no runtime but still judges its
      // tool calls through the parent's (shared) hook checker. #944: the
      // dispatch is scoped, so the chrome it produces is the child's.
      extensions: toolHookChecker,
      onPermissionRequest: config.onPermissionRequest,
      cwd: this.#cwd,
      append: (event) => this.#append(event),
    });
    // ADR-0034: the post-tool inspection seam, resolved like the gate's
    // hook checker — a subagent child owns no runtime but shares the
    // parent's, so a fetched page is judged in the child exactly as in the
    // parent (#944: scoped, so the chrome it produces is the child's).
    // Absent runtime = no seam: every result proceeds untouched.
    const toolResultSource: Pick<ExtensionRuntime, "checkToolResultHooks"> | undefined =
      typeof toolHookSource?.checkToolResultHooks === "function"
        ? (toolHookSource as Pick<ExtensionRuntime, "checkToolResultHooks">)
        : undefined;
    const toolResultHooks: ToolResultHookChecker | undefined = toolResultSource
      ? {
          checkToolResultHooks: (call) => this.#scopedDispatch(() => toolResultSource.checkToolResultHooks(call)),
        }
      : undefined;
    this.#toolRunner = new ToolRunner({
      ...(toolResultHooks ? { toolResultHooks } : {}),
      tools: () => this.#allTools(),
      gate: this.#gate,
      parallel: () => this.#provider.capabilities?.parallelToolCalls !== false,
      cwd: this.#cwd,
      skillDirs: () => this.#skillDirs,
      filesystemScope: (): FilesystemScope => (this.#permissions.mode === "yolo" ? "unrestricted" : "project"),
      turn: this.#turn,
      ...(this.#onAskUser ? { onAskUser: this.#onAskUser } : {}),
      append: (event) => this.#append(event),
      emitLive: (event) => this.#eventLog.emitLive(event),
      ...(config.handoff?.onGitPush
        ? { onGitPush: () => { this.#gitPushPending = true; } }
        : {}),
      // #617: successful write/edit → targeted MPM refresh queue. Lazy on
      // purpose: the lifecycle is constructed later in this constructor.
      onFileMutation: (rel: string) => this.#mpmLifecycle?.noteEdit(rel),
      // #759: orientation field validation — count successful exploratory
      // tool calls per turn; metadata only, never a restriction.
      onToolObserved: (tool: string, ok: boolean) => {
        if (!ok) return;
        if (tool === "grep" || tool === "glob") this.#mpmExploratoryCalls += 1;
      },
      // #778: browser screenshots become typed image parts only when the
      // serving model declares image input — the exact #488 probe.
      imageCapable: () => this.#imagesSupported(),
    });
    // Subagents (#13): the spawn tool creates in-process child sessions.
    // Depth 1 by construction — children are created with `subagents: null`.
    // #339: registered by default — the built-in presets (research/implement)
    // need zero configuration; hiding spawn behind the mere existence of an
    // `agents` key made subagents undiscoverable. moh.json `agents` now only
    // overrides presets/provider/concurrency.
    const subagents = config.subagents ?? {};
    if (config.subagents !== null) {
      const host = new SubagentHost({
        cwd: this.#cwd,
        parentTools: () => this.#allTools(),
        onEvent: (event) => this.#append(event),
        permissions: config.permissions,
        runtimeRules: () => this.#permissions.rules,
        // #849: a child spawned after a rotation inherits the parent's live
        // mode — never more permissive than the session it came from.
        sessionMode: () => this.#permissions.mode,
        onPermissionRequest: config.onPermissionRequest,
        // ADR-0033 §4: a child's confirmed turn asks the same client.
        ...(config.onConfirmTurn ? { onConfirmTurn: config.onConfirmTurn } : {}),
        // ADR-0031/ADR-0032: children are in-process sessions created by the
        // host, never re-assembled from config — they share the parent's
        // extension runtime, so the guardrail judges child tool calls through
        // the same gate and statuses stay one per extension (#784 spec §5).
        ...(config.extensions ? { extensions: config.extensions } : {}),
        registry: config.registry,
        endpoints: this.#endpoints,
        defaultProvider: subagents.provider ?? (() => this.#provider),
        presets: subagents.presets,
        maxConcurrency: subagents.maxConcurrency,
        home: subagents.home,
        // #620: children get a bounded read-only orientation snapshot for
        // their task, computed by the parent's own orientation seam. The
        // parent keeps every mutation and scheduling right; the child
        // receives only the rendered plan text (or nothing). The closure
        // is evaluated per spawn — the orientation exists by then (MPM
        // activation happens later in this constructor than the host).
        ...(config.mpm
          ? { mpm: { snapshotFor: (task: string) => this.#mpmOrientation?.planFor(task) ?? null } }
          : {}),
        ...(subagents.lanes ? { lanes: subagents.lanes } : {}),
        // ADR-0055 (#1127): the spawn event's requester — the model, or the
        // orchestration extension currently in scope. Default: the model.
        requester: () => this.#spawnRequester(),
        // The applied limits record the cap the child actually gets.
        defaultMaxIterations: () => maxIterations,
        // ADR-0053 + ADR-0055 (#998): the envelope extension spawns live
        // in — ten children per extension per session (ADR-0053's fixed
        // cap), each within this session's own iteration ceiling.
        extensionEnvelope: { maxIterations },
      });
      this.#subagentHost = host;
      // ADR-0053/#998: a granted `spawn-subagent` capability executes
      // through this session's host; the runtime resolves it lazily.
      config.extensions?.attachSubagentHost?.(host);
      this.#tools = { ...this.#tools, spawn: host.spawnTool() };
    }
    this.#extensions = config.extensions;
    // #944: a session that owns no runtime but borrows one (`toolHooks`) is
    // a subagent child. Its dispatches run scoped: extension chrome belongs
    // to the child's log, and an extension's per-session state must not be
    // the parent's.
    const borrowedRuntime = config.extensions ? undefined : (config.toolHooks as ExtensionRuntime | undefined);
    this.#borrowedHooks = typeof borrowedRuntime?.withSession === "function" ? borrowedRuntime : undefined;
    // ADR-0037: the session is the runtime's turn entry — an extension's
    // `ctx.requestTurn` lands here, through the queue.
    if (this.#extensions) this.#extensions.bindRequestTurn((text) => this.runSyntheticTurn(text).then((r) => r.ok));
    this.#onDispose = config.onDispose;
    // Extension load results (including hot-reload outcomes) land in the log
    // — held until the session's own start chrome is in (#834). A load can
    // settle before this constructor runs (the client resolved its source
    // earlier) and further loads can settle *during* it: appending both
    // streams as they arrive would either break the log-format invariant
    // (`session_start` first) or scramble the two against each other. Held
    // in delivery order, the log keeps the extensions' load order — which is
    // the order their hooks decide in.
    this.#extensionsHeld = this.#extensions !== undefined;
    this.#heldExtensionEvents.push(...(this.#extensions?.consumeLoadEvents() ?? []));
    this.#extensions?.onLoadEvent((event) => {
      if (this.#extensionsHeld) this.#heldExtensionEvents.push(event);
      else this.#append(event);
    });
    // ADR-0032: an extension status is client chrome — it never enters the
    // log. A headless client (no consent seam: there is no one to prompt,
    // hence no TUI) gets one stderr line per new status text instead.
    this.#hasConsentSeam = config.onPermissionRequest !== undefined;
    this.#startupDiagnostics = config.diagnostics ?? [];
    this.#startupNotes = config.notes ?? [];
    this.#extensions?.onStatusChange((extension, text) => this.#onExtensionStatus(extension, text));
    this.#promptComposer = config.promptComposer ?? new PromptComposer({ projectDir: this.#cwd });
    // #616: MPM orientation — opt-in via SessionConfig.mpm (a root the
    // projection maps). The service is supplied or constructed+loaded here;
    // failures degrade to no plans, never a session error.
    if (config.mpm) {
      try {
        const service = config.mpm.service ?? new MpmService(projectMapDir(this.#mohHome, this.#cwd));
        service.load();
        // #620: after a project identity migration the map may have been
        // relocated with the project data; revalidate it against the
        // active root before use — records whose file is absent at this
        // root are dropped (never trusted across a relocation). One-time,
        // metadata-only, non-blocking.
        if (service.fileCount > 0) service.revalidate(config.mpm.root ?? this.#cwd);
        this.#mpmService = service;
        this.#mpmRoot = config.mpm.root ?? this.#cwd;
        this.#mpmQuota = config.mpm.quota;
        this.#mpmExclude = config.mpm.exclude;
        this.#mpmOrientation = new MpmOrientation({
          service,
          root: config.mpm.root ?? this.#cwd,
          // #790: the rerank hook, when the assembly wired one (an active
          // bundled extension with the opt-in on). Absent = today's
          // discard branch, unchanged.
          ...(config.mpm.rerank ? { rerank: config.mpm.rerank } : {}),
        });
        // #788: the classifier's per-turn opinion, when one is wired.
        this.#mpmTurnGate = config.mpm.turnGate;
        // #790: the rerank hook, when one is wired (the send-time async
        // path reads this flag).
        this.#mpmRerank = config.mpm.rerank;
        // #663 (ADR-0028): the read-only `mpm_query` tool rides the same
        // opt-in — the model can nominate seeds itself when the task text
        // names no mapped path. Executed by this session's tool runner;
        // subagents get it through the ordinary child-tool subset (#620:
        // the service never leaves this session).
        this.#tools = { ...this.#tools, mpm_query: mpmQueryTool({ service, root: this.#mpmRoot!, orientation: this.#mpmOrientation! }) };
        // #617: background lifecycle — debounced external-change refresh,
        // turn priority, adaptive budgets. Only when a projection exists.
        this.#mpmLifecycle = new MpmLifecycle({
          service,
          root: config.mpm.root ?? this.#cwd,
          isBusy: () => this.#queue.pending(),
          quota: config.mpm.quota,
          exclude: config.mpm.exclude,
          ...config.mpm.lifecycle,
        });
      } catch {
        this.#mpmOrientation = null;
      }
    }
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
    // Compaction (#466): on by default when the option is present
    // (from-config passes it unconditionally); `enabled: false` turns it off.
    const comp = config.compaction;
    // #766 (ADR-0051): which summarizer actually served — read back by
    // the runner at marker time so a mid-run fallback is stamped.
    const strategyBox = { name: "llm" };
    if (comp && (comp.enabled ?? true)) {
      this.#compaction = new CompactionRunner({
        sessionId: this.#sessionId,
        provider: () => this.#provider,
        // One resolver set for the reference that SERVES the calls
        // (ADR-0049: one value, one owner; ADR-0050 §7: the window belongs
        // to the serving model, so its identity is the serving one) — the
        // lookup every window consumer shares.
        endpointType: () => this.#endpointTypeFor(this.servingModel),
        // ADR-0049: the one window lookup the guard and the chain read —
        // a provider-declared window outranks the catalog row here too.
        declaredWindows: () => this.#declaredWindows,
        // Door two (#1032): the endpoint identity + its own listing
        // windows, resolved by endpoint instead of provider kind.
        endpoint: () => {
          const ref = this.servingModel;
          const slash = ref.indexOf("/");
          if (slash > 0) {
            const endpoint = this.#windowEndpoint(ref.slice(0, slash));
            if (endpoint) return endpoint;
          }
          // #949 test/dev convenience: a bare provider named
          // "<endpointType>/<model>" resolves its window from the
          // catalog — an unknown window otherwise.
          if (!ref.includes("/")) return undefined;
          const [type, ...rest] = ref.split("/");
          return catalogEntryFor(type, rest.join("/")) !== undefined ? { type } : undefined;
        },
        append: (event) => this.#append(event),
        // #578 (d3/d7): cover the path pinned to the turn's head — the
        // branch actually summarized — so a mid-turn switch (effective
        // next turn) or a concurrent head move never puts a marker on a
        // path it does not describe. No pin (between turns): the live
        // log's active path.
        pathFn: () => {
          const live = this.#eventLog.live();
          const pin = this.#turnHead ?? (this.#diverged ? this.#localTip : undefined);
          return pin !== undefined ? (pathTo(live, pin) ?? activePath(live)) : activePath(live);
        },
        onCompacted: () => this.#rebuildAfterCompaction(),
        // #766 (ADR-0051): "deterministic" selects the digest summarizer
        // with the LLM summarizer as the explicit over-budget fallback;
        // the strategy box feeds the marker's `summarizer` audit stamp.
        summarizer: comp.summarizer ?? (comp.summarizerStrategy === "deterministic"
          ? createDeterministicSummarizer(createCompactionSummarizer(this.#provider, this.#cwd), strategyBox)
          : createCompactionSummarizer(this.#provider, this.#cwd)),
        ...(comp.summarizerStrategy === "deterministic" && !comp.summarizer
          ? { summarizerName: () => strategyBox.name }
          : {}),
        // ADR-0035: the section-filter dispatch, when a runtime exists.
        // `moh compact` on a closed file has no runtime here: it compacts
        // exactly as before (the filter is an optimization, not a gate).
        ...(this.#extensions
          ? {
              sectionFilter: (ctx: CompactionHookContext) => this.#extensions!.dispatchCompaction(ctx),
            }
          : {}),
        ...(comp.tailTurns !== undefined ? { tailTurns: comp.tailTurns } : {}),
        ...(comp.threshold !== undefined ? { threshold: comp.threshold } : {}),
        ...(comp.fallbackWindowTokens !== undefined ? { fallbackWindowTokens: comp.fallbackWindowTokens } : {}),
      });
    }
    // Session handoff (#434): the raw artifact is maintained whenever the
    // option is present (from-config passes it unconditionally — purely
    // additive, zero behavioral change when transport is Not Set).
    if (config.handoff) {
      this.#handoff = new HandoffRunner({
        file: config.handoff.file ?? HandoffRunner.artifactFile(this.#cwd, this.#mohHome),
        sessionId: this.#sessionId,
        cwd: this.#cwd,
        supersedes: config.handoff.supersedes,
      });
    }
    if (config.mcp) {
      // Startup validation: duplicate server names are a hard config error.
      McpRuntime.validate(config.mcp.servers);
      this.#mcp = new McpRuntime({
        ...config.mcp,
        cwd: this.#cwd,
        onEvent: (event) => this.#append(event),
        onTrust: config.mcp.onTrust ?? ((server) => persistProjectMcpTrust(join(this.#mohHome, "config"), this.#cwd, server)),
        // Trusted servers (user scope or persisted "always") never ask again.
        onTrustedTools: (toolNames) => {
          for (const tool of toolNames) this.#permissions.addRuntimeRule({ tool, effect: "allow" });
        },
      });
    }
    // ADR-0033/#787: the runtime whose `beforeTurn` hooks run for this
    // session's turns. A child session owns no runtime, but shares the
    // parent's for the turn-start decision point (its switch then lands in
    // the child's own log, because the seam below is *this* session's
    // switchModel).
    const borrowedBeforeTurn: Pick<ExtensionRuntime, "dispatchBeforeTurn" | "dispatchModelError"> | undefined =
      typeof config.toolHooks?.dispatchBeforeTurn === "function" ? config.toolHooks as Pick<ExtensionRuntime, "dispatchBeforeTurn" | "dispatchModelError"> : undefined;
    const beforeTurnSeam = this.#extensions ?? borrowedBeforeTurn;
    const dispatchBeforeTurn = beforeTurnSeam
      ? (ctx: Parameters<ExtensionRuntime["dispatchBeforeTurn"]>[0]) =>
          this.#scopedDispatch(() =>
            beforeTurnSeam.dispatchBeforeTurn({
              ...ctx,
              // #944: the hook knows which session it is judging for. Constant
              // per session instance — children never inherit the parent's.
              session: { id: this.#sessionId, owner: this.#extensions !== undefined },
            }),
          )
      : undefined;
    this.#loop = new AgentLoop({
      provider: () => this.#provider,
      maxIterations,
      tools: () => this.#allTools(),
      toolRunner: this.#toolRunner,
      ...(this.#extensions
        ? { extensions: this.#extensions }
        : // ADR-0054 (#1129): a child with no runtime borrows the
          // beforeModelCall dispatch from its parent (scoped, so the
          // chrome — refusals and `prompt_override` — lands in the
          // child's log, #944). The borrowed surface widens per ADR-0054.
          typeof config.toolHooks?.dispatchBeforeModelCall === "function"
          ? {
              extensions: {
                dispatchBeforeModelCall: (ctx: Parameters<ExtensionRuntime["dispatchBeforeModelCall"]>[0]) =>
                  this.#scopedDispatch(() =>
                    (config.toolHooks as Pick<ExtensionRuntime, "dispatchBeforeModelCall">).dispatchBeforeModelCall(ctx),
                  ),
              },
            }
          : {}),
      ...(dispatchBeforeTurn
        ? {
            beforeTurn: {
              dispatch: (text, turnIndex, model) =>
                dispatchBeforeTurn({ text, turnIndex, model, endpointCooldowns: this.endpointCooldowns }),
              applyModel: (ref) => this.switchModel(ref),
              // ADR-0033 §4: the client answers a confirmation. No seam =
              // headless: the loop refuses the turn itself ("silence by
              // default"), it never sends what it could not ask about.
              ...(this.#onConfirmTurn
                ? {
                    confirm: async (request: Parameters<NonNullable<SessionConfig["onConfirmTurn"]>>[0]) =>
                      this.#onConfirmTurn!(request),
                  }
                : {}),
            },
          }
        : {}),
      // ADR-0059: the retry-on-model-error seam — same registry and fit
      // guards as the manual switch, applied mid-turn only to recover a
      // call that failed with a non-Route error.
      ...(beforeTurnSeam
        ? {
            modelRetry: {
              dispatch: (ctx: { model: string; errorKind: string; message: string }) =>
                this.#scopedDispatch(() =>
                  beforeTurnSeam.dispatchModelError({
                    ...ctx,
                    // #1110: the same #852 cooldown list the per-turn
                    // switch reads — a proposed alternative must not name
                    // a stop the route already knows cannot serve.
                    endpointCooldowns: this.endpointCooldowns,
                    session: { id: this.#sessionId, owner: this.#extensions !== undefined },
                  }),
                ),
              applyModel: (ref: string) => this.switchModel(ref),
            },
          }
        : {}),
      turnIndex: () => this.#turnSeq,
      ...(this.#mcp ? { mcp: this.#mcp } : {}),
      messages: this.#messages,
      assemblePrompt: () => this.#assemblePrompt(),
      lastPrompt: () => this.#lastPrompt,
      // ADR-0054 (#1129): the ADR-0011 skill prompt holds the skills
      // section while it is in force — a replacement for it is refused.
      skillsProtected: () => this.#skillPrompt !== null,
      append: (event) => this.#append(event),
      // #488: mention expansion — `@path` tokens in user messages become
      // structured attachments at turn start, gated by the read-permission
      // resolver (`@` is UX sugar, never a bypass).
      mentions: {
        cwd: this.#cwd,
        canRead: (absPath: string) => this.#permissions.resolve("read", { path: absPath }) === "allow",
        // Vision note 4: per-turn probe of the *serving* model — the
        // catalog's declared input modalities (never inferred), with an
        // explicit `capabilities.multimodal: false` endpoint override.
        // A config `images.imageCapable` pin wins (tests/custom providers).
        imageCapable: () => this.#imagesSupported(),
      },
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
      // ADR-0049 (door one, #986): a refusal is the only teacher. The
      // session owns what a refusal means — learn the declared window, or
      // leave a trace when no shipped formula read it.
      onContextRefusal: (ref, err) => this.#noteContextRefusal(ref, err),
      // Post-turn triggers: memory extraction (#38, every N turns) and the
      // raw handoff artifact (#434, every settled turn — synchronous and
      // fail-silent, so a killed session keeps the last turn's state).
      onTurnSettled: (result) => {
        this.#maybeExtractMemory(result);
        // #466: fire-and-forget auto compaction (fail-silent, never blocks).
        this.#compaction?.maybeCompact(result, this.#eventLog.live(), this.#disposed);
        if (this.#handoff && result.status === "done") {
          this.#handoff.turnSettled(this.#turnSeq, this.#eventLog.live());
        }
      },
    });
    this.#queue = new TurnQueue({
      execute: (text, controller) => {
        this.#turnSeq += 1;
        return this.#loop.run(text, controller);
      },
      // ADR-0037: synthetic turns run through the same queue; the loop
      // entry skips beforeTurn and marks the user_message.
      executeSynthetic: (text, controller) => {
        this.#turnSeq += 1;
        return this.#loop.runSynthetic(text, controller);
      },
      // ADR-0037: the extension `afterTurn` dispatch runs from the queue's
      // settle path, after the slot is freed — an `afterTurn` hook may
      // `await ctx.requestTurn` without deadlocking the turn it observed.
      ...(this.#extensions
        ? {
            dispatchAfterTurn: (result: TurnResult, synthetic: boolean) =>
              this.#extensions!.dispatchAfterTurn(result, synthetic),
            append: (event: unknown) => this.#append(event as AgentEvent),
          }
        : {}),
      onTurnSettled: () => {
        if (this.#gitPushPending) {
          this.#gitPushPending = false;
          // AgentLoop has settled and written the raw artifact before the
          // queue resolves the turn. Client I/O stays fire-and-forget.
          queueMicrotask(() => {
            try { config.handoff?.onGitPush?.(); } catch { /* best-effort client seam */ }
          });
        }
        // ADR-0011: a turn-scoped skill prompt lives exactly one turn.
        // #616: so does the MPM orientation plan. One reassemble covers both.
        if (this.#skillPrompt || this.#mpmPlan || this.#mpmTaskText) {
          this.#skillPrompt = null;
          this.#mpmPlan = null;
          this.#mpmTaskText = null;
          // #759: #mpmReasoningText survives the turn — the last persisted
          // reasoning seeds the next send's plan.
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
      // #577 (core spec d1/d2): the resumed file may hold abandoned
      // branches — the session seeds and replays the active-path
      // projection only (root→head), never the raw array. Switching
      // branches is how the model sees a different past; whole-tree
      // context does not exist. The projection is the single pass that
      // linearizes once; everything downstream keeps its index logic.
      // Resume (#31): the log continues in a new AgentSession over the same
      // persisted history, seeded above. Seeded events are never re-appended
      // (the file already has them); only new events reach the sink.
      const resumeEvents = this.#resumeProjection!;
      this.#messages.splice(0, 0, ...replayMessages(resumeEvents));
      // ADR-0049 (door one): the refusals in the log are the session's
      // declared windows — reopening re-derives the very same numbers, so
      // compaction and the fit guard compute here what they computed then.
      this.#declaredWindows = DeclaredWindows.fromEvents(resumeEvents);
      // #1101: a resumed session keeps accepting verifications and
      // outcomes for the tasks its log declared.
      for (const event of resumeEvents) {
        if (event.type === "task_declared") this.#declaredTasks.add(event.taskId);
      }
      // #578 (d6): a compaction pointer that does not resolve on the
      // active path (corruption, truncation) restarts context from the
      // path start — surfaced as visible warning chrome, never silent.
      if (replayWarnings(resumeEvents).length > 0) {
        this.#append({ type: "compaction_dangling" });
      }
      // ADR-0021: resume leaves a trace — one chrome event at resume-open,
      // before any turn. The sole consumption marker for the pertinent-
      // session suggestion; both TUI and `moh run --resume` ride this seam.
      // ADR-0022: `moh compact` opens with consume: false — compacting
      // never consumes.
      if (config.resume.consume !== false) this.#append({ type: "session_resumed" });
      // #576 (head semantics d10): a dangling switch target (truncation,
      // corruption) falls back to the last valid event — the fallback is
      // surfaced as visible warning chrome, never silent.
      const resumeHead = resolveHead(config.resume.events);
      if (resumeHead.dangling !== undefined) {
        this.#append({ type: "branch_dangling", to: resumeHead.dangling });
      }
      const restoredRules = runtimeRulesFromEvents(config.resume.events);
      for (const rule of restoredRules) this.#permissions.addRuntimeRule(rule);
      if (restoredRules.length > 0) {
        this.#append({ type: "permission_rules_restored", rules: restoredRules.map(formatRule) });
      }
      this.#flushExtensionEvents();
      // Extensions missing on resume: a previously enabled extension that
      // the current runtime did not load produces a warning, nothing more.
      // #834: loads from the client's source are asynchronous (import +
      // consent), so the reconciliation waits for them — reporting an
      // extension missing before its load settled would be a lie.
      if (this.#extensions) {
        const enabled = new Set(
          config.resume.events
            .filter((e) => e.type === "extension_loaded")
            .map((e) => (e as { name: string }).name),
        );
        void this.#extensions.ready().then(() => {
          this.#reportMissingExtensions(enabled);
          // #834: loaded files are watched for hot-reload (state preserved);
          // a failed reload keeps the previous instance and is visible.
          this.#extensions?.startWatch();
        });
      }
      this.#assemblePrompt();
      // A mode change across resume is auditable like any startup flag.
      const lastMode = [...config.resume.events].reverse().find((e) => e.type === "session_mode");
      if (!lastMode || lastMode.mode !== this.#permissions.mode) this.#append({ type: "session_mode", mode: this.#permissions.mode });
      this.#appendStartupChrome(false);
      return;
    }
    this.#assemblePrompt();
    this.#append({ type: "session_start", schemaVersion: SCHEMA_VERSION, promptVersion: this.#promptVersion });
    this.#append({ type: "session_mode", mode: this.#permissions.mode });
    this.#declareInheritedRoute();
    this.#appendStartupChrome(true);
    this.#flushExtensionEvents();
    // Fire-and-forget: construction is sync, the session is not yet running.
    // The bundled-definition registration settles first (ADR-0032/ADR-0005):
    // `session_start` must never reach an extension whose setup is pending.
    void this.#extensions?.ready().then(() => {
      // #834: loaded files are watched for hot-reload (state preserved); a
      // failed reload keeps the previous instance and is visible.
      this.#extensions?.startWatch();
      return this.#extensions?.dispatchSessionStart();
    }).then((errors) => {
      for (const e of errors ?? []) this.#append(e);
    });
  }

  /**
   * ADR-0050 (§6): a session may be born serving a stop other than its
   * selection — a subagent child inherits the parent's fallback. Its own log
   * declares that state once, at open, with the existing `route_serving`
   * chrome (`previous` = the selection), so the child's log reads on its
   * own without the parent's. It reports how the session was born, not a
   * change the user watched happen: the subagent chip and the live panel
   * already show the child, so no client raises a fallback notice for it
   * (and a child's events never reach a client watching the parent).
   */
  #declareInheritedRoute(): void {
    const selected = this.selectedModel;
    const serving = this.servingModel;
    if (serving === selected) return;
    this.#append({ type: "route_serving", selected, serving, previous: selected });
  }

  /**
   * #834: a resumed file may list extensions enabled in an earlier
   * environment; one the current runtime did not load is a warning, never
   * an error (the session continues without it).
   */
  #reportMissingExtensions(enabled: ReadonlySet<string>): void {
    if (!this.#extensions || enabled.size === 0) return;
    const present = new Set(this.#extensions.instances.map((i) => i.def.name));
    for (const name of enabled) {
      if (present.has(name)) continue;
      this.#append({
        type: "extension_failed",
        name,
        reason: "missing_on_resume",
        message: "extension enabled in the resumed session was not loaded; continuing without it",
      });
    }
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

  /**
   * Visible startup chrome: the browser toolchain diagnostic (#774) and the
   * informational session notes (a bundled integration that stayed
   * inactive). Both are *chrome*, so they are appended after the session's
   * own start events — a session file must still begin with `session_start`
   * (the store's log-format invariant).
   *
   * `withNotes` is false on resume: a resumed file already carries the
   * informational lines of its first open, and repeating them on every
   * resume is noise. The browser diagnostic keeps its #774 semantics — the
   * toolchain may well be missing in the environment a session is resumed
   * in.
   */
  #appendStartupChrome(withNotes: boolean): void {
    for (const message of this.#startupDiagnostics) {
      this.#append({ type: "browser_unavailable", reason: message });
    }
    if (!withNotes) return;
    // #1100: the endpoints' user-owned commercial declarations, recorded
    // once per session open (resume skips — the log already carries them).
    // An invalid declaration (a `validUntil` before `validFrom`) is one
    // visible note, never a session error.
    for (const profile of this.#endpoints) {
      if (!profile.commercial) continue;
      const outcome = commercialDeclarationEvent(profile.name, profile.commercial);
      if ("event" in outcome) this.#append(outcome.event);
      else this.#append({ type: "session_note", text: outcome.error });
    }
    for (const note of this.#startupNotes) {
      this.#append({ type: "session_note", text: note });
    }
  }

  /** Drains the held extension load events (failed loads = warnings) into the
   * log, in delivery order. Called once the startup chrome is in. */
  #flushExtensionEvents(): void {
    if (!this.#extensionsHeld) return;
    this.#extensionsHeld = false;
    this.#heldExtensionEvents.push(...(this.#extensions?.consumeLoadEvents() ?? []));
    for (const event of this.#heldExtensionEvents.splice(0)) this.#append(event);
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

  /**
   * ADR-0055 (#1127): the live children this session spawned, each with its
   * spawn requester/limits — the list the stop control shows before acting.
   */
  liveSubagents(): { callId: string; name: string; requester: SubagentSpawnRequester; limits: SubagentSpawnLimits }[] {
    return this.#subagentHost?.liveSubagents() ?? [];
  }

  /**
   * ADR-0055 "one stop": stop everything this session's orchestrations
   * started — aborts every live child, records one `orchestration_stopped`
   * chrome event with the aborted callIds, and returns them. Children that
   * already settled contribute nothing; the extension itself stays enabled.
   */
  stopSubagents(): string[] {
    const stopped = this.#subagentHost?.stop() ?? [];
    if (stopped.length > 0) {
      this.#append({ type: "orchestration_stopped", callIds: stopped, stoppedAt: new Date().toISOString() });
    }
    return stopped;
  }

  /** ADR-0055 (#1127): set who the next spawns are attributed to — the
   * model (default) or a named orchestration extension. */
  setSpawnRequester(requester: () => SubagentSpawnRequester): void {
    this.#spawnRequester = requester;
  }

  /** Registry snapshot this session was created with (frozen). */
  get registry(): FrozenProviderRegistry | undefined {
    return this.#registry;
  }

  /** The user-selected model ref (`endpoint/model-id`, or a provider name). #166/#363.
   * ADR-0050: the standing choice — it stays stable while a fallback serves. */
  get activeModel(): string {
    return this.#provider.name;
  }

  /** #363: selected route stays user-owned while a fallback may serve calls. */
  get selectedModel(): string {
    return selectedModelOf(this.#provider);
  }

  /** #363: latest successful route used for later model calls — the model
   * in use (ADR-0050): what behaviour depending on the serving model reads. */
  get servingModel(): string {
    return servingModelOf(this.#provider);
  }

  /**
   * #488/#778 (ADR-0050 §7): whether an image may become a typed image
   * part — resolved against the model that SERVES this session's calls, so
   * a fallback onto a model without image input downgrades the attachment
   * (visible warning, chip text) instead of sending a request the serving
   * model rejects. The catalog's declared input modalities are the truth
   * (never inferred), with an explicit `capabilities.multimodal: false`
   * endpoint override; a config `images.imageCapable` pin wins outright
   * (tests/custom providers). One definition for both probes: the browser
   * screenshot seam (#778) and the `@path` mention seam (#488).
   */
  #imagesSupported(): boolean {
    const pin = this.#images?.imageCapable;
    if (typeof pin === "boolean") return pin;
    if (typeof pin === "function") return pin();
    const ref = this.servingModel;
    const slash = ref.indexOf("/");
    const [endpointName, modelId] = slash === -1 ? [ref, ""] : [ref.slice(0, slash), ref.slice(slash + 1)];
    const profile = this.#endpoints.find((e) => e.name === endpointName);
    if (profile?.capabilities?.multimodal === false) return false;
    return modelSupportsImages(catalogEntryFor(profile?.type ?? "", modelId), profile?.capabilities);
  }

  /**
   * #852: endpoint health at decision time — the active route's chain
   * stops that are in a failure cooldown (quota exhausted, rate limit,
   * empty completion, ...). Read by the model router so a switch never
   * names a target the session already knows cannot serve it. Empty for
   * a non-route provider (a pre-built instance, a bare registered id).
   */
  get endpointCooldowns(): readonly { ref: string; kind: string }[] {
    const route = this.#provider as Partial<import("../route").Route>;
    return typeof route.health === "function"
      ? route.health().map(({ ref, kind }) => ({ ref, kind }))
      : [];
  }

  /**
   * #1100: records one quota probe as `quota_observation` events — the
   * recording half of the #499 seam (`getQuota` produces the report, this
   * persists it). `endpointName` must be one of the session's endpoint
   * profiles; the endpoint identity is built through the #1099 sanitizer,
   * so no key or query string can enter. Unknown endpoint: a visible note,
   * never an error. The probe's `authority` badge rides along.
   */
  recordQuota(
    endpointName: string,
    report: import("../quota/types").QuotaReport,
    options: { model?: string; scope?: "account" | "workspace" | "endpoint" | "provider" | "model" | "pool"; pool?: string; unit?: "tokens" | "requests" | "credits" | "usd" | "provider-defined" } = {},
  ): void {
    const profile = this.#endpoints.find((e) => e.name === endpointName);
    if (!profile) {
      this.#append({ type: "session_note", text: `quota observation refused: unknown endpoint "${endpointName}"` });
      return;
    }
    const endpoint = endpointIdentity(profile.type, profile.baseUrl);
    for (const observation of observationsFromQuotaReport(report, {
      endpoint,
      endpointName: profile.name,
      ...(options.model ? { model: options.model } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.unit ? { unit: options.unit } : {}),
    })) {
      this.#append(observation);
    }
  }

  /**
   * #1101: declares a task/work unit — the recording seam for explicit
   * task-outcome telemetry. `taskId` is user-declared; without one a
   * generated correlation id (no content) is used. `reopens` links a
   * revision to the original task's id (which need not exist in this
   * session's log — cross-session reopen chains are a projection's job).
   * A blank explicit id is refused with a visible note, never invented
   * around. Returns the recorded task id.
   */
  declareTask(taskId?: string, options: { reopens?: string } = {}): string {
    const id = taskId !== undefined ? normalizeTaskId(taskId) : newUlid();
    if (!id) {
      this.#append({ type: "session_note", text: "task declaration refused: the task id was empty" });
      return "";
    }
    const reopens = options.reopens !== undefined ? normalizeTaskId(options.reopens) : undefined;
    if (options.reopens !== undefined && !reopens) {
      this.#append({ type: "session_note", text: "task declaration refused: the reopens id was empty" });
      return "";
    }
    this.#append(taskDeclaredEvent({ taskId: id, ...(reopens ? { reopens } : {}) }));
    this.#declaredTasks.add(id);
    return id;
  }

  /**
   * #1101: records one verification run (test/typecheck/build/lint or
   * equivalent) against a declared task. Explicit, never inferred; the
   * summary is redacted and bounded at the seam. A verification for an
   * undeclared task is refused with a visible note — an outcome must
   * always have a declared task to correlate to.
   */
  recordVerification(
    taskId: string,
    verification: {
      category: import("../task/telemetry").VerificationCategory;
      ok: boolean;
      exitStatus?: number;
      durationMs?: number;
      summary?: string;
    },
  ): void {
    const id = normalizeTaskId(taskId);
    if (!id || !this.#declaredTasks.has(id)) {
      this.#append({ type: "session_note", text: `verification refused: task "${taskId}" was never declared in this session` });
      return;
    }
    this.#append(taskVerificationEvent({ taskId: id, verificationId: newUlid(), ...verification }));
  }

  /**
   * #1101: records the explicit user verdict on a declared task. Only
   * this seam creates an outcome — absence stays `unknown` in every
   * projection. An outcome for an undeclared task is refused with a
   * visible note.
   */
  recordTaskOutcome(taskId: string, outcome: import("../task/telemetry").TaskOutcome): void {
    const id = normalizeTaskId(taskId);
    if (!id || !this.#declaredTasks.has(id)) {
      this.#append({ type: "session_note", text: `task outcome refused: task "${taskId}" was never declared in this session` });
      return;
    }
    this.#append(taskOutcomeEvent({ taskId: id, outcome }));
  }

  /** #1101: task ids declared in this session — replayed from the log on
   * construction, so a resumed session keeps accepting verifications and
   * outcomes for tasks its log declared. */
  get declaredTasks(): readonly string[] {
    return [...this.#declaredTasks];
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

  /**
   * #1032 (ADR-0049 door two): the endpoint a window is resolved for —
   * kind, baseUrl and the endpoint's own declared windows. One shape,
   * every window consumer funnels through it. Undefined for a bare
   * registered provider kind with no profile.
   */
  #windowEndpoint(endpointName: string): import("../compaction").WindowEndpoint | undefined {
    const profile = this.#endpoints.find((e) => e.name === endpointName);
    if (profile) {
      return {
        type: profile.type,
        baseUrl: profile.baseUrl,
        declaredWindows: this.#endpointDeclaredWindows[endpointName],
      };
    }
    if (this.#registry?.has(endpointName)) {
      return { type: endpointName, declaredWindows: this.#endpointDeclaredWindows[endpointName] };
    }
    return undefined;
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
   *
   * #948 context-fit guard: a target whose catalog window cannot hold
   * the session's measured context (`contextFit(ref)`) is refused for
   * every caller — one guard, one answer. The refusal is loud: an
   * `{ ok: false, reason: "context_length" }` result plus exactly one
   * `switch_refused` chrome event naming the target and the numbers;
   * nothing is applied, no `model_switched` is appended. Unknown window
   * and no measurement abstain (the switch proceeds).
   */
  switchModel(ref: string): { ok: true; model: string } | { ok: false; error: string; reason?: "context_length" } {
    const trimmed = ref.trim();
    if (!trimmed) return { ok: false, error: "empty model reference" };
    // Resolve first (an unresolvable ref stays an unresolvable-ref
    // error, not a fit refusal — the extension skip channel already
    // names that case)…
    let next: Provider;
    try {
      next = resolveProviderRef(
        trimmed,
        this.#registry ?? defaultRegistry.freeze(),
        this.#endpoints,
        // #948: the rebuilt chain (a switch replaces the active provider
        // wholesale) skips stops that cannot hold the measured context —
        // the same verdict the guard below enforces.
        {
          ...this.#routeResolutionOptions,
          measuredTokens: this.lastMeasuredTokens(),
          // ADR-0049: the rebuilt chain judges a stop on the declared
          // window it learned (door one) or on the endpoint's own listing
          // (door two), never on the row those corrected.
          declaredWindows: this.#declaredWindows,
          endpointDeclaredWindows: this.#endpointDeclaredWindows,
        },
      );
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const from = this.#provider.name;
    if (next.name === from) return { ok: true, model: from }; // no-op: same ref, no chrome
    // …then the fit wall (#948): universal, and never silent. The context
    // that must fit is the one measured *before* the switch (a switch
    // applies from the next turn), which is exactly what the last
    // measured call carries at decision time.
    const fit = this.contextFit(next.name);
    if (!fit.fits) {
      this.#append({
        type: "switch_refused",
        from,
        to: next.name,
        reason: "context_length",
        measured: fit.measured!,
        window: fit.window,
      });
      return {
        ok: false,
        reason: "context_length",
        error: `cannot switch to ${next.name}: its context window (${fit.window} tokens) is too small for this session's measured context (${fit.measured} tokens) — /compact or pick a model with a larger window`,
      };
    }
    this.#provider = next;
    this.#append({ type: "model_switched", from, to: next.name });
    return { ok: true, model: next.name };
  }

  /**
   * #948: the preventive context-fit check for one target ref — the same
   * predicate the switch guard enforces, exported so a client that can
   * ask first does (`/model` offers auto-compact or a better-fitting
   * model before the wall stands). Unresolvable refs read as fitting:
   * they fail later with their own error.
   */
  contextFit(ref: string): import("../context-fit").ContextFitVerdict {
    const trimmed = ref.trim();
    const slash = trimmed.indexOf("/");
    const name = slash > 0 ? trimmed.slice(0, slash) : trimmed;
    const modelId = slash > 0 ? trimmed.slice(slash + 1) : undefined;
    const profile = this.#endpoints.find((e) => e.name === name);
    const model = modelId ?? profile?.defaultModel;
    // ADR-0049: the client's pre-switch check reads the very lookup the
    // guard enforces — a declared window included (both doors), so the
    // settings/picker path can never disagree with the switch.
    const window = name && model
      ? contextWindowFor(`${name}/${model}`, this.#windowEndpoint(name), this.#declaredWindows)
      : 0;
    return contextFitFor({ measured: this.lastMeasuredTokens(), window });
  }

  /**
   * ADR-0049 (door one, #986): the context window a provider declared in
   * its own overflow refusal for one model reference, for this session —
   * undefined when that reference declared none. Read-only: clients show
   * the declared number next to the catalog one wherever a window is
   * displayed, and the fit guard folds it into the same lookup.
   */
  declaredWindowFor(ref: string): number | undefined {
    return this.#declaredWindows.declaredWindowFor(ref);
  }

  /**
   * ADR-0049 (door one): what a real refusal means. The provider declared
   * a window moh recognizes → the declared number becomes the effective
   * window for that reference, recorded once per correction as a
   * `declared_window` chrome event (the log is the session: resume
   * re-derives it). Nothing recognized → one line in the user's dotdir
   * trace, so the next formula can be discovered from real wordings.
   */
  #noteContextRefusal(ref: string, err: unknown): void {
    const declared = declaredWindowOf(err);
    const endpointType = this.#endpointTypeFor(ref);
    if (declared === undefined) {
      noteUnrecognizedContextRefusal({
        home: this.#mohHome,
        ...(endpointType ? { endpoint: endpointType } : {}),
        model: ref,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const slash = ref.indexOf("/");
    const catalog = contextWindowFor(ref, slash > 0 ? this.#windowEndpoint(ref.slice(0, slash)) : undefined);
    const effective = this.#declaredWindows.declaredWindowFor(ref) ?? catalog;
    // The log records corrections, not confirmations: a number moh is
    // already using changes nothing (a re-refusal of the same provider
    // repeats with every turn once the session is over its limit).
    if (effective === declared) return;
    this.#declaredWindows.learn(ref, declared);
    this.#append({ type: "declared_window", model: ref, window: declared, catalog });
  }

  /** Endpoint type for a model reference (`endpoint/model-id`), the
   * catalog lookup key: a configured endpoint's type, else a registered
   * provider id, else — #949 test/dev convenience — a bare provider named
   * "<endpointType>/<model>" whose first segment is a catalog kind (its
   * window then resolves from that catalog). */
  #endpointTypeFor(ref: string): string | undefined {
    const slash = ref.indexOf("/");
    if (slash <= 0) return undefined;
    const name = ref.slice(0, slash);
    const profiled = this.#endpoints.find((e) => e.name === name)?.type;
    if (profiled !== undefined) return profiled;
    if (this.#registry?.has(name)) return name;
    const rest = ref.slice(slash + 1);
    return name && catalogEntryFor(name, rest) !== undefined ? name : undefined;
  }

  /** #948: the session's last measured model-call input tokens (the
   * `#947` rule — a failed call's `{0,0}` is not a measurement), or
   * undefined when the log holds none. The switch guard's decision-time
   * fact: a switch applies from the next turn, so this is the context
   * the target must hold. */
  lastMeasuredTokens(): number | undefined {
    return CompactionRunner.lastMeasuredCall(this.#eventLog.history())?.inputTokens;
  }

  /** Tools registered on this session, including connected MCP tools. */
  get tools(): Record<string, Tool> {
    return this.#allTools();
  }

  /** Path of the JSONL session file this session appends to (via the
   * configured store sink). Read-only access for clients (e.g. the TUI
   * /reload seam); sessions without a file store return undefined. */
  get sessionFile(): string | undefined {
    return this.#sessionFile;
  }

  /**
   * #918 (ADR-0044): does this session's project root live on a Windows
   * drive mounted into WSL (`/mnt/...`)? Environment information, never an
   * error — clients render it as chrome (a persistent TUI footer hint, one
   * stderr line in a headless run) and nothing about it can block a turn.
   * Resolved once at assembly, realpath-anchored like the permission spine.
   */
  get rootOnWindowsMount(): boolean {
    return this.#rootOnWindowsMount;
  }

  /**
   * ADR-0038: sends one control command to a running extension (by its own
   * `name`, as published in `extension_loaded`). The payload is opaque to
   * the core and must be JSON-serializable; the event is appended through
   * the normal path (sink, listeners, single-writer guard) and delivered to
   * that extension's `onEvent` hooks alone. Naming an extension that is not
   * registered is not an error: the log records what was asked, and nobody
   * receives it.
   */
  setExtensionState(extension: string, payload: Record<string, unknown>): void {
    this.#append({ type: "extension_control", extension, payload });
  }

  /** The names of the extensions currently registered on this session. */
  extensionNames(): string[] {
    return this.#extensions?.instances.map((i) => i.def.name) ?? [];
  }

  /**
   * ADR-0062 (#1130): every registered extension command — what the
   * command completion and `/extensions` list. Empty without extensions.
   */
  extensionCommands(): { extension: string; name: string; description: string }[] {
    return this.#extensions?.extensionCommands() ?? [];
  }

  /** ADR-0062 (#1130): refused command registrations, with their reasons. */
  extensionCommandRefusals() {
    return this.#extensions?.commandRefusals() ?? [];
  }

  /** ADR-0062 (#1132): every registered panel, in extension order — one
   * per extension, at most 4 across all. `render` is the extension's own
   * Ink render function — opaque to the core, drawn only by a client with
   * a surface (the TUI rail); a headless client never calls it. */
  extensionPanels(): { extension: string; name: string; description: string; maxHeight?: number; render(): unknown }[] {
    return this.#extensions?.panels() ?? [];
  }

  /** ADR-0062 (#1132): every registered overlay, in extension then call
   * order; `render` as on panels. */
  extensionOverlays(): { extension: string; name: string; description: string; render(): unknown }[] {
    return this.#extensions?.overlays() ?? [];
  }

  /** ADR-0062 (#1132): refused panel/overlay registrations, with their reasons. */
  extensionUIRefusals(): readonly ExtensionUIRefusal[] {
    return this.#extensions?.uiRefusals() ?? [];
  }

  /** ADR-0062 (#1132): the overlay the client currently shows, null = none. */
  extensionActiveOverlay(): ActiveExtensionOverlay | null {
    return this.#extensions?.activeOverlay() ?? null;
  }

  /** ADR-0062 (#1132): closes the active extension overlay; a no-op when none. */
  closeExtensionOverlay(): void {
    this.#extensions?.closeOverlay();
  }

  /**
   * #1131: what only the running runtime knows about each registered
   * instance — source file, declared capabilities, registered commands.
   * The event log alone cannot answer these (the log records who and
   * which part, never the paths or the capability strings), so a screen
   * folds the log for the shared facts and merges this for the live ones.
   */
  extensionLiveInfo(): ExtensionLiveInfo[] {
    return (this.#extensions?.instances ?? []).map((i) => ({
      name: i.def.name,
      ...(i.file !== undefined ? { file: i.file } : {}),
      capabilities: i.def.capabilities ?? [],
      commands: i.commands.map((c) => ({ name: c.name, description: c.description ?? "" })),
      panels: (i.panel !== null
        ? [{
            name: i.panel.name,
            description: typeof i.panel.description === "string" && i.panel.description.length > 0 ? i.panel.description : `panel by ${i.def.name}`,
            ...(typeof i.panel.maxHeight === "number" && i.panel.maxHeight > 0 ? { maxHeight: i.panel.maxHeight } : {}),
          }]
        : []),
      overlays: i.overlays.map((o) => ({
        name: o.name,
        description: typeof o.description === "string" && o.description.length > 0 ? o.description : `overlay by ${i.def.name}`,
      })),
    }));
  }

  /**
   * Resolves when every pending extension registration has settled
   * (#1130): a headless client must consult `extensionCommands()` only
   * after this — `registerFiles` is fire-and-forget, so an eager check
   * races the import and a granted command can be missed.
   */
  extensionsReady(): Promise<void> {
    return this.#extensions ? this.#extensions.ready().then(() => undefined) : Promise.resolve();
  }

  /**
   * ADR-0062 (#1130): runs one extension command by slash name — the same
   * door the TUI toast and the headless JSONL line both print.
   */
  invokeExtensionCommand(name: string, args: string) {
    return this.#extensions
      ? this.#extensions.invokeCommand(name, args)
      : Promise.resolve({ ok: false as const, error: `no extension command "${name}"` });
  }

  /**
   * ADR-0038: reads one value from a registered extension's own `state`
   * store — how a client command reports what an extension is thinking
   * (the status seam reaches the footer, and an `appendEvent` is a
   * transcript line, not a return value). Undefined when the extension is
   * not registered or never stored that key; the value is opaque to the
   * core.
   */
  extensionState(extension: string, name: string): unknown {
    return this.#extensions?.instances.find((i) => i.def.name === extension)?.state[name];
  }

  /** Appends a session display-name event through the configured sink, so
   * the live store retains its single-writer accounting. */
  rename(name: string): void {
    this.#append({ type: "session_renamed", name: name.trim() });
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
    // #765: prompt snippets — when the caller passes arguments along
    // with the skill prompt, placeholders in the body are substituted
    // once, here, before anything (chrome event, prompt assembly) sees
    // it; downstream code keeps reading a plain text.
    if (options?.prompt && options.args) {
      options = {
        ...options,
        prompt: { ...options.prompt, text: substituteSkillArgs(options.prompt.text, options.args) },
      };
    }
    // #576 (d6): the turn pins its head here — every event of the turn
    // will parent to it even if a mid-turn switch moves the head; the
    // pin clears when the turn settles.
    const pending = this.#queue.pending();
    if (!pending) {
      const head = resolveHead(this.#eventLog.live()).head;
      this.#turnHead = this.#diverged ? (this.#localTip ?? head) : head;
    }
    // #616: turn-scoped MPM orientation — computed at send time from the
    // task text, cleared when the turn settles (same lifecycle as the
    // ADR-0011 skill prompt). Ineligible or uncertain: no plan at all.
    // #759: the task text and gates persist for the whole turn — the plan
    // recomputes at every prompt assembly with the previous call's
    // persisted reasoning as a low-tier seed source.
    this.#mpmTaskText = text;
    this.#mpmExploratoryCalls = 0;
    // #759: #mpmReasoningText is intentionally kept — the last persisted
    // reasoning (previous call included) is the seed source.
    this.#mpmOrientation?.beginTurn();
    // #790: at send the plan may be rescued by the rerank hook (an async
    // extension call — one per send, when an over-threshold seed set
    // would otherwise be discarded). The sync plan is computed now; the
    // rescued variant (when wired) re-runs the pipeline inside the
    // turn-start chain and replaces the plan before the first model call
    // assembles the prompt. Mid-turn reassemblies read whichever plan
    // landed through the sync `#orientationPlan` — no second rerank call.
    this.#mpmPlan = this.#orientationPlan();
    // ADR-0032/bundled activation: the runtime registers fire-and-forget
    // from the assembly, so a turn started while that is still in flight
    // waits for the setup to settle — a hook is never missing from a turn's
    // first tool call. No pending registration (the common case): `send`
    // starts the turn synchronously, exactly as before.
    const start = (): Promise<TurnResult> => this.#queue.send(text, options?.prompt);
    // #790: the rerank rescue runs inside the turn-start chain (it must
    // land before the first prompt assembly), but the no-rerank path
    // keeps today's synchronous start — `send` begins the turn in the
    // same tick, exactly as before.
    if (!(this.#mpmOrientation && this.#orientationHasRerank)) {
      const run = this.#extensions?.hasPendingRegistrations() === true ? this.#extensions.ready().then(start) : start();
      return run.finally(() => {
        this.#turnHead = undefined;
      });
    }
    const run = Promise.all([
      this.#orientationPlanWithRerank().then((plan) => {
        if (plan !== null) this.#mpmPlan = plan;
      }),
      this.#extensions?.hasPendingRegistrations() === true ? this.#extensions.ready() : Promise.resolve(),
    ]).then(start);
    return run.finally(() => {
      this.#turnHead = undefined;
    });
  }

  /**
   * ADR-0037: the session-mediated entry behind an extension's
   * `ctx.requestTurn` — one turn with a synthetic user-side message,
   * through the normal queue so preemption, usage accounting and
   * settlement stay the session's. Resolves `{ ok: false }` when the
   * session is disposed or a turn is already in flight (the runtime
   * renders every refusal as a visible `extension_failed`); the depth
   * limit itself is enforced by the runtime, not here.
   */
  /**
   * ADR-0037: the session-mediated entry behind an extension's
   * `ctx.requestTurn` — one turn with a synthetic user-side message,
   * through the same queue as a user send (abortion, usage accounting,
   * `#turnSeq` and settlement stay the session's). The queued item runs
   * when the slot is free, so a request made from a settling turn's own
   * `afterTurn` hook waits without deadlocking it; queued user sends go
   * first, and an active turn is never preempted by a synthetic one.
   * Resolves `{ ok: false }` only when the session is disposed.
   */
  runSyntheticTurn(text: string): Promise<{ ok: boolean; result?: TurnResult }> {
    if (this.#disposed) return Promise.resolve({ ok: false });
    const synthetic = (): Promise<TurnResult> => this.#queue.sendSynthetic(text);
    const run =
      this.#extensions?.hasPendingRegistrations() === true
        ? this.#extensions.ready().then(synthetic)
        : synthetic();
    return run
      .then((result) => ({ ok: true, result }))
      .catch(() => ({ ok: false }))
      .finally(() => {
        this.#turnHead = undefined;
      });
  }

  /**
   * Forced compaction (#466): `/compact` and `moh compact` land here.
   * Ignores threshold and stale-measurement guard, same tail/summarizer
   * as the auto path, same producer. On success the live messages are
   * rebuilt through the same replay path resume uses.
   */
  async compact(): Promise<
    | { ok: true; summary: string; upTo: number; upToId?: string; tailTurns: number; tokensBefore: number; tokensAfter: number; partial: boolean }
    | { ok: false; error: string }
  > {
    if (!this.#compaction) return { ok: false, error: "compaction is disabled for this session" };
    if (this.#queue.pending()) return { ok: false, error: "a turn is in flight; compact when the session is idle" };
    const events = this.#eventLog.live();
    // Before/after context estimate for clients (#466): the largest
    // measured inputTokens vs the tail the marker keeps. Estimated on
    // the same projection the producer covers (#578 d3).
    const tokensBefore = CompactionRunner.lastMeasuredCall(events)?.inputTokens ?? 0;
    const result = await this.#compaction.compactNow(events);
    if (!result.ok) return result;
    // #949: the tail accounting reads the marker's own pointer — the
    // producer's decision (window-aware, possibly inside the last turn)
    // is the truth; recomputing a tail without a window would report a
    // tail that does not exist.
    const path = activePath(events);
    const markerIndex = result.upToId !== undefined ? path.findIndex((e) => e.id === result.upToId) : -1;
    const tailStart = markerIndex >= 0 ? markerIndex + 1 : result.upTo;
    let tailTurns = 0;
    for (let i = tailStart; i < path.length; i++) {
      if (path[i]!.type === "user_message") tailTurns += 1;
    }
    const tokensAfter = CompactionRunner.turnTokens(path, tailStart, path.length);
    return { ...result, tailTurns, tokensBefore, tokensAfter, partial: result.partial ?? tailTurns === 0 };
  }

  /** Rebuilds `#messages` from the log after a marker (#466): the same
   * `replayMessages` path resume uses, then the system prompt is
   * re-attached by `#assemblePrompt`. A fresh measurement (not the stale
   * pre-compaction one) may re-trigger later. */
  #rebuildAfterCompaction(): void {
    // #577: the rebuilt context is the active-path projection (d2) — an
    // in-session switch before the rebuild must not resurface off-path
    // events into the model context.
    const messages = replayMessages(activePath(this.#eventLog.live()));
    this.#messages.splice(0, this.#messages.length, ...messages);
    this.#assemblePrompt();
  }

  /**
   * Post-turn memory trigger (#38): delegated to the MemoryRunner
   * collaborator (memory.ts) — every N completed turns, one discreet
   * `memory_updated` event on success, silence otherwise.
   */
  #maybeExtractMemory(result: TurnResult): void {
    this.#memory?.maybeExtract(result, this.#eventLog.live(), this.#disposed);
  }

  /**
   * #759: the current orientation plan — task text plus, when the previous
   * model call of this turn persisted reasoning and produced no successful
   * `mpm_query`, that reasoning text as the low-tier seed source.
   *
   * #790: synchronous; when the rerank hook rescued this send's plan the
   * orientation's internal cache returns it without a second call.
   */
  #orientationPlan(): string | null {
    const orientation = this.#mpmOrientation;
    if (!orientation || this.#mpmTaskText === null) return null;
    // #788: the per-turn eligibility gate (an active classifier's
    // codebase-oriented opinion). `false` suppresses this turn's plan —
    // the projection, `mpm_query` and the manual commands are untouched;
    // `undefined`/`true` change nothing.
    if (this.#mpmTurnGate?.() === false) {
      orientation.noteGated();
      return null;
    }
    return orientation.planFor(this.#mpmTaskText, this.#mpmReasoningText ?? undefined);
  }

  /**
   * #790: the send-time variant — the only caller that can await the
   * rerank hook. Same gate, same seeds; when the seed pipeline would
   * discard an over-threshold set, the hook ranks the candidates and the
   * rescued plan is cached in the orientation for the turn's sync
   * reassemblies. A failed or inconclusive rerank degrades to today's
   * no-plan, never a broken send.
   */
  async #orientationPlanWithRerank(): Promise<string | null> {
    const orientation = this.#mpmOrientation;
    if (!orientation || this.#mpmTaskText === null) return null;
    if (this.#mpmTurnGate?.() === false) {
      orientation.noteGated();
      return null;
    }
    return orientation.planForWithRerank(this.#mpmTaskText, this.#mpmReasoningText ?? undefined);
  }

  /** #790: whether the rerank hook is wired (config + extension state). */
  get #orientationHasRerank(): boolean {
    return this.#mpmRerank !== undefined;
  }

  /** Reassembles the system prompt for the next model call (#27). */
  #assemblePrompt(): void {
    const assembled = this.#promptComposer.compose({
      cwd: this.#cwd,
      platform: process.platform,
      now: new Date(),
      // ADR-0050: the prompt states what serves — the pair while a fallback
      // serves this session's calls, the single reference otherwise. Read
      // live, at every assembly: a fallback that happened mid-turn is in
      // the next call's prompt.
      model: formatModelPair(this.selectedModel, this.servingModel),
      tools: Object.values(this.#allTools()).map((t) => ({ name: t.name, description: t.description })),
      skills: this.#skills,
      ...(this.#skillPrompt ? { skillPrompt: this.#skillPrompt } : {}),
      memory: this.#memory?.excerpt(),
      extensionNotes: this.#extensions?.notes(),
      // ADR-0036: the live per-turn notes, read at each assembly (an
      // extension may set or replace its note mid-turn).
      turnNotes: this.#extensions?.turnNotes(),
      // #759: recomputed here — reasoning from the previous model call can
      // seed this one (mid-turn, after a tool result, included).
      ...(this.#mpmTaskText !== null ? { mpmOrientation: this.#orientationPlan() ?? undefined } : this.#mpmPlan ? { mpmOrientation: this.#mpmPlan } : {}),
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

  /**
   * #849: the permission mode currently in force — live, so the client's
   * banner and status render the rotated mode without any re-assembly.
   */
  get sessionMode(): SessionMode {
    return this.#permissions.mode;
  }

  /**
   * #849: rotates the permission mode in-session (`normal` → `auto-accept`
   * → `yolo`), effective from the very next tool decision: the gate and
   * the filesystem scope read the resolver's live mode. Appends exactly
   * one `session_mode` chrome event per change so replay and the
   * consumers that track the event (the Jev guardrail) follow; never
   * touches any configuration file — a new session starts from its config.
   * A no-op when the mode is already in force (no event, no churn).
   */
  setSessionMode(mode: SessionMode): void {
    if (this.#permissions.mode === mode) return;
    this.#permissions.setMode(mode);
    this.#append({ type: "session_mode", mode });
  }

  /**
   * ADR-0032: the statuses extensions currently publish, in registration
   * order (empty when none). Client chrome, polled like `mpmSnapshot`;
   * ephemeral — never in the log, cleared at session end and on reload.
   */
  extensionStatuses(): ExtensionStatus[] {
    return this.#extensions?.statuses() ?? [];
  }

  /**
   * ADR-0032 headless signal: one stderr line per *new* status text (a
   * repeat of the current text prints nothing, a clear prints nothing and
   * re-arms the announcement). The exit code is never affected — a status
   * is information, not an error.
   */
  #onExtensionStatus(extension: string, text: string | null): void {
    if (text === null) {
      this.#announcedStatus = null;
      return;
    }
    if (this.#hasConsentSeam || this.#announcedStatus === text) return;
    this.#announcedStatus = text;
    process.stderr.write(`moh: ${extension}: ${text}\n`);
  }

  /**
   * #619: live MPM status for the client chrome (TUI status row) plus
   * pending background work and fallback reason; null when MPM never
   * activated for this session (disabled, no projection, activation
   * failure) — the client renders nothing.
   */
  mpmSnapshot(): {
    status: MpmStatus;
    pendingWork: number;
    fallbackReason: MpmDiagnostics["fallbackReason"];
    /** #759: orientation seed statistics (metadata only). */
    seedStats?: MpmSeedStats;
    /** #759: successful exploratory tool calls this turn (field validation). */
    exploratoryCalls?: number;
  } | null {
    const service = this.#mpmService;
    if (!service) return null;
    return {
      status: service.status,
      pendingWork: this.#mpmLifecycle?.pendingCount ?? 0,
      fallbackReason: this.#mpmOrientation?.lastFallbackReason ?? null,
      ...(this.#mpmOrientation ? { seedStats: this.#mpmOrientation.seedStats } : {}),
      exploratoryCalls: this.#mpmExploratoryCalls,
    };
  }

  /**
   * #619: the full read-only diagnostics projection for on-demand client
   * inspection (same shape as the CLI's `moh mpm --json`), enriched with
   * this session's live lifecycle and orientation state. The config
   * resolution mirrors session assembly (user default, project restrict);
   * never throws — a config failure degrades to the disabled report.
   */
  mpmDiagnostics(): MpmDiagnostics {
    const service = this.#mpmService;
    if (!service) {
      const config = this.#resolveMpmConfig();
      // Degrade honestly: the disabled report, no fabrication. A throwaway
      // unloaded service satisfies the mpmDiagnostics contract (never read).
      return mpmDiagnostics({ service: new MpmService(join(this.#mohHome, "unused")), root: this.#cwd, config });
    }
    let config = this.#resolveMpmConfig();
    if (!config.enabled) {
      // #618 semantics: user/project disablement beats activation. Report
      // the disabled view even though a projection is live in-process.
      return mpmDiagnostics({ service, root: this.#mpmRoot ?? this.#cwd, config });
    }
    return mpmDiagnostics({
      service,
      root: this.#mpmRoot ?? this.#cwd,
      config,
      pendingWork: this.#mpmLifecycle?.pendingCount ?? 0,
      evictions: this.#mpmLifecycle?.evictionCount ?? 0,
      fallbackReason: this.#mpmOrientation?.lastFallbackReason ?? null,
      seedStats: this.#mpmOrientation?.seedStats,
    });
  }

  /** Same precedence as session assembly: user default, project restrict. */
  #resolveMpmConfig(): MpmEffectiveConfig {
    try {
      // moh.json's mpm section was already applied at assembly time; the
      // session does not re-read moh.json here (strict parse errors are an
      // assembly concern). Resolve user-only; the project override the
      // assembly applied rides along in the live quota/exclude fields. The
      // session's own activation (not the user default) is what matters
      // here, so an activated session reports enabled even under the
      // opt-in default (ADR-0026).
      return resolveMpmConfig({ ...readMpmUserConfig(userConfigFile(this.#mohHome)), enabled: true });
    } catch {
      // Malformed user config: diagnostics degrade to defaults, per #618.
      return resolveMpmConfig({ enabled: true });
    }
  }

  /**
   * #944 (ADR-0047): runs one hook dispatch, scoped to this session when it
   * is a borrower of the runtime (a subagent child) — the extension events
   * and hook failures produced inside `fn` belong to this session.
   *
   * The owner's own dispatches run unscoped: its channel is the runtime's
   * single one (`onLoadEvent`), which is what keeps the load-order chrome
   * in the log it opens.
   */
  #scopedDispatch<T>(fn: () => T): T {
    const runtime = this.#borrowedHooks;
    if (!runtime) return fn();
    return runtime.withSession({ id: this.#sessionId, write: (event) => this.#append(event), errors: [] }, fn);
  }

  #append(event: AgentEvent): void {
    // ADR-0032: a turn begins with its user_message — the per-session
    // `extension_event` cap counts per turn, so the counter resets here
    // (steering sends are turns too). #981: the budget belongs to the
    // session whose turn started: its own when it owns the runtime, the
    // borrowed one's when it runs through the parent's.
    if (event.type === "user_message") {
      if (this.#extensions) this.#extensions.beginTurn(this.#sessionId);
      else this.#borrowedHooks?.beginBorrowedTurn(this.#sessionId);
      // ADR-0037: a real (non-synthetic) user turn refills every
      // extension's synthetic-turn budget.
      if (event.synthetic !== true) this.#extensions?.noteRealTurn();
    }
    // #759: the reasoning text of the last persisted call is the low-tier
    // orientation seed source. Content stays in the log; only the plan
    // (paths + reasons) ever reaches the prompt.
    if (event.type === "reasoning") this.#mpmReasoningText = event.text;
    // #400 single-writer guard: at every append boundary, growth of the
    // backing file beyond what this writer last appended becomes one
    // `session_file_growth` chrome event (all surfaces warn) recorded
    // *before* the pending event — chronologically honest in the log.
    // `sessionFile` is always set when `externalGrowth` is (the from-config
    // seam pairs them), so the fallback is unreachable in practice.
    // #576 (head semantics d7/d8): the payload names both tips — the local
    // writer's own tip and the foreign tail's tip (the log's last
    // identified event at detection time) — and while divergence is
    // unresolved the local writer stamps explicit local-tip parents, so
    // the two writers can never merge into one branch by accident and the
    // head never moves on its own.
    if (this.#externalGrowth) {
      const growth = this.#externalGrowth();
      if (growth) {
        // The local tip at divergence time is the last event within the
        // expected (pre-growth) bytes — the foreign tail lives after them.
        // Lazily derived once: before the first growth this writer's own
        // appends keep `#localTip` fresh already.
        this.#localTip ??= localTipAt(this.#sessionFile ?? "", growth.expectedBytes) ?? undefined;
        // The foreign tip is the file's actual tail (last identified event),
        // not this writer's in-memory log — the in-memory history stopped
        // at the writer's own last append.
        const foreignTip = fileTailId(this.#sessionFile ?? "");
        this.#eventLog.append({
          type: "session_file_growth",
          file: this.#sessionFile ?? "",
          ...growth,
          ...(this.#localTip && foreignTip ? { localTip: this.#localTip, foreignTip } : {}),
        });        if (this.#localTip) this.#diverged = true;
      }
    }
    // #576 (head semantics d7): while divergence is unresolved, every
    // local event carries an explicit parent — its own previous local tip.
    // Off-head parents are mandatory-parent-rule writes, never head moves.
    // Same mechanism pins a turn to its head (d6): within a turn the pin
    // follows the turn's own events (the ordinary chain), but a mid-turn
    // switch never moves it — the running turn's events keep chaining on
    // the turn-start branch and the switch takes effect next turn.
    const pinned =
      event.parentId === undefined && event.type !== "branch_switched"
        ? (this.#turnHead ?? (this.#diverged ? this.#localTip : undefined))
        : undefined;
    const stamped = this.#eventLog.append(
      pinned ? { ...event, parentId: pinned } : event,
    );
    // The pin advances through the turn's own events only — a switch line
    // rides the old branch without moving the turn's head.
    if (this.#turnHead !== undefined && event.type !== "branch_switched") {
      this.#turnHead = stamped.id;
    }
    // The local tip only advances through this writer's own appends.
    if (stamped.type !== "session_file_growth" || stamped.localTip !== undefined) {
      this.#localTip = stamped.id;
    }
  }
  /**
   * #576: moves the head for this live session by appending one validated
   * `branch_switched { to }` through the sink (the live store keeps its
   * single-writer accounting, same as `rename`). `to` must resolve against
   * the live log. Switching to an interior node makes subsequent appends
   * split implicitly; the change takes effect from the next turn — the
   * in-flight turn stays pinned to its turn-start head (head semantics d6).
   * Also the adoption action for #400 divergence: switching to the local
   * tip resolves the divergence and clears the explicit-local-parent mode.
   */
  switchBranch(to: string): { ok: true } | { ok: false; error: string } {
    if (this.#disposed) return { ok: false, error: "session is disposed" };
    if (resolveEventRef(to, this.#eventLog.live()) === null) {
      return { ok: false, error: `branch target not found in this session: ${to}` };
    }
    this.#append({ type: "branch_switched", to });
    // Adoption (head semantics d9): an explicit switch — any switch — is
    // the user resolving where the head belongs; the divergence guard
    // lifts and the writer returns to head-following appends.
    this.#diverged = false;
    return { ok: true };
  }

  /**
   * #579 (spec §4): bookmarks a node for this live session by appending a
   * validated `tree_bookmarked { to, name? }` chrome event through the
   * sink (the live store keeps its single-writer accounting, same as
   * `switchBranch`). `to` must resolve against the live log (ULID or
   * `line:N` bridge); a non-empty name sets/renames, an empty/whitespace
   * name clears — last-wins. Never provider context; counted for
   * topology. The file-based path for closed sessions is
   * `bookmarkNode()` in session-store.
   */
  bookmarkNode(to: string, name?: string): { ok: true } | { ok: false; error: string } {
    if (this.#disposed) return { ok: false, error: "session is disposed" };
    if (resolveEventRef(to, this.#eventLog.live()) === null) {
      return { ok: false, error: `bookmark target not found in this session: ${to}` };
    }
    const trimmed = name?.trim() ?? "";
    this.#append(
      name === undefined
        ? { type: "tree_bookmarked", to }
        : trimmed === ""
          ? { type: "tree_bookmarked", to, name: "" }
          : { type: "tree_bookmarked", to, name: trimmed },
    );
    return { ok: true };
  }

  /** Ends the session: flushes a pending memory run, shuts down MCP servers, dispatches onSessionEnd hooks. Idempotent.
   * `timeoutMs` budgets the memory flush only (vision note 14): a slow
   * extraction is aborted — the log is append-only and safe, and the
   * extractor rolls its window back — instead of keeping the process alive
   * after the UI has exited. Everything else (MCP, hooks, idle drain) is
   * fast in practice and still awaited. */
  async dispose(options: { timeoutMs?: number } = {}): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#compaction?.pending) await this.#compaction.pending.catch(() => {});
    if (this.#memory?.pending) {
      const flush = this.#memory.pending.catch(() => {});
      if (options.timeoutMs === undefined) {
        await flush;
      } else {
        await Promise.race([
          flush,
          new Promise<void>((resolve) => {
            setTimeout(() => {
              this.#memory?.cancel();
              resolve();
            }, options.timeoutMs).unref?.();
          }),
        ]);
      }
    }
    await this.#mcp?.shutdown();
    this.#mpmLifecycle?.dispose();
    // #774: reap the per-session browser (no orphan Chromium at exit).
    try {
      await this.#onDispose?.();
    } catch { /* reaping is best-effort at shutdown */ }
    // #981: a borrowing session's per-session event budgets die with it —
    // the runtime that hosted them outlives every child.
    this.#borrowedHooks?.endBorrowedSession(this.#sessionId);
    if (!this.#extensions) return;
    // ADR-0032: statuses are ephemeral — nothing survives the session.
    this.#extensions.clearStatuses();
    // #834: hot-reload watchers live and die with the session that started them.
    this.#extensions.stopWatch();
    for (const e of await this.#extensions.dispatchSessionEnd("disposed")) this.#append(e);
    // The end-of-session events were just queued: let the dispatch drain
    // settle before the session is considered disposed.
    await this.#eventLog.idle();
  }
}