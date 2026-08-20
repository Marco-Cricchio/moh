/**
 * Default provider bundle: Vercel AI SDK as an invisible implementation
 * detail (ADR-0002). No AI SDK type is exported from @moh/core; everything
 * in this module maps between moh types and SDK types.
 */
import { streamText, type LanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { normalizeProviderError } from "../provider-errors";
import type { RouteTarget } from "../route";
import type { Message, StreamEvent, ToolResultPart } from "../types";

function languageModelFor(target: RouteTarget, apiKey: string | undefined, baseUrl: string | undefined): LanguageModel {
  const { kind, name } = target.endpoint;
  if (kind === "anthropic") {
    const anthropic = createAnthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
    return anthropic(target.modelId);
  }
  if (kind === "openai") {
    // Chat Completions, not the Responses API: openai-compat endpoints
    // (z.ai, Ollama, DeepSeek, ...) only expose /chat/completions.
    const openai = createOpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
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
          args: part.args ?? {},
        });
      } else if (part.kind === "tool_result") {
        content.push({
          type: "tool-result",
          toolCallId: part.callId,
          toolName: (part as ToolResultPart & { name?: string }).name ?? part.callId,
          result: part.output,
        });
      }
    }
    out.push({ role: msg.role, content } as never);
  }
  return { system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, messages: out };
}

/**
 * Single-shot streaming call via the AI SDK. The SDK's internal multi-step
 * loop is disabled (`stopWhen: []`-equivalent by not using tools here yet:
 * moh owns the loop). Errors are normalized to the 9-kind taxonomy.
 */
export function aiSdkStreamFor(
  target: RouteTarget,
  apiKey: string | undefined,
  baseUrl: string | undefined,
): (messages: Message[], signal: AbortSignal) => AsyncIterable<StreamEvent> {
  const model = languageModelFor(target, apiKey, baseUrl);
  return (messages, signal) => {
    return {
      async *[Symbol.asyncIterator]() {
        const { system, messages: aiMessages } = toAiMessages(messages);
        const result = streamText({
          model,
          system: system ?? undefined,
          messages: aiMessages ?? [],
          abortSignal: signal,
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
