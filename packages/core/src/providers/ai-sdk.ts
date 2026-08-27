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
import { wireForKind, type WireApi } from "../wire";
import { openRouterChatModel } from "./openrouter-chat";

/** Transport hints from the credential resolver (#151): ChatGPT-backend
 * URL, extra headers, and the wire protocol that backend speaks. */
export interface AiSdkTransport {
  baseUrl?: string;
  headers?: Record<string, string>;
  wire?: WireApi;
}
import { normalizeProviderError } from "../provider-errors";
import { FORMAT_EXPRESSIBLE_LEVELS } from "../thinking-preferences";
import type { RouteTarget } from "../route";
import type { Message, StreamEvent, StreamOptions, ThinkingFormat, ThinkingLevel, ToolSpec } from "../types";

/** #240/#256: the effective thinking level a wire can actually send.
 * A config-declared format (#256) overrides the wire-derived mapping —
 * the declaration is the user's explicit statement of what the backend
 * accepts. Levels the wire/format cannot express are dropped (never
 * silently remapped) — moh then sends nothing and audits no level. */
export function thinkingForWire(
  wire: WireApi,
  level: ThinkingLevel,
  format?: ThinkingFormat,
): { providerOptions: Record<string, unknown>; effective: ThinkingLevel } | undefined {
  // #256: declared formats map directly; they apply regardless of the
  // wire the model travels (that is their point — openai-compat backends
  // with non-OpenAI reasoning shapes).
  if (format === "anthropic-effort") {
    return level === "off"
      ? { providerOptions: { anthropic: { thinking: { type: "disabled" } } }, effective: level }
      : { providerOptions: { anthropic: { effort: level } }, effective: level };
  }
  if (format === "google-thinking-level") {
    if (!FORMAT_EXPRESSIBLE_LEVELS["google-thinking-level"].includes(level)) return undefined;
    return {
      providerOptions: { google: { thinkingConfig: level === "off" ? { thinkingLevel: null } : { thinkingLevel: level } } },
      effective: level,
    };
  }
  if (format === "openai-effort" || format === "openrouter-effort") {
    return { providerOptions: { openai: { reasoningEffort: level === "off" ? "none" : level } }, effective: level };
  }
  if (wire === "anthropic-messages") {
    // off = explicit disable; all five effort levels are native.
    return level === "off"
      ? { providerOptions: { anthropic: { thinking: { type: "disabled" } } }, effective: level }
      : { providerOptions: { anthropic: { effort: level } }, effective: level };
  }
  if (wire === "google") {
    if (!FORMAT_EXPRESSIBLE_LEVELS["google-thinking-level"].includes(level)) return undefined;
    // google: null disables; low/medium/high are native.
    return {
      providerOptions: { google: { thinkingConfig: level === "off" ? { thinkingLevel: null } : { thinkingLevel: level } } },
      effective: level,
    };
  }
  // openai-chat / openai-responses: reasoningEffort; "none" disables.
  return { providerOptions: { openai: { reasoningEffort: level === "off" ? "none" : level } }, effective: level };
}

/**
 * Anthropic requires `anthropic-beta: claude-code-20250219,oauth-2025-04-20` on API calls made
 * with subscriber (OAuth) access tokens (issue #134). Returned only for
 * subscription-authed anthropic endpoints; api-key traffic is untouched.
 */
export function anthropicSubscriptionHeaders(authKind: AuthMethodKind): Record<string, string> | undefined {
  return authKind === "subscription" ? { ...ANTHROPIC_OAUTH_BETA } : undefined;
}

function languageModelFor(
  target: RouteTarget,
  apiKey: string | undefined,
  transport: AiSdkTransport | undefined,
): LanguageModel {
  const { kind, name } = target.endpoint;
  const baseUrl = transport?.baseUrl;
  const headers = transport?.headers;
  // ADR-0010 (#159): dispatch on the wire, not the provider kind — kimi
  // and copilot speak anthropic-messages against their own backends, and
  // copilot switches wire per model (catalog metadata on the target).
  const wire: WireApi = transport?.wire ?? target.wire ?? wireForKind(kind);
  // OAuth beta headers apply only to the anthropic provider's own
  // subscription grants — never to other backends that happen to speak
  // the anthropic-messages wire.
  const anthropicHeaders = kind === "anthropic" ? anthropicSubscriptionHeaders(target.endpoint.authKind) : undefined;
  if (wire === "anthropic-messages") {
    const anthropic = createAnthropic({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      ...(anthropicHeaders ? { headers: anthropicHeaders } : {}),
    });
    return anthropic(target.modelId);
  }
  if (wire === "google") {
    const google = createGoogleGenerativeAI({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
    return google(target.modelId);
  }
  const openai = createOpenAI({
    apiKey,
    ...(baseUrl ? { baseURL: baseUrl } : {}),
    ...(headers ? { headers } : {}),
  });
  if (wire === "openai-responses") {
    return openai.responses(target.modelId);
  }
  if (wire === "openai-chat") {
    // #251: openrouter models marked `compat.thinkingFormat: "openrouter"`
    // travel the openai-chat wire but need OpenRouter's own reasoning
    // request/response shapes — applied at this wire/compat seam.
    if (target.compat?.thinkingFormat === "openrouter" || target.thinkingFormat === "openrouter-effort") {
      return openRouterChatModel({
        modelId: target.modelId,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
        ...(headers ? { headers } : {}),
      });
    }
    return openai.chat(target.modelId);
  }
  throw new Error(`endpoint "${name}": wire "${wire}" has no AI SDK model factory; provide createStream`);
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
      } else if (part.kind === "reasoning") {
        // #240: replayed provider reasoning rides back to the provider with
        // its opaque continuation artifacts (e.g. the signature) — they
        // preserve the exact completed provider context.
        content.push({
          type: "reasoning",
          text: part.text,
          ...(part.continuation ? { providerOptions: part.continuation } : {}),
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
  /** Transport hints for the model client (#151: ChatGPT-backend grant). */
  transport?: AiSdkTransport,
  /** Test seam: internal module (not exported from @moh/core), so the SDK
   * type stays invisible to clients (ADR-0002). Production callers omit it. */
  modelOverride?: LanguageModel,
): (messages: Message[], signal: AbortSignal, tools?: readonly ToolSpec[], options?: StreamOptions) => AsyncIterable<StreamEvent> {
  const model = modelOverride ?? languageModelFor(target, apiKey, transport);
  // ChatGPT-backend invariant (#151 follow-up): the codex backend rejects
  // /responses calls without an explicit `store: false` (400 "Store must
  // be set to false") — same rule the wizard ping hit. The model factory
  // in this @ai-sdk/openai version takes no options, so it rides as a
  // providerOption. Harmless on api.openai.com (the codex clients send
  // it there too); scoped to the responses wire only.
  const responsesStoreFalse =
    (transport?.wire ?? target.wire ?? wireForKind(target.endpoint.kind)) === "openai-responses"
      ? { providerOptions: { openai: { store: false } } }
      : {};
  return (messages, signal, tools, options) => {
    return {
      async *[Symbol.asyncIterator]() {
        const wire: WireApi = transport?.wire ?? target.wire ?? wireForKind(target.endpoint.kind);
        // #240/#256: the neutral thinking-level request, mapped per wire
        // or per config-declared format. Levels the wire/format cannot
        // express are not sent (and not audited) — never remapped.
        const thinking = options?.thinking ? thinkingForWire(wire, options.thinking.level, target.thinkingFormat) : undefined;
        // Announce the RouteTarget serving this call (#83) — `endpoint/model`
        // as moh resolved it. Providers (not routes) announce: one
        // announcement per actual stream, including fallback restarts.
        // #240: the announcement carries the effective thinking level sent.
        yield {
          type: "model_call_start",
          model: `${target.endpoint.name}/${target.modelId}`,
          ...(thinking ? { thinkingLevel: thinking.effective } : {}),
        };
        const { system, messages: aiMessages } = toAiMessages(messages);
        const aiTools = toAiTools(tools);
        const result = streamText({
          model,
          system: system ?? undefined,
          messages: aiMessages ?? [],
          abortSignal: signal,
          ...(aiTools ? { tools: aiTools, toolChoice: "auto" as const, stopWhen: stepCountIs(1) } : {}),
          ...(thinking ? { providerOptions: thinking.providerOptions as never } : {}),
          ...responsesStoreFalse,
          onError: () => {}, // errors surface via fullStream error parts
        });
        for await (const part of result.fullStream) {
          if (signal.aborted) return;
          switch (part.type) {
            case "reasoning-start":
              yield { type: "reasoning_start" };
              break;
            case "reasoning-delta":
              // fullStream carries `text`; raw model chunks use `delta` —
              // accept both shapes so custom LanguageModels keep working.
              yield {
                type: "reasoning_delta",
                text: (part as { text?: string; delta?: string }).text ?? (part as { delta?: string }).delta ?? "",
              };
              break;
            case "reasoning-end":
              // #240: the provider's continuation artifacts (e.g. the
              // Anthropic signature) ride as opaque metadata — persisted,
              // never rendered.
              yield {
                type: "reasoning_end",
                ...(part.providerMetadata ? { continuation: part.providerMetadata as Record<string, unknown> } : {}),
              };
              break;
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
