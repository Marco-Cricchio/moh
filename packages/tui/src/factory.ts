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
  loadMohConfig,
  resolveTrackerSync,
  trackerTools,
  sessionFromConfig,
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
  /** Default permission mode for new sessions (user config; bypass stays CLI-only). */
  permissionMode?: "normal" | "auto-accept";
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
    ...builtinTools(),
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
      ...(options.permissionMode ? { permissions: { mode: options.permissionMode } } : {}),
      ...(options.store ? { store: options.store } : {}),
      ...(options.resumeEvents ? { resumeEvents: options.resumeEvents } : {}),
    },
  });
}

/** moh.json for the project; null when absent/unreadable. Display-only
 * (the status-line label): a broken config still surfaces loudly at session
 * assembly (`sessionFromConfig`), this just keeps the chrome from crashing. */
function readMohConfigFor(cwd: string) {
  try {
    return loadMohConfig(join(cwd, "moh.json"));
  } catch {
    return null;
  }
}

/** Model label shown in the dev status line. */
export function providerLabel(provider: Provider | undefined, cwd: string): string {
  if (provider) return provider.name;
  return readMohConfigFor(cwd)?.provider ?? "mock";
}
