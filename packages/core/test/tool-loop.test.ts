import { describe, expect, test } from "bun:test";
import { z } from "zod";
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
      permissions: { bypassPermissions: true },
    });

    const result = await session.send("use the tool");

    expect(result.status).toBe("done");
    const log = session.history();
    expect(log.map((e: any) => e.type)).toEqual([
      "session_start",
      "session_mode",
      "user_message",
      "tool_call",
      "permission_granted",
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

  test("parallel same-turn tool calls land tool_result events in completion order", async () => {
    const slow = {
      name: "slow",
      description: "",
      inputSchema: undefined,
      execute: async () => {
        await Bun.sleep(50);
        return "slow done";
      },
    } as Tool;
    const fast = {
      name: "fast",
      description: "",
      inputSchema: undefined,
      execute: async () => {
        await Bun.sleep(5);
        return "fast done";
      },
    } as Tool;
    const provider = MockProvider.scripted([
      {
        deltas: [],
        finish: "tool_calls",
        toolCalls: [
          { name: "slow", args: {} },
          { name: "fast", args: {} },
        ],
      },
      { deltas: ["ok"], finish: "stop" },
    ]);
    const session = createSession({ provider, tools: { slow, fast }, permissions: { bypassPermissions: true } });

    const result = await session.send("run both");
    expect(result.status).toBe("done");
    const results = session
      .history()
      .filter((e: any) => e.type === "tool_result") as any[];
    expect(results.map((r) => r.output)).toEqual(["fast done", "slow done"]);
  });

  test("invalid tool arguments are rejected by the schema as an error tool_result", async () => {
    const strict: Tool<{ text: string }> = {
      name: "strict",
      description: "",
      inputSchema: z.object({ text: z.string().min(1) }),
      execute: async (args) => `got ${args.text}`,
    };
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "strict", args: { text: 42 } }] },
      { deltas: ["recovered"], finish: "stop" },
    ]);
    const session = createSession({ provider, tools: { strict } });

    const result = await session.send("bad args");
    expect(result.status).toBe("done");
    const toolResult = session.history().find((e: any) => e.type === "tool_result")! as any;
    expect(toolResult.ok).toBe(false);
    expect(toolResult.output).toContain("invalid arguments");
    expect(toolResult.output).toContain("text");
  });

  test("failing tool produces an error tool_result the model sees; turn continues", async () => {
    const seenByModel: any[] = [];
    const boom: Tool = {
      name: "boom",
      description: "",
      inputSchema: undefined,
      execute: async () => {
        throw new Error("kaboom");
      },
    };
    const provider = MockProvider.scripted([
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "boom", args: {} }] },
      { deltas: ["recovered"], finish: "stop" },
    ]);
    const recorder = recording(provider);
    const session = createSession({ provider: recorder.wrapped, tools: { boom }, permissions: { bypassPermissions: true } });

    const result = await session.send("fail once");
    expect(result.status).toBe("done");

    const errorResult = session.history().find((e: any) => e.type === "tool_result")! as any;
    expect(errorResult.ok).toBe(false);
    expect(errorResult.output).toContain("kaboom");

    // The model saw the failure in the follow-up call and still finished.
    expect(JSON.stringify(recorder.calls[1])).toContain("kaboom");
    expect(session.history().at(-1)!.type).toBe("done");
  });
});
