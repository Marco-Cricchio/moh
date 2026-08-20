import { MockProvider } from "./mock-provider";
import { AgentSession } from "./session";
import { builtinTools } from "./builtin-tools";
import type { AgentEvent, Message, Provider, StreamEvent, Tool, ToolCall, ToolContext, TurnResult } from "./types";

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
  builtinTools,
  type AgentEvent,
  type Message,
  type Provider,
  type StreamEvent,
  type Tool,
  type ToolCall,
  type ToolContext,
  type TurnResult,
};
