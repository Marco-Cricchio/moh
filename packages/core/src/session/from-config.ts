/**
 * Single session-assembly path (issue #100, ADR-0005).
 *
 * `sessionFromConfig` is the one owner of the assembly choreography:
 * moh.json read, project+user MCP server merge, provider resolution
 * (one path instead of three), subagent/memory wiring, and session
 * creation. Clients (TUI, CLI) inject only their consent seams and
 * client-specific overrides; neither resolves providers nor merges MCP
 * servers by hand.
 *
 * There is no silent fallback: a broken config or provider reference
 * surfaces as an explicit `{ error }` result (ADR-0005 removed the old
 * demo-provider swap). The demo provider runs only when explicitly
 * configured (`"mock"`, the zero-config default) or passed in.
 */
import { homedir } from "node:os";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectMapDir, type MpmQuota, type MpmService } from "../mpm/service";
import { readMpmUserConfig, resolveMpmConfig } from "../mpm/config";
import { extractWorkspace, mapFile, MPM_MAX_FILE_SIZE } from "../mpm/extractor";
import { discoverWorkspace } from "../mpm/discover";
import { MpmService as MpmServiceImpl } from "../mpm/service";
import type { MpmFileRecord } from "../mpm/types";
import { builtinTools } from "../builtin-tools";
import { declaredMcpServers, loadMohConfig, type MohConfig } from "../config";
import { mergeProviderConfigs, readUserProviderConfig } from "../provider-config";
import { declaredUserMcpServers, isProjectServerTrusted, type McpConsentAnswer } from "../mcp";
import { defaultRegistry, resolveProvider, resolveProviderRef } from "../provider-registry";
import { SessionStore } from "../session-store";
import type { PermissionOverrides } from "../permissions";
import type { AgentEvent, AskUserQuestionSet, AskUserSetResult, Provider, Tool } from "../types";
import { AgentSession } from "./session";
import type { SessionConfig } from "./config";
import { ExtensionRuntime } from "../extensions";
import type { ExtensionConsentRequest } from "../extensions";
import { extensionSourceFiles, loadExtensionSource } from "../extension-source";
import { discoverSkills } from "../skills";
import { userConfigFile } from "../user-config";
import { readTypesafeConfig, resolveTypesafeConfig } from "../typesafe";
import { createModelPool } from "../model-pool";
import { createJevGuardExtension, JEV_GUARD_NAME } from "@moh/jev-guard";
import type { PermissionAskContext, PermissionsConfig } from "./config";

/**
 * Initial projection build for a never-mapped project (MPM activation
 * deadlock fix): discover the workspace deterministically, extract the
 * supported files (metadata only), and write the projection atomically.
 * Fail-safe by design — any error leaves the directory untouched so the
 * next open retries; a session never fails because of MPM.
 */
function buildInitialProjection(mapDir: string, root: string, exclude: string[] | undefined): void {
  try {
    const service = new MpmServiceImpl(mapDir);
    service.rebuild(extractWorkspaceExcluding(root, exclude ?? []));
  } catch {
    // Fail-safe: leave no half projection; MPM degrades to inactive.
  }
}

/** Full extraction honoring the resolved user/project exclusion patterns. */
function extractWorkspaceExcluding(root: string, extraExcludes: string[]): Map<string, MpmFileRecord> {
  if (extraExcludes.length === 0) return extractWorkspace(root);
  // Same pipeline as extractWorkspace, but discovery also drops the
  // configured extra exclusion patterns before extraction.
  const files = discoverWorkspace(root, extraExcludes);
  const known = new Set(files);
  const records = new Map<string, MpmFileRecord>();
  for (const path of files) {
    const abs = join(root, path);
    try {
      const st = statSync(abs);
      if (st.size > MPM_MAX_FILE_SIZE) continue;
      const content = readFileSync(abs, "utf8");
      records.set(path, mapFile(root, path, content, st.size, known));
    } catch {
      continue; // unreadable: skipped, never fatal
    }
  }
  return records;
}

/** Why an assembly failed. `config`/`provider` are user-fixable; `session` is a startup validation error (e.g. duplicate MCP names). */
export type AssemblyErrorKind = "config" | "provider" | "session";

export interface AssemblyError {
  kind: AssemblyErrorKind;
  message: string;
}

/** The client interaction seams. Without them (headless), unpermitted calls and project MCP servers fail fast. */
export interface SessionConsent {
  /** Tool "ask" decisions (TUI: the permission modal). `always_for_site`
   * (#775) is the browser act-tier answer — session-scoped, never persisted.
   * ADR-0031: `context.source === "extension"` marks an ask raised by an
   * extension hook — the prompt offers yes/no only, labelled with its reason. */
  onPermissionRequest?: (
    tool: string,
    args: unknown,
    context?: PermissionAskContext,
  ) => Promise<"yes" | "always" | "always_for_site" | "no"> | "yes" | "always" | "always_for_site" | "no";
  /** ask_user channel (TUI: the inline question block, ADR-0019). */
  onAskUser?: (set: AskUserQuestionSet) => Promise<AskUserSetResult> | AskUserSetResult;
  /**
   * ADR-0033 §4: the pre-send confirmation channel (TUI: the confirmation
   * modal; headless clients answer "refuse"). Absent = the core refuses
   * any confirmed turn it cannot ask about.
   */
  onConfirmTurn?: SessionConfig["onConfirmTurn"];
  /** Project MCP server consent (TUI: reuses the permission modal). */
  onMcpTrust?: (server: string) => Promise<McpConsentAnswer> | McpConsentAnswer;
  /**
   * #834: the one-time enable consent for a client-loaded extension (TUI:
   * the permission modal, which names the extension, its source path and
   * its version). Absent = nothing can ask (headless): an extension that
   * was never enabled is refused with `extension_failed { reason: "consent" }`,
   * one line on stderr, and the session continues. A `true` answer is
   * persisted against the resolved path + content hash, so the same file
   * loads silently afterwards and an edit asks again.
   */
  onExtensionConsent?: (request: ExtensionConsentRequest) => Promise<boolean> | boolean;
}

/** Client-specific overrides the builder layers over the moh.json-derived defaults. */
export interface SessionOverrides {
  /** Full tool registry (TUI: built-ins + tracker tools in workflow mode). Default: built-ins. */
  tools?: Record<string, Tool>;
  /** Patch over the config-derived permission config (mode, yolo). Its
   * `overrides`, when given, replaces the merged set entirely (it wins over
   * `permissionFlags`) — pass one or the other, never both. */
  permissions?: Partial<PermissionsConfig>;
  /** Extra tier-2 rules (e.g. CLI --allow/--deny) merged on top of moh.json overrides; caller wins. */
  permissionFlags?: PermissionOverrides;
  /** First-party skills (#36): "include" (default) or "exclude". */
  firstParty?: "include" | "exclude";
  /** Extra event sink (e.g. CLI stdout streaming); the store append always runs. */
  sink?: (event: AgentEvent) => void;
  /** Existing store to append to (resume); default: a fresh SessionStore. */
  store?: SessionStore;
  /** Resume events when `store` is given; default: `store.load()`. */
  resumeEvents?: ReadonlyArray<AgentEvent>;
  /** The remote handoff accepted to seed this new session (#437). */
  handoffSupersedes?: import("../handoff").HandoffReference;
  /** Client-owned best-effort publish after the session successfully runs `git push`. */
  onGitPush?: () => void;
  /** ADR-0022: `moh compact` opens a closed file with `resumeConsume: false` —
   * the `session_resumed` marker is not appended (compacting never consumes). */
  resumeConsume?: boolean;
  /** #498: per-turn iteration cap override (CLI `--max-iterations`); wins
   * over moh.json `maxIterations`. `0` = unlimited sentinel. */
  maxIterations?: number;
}

export interface SessionFromConfigOptions {
  cwd: string;
  /** Home dir for `~/.moh` (user MCP config, session store). Default: os homedir. */
  home?: string;
  /** Pre-loaded moh.json (tests). Default: read from `<cwd>/moh.json`; invalid → config error. */
  config?: MohConfig;
  /** Pre-built provider instance (tests, cassettes). Wins over every reference. */
  provider?: Provider;
  /** Explicit provider reference override (CLI `--provider`): "mock", a custom id, or endpoint/model-id. */
  providerRef?: string;
  consent?: SessionConsent;
  overrides?: SessionOverrides;
}

export type SessionFromConfigResult =
  | { session: AgentSession; store: SessionStore }
  | { error: AssemblyError };

/** CLI-style merge: caller rules win per tool key; lists are unioned caller-first. */
function mergePermissionFlags(
  base: PermissionOverrides | undefined,
  flags: PermissionOverrides,
): PermissionOverrides {
  return {
    tools: { ...base?.tools, ...flags.tools },
    bashAllow: [...(flags.bashAllow ?? []), ...(base?.bashAllow ?? [])],
    bashDeny: [...(flags.bashDeny ?? []), ...(base?.bashDeny ?? [])],
    pathAllow: [...(flags.pathAllow ?? []), ...(base?.pathAllow ?? [])],
    pathDeny: [...(flags.pathDeny ?? []), ...(base?.pathDeny ?? [])],
    browserAllow: [...(flags.browserAllow ?? []), ...(base?.browserAllow ?? [])],
    browserDeny: [...(flags.browserDeny ?? []), ...(base?.browserDeny ?? [])],
  };
}

function assemblyError(kind: AssemblyErrorKind, e: unknown): { error: AssemblyError } {
  return { error: { kind, message: e instanceof Error ? e.message : String(e) } };
}

/**
 * Assembles a session from configuration. The one assembly path: reads
 * moh.json (or takes a pre-loaded config), merges project+user MCP
 * servers, resolves the provider (`provider` instance > `providerRef` >
 * moh.json `provider`, default "mock"), wires subagents/memory, creates
 * the store, and returns the session — or an explicit error. No silent
 * fallbacks.
 */
export function sessionFromConfig(options: SessionFromConfigOptions): SessionFromConfigResult {
  const home = options.home ?? homedir();
  let config: MohConfig;
  try {
    const project = options.config ?? loadMohConfig(join(options.cwd, "moh.json"));
    // User-level provider layering (#129): strict when the sections are
    // present — a broken user config fails loudly like a broken moh.json.
    const user = readUserProviderConfig(userConfigFile(home));
    config = mergeProviderConfigs(project, user);
  } catch (e) {
    return assemblyError("config", e);
  }

  let provider: Provider;
  try {
    provider =
      options.provider ??
      (options.providerRef !== undefined
        ? resolveProviderRef(options.providerRef, defaultRegistry.freeze(), config.endpoints ?? [])
        : resolveProvider(config));
  } catch (e) {
    return assemblyError("provider", e);
  }

  const o = options.overrides ?? {};
  const mohHome = join(home, ".moh");
  // The user config (guardian-owned) is read once and used by every
  // section that lives there: `typesafe` here, MCP trust below.
  const userFile = userConfigFile(home);

  // #784: the bundled Jev extension is activated by the *user* config's
  // `typesafe.apiKey` — read here, in the one assembly path every client
  // uses (TUI, `moh run`, `moh serve`, `moh compact`). No key = nothing is
  // registered and one informational line is recorded; no wizard, no
  // prompt, no warning. A broken `typesafe` section fails loudly above,
  // like a broken `provider` section.
  let typesafe;
  try {
    typesafe = resolveTypesafeConfig(readTypesafeConfig(userFile));
  } catch (e) {
    return assemblyError("config", e);
  }
  const notes: string[] = [];
  let extensions: ExtensionRuntime | undefined;
  // #834: the declared source of client-loadable extensions — the user's
  // `~/.moh/extensions/` dotdir plus the project's `moh.json` proposals.
  // Resolved for every client (one assembly path, ADR-0005), so a headless
  // run fails closed through the same code the TUI asks through.
  const extensionSources = extensionSourceFiles({
    mohHome,
    cwd: options.cwd,
    declared: config.extensions ?? [],
  });
  // The consent seam is the client's: with one, the user is asked; without
  // one (headless), a not-yet-enabled extension is refused and the only
  // channel left — stderr — carries the line the log would have shown.
  const onExtensionConsent = options.consent?.onExtensionConsent;
  if (typesafe.active || extensionSources.length > 0) {
    // One runtime for both doors: bundled first-party code registers with
    // `{ bundled: true }` (no consent — the host shipped the bytes),
    // path-loaded files go through the content-bound consent.
    extensions = new ExtensionRuntime({
      mohHome,
      ...(onExtensionConsent
        ? {
            consent: (name: string, version: string, file: string | undefined) =>
              onExtensionConsent({ name, version, ...(file ? { file } : {}) }),
          }
        : { onWarning: (message: string) => process.stderr.write(`moh: ${message}\n`) }),
    });
  }
  if (extensions && typesafe.active) {
    // #787: the core resolves *which models this session can reach* (lazy —
    // only the router asks); the extension owns the tiers and the judgment.
    // `enabled` is the config opt-in and the router's starting state, not a
    // gate: `/routing on` can enable it for a session that never opted in.
    // An off router costs nothing (no call, and it does not even resolve
    // the pool).
    const routing = { pool: createModelPool(config.endpoints ?? []), labels: typesafe.tiers };
    // Fire-and-forget: `AgentSession` awaits `ready()` before its first
    // turn, so no hook is ever missing from a tool call.
    void extensions.register(
      createJevGuardExtension({
        apiKey: typesafe.apiKey!,
        ...(typesafe.timeoutMs !== undefined ? { timeoutMs: typesafe.timeoutMs } : {}),
        routing,
        enabled: typesafe.routing,
        // #791: the anti-injection opt-in, off unless the user asked.
        injection: typesafe.injection,
        // #788: prompt classification — on unless explicitly turned off.
        classification: typesafe.classification,
        // #790: the MPM seed rerank, off unless the user asked.
        rerank: typesafe.rerank,
        // #793: per-turn skill suggestion, off unless the user asked.
        // The roster is resolved lazily, at each judged turn, through the
        // same discovery the prompt's skills index uses (bundled
        // first-party + user skills, project wins on clash).
        ...(typesafe.skills
          ? {
              skills: {
                roster: () =>
                  Promise.resolve(
                    discoverSkills({ mohHome, projectDir: options.cwd, firstParty: o.firstParty ?? "include" }).map(
                      (s) => ({ name: s.name, description: s.description }),
                    ),
                  ),
              },
            }
          : {}),
        // #789: the end-of-task quality gate, off unless the user asked
        // (it sends the changed code's diff to TypeSafe).
        ...(typesafe.lint ? { lint: { root: options.cwd } } : {}),
      }),
      // Bundled first-party code: the host shipped these bytes, so the
      // content-bound consent (a question about the user's disk) does not
      // apply to them.
      { bundled: true },
    );
  } else {
    notes.push("jev: inactive (no api key)");
  }

  // The declared source (#834): its files load through the same runtime, in
  // the resolved order. Fire-and-forget like the bundled registration —
  // the session awaits `ready()` before its first turn, so an extension's
  // consent prompt is answered before any hook could run.
  if (extensions && extensionSources.length > 0) void loadExtensionSource(extensions, extensionSources);

  // MCP (#15): project (moh.json, consent) first, then user (~/.moh/config, trusted).
  // Computed before the store exists so a throwing read leaves no orphan
  // session file behind. Project trust is resolved from the user config's
  // `mcpTrust` section (#352/SEC-01): the repo's own `trusted` field is ignored.
  const servers = [
    ...declaredMcpServers(config).map((s) => (isProjectServerTrusted(userFile, options.cwd, s.name) ? { ...s, trusted: true } : s)),
    ...declaredUserMcpServers(userFile),
  ];

  const store = o.store ?? SessionStore.create(options.cwd, home);
  let resumeEvents = o.resumeEvents;
  if (o.store && resumeEvents === undefined) {
    try {
      resumeEvents = store.load();
    } catch (e) {
      // A still-empty session file is a fresh append (no resume); a
      // non-empty corrupt log is a visible startup error.
      let empty = false;
      try {
        empty = statSync(store.file).size === 0;
      } catch {
        empty = true;
      }
      if (!empty) return assemblyError("session", e);
      resumeEvents = undefined;
    }
  }

  const permissions: PermissionsConfig = { ...o.permissions };
  const flagMerged = o.permissionFlags
    ? mergePermissionFlags(config.permissions?.overrides, o.permissionFlags)
    : config.permissions?.overrides;
  const finalOverrides = o.permissions?.overrides ?? flagMerged;
  if (finalOverrides) permissions.overrides = finalOverrides;

  const extraSink = o.sink;
  // #616/#618: MPM targeted orientation — automatic activation under the
  // resolved config: the user layer (~/.moh/config `mpm`) owns the default,
  // the project (moh.json `mpm`) may only restrict or disable. When enabled
  // and the project's projection exists, the session loads it (fail-safe)
  // with the resolved quota and exclusion patterns; otherwise nothing
  // changes (no service, no lifecycle, no prompt section).
  // Initial build: a never-mapped project is no longer a permanent dead
  // end — the projection is built synchronously here (bounded discovery,
  // metadata only) before activation. Every failure degrades to "no MPM",
  // never a session error; a subsequent open retries the build.
  let mpm: { service?: MpmService; root?: string; quota?: MpmQuota; exclude?: string[] } | undefined;
  try {
    const mpmConfig = resolveMpmConfig(readMpmUserConfig(userConfigFile(home)), config.mpm);
    if (mpmConfig.enabled) {
      const mapDir = projectMapDir(mohHome, options.cwd);
      if (!existsSync(join(mapDir, "manifest.json"))) {
        buildInitialProjection(mapDir, options.cwd, mpmConfig.exclude);
      }
      if (existsSync(join(mapDir, "manifest.json"))) {
        mpm = { root: options.cwd, quota: mpmConfig.quota, exclude: mpmConfig.exclude };
      }
    }
  } catch {
    mpm = undefined;
  }
  // #400 single-writer guard: AgentSession probes the store at every
  // append boundary; growth from elsewhere (another machine over a sync
  // channel, a second process) becomes a visible `session_file_growth`
  // chrome event through the normal append path. The sink itself stays
  // the plain store append.
  const sink = extraSink
    ? (event: AgentEvent) => {
        store.append(event);
        extraSink(event);
      }
    : (event: AgentEvent) => store.append(event);

  // #774 / ADR-0029: the browser tool rides the builtin assembly when
  // enabled; a missing toolchain surfaces as a `browser_unavailable`
  // chrome event (visible diagnostic, never a session error), and the
  // live browser is reaped at session dispose via `onDispose`.
  let browserDispose: (() => Promise<void>) | undefined;
  const browserDiagnostics: string[] = [];
  const builtinOpts: import("../builtin-tools").BuiltinToolsOptions = {
    ledgerRoot: join(mohHome, "bash-ledgers"),
    ...(config.browser ? { browser: config.browser } : {}),
    // #777: upload containment anchors on the session root; the
    // per-occurrence asks (out-of-root upload, required download) ride
    // the session's permission consent — headless (no seam) refuses
    // out-of-root uploads and keeps downloads blocked.
    browserRoot: options.cwd,
    ...(options.consent?.onPermissionRequest
      ? {
          browserAsk: async (question) => {
            const detail =
              question.kind === "download"
                ? `download "${question.filename}" (${question.size} bytes)`
                : `upload of the out-of-root path "${question.path}"`;
            const answer = await options.consent!.onPermissionRequest!("browser", {
              browserAsk: question.kind,
              detail,
            });
            return answer !== "no";
          },
        }
      : {}),
    diagnostics: browserDiagnostics,
  };
  const builtins = builtinTools(builtinOpts);
  browserDispose = builtinOpts.browserSession ? () => builtinOpts.browserSession!.dispose() : undefined;

  try {
    const session = new AgentSession({
      provider,
      endpoints: config.endpoints ?? [],
      cwd: options.cwd,
      ...(mpm
        ? {
            mpm: {
              ...mpm,
              // #788: when the Jev classification is active it publishes
              // its codebase-oriented opinion per turn; wire it as the
              // per-turn eligibility gate (a lazy read — the extension
              // writes the flag on each `beforeTurn`).
              ...(typesafe.active && typesafe.classification
                ? {
                    turnGate: () => {
                      const read = extensions?.instances.find((i) => i.def.name === JEV_GUARD_NAME)?.state[
                        "mpmGate"
                      ];
                      return read === true ? true : read === false ? false : undefined;
                    },
                  }
                : {}),
              // #790: when the rerank opt-in is on, the extension publishes
              // its judge as `state.rerank`; wire it as the orientation's
              // over-threshold rescue hook (a lazy read — the hook exists
              // only after the extension's setup ran, and the session
              // awaits `ready()` before its first turn).
              ...(typesafe.active && typesafe.rerank
                ? {
                    rerank: (req: import("../mpm/orientation").RerankRequest) => {
                      const hook = extensions?.instances.find((i) => i.def.name === JEV_GUARD_NAME)?.state["rerank"];
                      if (typeof hook !== "function") return Promise.resolve(null);
                      return (hook as (r: import("../mpm/orientation").RerankRequest) => Promise<import("../mpm/orientation").RerankResponse>)(req);
                    },
                  }
                : {}),
            },
          }
        : {}),
      tools: o.tools ?? builtins,
      mohHome,
      sessionFile: store.file,
      externalGrowth: () => store.externalGrowth(),
      ...(o.firstParty ? { firstParty: o.firstParty } : {}),
      ...(extensions ? { extensions } : {}),
      ...(notes.length ? { notes } : {}),
      ...(servers.length
        ? {
            mcp: {
              servers,
              ...(options.consent?.onMcpTrust ? { onConsent: options.consent.onMcpTrust } : {}),
            },
          }
        : {}),
      ...(Object.keys(permissions).length ? { permissions } : {}),
      ...(options.consent?.onPermissionRequest ? { onPermissionRequest: options.consent.onPermissionRequest } : {}),
      ...(options.consent?.onAskUser ? { onAskUser: options.consent.onAskUser } : {}),
      ...(options.consent?.onConfirmTurn ? { onConfirmTurn: options.consent.onConfirmTurn } : {}),
      sink,
      // Subagents (#13): presets from moh.json `agents` merge over the built-ins.
      ...(config.agents ? { subagents: { presets: config.agents } } : {}),
      // Memory (#38): on by default (spec); moh.json `memory` tunes/disables it.
      ...(config.memory ? { memory: config.memory } : { memory: {} }),
      // Compaction (#466): on by default; purely additive when absent.
      compaction: {},
      // Session handoff (#434): the raw artifact is maintained locally
      // regardless of `handoff.transport` (transport gates publishing
      // only, T2+; absent = Not Set = off, purely additive here).
      handoff: {
        ...(o.handoffSupersedes ? { supersedes: o.handoffSupersedes } : {}),
        ...(o.onGitPush ? { onGitPush: o.onGitPush } : {}),
      },
      // Per-turn iteration cap (#190): moh.json `maxIterations`, default 50.
      // #498: `0` is the unlimited sentinel and must pass through (hence
      // `!== undefined`, not a truthiness check). A client override (CLI
      // `--max-iterations`) wins over the config value.
      ...(o.maxIterations !== undefined || config.maxIterations !== undefined
        ? { maxIterations: o.maxIterations ?? config.maxIterations }
        : {}),
      ...(resumeEvents?.length ? { resume: { events: resumeEvents, consume: o.resumeConsume !== false } } : {}),
      // #774: reap the browser at session dispose; emit the visible
      // missing-toolchain diagnostic at session start.
      ...(browserDispose ? { onDispose: browserDispose } : {}),
      ...(browserDiagnostics.length ? { diagnostics: browserDiagnostics } : {}),
    });
    return { session, store };
  } catch (e) {
    return assemblyError("session", e);
  }
}
