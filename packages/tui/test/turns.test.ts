import { describe, expect, test } from "bun:test";
import { projectTurns } from "../src/turns";
import type { AgentEvent } from "@moh/core";

const ev = (e: AgentEvent) => e;

describe("projectTurns", () => {
  test("an open log ends with a streaming turn", () => {
    const turns = projectTurns([
      ev({ type: "session_start", schemaVersion: 1, promptVersion: "p" }),
      ev({ type: "user_message", text: "hi" }),
      ev({ type: "assistant_delta", text: "Hel" }),
      ev({ type: "assistant_delta", text: "lo" }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.user).toBe("hi");
    expect(turns[0]!.reply).toBe("Hello");
    expect(turns[0]!.phase).toBe("streaming");
  });

  test("done settles the turn; tool calls pair by callId", () => {
    const turns = projectTurns([
      ev({ type: "user_message", text: "run it" }),
      ev({ type: "tool_call", callId: "a", name: "bash", args: { cmd: "ls" } }),
      ev({ type: "tool_call", callId: "b", name: "read", args: { path: "x" } }),
      ev({ type: "tool_result", callId: "b", ok: true, output: "content" }),
      ev({ type: "assistant_delta", text: "done!" }),
      ev({ type: "done" }),
    ]);
    expect(turns[0]!.phase).toBe("done");
    expect(turns[0]!.toolCalls).toEqual([
      { callId: "a", name: "bash", args: { cmd: "ls" }, ok: null, output: null },
      { callId: "b", name: "read", args: { path: "x" }, ok: true, output: "content" },
    ]);
  });

  test("steering: cancelled turn then a new user_message opens a new turn", () => {
    const turns = projectTurns([
      ev({ type: "user_message", text: "first" }),
      ev({ type: "assistant_delta", text: "par" }),
      ev({ type: "cancelled" }),
      ev({ type: "user_message", text: "actually, wait" }),
      ev({ type: "assistant_delta", text: "ok" }),
      ev({ type: "done" }),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.phase).toBe("cancelled");
    expect(turns[0]!.reply).toBe("par");
    expect(turns[1]!.user).toBe("actually, wait");
    expect(turns[1]!.phase).toBe("done");
  });

  test("error settles the turn with reason and message", () => {
    const turns = projectTurns([
      ev({ type: "user_message", text: "go" }),
      ev({ type: "error", reason: "auth", message: "bad key" }),
    ]);
    expect(turns[0]!.phase).toBe("error");
    expect(turns[0]!.error).toEqual({ reason: "auth", message: "bad key" });
  });

  test("chrome events are not turns", () => {
    const turns = projectTurns([
      ev({ type: "session_start", schemaVersion: 1, promptVersion: "p" }),
      ev({ type: "session_mode", mode: "normal" }),
      ev({ type: "permission_requested", callId: "a", tool: "bash" }),
    ]);
    expect(turns).toHaveLength(0);
  });
});
