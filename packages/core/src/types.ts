/**
 * Schema version of the AgentEvent log. Bump on breaking event-shape changes.
 */
export const SCHEMA_VERSION = 1;

/**
 * The single wording for a tool result synthesized because the turn was
 * cancelled (or the process died) before the tool returned (#237). Both
 * synthesizing sites — ToolRunner at abort time and replayMessages at
 * resume time — must agree, or the replayed log drifts from what a live
 * abort would have written.
 */
export const CANCELLED_TOOL_OUTPUT = "turn cancelled before the tool returned";

import { z } from "zod";
import type { PermissionRule } from "./permissions";

export type TextPart = { kind: "text"; text: string };
/** #240: provider-exposed reasoning attached to an assistant message —
 * completed text plus the provider's opaque continuation artifacts
 * (e.g. a signature) required to resume the exact provider context. */
export type ReasoningPart = { kind: "reasoning"; text: string; continuation?: Record<string, unknown> };
export type ToolCallPart = ToolCall & { kind: "tool_call" };
export type ToolResultPart = { kind: "tool_result"; callId: string; ok: boolean; output: string };
export type MessagePart = TextPart | ReasoningPart | ToolCallPart | ToolResultPart;

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
  | "content_filtered"
  | "aborted";

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
  | { type: "finish"; reason: FinishReason }
  /** #83: providers announce the model serving this call at stream start.
   * #240: the announcement may carry the effective thinking level the
   * provider actually sent (after per-wire capability mapping) — the
   * loop audits it on the `model_call` event. */
  | { type: "model_call_start"; model: string; thinkingLevel?: ThinkingLevel }
  /** #240: provider reasoning stream lifecycle — neutral, SDK-free.
   * Deltas stream live; the loop buffers them and persists the completed
   * block as a single `reasoning` AgentEvent when the call completes. */
  | { type: "reasoning_start" }
  | { type: "reasoning_delta"; text: string }
  | { type: "reasoning_end"; continuation?: Record<string, unknown> }
  /** ADR-0012: the route engine announces a fallback stop: the active
   * target failed with `reason` (a ProviderError kind, e.g.
   * "quota_exhausted") and the request restarts on `to`. */
  | { type: "fallback"; from: string; to: string; reason: string };

export type FinishReason = "stop" | "tool_calls";

/** Token counts as reported by providers (#83). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Tool identity as advertised to providers (name, description, JSON schema). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) of the tool args, from the Zod inputSchema; optional for schema-less tools. */
  parameters?: Record<string, unknown>;
}

/** Canonical thinking-level scale (#239 decision 8, #241). moh never
 * silently remaps one level to another: unsupported levels are not sent. */
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "xhigh" | "max";

/** The canonical level set in display order (#241): the one scale pickers
 * offer and preferences persist, whatever a provider calls its levels. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh", "max"];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** Neutral per-call stream request options (#240). Providers that do not
 * support thinking levels simply ignore them — no invented request fields. */
export interface StreamOptions {
  thinking?: { level: ThinkingLevel };
}

/**
 * A provider talks to a model. Single-shot: it never loops.
 */
export interface Provider {
  readonly name: string;
  /** Feature flags of the underlying endpoint; drive capability downgrades. */
  readonly capabilities?: EndpointCapabilities;
  stream(
    messages: Message[],
    signal: AbortSignal,
    /** Tools the loop offers the model this call (echo/e2e; providers may ignore). */
    tools?: readonly ToolSpec[],
    /** Neutral request options (#240): thinking level. Optional and
     * additive — existing/custom providers keep their signature. */
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent>;
}

/** Per-endpoint feature flags (issue #28). */
export interface EndpointCapabilities {
  caching: boolean;
  parallelToolCalls: boolean;
  multimodal: boolean;
}

export type AgentEvent =
  | { type: "session_start"; schemaVersion: number; promptVersion: string }
  | { type: "user_message"; text: string }
  | { type: "assistant_delta"; text: string }
  | ({ type: "tool_call" } & ToolCall)
  | { type: "tool_result"; callId: string; ok: boolean; output: string }
  /** #83: one record per model call — which model served it and what it cost.
   * #240: `thinkingLevel` audits the effective level actually sent, if any
   * (#239 decision 9: switches, fallbacks, provider defaults accounted). */
  | { type: "model_call"; model: string; usage: TokenUsage; thinkingLevel?: ThinkingLevel; /** #243: the call did not finalize a provider message (interrupted,
   * failed, or superseded by a retry/fallback stop). Its reasoning stays
   * displayable, but replay must not treat its partial content as a valid
   * assistant message. */ failed?: true }
  /** #240: completed provider reasoning of one model call — persisted in
   * the log (Principle 2), replayed into the assistant message context
   * with its opaque continuation artifacts. Emitted before the call's
   * `model_call` event; partial reasoning of interrupted calls never
   * forms a valid assistant message. */
  | { type: "reasoning"; text: string; continuation?: Record<string, unknown> }
  /** Turn rollup (#83): this turn's usage totals and the models that served it. */
  | { type: "done"; usage?: TokenUsage; models?: string[] }
  | { type: "error"; reason: string; message: string }
  | { type: "cancelled" }
  | { type: "permission_requested"; callId: string; tool: string }
  | { type: "permission_granted"; callId: string; tool: string; reason: PermissionGrantReason }
  | { type: "permission_denied"; callId: string; tool: string; reason: string }
  | { type: "permission_rule_added"; rule: PermissionRule }
  | { type: "session_mode"; mode: "normal" | "auto-accept" | "bypass" }
  /** ADR-0011: a turn-scoped skill prompt was attached to this turn's
   * send. Chrome — appended just before the turn's user_message; replay
   * ignores it (the skill body lived in the system prompt, not the log). */
  | { type: "skill_invoked"; name: string }
  /** #166: the active model ref changed mid-session (no new session;
   * takes effect from the next turn). Chrome — replay shows the switch. */
  | { type: "model_switched"; from: string; to: string }
  /** ADR-0012: a fallback stop fired mid-call (route engine). Chrome —
   * replay shows the switch; the TUI toasts it (visible, not silent). */
  | { type: "fallback"; from: string; to: string; reason: string }
  /**
   * Compaction marker: replay uses `summary` in place of the events before
   * index `upTo` (exclusive), while retaining the recent tail; the log
   * itself is never truncated.
   */
  | { type: "compaction"; summary: string; upTo: number }
  | { type: "extension_loaded"; name: string; version: string }
  | { type: "extension_failed"; name: string; reason: string; message: string }
  /** MCP lifecycle (#15): lazy start, per-server failures, session-end stop. */
  | { type: "mcp_server_started"; server: string; tools: string[] }
  | { type: "mcp_server_failed"; server: string; reason: string; message: string }
  | { type: "mcp_server_stopped"; server: string }
  /** Sampling/roots/elicitation request from an MCP server, refused (tools only). */
  | { type: "mcp_refused"; server: string; capability: "sampling" | "roots" | "elicitation" }
  /**
   * Memory (#38): the maintenance subagent appended facts after a turn.
   * Discreet by design — clients may show an indicator, never chat noise.
   */
  | { type: "memory_updated"; entries: number; topics: string[] }
  /** Subagents (#13): a child session was spawned; `log` is its own JSONL file. */
  | { type: "subagent_spawn"; callId: string; name: string; preset?: string; log: string }
  /** Subagent finished; usage tokens accumulated by the child, where exposed. */
  | {
      type: "subagent_result";
      callId: string;
      name: string;
      status: "done" | "error" | "cancelled";
      usage: { inputTokens: number; outputTokens: number };
      log: string;
    };

/** Why an "ask" decision was auto-granted (session mode), never a user round-trip. */
export type PermissionGrantReason = "bypass" | "auto_accept" | "user";

export type TurnStatus = "done" | "error" | "cancelled";

/** One selectable answer of an ask_user question: short label plus a description shown to the user. */
export interface AskUserOption {
  label: string;
  description: string;
}

/** An ask_user question as rendered to the user. */
export interface AskUserQuestion {
  question: string;
  options: AskUserOption[];
  /** The option label flagged as the suggested answer (the ➡️ of the grilling format). */
  suggested: string;
}

/** A user's answer: exactly one of the choice label (an offered option) or free text. */
export type AskUserResult = { choice?: string; text?: string };

/** Runtime context handed to every tool execution. */
export interface ToolContext {
  signal: AbortSignal;
  cwd: string;
  /** Progressive output channel (streamed partial output); may be a no-op. */
  onProgress: (chunk: string) => void;
  /** Skill directories (#30): read-only roots outside cwd the read tool may access. */
  skillDirs?: readonly string[];
  /** 1-based live-run turn sequence — lets tools scope caches per turn
   * (e.g. the read ledger's re-read nudge, #196). */
  turn?: number;
  /** Interactive question channel (ask_user). Absent (headless) → the tool fails fast. */
  askUser?: (question: AskUserQuestion) => Promise<AskUserResult> | AskUserResult;
}

/** The tool contract every built-in and extension tool implements. */
export interface Tool<A = any> {
  name: string;
  description: string;
  /** Zod schema validating raw model args before execute(). */
  inputSchema: z.ZodType<A> | undefined;
  /** True for tools that converse with the human (ask_user): they
   * serialize within a parallel batch — one pending question at a
   * time is a UI invariant (#223). */
  interactive?: boolean;
  execute(args: A, ctx: ToolContext): Promise<string> | string;
}

/** A tool invocation requested by the model. */
export interface ToolCall {
  callId: string;
  name: string;
  args: unknown;
}

export interface TurnResult {
  status: TurnStatus;
  /** Present when status is "error" (e.g. "max_iterations" or a ProviderError kind). */
  reason?: string;
  message?: string;
}

/** ADR-0011: one turn-scoped skill prompt attached to a send. The body
 * rides the system prompt (skills section) for exactly one turn; the
 * user message stays the clean text. */
export interface SkillPrompt {
  /** Skill name for audit/chrome (the `skill_invoked` event). */
  name: string;
  /** Full instructions, body only (frontmatter already stripped). */
  text: string;
}

/** Options for `AgentSession.send` (ADR-0011). */
export interface SendOptions {
  /** Turn-scoped skill prompt; dropped when the turn settles. */
  prompt?: SkillPrompt;
}
