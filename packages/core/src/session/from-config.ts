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
import { userConfigFile } from "../user-config";
import type { PermissionsConfig } from "./config";

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
  /** Tool "ask" decisions (TUI: the permission modal). */
  onPermissionRequest?: (
    tool: string,
    args: unknown,
  ) => Promise<"yes" | "always" | "no"> | "yes" | "always" | "no";
  /** ask_user channel (TUI: the inline question block, ADR-0019). */
  onAskUser?: (set: AskUserQuestionSet) => Promise<AskUserSetResult> | AskUserSetResult;
  /** Project MCP server consent (TUI: reuses the permission modal). */
  onMcpTrust?: (server: string) => Promise<McpConsentAnswer> | McpConsentAnswer;
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

  // MCP (#15): project (moh.json, consent) first, then user (~/.moh/config, trusted).
  // Computed before the store exists so a throwing read leaves no orphan
  // session file behind. Project trust is resolved from the user config's
  // `mcpTrust` section (#352/SEC-01): the repo's own `trusted` field is ignored.
  const userFile = userConfigFile(home);
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

  try {
    const session = new AgentSession({
      provider,
      endpoints: config.endpoints ?? [],
      cwd: options.cwd,
      ...(mpm ? { mpm } : {}),
      tools: o.tools ?? builtinTools({ ledgerRoot: join(mohHome, "bash-ledgers") }),
      mohHome,
      sessionFile: store.file,
      externalGrowth: () => store.externalGrowth(),
      ...(o.firstParty ? { firstParty: o.firstParty } : {}),
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
    });
    return { session, store };
  } catch (e) {
    return assemblyError("session", e);
  }
}
