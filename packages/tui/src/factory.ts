/**
 * Session factory for the TUI: a thin caller of the core's single
 * assembly path (`sessionFromConfig`, ADR-0005). The TUI contributes
 * only what is its own: the permission/ask-user modal seams, the MCP
 * consent route through the same permission modal, tracker tools in
 * workflow mode, and the first-party skill filter. There is no silent
 * demo fallback anymore — a broken moh.json surfaces as a visible
 * `{ error }` result the App reports to the user.
 */
import {
  SessionStore,
  builtinTools,
  loadMergedConfig,
  resolveTrackerSync,
  trackerTools,
  sessionFromConfig,
  type MohConfig,
  type AgentEvent,
  type AgentSession,
  type AskUserQuestion,
  type AskUserResult,
  type AssemblyError,
  type Provider,
  type Tool,
  type TrackerBackend,
} from "@moh/core";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenSessionOptions {
  cwd: string;
  /** Pre-configured provider (tests, explicit override). */
  provider?: Provider;
  /** Session store to sink events into (created fresh when omitted). */
  store?: SessionStore;
  /** Persisted events to resume from (the store must be that file). */
  resumeEvents?: ReadonlyArray<AgentEvent>;
  home?: string;
  /** Consent seam for the TUI permission modal (#33). */
  onPermissionRequest?: (tool: string, args: unknown) => Promise<"yes" | "always" | "no"> | "yes" | "always" | "no";
  /** Interactive question channel for the ask_user tool (#70). */
  onAskUser?: (question: AskUserQuestion) => Promise<AskUserResult> | AskUserResult;
  /** Default permission mode for new sessions (user config; yolo stays launch-only). */
  permissionMode?: "normal" | "auto-accept";
  /** #377: yolo session (launch-only `--yolo`): no permission prompts and
   * unrestricted filesystem for built-in tools. Never persisted, never
   * settable from Settings. */
  yolo?: boolean;
  /** Tool registry override (tests). Default: built-ins (+ tracker tools in workflow mode). */
  tools?: Record<string, Tool>;
  /** Workflow mode (#36): includes first-party skills and tracker tools. */
  workflow?: boolean;
  /** Pre-resolved tracker backend (tests); default: resolveTracker. */
  tracker?: TrackerBackend | null;
}

export type MakeSessionResult =
  | { session: AgentSession; store: SessionStore }
  | { error: AssemblyError };

export function makeSession(options: OpenSessionOptions): MakeSessionResult {
  const tracker =
    options.tracker !== undefined ? options.tracker : options.workflow ? resolveTrackerSync({ cwd: options.cwd }) : null;
  const tools = options.tools ?? {
    ...builtinTools({ ledgerRoot: join(options.home ?? homedir(), ".moh", "bash-ledgers") }),
    ...(tracker ? trackerTools(tracker) : {}),
  };
  return sessionFromConfig({
    cwd: options.cwd,
    home: options.home,
    provider: options.provider,
    consent: {
      // Project MCP servers ask consent on first use; the TUI reuses the
      // same permission modal seam used for tool calls.
      ...(options.onPermissionRequest
        ? {
            onPermissionRequest: options.onPermissionRequest,
            onMcpTrust: (server: string) => options.onPermissionRequest!(`mcp__${server}`, {}),
          }
        : {}),
      ...(options.onAskUser ? { onAskUser: options.onAskUser } : {}),
    },
    overrides: {
      tools,
      // Workflow mode (#36): first-party skills join the index; off filters
      // them out so base behavior stays untouched.
      firstParty: options.workflow ? "include" : "exclude",
      ...(options.yolo
        ? { permissions: { ...options.permissionMode ? { mode: options.permissionMode } : {}, unrestrictedTools: true } }
        : options.permissionMode ? { permissions: { mode: options.permissionMode } } : {}),
      ...(options.store ? { store: options.store } : {}),
      ...(options.resumeEvents ? { resumeEvents: options.resumeEvents } : {}),
    },
  });
}

/** Merged provider view (project moh.json + user config, #129) for the
 * status-line label. Display-only and warning-only (decision 6): a broken
 * config still surfaces loudly at session assembly; here it just shows a
 * warning label instead of crashing the chrome.
 * Returns `null` when the merged view is broken. */
function readMergedConfigFor(cwd: string, home?: string): MohConfig | null {
  try {
    return loadMergedConfig(cwd, { home });
  } catch {
    return null;
  }
}

/** Model label shown in the dev status line. */
export function providerLabel(provider: Provider | undefined, cwd: string, home?: string): string {
  if (provider) return provider.name;
  const config = readMergedConfigFor(cwd, home);
  if (config === null) return "invalid config";
  return config.provider ?? "mock";
}
