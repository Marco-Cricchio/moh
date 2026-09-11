import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThemeProvider, THEMES } from "../src/themes";
import { cycleTreeFilter, TreePanel } from "../src/TreePanel";
import { sessionTree, switchBranch, bookmarkNode, SessionStore, createSession, MockProvider } from "@moh/core";
import { stripAnsi, waitForCondition, waitForFrame } from "./helpers";
import type { TreeView } from "@moh/core";

const dir = () => join(tmpdir(), `moh-tui-tree-${process.pid}-${Date.now()}`);

/** Builds a real branched session file through the core seams: two turns
 * on the main line, then a switch to the first turn and a new branch. */
async function buildBranchedSession(): Promise<string> {
  const home = join(dir(), "home");
  const cwd = join(dir(), "repo");
  const store = SessionStore.create(cwd, home);
  const session = createSession({
    cwd,
    provider: MockProvider.scripted([
      { deltas: ["first answer"], finish: "stop" },
      { deltas: ["second answer"], finish: "stop" },
      { deltas: ["branch answer"], finish: "stop" },
    ]),
    sink: (e) => store.append(e),
  });
  await session.send("fix the auth redirect loop");
  await session.send("add integration tests");
  // Rewind to the first turn, then send again: an implicit second branch.
  const view = sessionTree(store.file!);
  if (!("nodes" in view)) throw new Error(view.error);
  const firstTurn = view.nodes.find((n) => n.kind === "turn" && n.label.startsWith("fix the auth"))!;
  switchBranch(store.file!, firstTurn.id);
  await session.send("retry with jwt middleware");
  await session.dispose({ timeoutMs: 5_000 });
  return store.file as string;
}

function viewOf(file: string): TreeView {
  const view = sessionTree(file);
  if (!("nodes" in view)) throw new Error(view.error);
  return view;
}

const noop = () => {};

function mount(props: Partial<Parameters<typeof TreePanel>[0]> & { view: TreeView | { error: string } }) {
  return render(
    <ThemeProvider value={THEMES["tokyo-night"]}>
      <TreePanel
        label="test session"
        onSwitch={props.onSwitch ?? noop}
        onBranchFrom={props.onBranchFrom ?? noop}
        onBookmark={props.onBookmark ?? noop}
        onClose={props.onClose ?? noop}
        {...props}
      />
    </ThemeProvider>,
  );
}

describe("TreePanel (#581)", () => {
  test("renders the D frame: title in the top border, branch/turn counts, head marker", async () => {
    const file = await buildBranchedSession();
    const i = mount({ view: viewOf(file) });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "Session tree");
      await waitForFrame(frame, "test session");
      await waitForFrame(frame, "← head");
      await waitForFrame(frame, "fix the auth redirect loop");
      // Frame walls exist.
      expect(frame()).toContain("╭─");
      expect(frame()).toContain("╯");
    } finally {
      i.unmount();
    }
  });

  test("filter cycle helper: all → active+bookmarked → abandoned only → all", () => {
    expect(cycleTreeFilter("all")).toBe("active+bookmarked");
    expect(cycleTreeFilter("active+bookmarked")).toBe("abandoned only");
    expect(cycleTreeFilter("abandoned only")).toBe("all");
  });

  test("f cycles filters and the header chips show the active one", async () => {
    const file = await buildBranchedSession();
    const i = mount({ view: viewOf(file) });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "filter  [all]");
      await i.stdin.write("f");
      await waitForFrame(frame, "[active+bookmarked]");
      await i.stdin.write("f");
      await waitForFrame(frame, "[abandoned only]");
      await i.stdin.write("f");
      await waitForFrame(frame, "[all]");
    } finally {
      i.unmount();
    }
  });

  test("arrow keys move the selection marker", async () => {
    const file = await buildBranchedSession();
    const i = mount({ view: viewOf(file) });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "Session tree");
      await i.stdin.write("\x1b[B"); // down
      await waitForCondition(
        () => frame().includes("▶ ○ add integration tests"),
        () => `selection never moved. Last frame:\n${frame()}`,
      );
    } finally {
      i.unmount();
    }
  });

  test("enter calls onSwitch with the selected node id", async () => {
    const file = await buildBranchedSession();
    const view = viewOf(file);
    const switched: string[] = [];
    const i = mount({ view, onSwitch: (id) => switched.push(id) });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "Session tree");
      await i.stdin.write("\x1b[B");
      await waitForCondition(
        () => frame().includes("▶ ○ add integration tests"),
        () => "selection never moved",
      );
      await i.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 80));
      expect(switched.length).toBe(1);
    } finally {
      i.unmount();
    }
  });

  test("r calls onBranchFrom with the selected node", async () => {
    const file = await buildBranchedSession();
    const view = viewOf(file);
    const branched: string[] = [];
    const i = mount({ view, onBranchFrom: (node) => branched.push(node.id) });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "Session tree");
      await i.stdin.write("r");
      await new Promise((r) => setTimeout(r, 80));
      expect(branched.length).toBe(1);
    } finally {
      i.unmount();
    }
  });

  test("b toggles a bookmark through onBookmark (empty name = clear semantics caller-side)", async () => {
    const file = await buildBranchedSession();
    const view = viewOf(file);
    const bookmarks: [string, string | undefined][] = [];
    const i = mount({ view, onBookmark: (id, name) => bookmarks.push([id, name]) });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "Session tree");
      await i.stdin.write("b");
      await new Promise((r) => setTimeout(r, 80));
      expect(bookmarks).toEqual([[view.headId, undefined]]);
    } finally {
      i.unmount();
    }
  });

  test("B opens the name prompt; enter submits the buffer", async () => {
    const file = await buildBranchedSession();
    const view = viewOf(file);
    const bookmarks: [string, string | undefined][] = [];
    const i = mount({ view, onBookmark: (id, name) => bookmarks.push([id, name]) });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "Session tree");
      await i.stdin.write("B");
      await waitForFrame(frame, "bookmark name:");
      // CI hardening (#631 policy): the frame only proves the prompt rendered;
      // a keystroke arriving in the same tick can race the useInput handler
      // re-binding after the naming state flips (first char swallowed on slow
      // runners — seen as "ttempt-2"). Settle before typing, then assert the
      // full buffer echoed in the prompt so a loss fails loudly here, not at
      // submit.
      await new Promise((r) => setTimeout(r, 100));
      for (const ch of "attempt-2") {
        await i.stdin.write(ch);
        await new Promise((r) => setTimeout(r, 20));
      }
      await waitForFrame(frame, "attempt-2");
      await i.stdin.write("\r");
      await new Promise((r) => setTimeout(r, 80));
      expect(bookmarks).toEqual([[view.headId, "attempt-2"]]);
    } finally {
      i.unmount();
    }
  });

  test("esc closes", async () => {
    const file = await buildBranchedSession();
    let closed = false;
    const i = mount({ view: viewOf(file), onClose: () => (closed = true) });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "Session tree");
      await i.stdin.write("\x1b");
      await new Promise((r) => setTimeout(r, 80));
      expect(closed).toBe(true);
    } finally {
      i.unmount();
    }
  });

  test("an error view renders the message, not a crash", async () => {
    const i = mount({ view: { error: "session log not found" } });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "✗ session log not found");
    } finally {
      i.unmount();
    }
  });

  test("row cap: internal scrolling window with more-indicators", async () => {
    // A synthetic view wider than the tiny cap: more-indicator above,
    // selection clamped inside the window.
    const view: TreeView = {
      headId: "n6",
      nodes: Array.from({ length: 8 }, (_, index) => ({
        id: `n${index}`,
        parentId: index === 0 ? null : `n${index - 1}`,
        depth: 0,
        onActivePath: true,
        kind: "turn" as const,
        label: `turn ${index}`,
      })),
    };
    const i = mount({ view, rows: 3 });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "▲ more");
      // Scrolling up reveals the bottom more-indicator.
      await i.stdin.write("k");
      await i.stdin.write("k");
      await waitForCondition(() => frame().includes("▼ more"), () => `▼ more never appeared. Frame:\n${frame()}`);
    } finally {
      i.unmount();
    }
  });

  test("live switch: enter appends branch_switched through the caller's core seam", async () => {
    // End-to-end over the real session seam: the panel's onSwitch calls
    // session.switchBranch; the file gains a branch_switched event.
    const home = join(dir(), "home");
    const cwd = join(dir(), "repo");
    const store = SessionStore.create(cwd, home);
    const session = createSession({
      cwd,
      provider: MockProvider.scripted([
        { deltas: ["a"], finish: "stop" },
        { deltas: ["b"], finish: "stop" },
      ]),
      sink: (e) => store.append(e),
    });
    await session.send("first turn");
    await session.send("second turn");
    const file = store.file as string;
    const view = viewOf(file);
    const firstTurn = view.nodes.find((n) => n.kind === "turn" && n.label.startsWith("first turn"))!;
    const i = mount({
      view,
      onSwitch: (id) => session.switchBranch(id),
    });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "Session tree");
      await i.stdin.write("j");
      await i.stdin.write("j");
      await i.stdin.write("\r");
      const { readFileSync } = await import("node:fs");
      await waitForFrame(
        () => (readFileSync(file, "utf8").includes("branch_switched") ? "ok" : ""),
        "ok",
      );
      // The switch appended chrome, never session_resumed (no consume).
      expect(readFileSync(file, "utf8").includes("session_resumed")).toBe(false);
    } finally {
      i.unmount();
      void session.dispose({ timeoutMs: 1_000 });
    }
  });

  test("foreignTip marks the whole foreign branch with the warning glyph", async () => {
    // Synthetic view: a foreign tip with a child — both rows carry ⚠.
    const view: TreeView = {
      headId: "kid",
      nodes: [
        { id: "root", parentId: null, depth: 0, onActivePath: true, kind: "turn", label: "root turn" },
        { id: "foreign", parentId: "root", depth: 1, onActivePath: false, kind: "turn", label: "foreign tail" },
        { id: "kid", parentId: "foreign", depth: 2, onActivePath: false, kind: "turn", label: "foreign child" },
      ],
    };
    const i = mount({ view, foreignTip: "foreign" });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "⚠ foreign tail");
      await waitForFrame(frame, "⚠ foreign child");
      await waitForFrame(frame, "● root turn");
    } finally {
      i.unmount();
    }
  });
});

describe("TreePanel frame geometry (#581 review fix)", () => {
  test("every painted row has the same width: top border = body rows = bottom border", async () => {
    const file = await buildBranchedSession();
    const i = mount({ view: viewOf(file) });
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    try {
      await waitForFrame(frame, "Session tree");
      const rows = frame().split("\n").filter((l) => /[│╭╰]/.test(l));
      expect(rows.length).toBeGreaterThan(3);
      const widths = new Set(rows.map((r) => r.length));
      if (widths.size !== 1) {
        throw new Error(
          `frame rows have differing widths (${[...widths].join(", ")}):\n` +
            rows.map((r) => `${r.length} |${r}|`).join("\n"),
        );
      }
      expect(widths.size).toBe(1);
    } finally {
      i.unmount();
    }
  });
});
