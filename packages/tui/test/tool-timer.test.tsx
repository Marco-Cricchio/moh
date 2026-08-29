import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { createSession, builtinTools, type AgentEvent } from "@moh/core";
import { Chat } from "../src/Chat";
import { projectTranscript, TranscriptBlockView } from "../src/transcript";
import { updateToolTimings, formatDuration, formatTimeout } from "../src/tool-timing";
import { ThemeProvider, THEMES } from "../src/themes";
import { stripAnsi } from "./helpers";

describe("tool timing formats (#300 decision 2)", () => {
  test("formatDuration: seconds under a minute, padded past it, whole minutes alone", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(300_000)).toBe("5m");
  });

  test("formatTimeout: sub-minute limits keep seconds; even minute limits read as minutes", () => {
    expect(formatTimeout(30_000)).toBe("30s");
    expect(formatTimeout(90_000)).toBe("1m 30s");
    expect(formatTimeout(600_000)).toBe("10m");
  });
});

describe("tool timing ledger", () => {
  test("a call's arrival is stamped once and never reset by later batches", () => {
    const events = [
      { type: "tool_call", callId: "a" },
    ];
    const first = updateToolTimings(new Map(), events, 0);
    const at = first.timings.get("a")!.at;
    // A later batch (deltas appended after the call) must not re-stamp it:
    // the elapsed clock would jump back to zero on every flush.
    const second = updateToolTimings(first.timings, [...events, { type: "assistant_delta" } as { type: string }], first.scanned);
    expect(second.timings.get("a")!.at).toBe(at);
    expect(second.scanned).toBe(2);
  });

  test("the duration measures the batch gap between call and result", async () => {
    const call = [{ type: "tool_call", callId: "a" }];
    const first = updateToolTimings(new Map(), call, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = updateToolTimings(first.timings, [...call, { type: "tool_result", callId: "a" }], first.scanned);
    const duration = second.timings.get("a")!.durationMs;
    expect(duration).toBeDefined();
    expect(duration!).toBeGreaterThanOrEqual(25);
  });

  test("a stray result without its call is ignored", () => {
    const { timings } = updateToolTimings(new Map(), [{ type: "tool_result", callId: "ghost" }], 0);
    expect(timings.size).toBe(0);
  });
});

describe("tool timing projection (#300)", () => {
  test("tool blocks carry callId, timeoutMs and settled duration", () => {
    const events: AgentEvent[] = [
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "bun test" }, timeoutMs: 30_000 },
      { type: "tool_result", callId: "c1", ok: true, output: "1 pass" },
    ];
    const timings = updateToolTimings(new Map(), events, 0).timings;
    timings.set("c1", { at: timings.get("c1")!.at, durationMs: 18_000 });
    const [block] = projectTranscript(events, { mode: "dev", toolTimings: timings });
    expect(block).toMatchObject({ callId: "c1", timeoutMs: 30_000, durationMs: 18_000 });
  });

  test("vibe tool blocks carry the same timing fields", () => {
    const events: AgentEvent[] = [
      { type: "tool_call", callId: "c1", name: "bash", args: { command: "bun test" }, timeoutMs: 120_000 },
      { type: "tool_result", callId: "c1", ok: true, output: "ok" },
    ];
    const [block] = projectTranscript(events, { mode: "vibe", toolTimings: updateToolTimings(new Map(), events, 0).timings });
    expect(block.callId).toBe("c1");
    expect(block.timeoutMs).toBe(120_000);
  });
});

describe("tool timer rendering (#300)", () => {
  const frame = (ui: React.ReactElement) => stripAnsi(render(ui).lastFrame() ?? "");

  test("live block head shows elapsed and limit right-aligned", () => {
    const block = projectTranscript(
      [{ type: "tool_call", callId: "t1", name: "bash", args: { command: "sleep 60" }, timeoutMs: 30_000 }],
      { mode: "dev" },
    )[0]!;
    const out = frame(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <TranscriptBlockView block={block} width={80} liveMeta={{ elapsedMs: 12_000, timeoutMs: 30_000 }} />
      </ThemeProvider>,
    );
    expect(out).toContain("⏱ 12s · 30s");
    expect(out).toContain("◌ bash sleep 60");
  });

  test("live block without a timeout shows elapsed only", () => {
    const block = projectTranscript(
      [{ type: "tool_call", callId: "t1", name: "glob", args: { pattern: "*.ts" } }],
      { mode: "dev" },
    )[0]!;
    const out = frame(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <TranscriptBlockView block={block} width={80} liveMeta={{ elapsedMs: 4_000 }} />
      </ThemeProvider>,
    );
    expect(out).toContain("⏱ 4s");
    expect(out).not.toContain("· 30s");
  });

  test("settled block shows the final duration, never the live timer", () => {
    const events: AgentEvent[] = [
      { type: "tool_call", callId: "t1", name: "bash", args: { command: "bun test" }, timeoutMs: 30_000 },
      { type: "tool_result", callId: "t1", ok: true, output: "1 pass" },
    ];
    const timings = updateToolTimings(new Map(), events, 0).timings;
    timings.set("t1", { at: timings.get("t1")!.at, durationMs: 18_000 });
    const block = projectTranscript(events, { mode: "dev", toolTimings: timings })[0]!;
    const out = frame(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <TranscriptBlockView block={block} width={80} />
      </ThemeProvider>,
    );
    expect(out).toContain("✓ bash");
    expect(out).toContain("· 18s");
    expect(out).not.toContain("⏱");
  });

  test("a settled call without ledger timing renders no timer (deterministic Static)", () => {
    const events: AgentEvent[] = [
      { type: "tool_call", callId: "t1", name: "read", args: { path: "a.ts" } },
      { type: "tool_result", callId: "t1", ok: true, output: "content" },
    ];
    const block = projectTranscript(events, { mode: "dev" })[0]!;
    const out = frame(
      <ThemeProvider value={THEMES["tokyo-night"]}>
        <TranscriptBlockView block={block} width={80} />
      </ThemeProvider>,
    );
    expect(out).not.toContain("⏱");
    expect(out).not.toMatch(/· \d+s/);
  });
});

describe("live tool timer in Chat (#300 integration)", () => {
  const nap = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  function drain(session: { events: AsyncIterable<unknown> }) {
    void (async () => {
      for await (const _ of session.events) void _;
    })();
  }

  /** A provider that emits a bash tool call whose result is held behind a
   * gate the test releases — the live volatile area must show the running
   * timer while the command "hangs", and the final duration once settled. */
  function gatedBashProvider(textGate: Promise<void>) {
    let call = 0;
    const stream = async function* () {
      call += 1;
      if (call === 1) {
        yield {
          type: "tool_calls",
          calls: [{ callId: "bash-1", name: "bash", args: { command: "sleep 5 && echo slow", timeoutMs: 120_000 } }],
        };
        yield { type: "finish", reason: "tool_calls" as const };
        return;
      }
      await textGate;
      yield { type: "text_delta", text: "done\n\n" };
      yield { type: "finish", reason: "stop" as const };
    };
    return { name: "gated", stream } as unknown as import("@moh/core").Provider;
  }

  test("pending bash call shows the live timer with its effective limit", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provider = gatedBashProvider(gate);
    const session = createSession({
      provider,
      tools: builtinTools(),
      permissions: { mode: "auto-accept", bypassPermissions: true },
      memory: { enabled: false },
    });
    drain(session);
    const ui = render(
      <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="gated" width={80} />,
    );
    const done = session.send("run it");
    // The first Clock tick can be delayed under a loaded CI worker. Poll for
    // any non-zero live elapsed value while the deliberately long command runs.
    const deadline = Date.now() + 3_000;
    let midTurn = "";
    do {
      await nap(100);
      midTurn = stripAnsi(ui.lastFrame() ?? "");
    } while (!/⏱ [1-9]\d*s · 2m/.test(midTurn) && Date.now() < deadline);
    expect(midTurn).toMatch(/⏱ [1-9]\d*s · 2m/);
    release!();
    await done;
    await nap(150);
    const settled = stripAnsi(ui.lastFrame() ?? "");
    // After promotion the settled block carries the deterministic duration,
    // never the volatile elapsed timer.
    expect(settled).not.toContain("⏱");
    expect(settled).toMatch(/✓ bash .* · \d+s/);
    ui.unmount();
  }, 10_000);
});
