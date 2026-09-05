import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { Text } from "ink";
import { ThemeProvider, THEMES } from "../src/themes";
import { BottomBar } from "../src/BottomBar";
import { SubagentPanel } from "../src/SubagentPanel";
import {
  trackSubagents,
  subagentGlyph,
  subagentStateLabel,
  panelHeader,
  panelFreezeLine,
  isStalled,
  formatElapsed,
  panelWidth,
  coalesceTailLines,
  useSubagentTails,
  TAIL_POLL_MS,
  STALLED_AFTER_MS,
  PANEL_TAIL_LINES,
  type TrackedSubagent,
  type SubagentTail,
} from "../src/subagent-panel";
import { stripAnsi } from "./helpers";
import type { AgentEvent } from "@moh/core";

describe("trackSubagents", () => {
  test("pairs spawn/result by callId and keeps order", () => {
    const events: AgentEvent[] = [
      { type: "session_start", schemaVersion: 1, promptVersion: "1" },
      { type: "subagent_spawn", callId: "a", name: "scout", preset: "research", log: "/x/a.jsonl" },
      { type: "subagent_spawn", callId: "b", name: "worker", log: "/x/b.jsonl" },
      { type: "subagent_result", callId: "a", name: "scout", status: "done", usage: { inputTokens: 100, outputTokens: 50 }, log: "/x/a.jsonl" },
    ];
    const subs = trackSubagents(events);
    expect(subs.map((s) => s.name)).toEqual(["scout", "worker"]);
    expect(subs[0]!.status).toBe("done");
    expect(subs[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(subs[1]!.status).toBe("running");
    expect(subs[1]!.log).toBe("/x/b.jsonl");
  });

  test("adds ordinal only when child names collide", () => {
    const duplicated = trackSubagents([
      { type: "subagent_spawn", callId: "a", name: "subagent", log: "/x/a.jsonl" },
      { type: "subagent_spawn", callId: "b", name: "subagent", log: "/x/b.jsonl" },
      { type: "subagent_spawn", callId: "c", name: "scout", log: "/x/c.jsonl" },
    ]);
    expect(duplicated.map((sub) => sub.displayName ?? sub.name)).toEqual(["1 subagent", "2 subagent", "scout"]);
  });

  test("empty log → no subagents", () => {
    expect(trackSubagents([])).toEqual([]);
  });
});

const runningSub: TrackedSubagent = {
  callId: "a",
  name: "scout",
  log: "/x/a.jsonl",
  status: "running",
  startedAt: Date.now(),
};

const tailOf = (lines: string[], currentTool: string | null = "bash"): SubagentTail => ({
  lines: lines.map((text, id) => ({ id: id + 1, text })),
  currentTool,
  lastActivityAt: Date.now(),
});

describe("live tail polling", () => {
  test("repaints each appended child delta before the child settles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moh-live-tail-"));
    const log = join(dir, "child.jsonl");
    const sub: TrackedSubagent = { ...runningSub, log };
    function Probe() {
      const tail = useSubagentTails([sub]).get(sub.callId);
      return <Text>{tail?.lines.at(-1)?.text ?? "waiting"}</Text>;
    }
    const ink = render(<ThemeProvider value={THEMES["tokyo-night"]}><Probe /></ThemeProvider>);
    try {
      await writeFile(log, `${JSON.stringify({ type: "assistant_delta", text: "first " })}\n`);
      await Bun.sleep(TAIL_POLL_MS * 2);
      expect(stripAnsi(ink.lastFrame() ?? "")).toContain("first");
      await appendFile(log, `${JSON.stringify({ type: "assistant_delta", text: "second" })}\n`);
      await Bun.sleep(TAIL_POLL_MS * 2);
      expect(stripAnsi(ink.lastFrame() ?? "")).toContain("first second");
    } finally {
      ink.unmount();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("glyphs and panel text", () => {
  test("coalesces consecutive assistant deltas into one tail preview", () => {
    const coalesced = coalesceTailLines(
      [{ id: 1, text: "● read · notes.md" }, { id: 2, text: "· one " }],
      [{ id: 3, text: "· two " }, { id: 4, text: "· three" }, { id: 5, text: "✓ done" }],
    );
    expect(coalesced).toEqual([
      { id: 1, text: "● read · notes.md" },
      { id: 4, text: "· one two three" },
      { id: 5, text: "✓ done" },
    ]);
  });

  test("running is ◐, stalled ⏸, settled ✓/✗", () => {
    expect(subagentGlyph(runningSub, tailOf(["● bash"]), Date.now())).toBe("◐");
    const stalledTail: SubagentTail = { ...tailOf(["● bash"]), lastActivityAt: Date.now() - STALLED_AFTER_MS - 1000 };
    expect(subagentGlyph(runningSub, stalledTail, Date.now())).toBe("⏸");
    expect(subagentGlyph({ ...runningSub, status: "done" }, undefined, Date.now())).toBe("✓");
    expect(subagentGlyph({ ...runningSub, status: "error" }, undefined, Date.now())).toBe("✗");
    expect(isStalled(runningSub, stalledTail, Date.now())).toBe(true);
    expect(isStalled({ ...runningSub, status: "done" }, stalledTail, Date.now())).toBe(false);
  });

  test("panel header carries name, elapsed, state, tool", () => {
    const now = runningSub.startedAt + 67_000;
    const tail = { ...tailOf(["● bash · git status"], "bash"), lastActivityAt: now };
    const header = panelHeader(runningSub, tail, now);
    expect(header).toContain("scout");
    expect(header).toContain("1m07s");
    expect(header).toContain("running");
    expect(header).toContain("bash");
    const stalled = panelHeader(runningSub, { ...tailOf([]), lastActivityAt: Date.now() - STALLED_AFTER_MS - 1 }, Date.now());
    expect(stalled).toContain("stalled");
  });

  test("freeze line on settle; empty while running", () => {
    expect(panelFreezeLine(runningSub)).toBe("");
    const done: TrackedSubagent = { ...runningSub, status: "done", usage: { inputTokens: 1500, outputTokens: 600 } };
    const line = panelFreezeLine(done);
    expect(line).toContain("✓ done");
    expect(line).toContain("2.1k tok");
    expect(line).toContain("result in transcript");
  });

  test("elapsed formatting", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(59_000)).toBe("59s");
    expect(formatElapsed(67_000)).toBe("1m07s");
  });

  test("panel width clamps", () => {
    expect(panelWidth(60)).toBe(28);
    expect(panelWidth(200)).toBe(46);
    expect(panelWidth(120)).toBe(36);
  });
});

const base = {
  width: 120,
  pending: false,
  spinner: "⠸",
  mode: "dev" as const,
  model: "mock",
  turns: 1,
  tokens: { contextIn: 10_000, totalOut: 100, calls: 1 },
  level: "medium" as const,
  focusedChip: null,
};

function barFrame(props: Record<string, unknown>): string {
  const ink = render(
    <ThemeProvider value={THEMES["tokyo-night"]}>
      <BottomBar {...base} {...(props as any)} />
    </ThemeProvider>,
  );
  const frame = stripAnsi(ink.lastFrame() ?? "");
  ink.unmount();
  return frame;
}

describe("subagent chips in the bottom bar (#497)", () => {
  const chips = [
    { label: "scout", glyph: "◐", active: false },
    { label: "worker", glyph: "✓", active: false },
  ];

  test("chips appear per subagent with state glyphs, on their own row above the action chips", () => {
    const ink = render(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <BottomBar {...base} subagentChips={chips} />
      </ThemeProvider>,
    );
    // Capture before unmount: Ink's Linux renderer clears lastFrame during
    // unmount (macOS happens to retain it), so querying it afterwards made
    // this otherwise deterministic layout test flaky in CI.
    const frame = stripAnsi(ink.lastFrame() ?? "");
    const lines = frame.split("\n");
    ink.unmount();
    const subLine = lines.findIndex((l) => l.includes("scout"));
    const actionLine = lines.findIndex((l) => l.includes("⏎ send"));
    expect(subLine).toBeGreaterThanOrEqual(0);
    expect(actionLine).toBeGreaterThan(subLine); // own row, above the actions
    expect(frame).toContain("◐");
  });

  test("no subagents → no chips (footer unchanged)", () => {
    const frame = barFrame({});
    expect(frame).not.toContain("scout");
    expect(frame).toContain("⏎ send");
  });

  test("overflow beyond 3 renders +N", () => {
    const four = [
      { label: "aa", glyph: "◐", active: false },
      { label: "bb", glyph: "◐", active: false },
      { label: "cc", glyph: "◐", active: false },
      { label: "dd", glyph: "◐", active: false },
    ];
    const frame = barFrame({ subagentChips: four.slice(0, 3).concat([{ label: "+1", glyph: "", active: false }]) });
    expect(frame).toContain("+1");
    expect(frame).not.toContain("dd");
  });

  test("compact width collapses to a count (⊙N)", () => {
    const frame = barFrame({ subagentChips: chips, width: 60 });
    expect(frame).toContain("⊙2");
    expect(frame).not.toContain("scout");
    // Action chips still render on their own row below.
    expect(frame).toContain("⏎ send");
  });

  test("active chip highlights (accent border)", () => {
    const frame = barFrame({ subagentChips: [{ label: "scout", glyph: "◐", active: true }] });
    expect(frame).toContain("scout");
    // Highlight rides ANSI color; ink-testing-library's stdout strips color
    // (chalk.level 0 under bun test), so the plain frame proves layout and
    // presence; the accent wiring is asserted by focus handlers in App.
  });
});

describe("live panel rendering", () => {
  test("shows header and tail lines", () => {
    const ink = render(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <SubagentPanel sub={runningSub} tail={tailOf(["● bash · git status", "✓ done", "● read · src/a.ts"])} now={Date.now()} width={40} />
      </ThemeProvider>,
    );
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("scout");
    // Running peek retains up to five meaningful visual rows.
    expect(frame).toContain("● bash · git status");
    expect(frame).toContain("✓ done");
    expect(frame).toContain("● read · src/a.ts");
    ink.unmount();
  });

  test("empty running tail stays header-only", () => {
    const ink = render(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <SubagentPanel sub={runningSub} tail={undefined} now={Date.now()} width={40} />
      </ThemeProvider>,
    );
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("scout");
    expect(frame).not.toContain("no events yet");
    ink.unmount();
  });

  test("settled panel freezes with the final line", () => {
    const done: TrackedSubagent = { ...runningSub, status: "done", usage: { inputTokens: 1000, outputTokens: 1000 } };
    const ink = render(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <SubagentPanel sub={done} tail={tailOf(["✓ done"])} now={Date.now()} width={60} />
      </ThemeProvider>,
    );
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("2.0k tok");
    expect(frame.split("\n").map((l) => l.trim()).join(" ")).toContain("result in transcript");
    // On settle only the header + one freeze acknowledgement remains; the
    // live tail belongs to the static transcript block now.
    expect(frame).not.toContain("✓ done\n│  ✓ done");
    ink.unmount();
  });
});
