import { describe, expect, test } from "bun:test";
import { createSession, MockProvider } from "../src/index";
import type { Message, Provider, StreamEvent, Tool } from "../src/index";

function echoTool(): Tool<{ text: string }> {
  return {
    name: "echo",
    description: "echoes text",
    inputSchema: undefined as never,
    execute: async (args: { text: string }) => `echo:${args.text}`,
  };
}

function recording(provider: Provider) {
  const calls: Message[][] = [];
  const wrapped: Provider = {
    name: provider.name,
    stream: (messages, signal) => {
      calls.push(messages);
      return provider.stream(messages, signal);
    },
  };
  return { wrapped, calls };
}

describe("tool-calling loop", () => {
  test("model returns a tool call, core executes it, result returns to the model, turn ends with done", async () => {
    const seenByModel: Message[][] = [];
    const provider = MockProvider.scripted([
      {
        deltas: [],
        finish: "tool_calls",
        toolCalls: [{ name: "echo", args: { text: "hi" } }],
      },
      { deltas: ["done after tool"], finish: "stop" },
    ]);
    const recorder = recording(provider);
    const session = createSession({
      provider: recorder.wrapped,
      tools: { echo: echoTool() },
    });

    const result = await session.send("use the tool");

    expect(result.status).toBe("done");
    const log = session.history();
    expect(log.map((e: any) => e.type)).toEqual([
      "session_start",
      "user_message",
      "tool_call",
      "tool_result",
      "assistant_delta",
      "done",
    ]);
    const toolCall = log.find((e: any) => e.type === "tool_call")!;
    const toolResult = log.find((e: any) => e.type === "tool_result")!;
    expect((toolCall as any).name).toBe("echo");
    expect((toolCall as any).args).toEqual({ text: "hi" });
    expect((toolResult as any).callId).toBe((toolCall as any).callId);
    expect((toolResult as any).ok).toBe(true);
    expect((toolResult as any).output).toBe("echo:hi");

    // Second model call received the tool result in its messages.
    expect(recorder.calls.length).toBe(2);
    expect(JSON.stringify(recorder.calls[1])).toContain("echo:hi");
  });
});
