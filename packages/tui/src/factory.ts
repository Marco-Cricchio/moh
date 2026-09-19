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
  handoffDebug,
  type HandoffOffer,
  type HandoffTransportError,
  type MohConfig,
  type AgentEvent,
  type AgentSession,
  type AskUserQuestionSet,
  type ConfirmTurnRequest,
  type TurnConfirmOutcome,
  type AskUserSetResult,
  type AssemblyError,
  type ExtensionConsentRequest,
  type PermissionAskContext,
  type Provider,
  type Tool,
  type TrackerBackend,
} from "@moh/core";
import { homedir } from "node:os";
import { join } from "node:path";

/** #834: the modal tool id for an extension's enable consent. It is never a
 * tool call: it exists so the ask renders as a question about code. */
export const EXTENSION_CONSENT_TOOL = "extension";

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
  /** Consent seam for the TUI permission modal (#33). The optional
   * `context` marks a request that is not a tool call: an AskUser-level
   * question only (ADR-0031 extension asks, #834 extension enable consent). */
  onPermissionRequest?:
    | ((tool: string, args: unknown, context?: PermissionAskContext) => Promise<"yes" | "always" | "always_for_site" | "no"> | "yes" | "always" | "always_for_site" | "no");
  /** Interactive question channel for the ask_user tool (#70). */
  onAskUser?: (set: AskUserQuestionSet) => Promise<AskUserSetResult> | AskUserSetResult;
  /** ADR-0033 §4 (#791): the pre-send confirmation modal's seam. */
  onConfirmTurn?: (request: ConfirmTurnRequest) => Promise<TurnConfirmOutcome> | TurnConfirmOutcome;
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
            onMcpTrust: (server: string) => {
              const answer = options.onPermissionRequest!(`mcp__${server}`, {});
              // MCP trust has no "always_for_site" — map it to plain always.
              return Promise.resolve(answer).then((a) => (a === "always_for_site" ? "always" : a));
            },
            // #834: enabling a loaded extension rides the same modal — it is
            // the question the user must answer before arbitrary in-process
            // code runs, so it names the extension, its version and its
            // source path, and it resolves to a plain yes/no (never a rule).
            onExtensionConsent: (request: ExtensionConsentRequest) =>
              Promise.resolve(
                options.onPermissionRequest!(
                  EXTENSION_CONSENT_TOOL,
                  { name: request.name, version: request.version, ...(request.file ? { file: request.file } : {}) },
                  { source: "extension", extension: request.name },
                ),
              ).then((answer) => answer !== "no"),
          }
        : {}),
      ...(options.onAskUser ? { onAskUser: options.onAskUser } : {}),
      ...(options.onConfirmTurn ? { onConfirmTurn: options.onConfirmTurn } : {}),
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
  options?: { timeoutMs?: number },
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
    ...(options?.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    enrich: async (payload) => enrichHandoffWithWayfinder(payload, await resolveTracker({ cwd })),
  }).then((result) => {
    if (!result.ok) onWarning(handoffWarning(result.error));
  });
}

/**
 * Startup publish retry (handoff publish retry): when the exit-time
 * publish failed — most often the 2s exit budget expiring on a slow
 * network — the artifact stays local and the next session start retries
 * it with a generous budget, off the exit path entirely. Idempotent via
 * the published marker: an artifact already on the remote is a no-op
 * (the retry resolves without touching gh). Returns `null` when the
 * transport is off. No retry for `no-artifact` (nothing to send) or
 * `newer-remote` (deliberate local state — only an explicit publish
 * may overwrite).
 */export function retryPendingHandoffPublish(
  cwd: string,
  home: string | undefined,
  onWarning: (message: string) => void,
): Promise<unknown> | null {
  return handoffPublishWork(cwd, home, (message) => {
    // A retry timeout is network reality, not an error worth a toast on
    // every startup — only persistent failures already warn at exit. And
    // no artifact simply means nothing to retry: silence.
    if (!message.includes("exit budget") && !message.includes("no local artifact") && !message.includes("remote handoff is newer")) onWarning(message);
  }, { timeoutMs: 10_000 });
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
    case "newer-remote":
      return `handoff: the remote handoff is newer (${error.remoteUpdatedAt}) — not overwritten; publish explicitly to confirm`;
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
  let active = false;
  try {
    active = transportActive(loadMergedConfig(cwd, { home })?.handoff);
  } catch {
    // A broken config already surfaced loudly at session assembly.
    handoffDebug("transport-off", { reason: "broken-config" });
    return { status: "none" };
  }
  handoffDebug("transport-active", { active });
  if (!active) return { status: "none" };
  handoffDebug("fetch-start", { cwd });
  return discoverHandoff({
    cwd,
    home: home ?? homedir(),
    transport: createGistHandoffTransport({ cwd, home }),
  });
}

/** #595: whether gist handoff is active for `cwd` (merged config), for the
 * cold-directory auto-scan gate. Fail-silent: a broken config is no scan. */
export function transportActiveFor(cwd: string, home?: string): boolean {
  try {
    return transportActive(loadMergedConfig(cwd, { home })?.handoff);
  } catch {
    return false;
  }
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
