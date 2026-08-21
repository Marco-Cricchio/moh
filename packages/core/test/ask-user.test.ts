import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools } from "../src/builtin-tools";
import { createSession, MockProvider } from "../src/index";
import type { AskUserQuestion, AskUserResult, ToolContext } from "../src/index";

const cwd = mkdtempSync(join(tmpdir(), "moh-askuser-"));
const tools = builtinTools();

function ctxWith(askUser?: (q: AskUserQuestion) => Promise<AskUserResult> | AskUserResult): ToolContext {
  return { signal: new AbortController().signal, cwd, onProgress: () => {}, ...(askUser ? { askUser } : {}) };
}

const validArgs = {
  question: "Which database should we target?",
  options: [
    { label: "Postgres", description: "Mature relational default" },
    { label: "SQLite", description: "Zero-config, file-based" },
  ],
  suggested: "SQLite",
};

describe("ask_user tool", () => {
  test("schema rejects more than 4 options, zero options, or non-unique labels", async () => {
    const five = { ...validArgs, options: [1, 2, 3, 4, 5].map((i) => ({ label: `o${i}`, description: "" })) };
    expect(() => tools.ask_user.inputSchema!.parse(five)).toThrow();
    expect(() => tools.ask_user.inputSchema!.parse({ ...validArgs, options: [] })).toThrow();
    const dup = { ...validArgs, options: [validArgs.options[0]!, { ...validArgs.options[0]! }] };
    expect(() => tools.ask_user.inputSchema!.parse(dup)).toThrow();
  });

  test("schema requires suggested to match exactly one option label", () => {
    expect(() => tools.ask_user.inputSchema!.parse({ ...validArgs, suggested: "Mongo" })).toThrow();
    expect(tools.ask_user.inputSchema!.parse(validArgs)).toBeTruthy();
  });

  test("returns the chosen option label", async () => {
    const ctx = ctxWith(async (q) => {
      expect(q.question).toBe(validArgs.question);
      expect(q.options).toHaveLength(2);
      expect(q.suggested).toBe("SQLite");
      return { choice: "Postgres" };
    });
    const out = await tools.ask_user.execute(validArgs, ctx);
    expect(out).toBe("Postgres");
  });

  test("returns free-text answers verbatim", async () => {
    const ctx = ctxWith(() => ({ text: "whatever the team prefers" }));
    const out = await tools.ask_user.execute(validArgs, ctx);
    expect(out).toBe("whatever the team prefers");
  });

  test("rejects answers that pick a label that was not offered", async () => {
    const ctx = ctxWith(() => ({ choice: "Mongo" }));
    await expect(tools.ask_user.execute(validArgs, ctx)).rejects.toThrow(/not one of the offered options/);
  });

  test("fails fast without an interactive askUser channel (headless)", async () => {
    await expect(tools.ask_user.execute(validArgs, ctxWith())).rejects.toThrow(
      /no interactive user is attached.*without asking/i,
    );
  });

  test("rejects a callback answer carrying neither choice nor text", async () => {
    const ctx = ctxWith(() => ({}) as AskUserResult);
    await expect(tools.ask_user.execute(validArgs, ctx)).rejects.toThrow();
  });

  test("session plumbing: onAskUser answers flow back as a paired tool_result in the event log", async () => {
    const provider = MockProvider.scripted([
      {
        deltas: [],
        finish: "tool_calls",
        toolCalls: [
          {
            name: "ask_user",
            args: { question: "Pick one", options: [{ label: "a", description: "first" }, { label: "b", description: "second" }], suggested: "a" },
          },
        ],
      },
      { deltas: ["thanks, going with the answer"], finish: "stop" },
    ]);
    const session = createSession({
      provider,
      tools: builtinTools(),
      cwd,
      permissions: { bypassPermissions: true },
      onAskUser: async () => ({ choice: "b" }),
    });
    const result = await session.send("decide");
    expect(result.status).toBe("done");
    const log = session.history();
    const call = log.find((e) => e.type === "tool_call")!;
    const res = log.find((e) => e.type === "tool_result")!;
    if (call.type !== "tool_call" || res.type !== "tool_result") throw new Error("missing events");
    expect(res.callId).toBe(call.callId);
    expect(res.ok).toBe(true);
    expect(res.output).toBe("b");
  });
});
