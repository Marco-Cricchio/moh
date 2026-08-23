import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import {
  ChatWindow,
  clampScrollOffset,
  maxScrollOffset,
  resolveOffset,
  scrollAnchor,
  turnLines,
  wrapWords,
  type ChatLine,
} from "../src/chat-window";
import type { TurnView } from "../src/turns";

const W = 40;

const turn = (over: Partial<TurnView>): TurnView => ({
  id: 0,
  user: "hello",
  reply: "",
  toolCalls: [],
  phase: "done",
  ...over,
});

describe("wrapWords", () => {
  test("wraps at the width, respects explicit newlines, keeps words whole", () => {
    expect(wrapWords("aaa bbb", 10)).toEqual(["aaa bbb"]);
    expect(wrapWords("aaaa bb cc", 5)).toEqual(["aaaa", "bb cc"]);
    expect(wrapWords("one\ntwo three", 9)).toEqual(["one", "two three"]);
    expect(wrapWords("", 5)).toEqual([""]);
  });
});

describe("turnLines (flat prototype rendering, issue #117)", () => {
  test("user block: accent speaker label, wrapped body, spacer", () => {
    const lines = turnLines(turn({ user: "hi there" }), W, {});
    expect(lines[0]).toEqual({ text: " you", tone: "accent" });
    expect(lines[1]).toEqual({ text: " hi there", tone: "fg" });
    expect(lines[2]).toEqual({ text: "", tone: "fg" });
  });

  test("settled reply: purple moh label, wrapped reply, spacer", () => {
    const lines = turnLines(turn({ reply: "the answer" }), W, {});
    expect(lines).toContainEqual({ text: " moh", tone: "purple" });
    expect(lines).toContainEqual({ text: " the answer", tone: "fg" });
    expect(lines.at(-1)).toEqual({ text: "", tone: "fg" });
  });

  test("reply with md renderer: markdown interpreted, not shown raw", () => {
    const md = createMarkdownRenderer(THEMES[DEFAULT_THEME], W);
    const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
    const lines = turnLines(turn({ reply: "**bold** and `code`" }), W, { md });
    const flat = lines.map((l) => strip(l.text)).join("\n");
    expect(flat).not.toContain("**bold**");
    expect(flat).toContain("bold");
    expect(flat).not.toContain("`code`");
  });

  test("reply without md renderer: plain word-wrap fallback", () => {
    const lines = turnLines(turn({ reply: "**bold**" }), W, {});
    expect(lines).toContainEqual({ text: " **bold**", tone: "fg" });
  });

  test("tool lines: dim, ✓/✗/… marks, running calls stay pending", () => {
    const lines = turnLines(
      turn({
        toolCalls: [
          { callId: "1", name: "read", args: {}, ok: true, output: "12 lines" },
          { callId: "2", name: "bash", args: {}, ok: false, output: "boom" },
          { callId: "3", name: "grep", args: {}, ok: null, output: null },
        ],
        reply: "done",
      }),
      W,
      {},
    );
    const tools = lines.filter((l) => l.tone === "dim");
    expect(tools.some((l) => l.text.includes("✓") && l.text.includes("read"))).toBe(true);
    expect(tools.some((l) => l.text.includes("✗") && l.text.includes("bash"))).toBe(true);
    expect(tools.some((l) => l.text.includes("…") && l.text.includes("grep"))).toBe(true);
  });

  test("detail mode inlines truncated tool output", () => {
    const lines = turnLines(
      turn({ toolCalls: [{ callId: "1", name: "bash", args: {}, ok: true, output: "line1\nline2" }] }),
      W,
      { detail: true },
    );
    expect(lines.some((l) => l.tone === "dim" && l.text.includes("line1"))).toBe(true);
    expect(lines.some((l) => l.tone === "dim" && l.text.includes("line2"))).toBe(true);
  });

  test("streaming turn: partial reply plus a live status line", () => {
    const lines = turnLines(turn({ phase: "streaming", reply: "so far" }), W, {
      spinner: "⠋",
      streamingNote: "esc to steer",
    });
    expect(lines).toContainEqual({ text: " moh", tone: "purple" });
    expect(lines).toContainEqual({ text: " so far", tone: "fg" });
    expect(lines.some((l) => l.tone === "dim" && l.text.includes("⠋") && l.text.includes("esc to steer"))).toBe(true);
    // no trailing spacer while streaming: the status line is the tail
    expect(lines.at(-1)!.tone).toBe("dim");
  });

  test("error and cancelled phases surface as warn/dim lines", () => {
    const err = turnLines(turn({ phase: "error", error: { reason: "auth", message: "no key" } }), W, {});
    expect(err.some((l) => l.tone === "warn" && l.text.includes("auth"))).toBe(true);
    const stopped = turnLines(turn({ phase: "cancelled", reply: "partial" }), W, {});
    expect(stopped.some((l) => l.tone === "dim" && l.text.includes("stopped"))).toBe(true);
  });
});

describe("scroll window math (bottom-anchored, top-based offset)", () => {
  test("maxScrollOffset and clamp", () => {
    expect(maxScrollOffset(50, 10)).toBe(40);
    expect(maxScrollOffset(5, 10)).toBe(0); // everything fits
    expect(clampScrollOffset(-3, 50, 10)).toBe(0);
    expect(clampScrollOffset(99, 50, 10)).toBe(40);
  });

  test("follow-tail: resolveOffset pins to the bottom as content grows", () => {
    expect(resolveOffset({ follow: true, offset: 0 }, 50, 10)).toBe(40);
    expect(resolveOffset({ follow: true, offset: 0 }, 80, 10)).toBe(70);
  });

  test("scrolled up: resolveOffset keeps the view stable as content grows", () => {
    // offset = index of the first visible line; new lines arrive below
    expect(resolveOffset({ follow: false, offset: 10 }, 50, 10)).toBe(10);
    expect(resolveOffset({ follow: false, offset: 10 }, 80, 10)).toBe(10);
  });

  test("scrollAnchor: up pauses follow, reaching the bottom resumes it", () => {
    const bottom = { follow: true, offset: 0 };
    const up = scrollAnchor(bottom, -1, 50, 10);
    expect(up).toEqual({ follow: false, offset: 39 });
    const back = scrollAnchor(up, 1, 50, 10);
    expect(back.follow).toBe(true); // offset normalized to the bottom, irrelevant while following
    // clamped at both edges, idempotent at the bottom
    expect(scrollAnchor(bottom, 1, 50, 10).follow).toBe(true);
    expect(scrollAnchor({ follow: false, offset: 0 }, -1, 50, 10)).toEqual({ follow: false, offset: 0 });
  });
});

describe("ChatWindow component", () => {
  const line = (text: string, tone: ChatLine["tone"] = "fg"): ChatLine => ({ text, tone });
  const mount = (ui: React.ReactNode) => {
    const i = render(<ThemeProvider value={THEMES[DEFAULT_THEME]}>{ui}</ThemeProvider>);
    return i;
  };

  test("fixed height, bottom-anchored: newest lines visible, oldest dropped", () => {
    const lines = Array.from({ length: 20 }, (_, i) => line(`line-${i}`));
    const i = mount(<ChatWindow lines={lines} height={5} offset={15} />);
    const frame = i.lastFrame() ?? "";
    expect(frame).toContain("line-19");
    expect(frame).toContain("line-15");
    expect(frame).not.toContain("line-14");
    expect(frame).not.toContain("line-0");
    i.unmount();
  });

  test("scrolled offset: shows the window at the given offset, tail hidden", () => {
    const lines = Array.from({ length: 20 }, (_, i) => line(`line-${i}`));
    const i = mount(<ChatWindow lines={lines} height={5} offset={0} />);
    const frame = i.lastFrame() ?? "";
    expect(frame).toContain("line-0");
    expect(frame).toContain("line-4");
    expect(frame).not.toContain("line-19");
    i.unmount();
  });

  test("short transcripts pad: never taller than the fixed height", () => {
    const i = mount(<ChatWindow lines={[line("only"), line("two")]} height={8} offset={0} />);
    const rows = (i.lastFrame() ?? "").split("\n").length;
    expect(rows).toBe(8);
    i.unmount();
  });
});
