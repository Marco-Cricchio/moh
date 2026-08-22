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
import { statSync } from "node:fs";
import { join } from "node:path";
import { builtinTools } from "../builtin-tools";
import { declaredMcpServers, loadMohConfig, type MohConfig } from "../config";
import { declaredUserMcpServers, type McpConsentAnswer } from "../mcp";
import { defaultRegistry, resolveProvider, resolveProviderRef } from "../provider-registry";
import { SessionStore } from "../session-store";
import type { PermissionOverrides } from "../permissions";
import type { AgentEvent, AskUserQuestion, AskUserResult, Provider, Tool } from "../types";
import { AgentSession } from "./session";
import { userConfigFile } from "../user-config";
import type { PermissionsConfig } from "./config";

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
  /** ask_user channel (TUI: the question modal). */
  onAskUser?: (question: AskUserQuestion) => Promise<AskUserResult> | AskUserResult;
  /** Project MCP server consent (TUI: reuses the permission modal). */
  onMcpTrust?: (server: string) => Promise<McpConsentAnswer> | McpConsentAnswer;
}

/** Client-specific overrides the builder layers over the moh.json-derived defaults. */
export interface SessionOverrides {
  /** Full tool registry (TUI: built-ins + tracker tools in workflow mode). Default: built-ins. */
  tools?: Record<string, Tool>;
  /** Patch over the config-derived permission config (mode, bypass). Its
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
  let config: MohConfig;
  try {
    config = options.config ?? loadMohConfig(join(options.cwd, "moh.json"));
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
  const home = options.home ?? homedir();
  const mohHome = join(home, ".moh");

  // MCP (#15): project (moh.json, consent) first, then user (~/.moh/config, trusted).
  // Computed before the store exists so a throwing read leaves no orphan
  // session file behind.
  const servers = [...declaredMcpServers(config), ...declaredUserMcpServers(userConfigFile(home))];

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
  const sink = extraSink
    ? (event: AgentEvent) => {
        store.append(event);
        extraSink(event);
      }
    : (event: AgentEvent) => store.append(event);

  try {
    const session = new AgentSession({
      provider,
      cwd: options.cwd,
      tools: o.tools ?? builtinTools(),
      mohHome,
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
      ...(resumeEvents?.length ? { resume: { events: resumeEvents } } : {}),
    });
    return { session, store };
  } catch (e) {
    return assemblyError("session", e);
  }
}
