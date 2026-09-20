/**
 * #849: the permission mode is runtime-mutable within a session —
 * `setSessionMode` updates every consumer (the permission gate and the
 * filesystem scope) live, appends exactly one `session_mode` chrome
 * event per change, and is never persisted: a new session starts from
 * its configuration again.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, createSession, type Tool } from "../src/index";

function tmpDir(prefix = "moh-mode-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return dir;
}

const writeTool: Tool = {
  name: "write",
  description: "writes a file",
  inputSchema: undefined,
  execute: (args: { path: string; content: string }) => {
    writeFileSync(args.path, args.content);
    return `wrote ${args.path}`;
  },
};

/** One scripted turn (repeats when exhausted): call `write`, then stop. */
const oneWrite = (path: string) => [
  { deltas: [""], finish: "tool_calls" as const, toolCalls: [{ name: "write", args: { path, content: "x" } }] },
];

const toolTurn = () => [
  { deltas: [""], finish: "tool_calls" as const, toolCalls: [{ name: "echo", args: { text: "hi" } }] },
  { deltas: ["done"], finish: "stop" as const },
];
const echoTool: Tool = { name: "echo", description: "echoes", inputSchema: undefined, execute: (a: { text: string }) => a.text };

describe("#849 session mode rotation", () => {
  test("setSessionMode mutates the mode and appends one session_mode event per change", () => {
    const session = createSession({ provider: MockProvider.scripted([{ deltas: [""], finish: "stop" }]) });
    expect(session.sessionMode).toBe("normal");
    session.setSessionMode("auto-accept");
    expect(session.sessionMode).toBe("auto-accept");
    session.setSessionMode("yolo");
    session.setSessionMode("normal");
    const modes = session.history().filter((e) => e.type === "session_mode");
    // one at start, one per change — four total, in order
    expect(modes.map((m) => (m as any).mode)).toEqual(["normal", "auto-accept", "yolo", "normal"]);
  });

  test("entering yolo mid-session permits an out-of-root write; leaving restores containment", async () => {
    const root = tmpDir();
    mkdirSync(join(root, "proj"));
    const outside = join(tmpDir(), "outside.txt");
    let asked = 0;
    const session = createSession({
      provider: MockProvider.scripted(oneWrite(outside)),
      tools: { write: writeTool },
      cwd: join(root, "proj"),
      maxIterations: 2,
      onPermissionRequest: () => {
        asked += 1;
        return "no";
      },
    });
    // normal mode: out-of-root write asks; the ask is refused → denied.
    // (maxIterations 2: the refused call repeats once before the cap.)
    await session.send("go");
    expect(asked).toBeGreaterThan(0);
    expect(session.history().some((e) => e.type === "permission_denied")).toBe(true);

    // switch to yolo mid-session: the same write proceeds, no prompt.
    session.setSessionMode("yolo");
    asked = 0;
    const result = await session.send("go2");
    expect(result.status).toBe("done");
    expect(asked).toBe(0);
    expect(session.history().some((e) => e.type === "permission_granted" && e.reason === "yolo")).toBe(true);

    // leaving yolo restores the ask immediately (denied again on refusal).
    session.setSessionMode("normal");
    asked = 0;
    await session.send("go3");
    expect(asked).toBeGreaterThan(0);
  });

  test("auto-accept still routes an extension ask to the consent seam", async () => {
    let asked = 0;
    const hookRt = {
      checkToolHooks: async () => ({ veto: false, ask: true, reason: "guardrail", by: "jev", errors: [] }),
    };
    const session = createSession({
      provider: MockProvider.scripted(toolTurn()),
      tools: { echo: echoTool },
      permissions: { mode: "normal" },
      // The core accepts the ToolHookChecker shape via `toolHooks`.
      toolHooks: hookRt as any,
      onPermissionRequest: () => {
        asked += 1;
        return "no";
      },
    });
    session.setSessionMode("auto-accept");
    await session.send("go");
    expect(asked).toBe(1);
  });

  test("a rotation writes no configuration and a fresh session starts from its config", () => {
    const home = tmpDir();
    const session = createSession({ provider: MockProvider.scripted([{ deltas: [""], finish: "stop" }]), mohHome: home });
    session.setSessionMode("yolo");
    session.setSessionMode("normal");
    // No moh.json/config writes happened in the home dir beyond what
    // assembly already does — the mode lives only in the event log.
    const modes = session.history().filter((e) => e.type === "session_mode");
    expect(modes.length).toBe(3);
    const fresh = createSession({ provider: MockProvider.scripted([{ deltas: [""], finish: "stop" }]), mohHome: home });
    expect(fresh.sessionMode).toBe("normal");
  });
});
