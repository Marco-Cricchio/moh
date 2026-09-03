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
  resolveTracker,
  resolveTrackerSync,
  trackerTools,
  sessionFromConfig,
  HandoffRunner,
  enrichHandoffWithWayfinder,
  createGistHandoffTransport,
  publishHandoffAtExit,
  transportActive,
  discoverHandoff,
  type HandoffOffer,
  type HandoffTransportError,
  type MohConfig,
  type AgentEvent,
  type AgentSession,
  type AskUserQuestionSet,
  type AskUserSetResult,
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
  /** The accepted remote handoff that this fresh session supersedes (#437). */
  handoffOffer?: Extract<HandoffOffer, { status: "offer" }>;
  /** Best-effort warning from automatic push-time publication (#437). */
  onHandoffWarning?: (message: string) => void;
  home?: string;
  /** Consent seam for the TUI permission modal (#33). */
  onPermissionRequest?: (tool: string, args: unknown) => Promise<"yes" | "always" | "no"> | "yes" | "always" | "no";
  /** Interactive question channel for the ask_user tool (#70). */
  onAskUser?: (set: AskUserQuestionSet) => Promise<AskUserSetResult> | AskUserSetResult;
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
      ...(options.handoffOffer
        ? { handoffSupersedes: { sessionId: options.handoffOffer.payload.sessionId, updatedAt: options.handoffOffer.payload.updatedAt } }
        : {}),
      ...(options.onHandoffWarning ? { onGitPush: handoffPushWork(options.cwd, options.home, options.onHandoffWarning) } : {}),
    },
  });
}

/**
 * Exit-time handoff publish (#433, T2 #435): when moh.json activates
 * `handoff.transport: "gist"`, the raw artifact (#434) is published to
 * the secret gist through the exit-work budget (ADR-0015). Returns
 * `null` when the transport is off — single machine, byte-for-byte
 * today's behavior (story 8). Failures surface as one warning, never
 * as a crash or a held process (story 15: the artifact stays local).
 */
/** Starts (without awaiting) a bounded publish after a successful git push.
 * A tool call must never wait for gh/network work. */
export function handoffPushWork(
  cwd: string,
  home: string | undefined,
  onWarning: (message: string) => void,
): () => void {
  return () => {
    // Yield before a gist transport starts its synchronous gh runner.
    // The settled turn/tool result is already final when this runs.
    setTimeout(() => {
      const work = handoffPublishWork(cwd, home, onWarning);
      void work;
    }, 0).unref?.();
  };
}

export function handoffPublishWork(
  cwd: string,
  home: string | undefined,
  onWarning: (message: string) => void,
): Promise<unknown> | null {
  let active = false;
  try {
    const config = readMergedConfigFor(cwd, home);
    active = transportActive(config?.handoff);
  } catch {
    // A broken config already surfaced loudly at session assembly.
    return null;
  }
  if (!active) return null;
  return publishHandoffAtExit({
    artifactFile: HandoffRunner.artifactFile(cwd, join(home ?? homedir(), ".moh")),
    transport: createGistHandoffTransport({ cwd, home }),
    enrich: async (payload) => enrichHandoffWithWayfinder(payload, await resolveTracker({ cwd })),
  }).then((result) => {
    if (!result.ok) onWarning(handoffWarning(result.error));
  });
}

/** The one warning line per failure reason (#433 story 15). */
export function handoffWarning(error: HandoffTransportError): string {
  switch (error.reason) {
    case "no-artifact":
      return "handoff: no local artifact to publish";
    case "gh-missing":
      return "handoff: gh is not installed — handoff kept local only";
    case "not-logged-in":
      return "handoff: gh is not logged in — handoff kept local only";
    case "timeout":
      return "handoff: publish exceeded the exit budget — handoff kept local only";
    case "failed":
      return `handoff: publish failed (${error.message}) — handoff kept local only`;
  }
}

/**
 * Startup handoff discovery (#433, T3 #436): when `handoff.transport`
 * is "gist", fetches the newest published handoff and compares it with
 * the newest local session. Returns `{ status: "none" }` whenever the
 * transport is off or anything fails — single machine stays
 * byte-for-byte today's home (story 8); offline/gh-less machines just
 * see no offer (story 15). Never rejects, never hangs (bounded fetch).
 */
export async function discoverHandoffForHome(
  cwd: string,
  home: string | undefined,
): Promise<HandoffOffer> {
  try {
    if (!transportActive(loadMergedConfig(cwd, { home })?.handoff)) return { status: "none" };
  } catch {
    // A broken config already surfaced loudly at session assembly.
    return { status: "none" };
  }
  return discoverHandoff({
    cwd,
    home: home ?? homedir(),
    transport: createGistHandoffTransport({ cwd, home }),
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
