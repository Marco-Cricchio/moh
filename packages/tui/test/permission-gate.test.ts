import { describe, expect, test } from "bun:test";
import { describePermissionRequest, PermissionGate } from "../src/permission-gate";

describe("describePermissionRequest", () => {
  test("bash shows the full command and the runtime rule it would write", () => {
    const view = describePermissionRequest("bash", { command: "git status --short && echo done" });
    expect(view.detail).toEqual(["command: git status --short && echo done"]);
    expect(view.rulePreview).toBe("bash:git status --short echo done");
  });

  test("path tools show the path and a rule preview", () => {
    const view = describePermissionRequest("write", { path: "src/app.ts", content: "x" });
    expect(view.detail).toEqual(["path: src/app.ts"]);
    expect(view.rulePreview).toBe("write:src/app.ts");
  });

  test("other tools render truncated JSON args", () => {
    const big = { data: "x".repeat(300) };
    const view = describePermissionRequest("fetch", big);
    expect(view.detail[0]!.length).toBeLessThanOrEqual(200);
    expect(view.detail[0]!.endsWith("…")).toBe(true);
  });

  test("tracker claims show the issue, never raw JSON", () => {
    const view = describePermissionRequest("tracker_claim", { id: "357" });
    expect(view.detail).toEqual(["issue: #357"]);
    expect(view.rulePreview).toBe("tracker_claim");
  });
});

describe("PermissionGate", () => {
  test("ask holds pending until resolved; current exposes the view", async () => {
    const gate = new PermissionGate();
    const p = gate.ask("bash", { command: "ls" });
    expect(gate.current?.tool).toBe("bash");
    expect(gate.current?.detail).toEqual(["command: ls"]);
    let settled: string | undefined;
    void p.then((a) => (settled = a));
    gate.resolve("always");
    await Bun.sleep(5);
    expect(settled).toBe("always");
    expect(gate.current).toBeNull();
  });

  test("resolve without a pending request is a no-op; overlapping asks deny", async () => {
    const gate = new PermissionGate();
    gate.resolve("yes"); // no throw
    const first = gate.ask("bash", { command: "ls" });
    const second = await gate.ask("bash", { command: "rm -rf /" });
    expect(second).toBe("no");
    gate.resolve("no");
    expect(await first).toBe("no");
  });

  test("an \"always\" answer persists for the session: later asks never prompt", async () => {
    const gate = new PermissionGate();
    const first = gate.ask("tracker_claim", { id: "1" });
    gate.resolve("always");
    expect(await first).toBe("always");
    // Same tool, different args: the bare runtime rule covers it.
    expect(gate.current).toBeNull();
    expect(await gate.ask("tracker_claim", { id: "2" })).toBe("yes");
    // A different tool still prompts.
    const other = gate.ask("tracker_unclaim", { id: "2" });
    expect(gate.current?.tool).toBe("tracker_unclaim");
    gate.resolve("no");
    expect(await other).toBe("no");
  });

  test("subscribers are notified on ask and resolve", async () => {
    const gate = new PermissionGate();
    const events: number[] = [];
    const unsub = gate.subscribe(() => events.push(gate.version));
    const p = gate.ask("bash", { command: "ls" });
    gate.resolve("yes");
    await p;
    expect(events.length).toBeGreaterThanOrEqual(2);
    unsub();
  });
});
