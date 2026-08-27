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
 * incrementally as they are extracted (#253: reasoning precedes text in
 * OpenRouter streams; a remainder flushes at stream end, covering
 * reasoning-only streams). Opaque/encrypted details ride as providerMetadata —
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
  /** #253: live-emission hook, set by the merge pump while its output
   * stream is active; the extractor calls it synchronously as each
   * reasoning line is parsed off the wire. */
  onExtracted?: () => void;
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
      if (changed) this.buffer.onExtracted?.();
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

/** Injects the extracted reasoning into the inner model's part stream.
 * #253: reasoning is delivered live — the extractor pushes each delta
 * through `buffer.onExtracted` the moment its SSE line is parsed off the
 * wire, so downstream consumers see deltas while the model still thinks
 * instead of one pre-text burst. Two facts make the direct emission safe
 * and ordered:
 *
 * 1. Extraction is driven eagerly: the inner adapter's early-error check
 *    tees and drains the parsed SSE stream before any consumer part
 *    exists, and without it reasoning-only chunks produce no part at all
 *    (and are held back entirely until the first text chunk) — so part-
 *    stream transforms alone cannot deliver incrementally.
 * 2. Extraction is causally upstream of the parts it cleaned: a reasoning
 *    line is parsed (and emitted) before the adapter can produce the part
 *    of any later line, so interleaving in the output preserves wire
 *    order without buffering.
 *
 * The pump below starts the inner part stream in the background and
 * forwards its parts, ending the open reasoning block (with its complete
 * continuation metadata) before the first text/tool part or, for
 * reasoning-only streams, at stream end. The inner `doStream` promise is
 * deliberately NOT awaited before the merged stream is handed back: the
 * stock adapter's early-error gate holds the call unresolved until the
 * first text-capable chunk, which would reintroduce the burst. */
function mergeReasoning(inner: Promise<{ stream: ReadableStream<Part> }>, buffer: ReasoningBuffer): ReadableStream<Part> {
  let emittedTexts = 0;
  let emittedDetails = 0;
  let open = false;
  let ended = true;
  let closed = false;
  let emit: (part: Part) => void = () => {};
  const drain = (): void => {
    if (closed || emittedTexts >= buffer.texts.length) return;
    if (ended) {
      emit({ type: "reasoning-start", id: REASONING_ID });
      open = true;
      ended = false;
    }
    for (; emittedTexts < buffer.texts.length; emittedTexts++) {
      emit({ type: "reasoning-delta", id: REASONING_ID, delta: buffer.texts[emittedTexts] });
    }
  };
  const endBlock = (): void => {
    if (!open) return;
    const details = buffer.details.slice(emittedDetails);
    emittedDetails = buffer.details.length;
    emit({
      type: "reasoning-end",
      id: REASONING_ID,
      providerMetadata: { openrouter: { reasoningDetails: details } },
    });
    open = false;
    ended = true;
  };
  return new ReadableStream<Part>({
    async start(controller) {
      emit = (p) => {
        if (!closed) controller.enqueue(p);
      };
      buffer.onExtracted = drain;
      drain(); // anything extracted before the pump attached
      try {
        // The inner call runs concurrently from doStream (see below); its
        // parts arrive only after the adapter's early-error gate releases
        // at the first text-capable chunk — reasoning emitted until then
        // comes exclusively from the extraction hook above.
        const { stream } = await inner;
        const reader = stream.getReader();
        for (;;) {
          const { value: part, done } = await reader.read();
          if (done) break;
          drain(); // ordering safety net (extraction precedes its parts)
          if (part.type === "text-start" || part.type === "text-delta" || part.type === "tool-input-start") {
            endBlock();
          }
          emit(part);
        }
      } catch (err) {
        buffer.onExtracted = undefined;
        drain();
        endBlock();
        closed = true;
        controller.error(err);
        return;
      } finally {
        buffer.onExtracted = undefined;
      }
      drain();
      endBlock();
      closed = true;
      controller.close();
    },
    cancel() {
      closed = true;
      buffer.onExtracted = undefined;
    },
  });
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
    const buffer: ReasoningBuffer = { texts: [], details: [] };
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
      // #253: started immediately, NOT awaited here — the stock adapter's
      // early-error gate keeps doStream unresolved until the first
      // text-capable chunk, so awaiting would hold the merged stream (and
      // its live reasoning) back to a burst again. The merged stream pumps
      // the promise instead. Cost: the outer result carries no
      // request/response metadata; wire metadata still reaches consumers
      // via the `response-metadata` stream part.
      const innerResult = (inner.doStream as (o: unknown) => Promise<{ stream: ReadableStream<Part> }>)(options);
      void innerResult.catch(() => {}); // observed by the pump; no unhandled rejection
      return { stream: mergeReasoning(innerResult, buffer) } as never;
    },
  } as unknown as LanguageModel;
}
