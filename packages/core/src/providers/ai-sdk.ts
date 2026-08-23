/**
 * Default provider bundle: Vercel AI SDK as an invisible implementation
 * detail (ADR-0002). No AI SDK type is exported from @moh/core; everything
 * in this module maps between moh types and SDK types.
 */
import { jsonSchema, streamText, stepCountIs, type LanguageModel, type ToolSet } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { AuthMethodKind } from "../auth/types";
import { ANTHROPIC_OAUTH_BETA } from "../auth/anthropic";
import { CHATGPT_CODEX_BASE_URL } from "../auth/openai";
import { normalizeProviderError } from "../provider-errors";
import type { RouteTarget } from "../route";
import type { Message, StreamEvent, ToolSpec } from "../types";

/**
 * Anthropic requires `anthropic-beta: oauth-2025-04-20` on API calls made
 * with subscriber (OAuth) access tokens (issue #134). Returned only for
 * subscription-authed anthropic endpoints; api-key traffic is untouched.
 */
export function anthropicSubscriptionHeaders(authKind: AuthMethodKind): Record<string, string> | undefined {
  return authKind === "subscription" ? { ...ANTHROPIC_OAUTH_BETA } : undefined;
}

function languageModelFor(
  target: RouteTarget,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  headers?: Record<string, string>,
): LanguageModel {
  const { kind, name } = target.endpoint;
  if (kind === "anthropic") {
    const headers = anthropicSubscriptionHeaders(target.endpoint.authKind);
    const anthropic = createAnthropic({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      ...(headers ? { headers } : {}),
    });
    return anthropic(target.modelId);
  }
  if (kind === "openai") {
    const openai = createOpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}), ...(headers ? { headers } : {}) });
    // #151: subscription-authed endpoints without a minted key stream via
    // the ChatGPT backend, which only speaks the Responses API (codex's
    // wire). Minted-key and openai-compat endpoints keep /chat/completions.
    if (target.endpoint.authKind === "subscription" && baseUrl === CHATGPT_CODEX_BASE_URL) {
      return openai.responses(target.modelId);
    }
    return openai.chat(target.modelId);
  }
  if (kind === "google") {
    const google = createGoogleGenerativeAI({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
    return google(target.modelId);
  }
  throw new Error(`endpoint "${name}": kind "${kind}" has no AI SDK model factory; provide createStream`);
}

/** Maps moh messages to AI SDK: system messages become the `system` option. */
function toAiMessages(messages: Message[]): { system: string | undefined; messages: Parameters<typeof streamText>[0]["messages"] } {
  // Tool results carry only a callId; resolve the tool name (#46) from the
  // pending tool_call parts in the same conversation, falling back to callId.
  const toolNames = new Map<string, string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.kind === "tool_call") toolNames.set(part.callId, part.name);
    }
  }
  const out: Parameters<typeof streamText>[0]["messages"] = [];
  const systemParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
      continue;
    }
    const content: unknown[] = [];
    for (const part of msg.parts) {
      if (part.kind === "text") {
        content.push({ type: "text", text: part.text });
      } else if (part.kind === "tool_call") {
        content.push({
          type: "tool-call",
          toolCallId: part.callId,
          toolName: part.name,
          input: part.args ?? {},
        });
      } else if (part.kind === "tool_result") {
        content.push({
          type: "tool-result",
          toolCallId: part.callId,
          toolName: toolNames.get(part.callId) ?? part.callId,
          output: { type: "text", value: part.output },
        });
      }
    }
    // The SDK requires tool results in a `tool` role message (v5+); moh
    // stores them in a user message (#46).
    const isToolMessage = msg.role === "user" && msg.parts.some((p) => p.kind === "tool_result");
    out.push({ role: isToolMessage ? "tool" : msg.role, content } as never);
  }
  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, messages: out };
}

/** moh ToolSpec -> SDK tool definition. No `execute`: moh owns the loop. */
function toAiTools(specs: readonly ToolSpec[] | undefined): ToolSet | undefined {
  if (!specs || specs.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const spec of specs) {
    tools[spec.name] = {
      description: spec.description,
      ...(spec.parameters ? { inputSchema: jsonSchema(spec.parameters as never) } : {}),
    } as never;
  }
  return tools;
}

/**
 * Single-shot streaming call via the AI SDK. moh owns the loop: tools are
 * sent as definitions only (no `execute`) and the SDK multi-step loop is
 * pinned to one step (`stopWhen: stepCountIs(1)`). Errors are normalized
 * to the 9-kind taxonomy.
 */
export function aiSdkStreamFor(
  target: RouteTarget,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  /** Extra headers for the model client (#151: ChatGPT-backend originator). */
  headers?: Record<string, string>,
  /** Test seam: internal module (not exported from @moh/core), so the SDK
   * type stays invisible to clients (ADR-0002). Production callers omit it. */
  modelOverride?: LanguageModel,
): (messages: Message[], signal: AbortSignal, tools?: readonly ToolSpec[]) => AsyncIterable<StreamEvent> {
  const model = modelOverride ?? languageModelFor(target, apiKey, baseUrl, headers);
  return (messages, signal, tools) => {
    return {
      async *[Symbol.asyncIterator]() {
        // Announce the RouteTarget serving this call (#83) — `endpoint/model`
        // as moh resolved it. Providers (not routes) announce: one
        // announcement per actual stream, including fallback restarts.
        yield { type: "model_call_start", model: `${target.endpoint.name}/${target.modelId}` };
        const { system, messages: aiMessages } = toAiMessages(messages);
        const aiTools = toAiTools(tools);
        const result = streamText({
          model,
          system: system ?? undefined,
          messages: aiMessages ?? [],
          abortSignal: signal,
          ...(aiTools ? { tools: aiTools, toolChoice: "auto" as const, stopWhen: stepCountIs(1) } : {}),
          onError: () => {}, // errors surface via fullStream error parts
        });
        for await (const part of result.fullStream) {
          if (signal.aborted) return;
          switch (part.type) {
            case "text-delta":
              yield { type: "text_delta", text: part.text };
              break;
            case "tool-call": {
              const input = (part as { input?: unknown }).input ?? {};
              yield { type: "tool_calls", calls: [{ callId: part.toolCallId, name: part.toolName, args: input }] };
              break;
            }
            case "error":
              throw normalizeProviderError(part.error ?? part, signal);
            case "finish":
              yield {
                type: "usage",
                inputTokens: part.totalUsage?.inputTokens ?? 0,
                outputTokens: part.totalUsage?.outputTokens ?? 0,
              };
              yield {
                type: "finish",
                reason: part.finishReason === "tool-calls" ? "tool_calls" : "stop",
              };
              break;
            default:
              break;
          }
        }
      },
    };
  };
}
