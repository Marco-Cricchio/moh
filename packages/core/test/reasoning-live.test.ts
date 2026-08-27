import { describe, expect, it } from "bun:test";
import { createSession } from "../src/index";
import { aiSdkStreamFor } from "../src/providers/ai-sdk";
import { Endpoint, type RouteTarget } from "../src/route";
import type { AgentEvent, Message, Provider, StreamEvent } from "../src/types";

/** #253: live reasoning delivery is provider-neutral. The AI-SDK-native
 * anthropic wire must forward reasoning deltas as they arrive on the wire
 * (fixture SSE with a gated source: each text chunk is enqueued only after
 * the consumer observed the preceding reasoning delta — a buffering
 * implementation deadlocks and the race rejects). */

const encoder = new TextEncoder();
const userMsg: Message[] = [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];

/** Anthropic Messages SSE line for a thinking delta. */
const thinkingDelta = (text: string) =>
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } })}\n\n`;
const textDelta = (text: string) =>
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } })}\n\n`;
const blockStart = (i: number, type: string) =>
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: type === "thinking" ? { type, thinking: "" } : { type, text: "" } })}\n\n`;
const messageStart =
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "claude", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`;
const messageDelta =
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}\n\n`;
const messageStop = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;

describe("anthropic live reasoning streaming (#253)", () => {
  it("forwards reasoning deltas incrementally through the neutral adapter", async () => {
    const seen: string[] = [];
    const waitFor = (text: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${text}" (got: ${seen.join("|")})`)), 2000);
        const check = () => {
          if (seen.includes(text)) {
            clearTimeout(timer);
            resolve();
          } else setTimeout(check, 5);
        };
        check();
      });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(messageStart));
        controller.enqueue(encoder.encode(blockStart(0, "thinking")));
        controller.enqueue(encoder.encode(thinkingDelta("plan a. ")));
        await waitFor("plan a. ");
        controller.enqueue(encoder.encode(thinkingDelta("plan b.")));
        await waitFor("plan b.");
        controller.enqueue(encoder.encode(blockStart(1, "text")));
        controller.enqueue(encoder.encode(textDelta("the answer")));
        controller.enqueue(encoder.encode(messageDelta));
        controller.enqueue(encoder.encode(messageStop));
        controller.close();
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const target: RouteTarget = {
      endpoint: new Endpoint({ name: "a", kind: "anthropic", apiKey: "k" }),
      modelId: "claude-sonnet-4",
    };
    const events: StreamEvent[] = [];
    try {
      const stream = aiSdkStreamFor(target, "k", undefined);
      for await (const e of stream(userMsg, new AbortController().signal, undefined, { thinking: { level: "high" } })) {
        if (e.type === "reasoning_delta") seen.push(e.text);
        events.push(e);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
    const kinds = events.map((e) => e.type);
    expect(kinds).toContain("reasoning_start");
    expect(seen).toEqual(["plan a. ", "plan b."]);
    // text after reasoning, order preserved
    expect(kinds.indexOf("reasoning_delta")).toBeLessThan(kinds.indexOf("text_delta"));
    expect(kinds[kinds.length - 1]).toBe("finish");
  });
});

/** #253: the Core forwards the neutral reasoning lifecycle to a live,
 * non-persisted channel while the model thinks. The provider gates its
 * text on the live observer having seen each delta — proves the loop
 * relays reasoning in real time, and that the log never sees deltas. */
describe("core live reasoning channel (#253)", () => {
  it("session.onLiveEvent receives reasoning deltas live; the log keeps only the completed block", async () => {
    const liveSeen: string[] = [];
    const waitFor = (text: string) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for live "${text}" (got: ${liveSeen.join("|")})`)), 2000);
        const check = () => {
          if (liveSeen.includes(text)) {
            clearTimeout(timer);
            resolve();
          } else setTimeout(check, 5);
        };
        check();
      });
    const logged: AgentEvent[] = [];
    const provider: Provider = {
      name: "reasoner",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "model_call_start", model: "reasoner" };
        yield { type: "reasoning_start" };
        yield { type: "reasoning_delta", text: "live one " };
        await waitFor("live one ");
        yield { type: "reasoning_delta", text: "live two" };
        await waitFor("live two");
        yield { type: "reasoning_end" };
        yield { type: "text_delta", text: "answer" };
        yield { type: "finish", reason: "stop" };
      },
    };
    const session = createSession({ provider, sink: (event) => logged.push(event) });
    session.onLiveEvent((event) => {
      if (event.type === "reasoning_delta") liveSeen.push(event.text);
    });
    await session.send("hi");
    expect(liveSeen).toEqual(["live one ", "live two"]);
    // persistence semantics unchanged: completed block only, no deltas
    expect(logged.some((e) => (e as { type: string }).type === "reasoning_delta")).toBe(false);
    expect(logged).toContainEqual({ type: "reasoning", text: "live one live two" });
  });
});
