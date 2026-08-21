/**
 * Session factory for the TUI: resolves the provider like `moh run`
 * (explicit provider > moh.json provider/endpoint > mock demo) and wires
 * persistence to a SessionStore.
 */
import {
  MockProvider,
  SessionStore,
  builtinTools,
  createSession,
  declaredMcpServers,
  declaredUserMcpServers,
  loadMohConfig,
  resolveProvider,
  resolveTrackerSync,
  trackerTools,
  type AgentEvent,
  type AgentSession,
  type DeclaredMcpServer,
  type MohConfig,
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
  /** Default permission mode for new sessions (user config; bypass stays CLI-only). */
  permissionMode?: "normal" | "auto-accept";
  /** Tool registry override (tests). Default: built-ins (+ tracker tools in workflow mode). */
  tools?: Record<string, Tool>;
  /** Workflow mode (#36): includes first-party skills and tracker tools. */
  workflow?: boolean;
  /** Pre-resolved tracker backend (tests); default: resolveTracker. */
  tracker?: TrackerBackend | null;
}

/** moh.json for the project; null when absent/unreadable (zero-config mock). */
function readMohConfigFor(cwd: string): MohConfig | null {
  try {
    return loadMohConfig(join(cwd, "moh.json"));
  } catch {
    return null;
  }
}

/** Declared MCP servers: project (moh.json) first, then user (~/.moh/config). */
export function declaredServersFor(cwd: string, home?: string): DeclaredMcpServer[] {
  const config = readMohConfigFor(cwd);
  const project = config ? declaredMcpServers(config) : [];
  const user = declaredUserMcpServers(join(home ?? homedir(), ".moh", "config"));
  return [...project, ...user];
}

export function makeSession(options: OpenSessionOptions): { session: AgentSession; store: SessionStore } {
  const store = options.store ?? SessionStore.create(options.cwd, options.home);
  const mcpServers = declaredServersFor(options.cwd, options.home);
  const mohHome = join(options.home ?? homedir(), ".moh");
  const tracker =
    options.tracker !== undefined ? options.tracker : options.workflow ? resolveTrackerSync({ cwd: options.cwd }) : null;
  const config = readMohConfigFor(options.cwd);
  const tools = options.tools ?? {
    ...builtinTools(),
    ...(tracker ? trackerTools(tracker) : {}),
  };
  const session = createSession({
    provider: options.provider ?? resolveDefaultProvider(options.cwd),
    cwd: options.cwd,
    tools,
    // Workflow mode (#36): first-party skills join the index; off filters
    // them out so base behavior stays untouched. Tracker tools join the
    // registry under the same permission spine as any built-in.
    mohHome,
    firstParty: options.workflow ? "include" : "exclude",
    ...(mcpServers.length
      ? {
          mcp: {
            servers: mcpServers,
            // Project servers ask consent on first use; the TUI reuses the
            // same permission modal seam used for tool calls.
            ...(options.onPermissionRequest
              ? { onConsent: (server: string) => options.onPermissionRequest!(`mcp__${server}`, {}) }
              : {}),
          },
        }
      : {}),
    ...(options.onPermissionRequest ? { onPermissionRequest: options.onPermissionRequest } : {}),
    ...(options.permissionMode ? { permissions: { mode: options.permissionMode } } : {}),
    sink: (event) => store.append(event),
    // Subagents (#13): presets from moh.json `agents` merge over the built-ins.
    ...(config?.agents ? { subagents: { presets: config.agents } } : {}),
    ...(options.resumeEvents ? { resume: { events: options.resumeEvents } } : {}),
  });
  return { session, store };
}

/** moh.json `provider` reference, mock demo when nothing is configured. */
export function resolveDefaultProvider(cwd: string): Provider {
  const config = readMohConfigFor(cwd);
  if (config) {
    try {
      return resolveProvider(config);
    } catch {
      // invalid provider reference: fall through to the mock demo
    }
  }
  return MockProvider.demo();
}

/** Model label shown in the dev status line. */
export function providerLabel(provider: Provider | undefined, cwd: string): string {
  if (provider) return provider.name;
  return readMohConfigFor(cwd)?.provider ?? "mock";
}
