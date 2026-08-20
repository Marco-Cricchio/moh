/**
 * Session factory for the TUI: resolves the provider like `moh run`
 * (explicit provider > moh.json provider/endpoint > mock demo) and wires
 * persistence to a SessionStore.
 */
import { join } from "node:path";
import {
  MockProvider,
  SessionStore,
  builtinTools,
  createSession,
  loadMohConfig,
  resolveProvider,
  type AgentEvent,
  type AgentSession,
  type MohConfig,
  type Provider,
} from "@moh/core";

export interface OpenSessionOptions {
  cwd: string;
  /** Pre-configured provider (tests, explicit override). */
  provider?: Provider;
  /** Session store to sink events into (created fresh when omitted). */
  store?: SessionStore;
  /** Persisted events to resume from (the store must be that file). */
  resumeEvents?: ReadonlyArray<AgentEvent>;
  home?: string;
}

/** moh.json for the project; null when absent/unreadable (zero-config mock). */
function readMohConfigFor(cwd: string): MohConfig | null {
  try {
    return loadMohConfig(join(cwd, "moh.json"));
  } catch {
    return null;
  }
}

export function makeSession(options: OpenSessionOptions): { session: AgentSession; store: SessionStore } {
  const store = options.store ?? SessionStore.create(options.cwd, options.home);
  const session = createSession({
    provider: options.provider ?? resolveDefaultProvider(options.cwd),
    cwd: options.cwd,
    tools: builtinTools(),
    sink: (event) => store.append(event),
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
