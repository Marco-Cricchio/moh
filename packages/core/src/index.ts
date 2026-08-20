import { MockProvider } from "./mock-provider";
import { AgentSession } from "./session";
import type { AgentEvent, Message, Provider, StreamEvent, Tool, ToolContext, TurnResult } from "./types";

export interface SessionConfig {
  /**
   * A Provider instance (e.g. `MockProvider.scripted([...])`).
   * Each session owns its loop state; instances are never shared globally.
   */
  provider: Provider;
  /** Per-turn iteration cap. Default 50. */
  maxIterations?: number;
  /** Tools available to the model, keyed by tool name. */
  tools?: Record<string, Tool>;
  /** Working root for tool executions. Default process.cwd(). */
  cwd?: string;
}

export function createSession(config: SessionConfig): AgentSession {
  return new AgentSession(config);
}

export {
  AgentSession,
  MockProvider,
  type AgentEvent,
  type Message,
  type Provider,
  type StreamEvent,
  type Tool,
  type ToolContext,
  type TurnResult,
};
