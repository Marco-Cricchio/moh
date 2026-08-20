import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools, createSession, MockProvider } from "../src/index";

describe("end-to-end tool usage", () => {
  test("a scripted session writes a file via the write tool and reads it back", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-e2e-"));
    const provider = MockProvider.scripted([
      {
        deltas: [],
        finish: "tool_calls",
        toolCalls: [
          { name: "write", args: { path: "note.txt", content: "moh was here" } },
        ],
      },
      { deltas: [], finish: "tool_calls", toolCalls: [{ name: "read", args: { path: "note.txt" } }] },
      { deltas: ["The note says: moh was here"], finish: "stop" },
    ]);
    const session = createSession({
      provider,
      tools: builtinTools(),
      cwd,
      maxIterations: 10,
      permissions: { mode: "auto-accept" },
    });

    const result = await session.send("write and read a note");
    expect(result.status).toBe("done");

    const log = session.history();
    const calls = log.filter((e: any) => e.type === "tool_call") as any[];
    const results = log.filter((e: any) => e.type === "tool_result") as any[];
    expect(calls.map((c) => c.name)).toEqual(["write", "read"]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(JSON.stringify(results)).toContain("moh was here");

    const lastDelta = log.filter((e: any) => e.type === "assistant_delta").pop()!;
    expect((lastDelta as any).text).toContain("moh was here");
    expect(log.at(-1)!.type).toBe("done");
  });
});
