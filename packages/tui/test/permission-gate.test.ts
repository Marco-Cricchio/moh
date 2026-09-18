import { describe, expect, test } from "bun:test";
import { describePermissionRequest, PermissionGate } from "../src/permission-gate";

describe("describePermissionRequest", () => {
  test("bash shows the full command; compounds have no unsafe flattened runtime rule", () => {
    const view = describePermissionRequest("bash", { command: "git status --short && echo done" });
    expect(view.detail).toEqual(["command: git status --short && echo done"]);
    expect(view.rulePreview).toBeNull();
  });

  test("bash previews a runtime rule for a single command segment", () => {
    const view = describePermissionRequest("bash", { command: "git status --short" });
    expect(view.rulePreview).toBe("bash:git status --short");
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

describe("#775: browser asks", () => {
  test("the ask renders action + domain + element description and a site-scoped rule preview", () => {
    const view = describePermissionRequest("browser", {
      action: "click",
      ref: "e12",
      pageUrl: "https://app.example.com/settings",
      elementDescription: '[button "Delete permanently"]',
    });
    expect(view.detail).toContain('click [button "Delete permanently"] on app.example.com');
    expect(view.rulePreview).toBe("browser:click https://app.example.com/**");
  });

  test("without an element description the ask still shows action + domain", () => {
    const view = describePermissionRequest("browser", { action: "fill", ref: "e3", pageUrl: "http://localhost:3000/login" });
    expect(view.detail.join("\n")).toMatch(/fill \[ref e3\] on localhost:3000/);
    expect(view.rulePreview).toBe("browser:fill http://localhost:3000/**");
  });

  test("a site-scoped runtime rule short-circuits same-site asks", () => {
    const gate = new PermissionGate();
    void gate.ask("browser", { action: "click", ref: "e1", pageUrl: "https://app.example.com/a", elementDescription: "[button \"Go\"]" });
    gate.resolve("always_for_site");
    expect(gate.current).toBeNull();
    return gate.ask("browser", { action: "click", ref: "e2", pageUrl: "https://app.example.com/b" }).then((answer) => {
      expect(answer).toBe("yes");
      expect(gate.current).toBeNull();
    });
  });

  test("a different site asks again after always_for_site", () => {
    const gate = new PermissionGate();
    void gate.ask("browser", { action: "click", ref: "e1", pageUrl: "https://app.example.com/a" });
    gate.resolve("always_for_site");
    let settled: string | null = null;
    const p = gate.ask("browser", { action: "click", ref: "e2", pageUrl: "https://other.test/" }).then((a) => {
      settled = a;
      return a;
    });
    expect(gate.current).not.toBeNull();
    gate.resolve("no");
    return p.then((a) => {
      expect(a).toBe("no");
      expect(settled).toBe("no");
    });
  });
});
