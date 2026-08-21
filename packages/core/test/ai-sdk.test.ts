import { describe, expect, it } from "bun:test";
import { simulateReadableStream } from "ai/test";
import { aiSdkStreamFor } from "../src/providers/ai-sdk";
import { Endpoint, type RouteTarget } from "../src/route";
import type { LanguageModel } from "ai";
import type { Message, StreamEvent, ToolSpec } from "../src/types";

type StreamPart = Record<string, unknown> & { type: string };

/** Minimal LanguageModelV4 mock that records raw doStream params. */
function mockModel(parts: StreamPart[], calls: any[]): LanguageModel {
  return {
    specificationVersion: "v4",
    provider: "mock",
    doStream: async (args: any) => {
      calls.push(args);
      return {
        stream: simulateReadableStream({
          chunks: parts,
        }) as any,
      };
    },
  } as unknown as LanguageModel;
}

function harness(parts: StreamPart[]) {
  const calls: any[] = [];
  const target: RouteTarget = {
    endpoint: new Endpoint({ name: "t-openai", kind: "openai", apiKey: "k" }),
    modelId: "m",
  };
  const stream = aiSdkStreamFor(target, "k", undefined, mockModel(parts, calls));
  return {
    calls,
    run: async (messages: Message[], tools?: readonly ToolSpec[]): Promise<StreamEvent[]> => {
      const events: StreamEvent[] = [];
      for await (const e of stream(messages, new AbortController().signal, tools)) events.push(e);
      return events;
    },
  };
}

const finish = (unified: string) => ({
  type: "finish",
  finishReason: { unified, raw: unified },
  usage: { inputTokens: { total: 1 }, outputTokens: { total: 2 }, totalTokens: 3 },
});

describe("ai-sdk adapter tool plumbing (#46)", () => {
  it("maps tool definitions to the model (name, description, JSON schema, toolChoice auto)", async () => {
    const h = harness([finish("stop")]);
    await h.run(
      [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      [
        {
          name: "read",
          description: "Read a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    );
    const c = h.calls[0]!;
    expect(c.tools).toHaveLength(1);
    expect(c.tools[0].name).toBe("read");
    expect(c.tools[0].description).toBe("Read a file");
    expect(c.tools[0].inputSchema).toMatchObject({ type: "object" });
    expect(c.toolChoice).toEqual({ type: "auto" });
  });

  it("sends no tools when the session offers none", async () => {
    const h = harness([finish("stop")]);
    await h.run([{ role: "user", parts: [{ kind: "text", text: "hi" }] }]);
    const c = h.calls[0]!;
    expect(c.tools ?? []).toHaveLength(0);
  });

  it("resolves the tool name of a tool_result from the pending tool_call (role: tool)", async () => {
    const h = harness([finish("stop")]);
    await h.run([
      {
        role: "assistant",
        parts: [{ kind: "tool_call", callId: "call_1", name: "bash", args: { cmd: "ls" } }],
      },
      {
        role: "user",
        parts: [{ kind: "tool_result", callId: "call_1", ok: true, output: "a b" }],
      },
    ]);
    const messages = h.calls[0]!.prompt;
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content[0]).toMatchObject({ type: "tool-call", toolName: "bash", input: { cmd: "ls" } });
    const toolMsg = messages.at(-1);
    expect(toolMsg.role).toBe("tool");
    expect(toolMsg.content[0]).toMatchObject({
      type: "tool-result",
      toolName: "bash",
      output: { type: "text", value: "a b" },
    });
  });

  it("emits moh tool_calls events from an SDK tool-call stream (single step)", async () => {
    const h = harness([
      {
        type: "tool-call",
        toolCallId: "call_9",
        toolName: "read",
        input: JSON.stringify({ path: "/tmp" }),
      },
      finish("tool-calls"),
    ]);
    const events = await h.run(
      [{ role: "user", parts: [{ kind: "text", text: "hi" }] }],
      [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
    );
    const call = events.find((e) => e.type === "tool_calls") as Extract<StreamEvent, { type: "tool_calls" }>;
    expect(call?.calls).toEqual([{ callId: "call_9", name: "read", args: { path: "/tmp" } }]);
    const fin = events.find((e) => e.type === "finish") as Extract<StreamEvent, { type: "finish" }>;
    expect(fin?.reason).toBe("tool_calls");
    const usage = events.find((e) => e.type === "usage") as Extract<StreamEvent, { type: "usage" }>;
    expect(usage).toMatchObject({ inputTokens: 1, outputTokens: 2 });
    // moh owns the loop: exactly one model call despite the tool-call finish.
    expect(h.calls).toHaveLength(1);
  });
});
