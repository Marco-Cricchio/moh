/**
 * OpenRouter Chat Completions compat (#251): models whose catalog entry
 * carries `compat.thinkingFormat: "openrouter"` need two wire-specific
 * translations the stock @ai-sdk/openai chat adapter cannot express:
 *
 * 1. Request: OpenRouter documents `reasoning: { effort, exclude }`,
 *    not the OpenAI-style `reasoning_effort` the chat adapter sends.
 * 2. Response: streamed `delta.reasoning_details` (and the legacy
 *    `delta.reasoning` string) are stripped by the adapter's narrow
 *    chunk schema, so reasoning never reaches moh's neutral lifecycle.
 *
 * Both are handled here as an invisible wrapper LanguageModel: it
 * delegates to the stock openai.chat model through a patched fetch that
 * rewrites the request body and extracts OpenRouter reasoning fields
 * from the SSE stream, then injects standard reasoning-* stream parts
 * in order (reasoning always precedes text in OpenRouter streams;
 * any remainder flushes at stream end, covering reasoning-only
 * streams). Opaque/encrypted details ride as providerMetadata —
 * preserved verbatim for continuation, never rendered, and never
 * leaked as provider-specific stream-part types into the Core contract.
 */
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/** Reasoning extracted from one OpenRouter response. */
interface ReasoningBuffer {
  /** Ordered reasoning text pieces (reasoning.text details, legacy field). */
  texts: string[];
  /** Every raw detail entry, verbatim — continuation metadata. */
  details: unknown[];
  flushed: boolean;
}

function isTextDetail(detail: unknown): detail is { type: string; text: string } {
  if (typeof detail !== "object" || detail === null) return false;
  const d = detail as { type?: unknown; text?: unknown };
  return typeof d.type === "string" && d.type.startsWith("reasoning.text") && typeof d.text === "string";
}

/**
 * SSE line transform: for each complete `data: {json}` line, move
 * `delta.reasoning_details` / legacy `delta.reasoning` into the buffer
 * and emit the cleaned line. Line-buffered, so chunk boundaries in the
 * underlying byte stream are safe (multibyte chars never split: only
 * complete lines are processed, the remainder stays buffered).
 */
class ReasoningExtractor extends TransformStream<Uint8Array, Uint8Array> {
  #decoder = new TextDecoder();
  #encoder = new TextEncoder();
  #partial = "";

  constructor(private buffer: ReasoningBuffer) {
    super({
      transform: (bytes, controller) => {
        this.#partial += this.#decoder.decode(bytes, { stream: true });
        const lines = this.#partial.split("\n");
        this.#partial = lines.pop() ?? "";
        for (const line of lines) controller.enqueue(this.#encoder.encode(`${this.#process(line)}\n`));
      },
      flush: (controller) => {
        this.#partial += this.#decoder.decode();
        if (this.#partial.length > 0) controller.enqueue(this.#encoder.encode(this.#process(this.#partial)));
      },
    });
  }

  #process(line: string): string {
    if (!line.startsWith("data:")) return line;
    const payload = line.slice(5).trimStart();
    if (payload === "[DONE]") return line;
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return line; // not JSON — pass through untouched
    }
    const choices = (json as { choices?: unknown[] }).choices;
    if (!Array.isArray(choices)) return line;
    let changed = false;
    for (const choice of choices) {
      const delta = (choice as { delta?: Record<string, unknown> }).delta;
      if (!delta || typeof delta !== "object") continue;
      if (Array.isArray(delta.reasoning_details)) {
        for (const detail of delta.reasoning_details) {
          this.buffer.details.push(detail);
          if (isTextDetail(detail)) this.buffer.texts.push(detail.text);
        }
        delete delta.reasoning_details;
        changed = true;
      }
      if (typeof delta.reasoning === "string") {
        this.buffer.details.push({ type: "reasoning.text", text: delta.reasoning });
        this.buffer.texts.push(delta.reasoning);
        delete delta.reasoning;
        changed = true;
      }
    }
    return changed ? `data: ${JSON.stringify(json)}` : line;
  }
}

/** OpenRouter's documented request shape:
 * https://openrouter.ai/docs — reasoning: { effort, exclude: false }
 * (never excluded: moh persists and displays provider reasoning). */
function rewriteRequestBody(body: string, effort: string | undefined): string {
  try {
    const json = JSON.parse(body) as Record<string, unknown> & { reasoning_effort?: unknown };
    delete json.reasoning_effort;
    if (effort !== undefined) {
      json.reasoning = { effort, exclude: false };
    }
    return JSON.stringify(json);
  } catch {
    return body; // not JSON — leave untouched, let the server reject it
  }
}

type BaseFetch = typeof fetch;

function patchedFetch(baseFetch: BaseFetch, buffer: ReasoningBuffer, effort: string | undefined): BaseFetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string" && init.body.startsWith("{")) {
      init = { ...init, body: rewriteRequestBody(init.body, effort) };
    }
    const res = await baseFetch(input, init);
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("text/event-stream") || !res.body) return res;
    return new Response(res.body.pipeThrough(new ReasoningExtractor(buffer)), {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }) as BaseFetch;
}

/** The effort moh selected for this call: thinkingForWire maps the
 * neutral level to providerOptions.openai.reasoningEffort (off →
 * "none"); the wrapper reads it and translates it to OpenRouter's
 * shape at the wire, so the Core contract stays provider-neutral. */
function effortFromProviderOptions(providerOptions: unknown): string | undefined {
  const openai = (providerOptions as { openai?: { reasoningEffort?: unknown } } | undefined)?.openai;
  const effort = openai?.reasoningEffort;
  if (typeof effort !== "string" || effort === "none" || effort === "") return undefined;
  return effort;
}

/** Strips the openai reasoningEffort option so the inner chat model
 * does not emit the standard `reasoning_effort` field (double-written
 * then deleted by the fetch rewrite as a second safety net). */
function stripReasoningEffort(providerOptions: unknown): unknown {
  if (typeof providerOptions !== "object" || providerOptions === null) return providerOptions;
  const { openai, ...rest } = providerOptions as { openai?: Record<string, unknown> };
  if (openai === undefined) return providerOptions;
  const { reasoningEffort, ...openaiRest } = openai;
  return Object.keys(openaiRest).length > 0 ? { ...rest, openai: openaiRest } : rest;
}

type Part = Record<string, unknown> & { type: string };
const REASONING_ID = "openrouter-reasoning";

function flushReasoning(buffer: ReasoningBuffer, enqueue: (part: Part) => void): void {
  if (buffer.flushed) return;
  buffer.flushed = true;
  if (buffer.texts.length === 0) return;
  enqueue({ type: "reasoning-start", id: REASONING_ID });
  for (const text of buffer.texts) enqueue({ type: "reasoning-delta", id: REASONING_ID, delta: text });
  enqueue({
    type: "reasoning-end",
    id: REASONING_ID,
    providerMetadata: { openrouter: { reasoningDetails: buffer.details } },
  });
}

/** Injects the buffered reasoning into the inner model's part stream,
 * in order: flushed before the first text/tool part, or at stream end
 * for reasoning-only streams (SSE order guarantees all prior reasoning
 * chunks were extracted before the first text part arrives). */
function mergeReasoning(inner: ReadableStream<Part>, buffer: ReasoningBuffer): ReadableStream<Part> {
  return inner.pipeThrough(
    new TransformStream<Part, Part>({
      transform(part, controller) {
        if (
          !buffer.flushed &&
          (part.type === "text-start" || part.type === "text-delta" || part.type === "tool-input-start")
        ) {
          flushReasoning(buffer, (p) => controller.enqueue(p));
        }
        controller.enqueue(part);
      },
      flush(controller) {
        flushReasoning(buffer, (p) => controller.enqueue(p));
      },
    }),
  ) as ReadableStream<Part>;
}

export interface OpenRouterChatModelOptions {
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Base fetch for the wire; defaults to the global fetch (test seam). */
  fetch?: BaseFetch;
}

/** Wraps the stock openai.chat model with the OpenRouter compat
 * translations (#251). Invisible to the Core: a plain LanguageModel. */
export function openRouterChatModel(options: OpenRouterChatModelOptions): LanguageModel {
  const baseFetch = options.fetch ?? (globalThis.fetch as BaseFetch);
  // One client factory for both the interface prototype and the
  // per-call inner model (the latter swaps in the patched fetch).
  const chatModel = (fetch?: BaseFetch) =>
    createOpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      ...(fetch ? { fetch: fetch as never } : {}),
    }).chat(options.modelId);
  const proto = chatModel() as unknown as {
    specificationVersion: string;
    provider: string;
    modelId: string;
    supportedUrls: unknown;
  };
  // Per-call setup shared by doGenerate/doStream: the reasoning buffer,
  // the effort translation, the stripped options, the inner model.
  const prepare = (callOptions: { providerOptions?: unknown }) => {
    const buffer: ReasoningBuffer = { texts: [], details: [], flushed: false };
    const effort = effortFromProviderOptions(callOptions.providerOptions);
    const stripped = stripReasoningEffort(callOptions.providerOptions);
    const inner = chatModel(patchedFetch(baseFetch, buffer, effort)) as unknown as Record<string, unknown>;
    return { buffer, inner, options: stripped !== callOptions.providerOptions ? { ...callOptions, providerOptions: stripped } : callOptions };
  };
  return {
    specificationVersion: proto.specificationVersion,
    provider: proto.provider,
    modelId: proto.modelId,
    supportedUrls: proto.supportedUrls as never,
    async doGenerate(callOptions: { providerOptions?: unknown; [key: string]: unknown }) {
      const { buffer, inner, options } = prepare(callOptions);
      const result = await (inner.doGenerate as (o: unknown) => Promise<{ content: unknown[] }>)(options);
      if (buffer.texts.length === 0) return result as never;
      const content = [
        {
          type: "reasoning",
          text: buffer.texts.join(""),
          providerMetadata: { openrouter: { reasoningDetails: buffer.details } },
        },
        ...result.content,
      ];
      return { ...result, content } as never;
    },
    async doStream(callOptions: { providerOptions?: unknown; [key: string]: unknown }) {
      const { buffer, inner, options } = prepare(callOptions);
      const result = await (inner.doStream as (o: unknown) => { stream: ReadableStream<Part> })(options);
      return { ...result, stream: mergeReasoning(result.stream, buffer) } as never;
    },
  } as unknown as LanguageModel;
}
