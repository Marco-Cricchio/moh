/**
 * Schema version of the AgentEvent log. Bump on breaking event-shape changes.
 */
export const SCHEMA_VERSION = 1;

export type TextPart = { kind: "text"; text: string };
export type ToolCallPart = { kind: "tool_call"; callId: string; name: string; args: unknown };
export type ToolResultPart = { kind: "tool_result"; callId: string; ok: boolean; output: string };
export type MessagePart = TextPart | ToolCallPart | ToolResultPart;

/**
 * One message in the conversation fed to providers.
 */
export interface Message {
  role: "system" | "user" | "assistant";
  parts: MessagePart[];
}

export type ProviderErrorKind =
  | "auth"
  | "rate_limited"
  | "quota_exhausted"
  | "overloaded"
  | "network"
  | "invalid_request"
  | "context_length"
  | "content_filtered";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_calls"; calls: { callId: string; name: string; args: unknown }[] }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: FinishReason };

export type FinishReason = "stop" | "tool_calls";

/**
 * A provider talks to a model. Single-shot: it never loops.
 */
export interface Provider {
  readonly name: string;
  stream(
    messages: Message[],
    signal: AbortSignal,
  ): AsyncIterable<StreamEvent>;
}

export type AgentEvent =
  | { type: "session_start"; schemaVersion: number }
  | { type: "user_message"; text: string }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; ok: boolean; output: string }
  | { type: "done" }
  | { type: "error"; reason: string; message: string }
  | { type: "cancelled" };

export type TurnStatus = "done" | "error" | "cancelled";

/** Runtime context handed to every tool execution. */
export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  /** Progressive output channel (streamed partial output); may be a no-op. */
  onProgress: (chunk: string) => void;
}

/** The tool contract every built-in and extension tool implements. */
export interface Tool<A = any> {
  name: string;
  description: string;
  /** Zod schema validating raw model args before execute(). */
  inputSchema: unknown;
  execute(args: A, ctx: ToolContext): Promise<string> | string;
}

export interface TurnResult {
  status: TurnStatus;
  /** Present when status is "error" (e.g. "max_iterations" or a ProviderError kind). */
  reason?: string;
  message?: string;
}
