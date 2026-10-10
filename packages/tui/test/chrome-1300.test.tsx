import "./faketty/ci-mask";
import { expect, test } from "bun:test";
import React from "react";
import { Box, Text } from "ink";
import { createSession, MockProvider } from "@moh/core";
import { Chat, transcriptTail } from "../src/Chat";
import { projectTranscript, TranscriptBlockView } from "../src/transcript";
import { renderOnFakeTty } from "./faketty/render";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const width of [24, 44, 80]) {
  test(`#1300 bordered user tail fits a real ${width}-column frame`, async () => {
    const blocks = projectTranscript(Array.from({ length: 6 }, (_, index) => ({
      type: "user_message" as const,
      text: index === 5 ? "last prompt " + "long words and wrapping 界面👩‍💻 ".repeat(30) : `prompt ${index}`,
    })));
    for (const budget of [4, 5, 12, 18]) {
      const tail = transcriptTail(blocks, width, budget, true);
      const term = renderOnFakeTty(<Box flexDirection="column">{tail.map((block) => <TranscriptBlockView key={block.key} block={block} width={width} />)}</Box>, { cols: width, rows: budget + 1 });
      try {
        await term.settle();
        expect(term.maxFrameRows()).toBeLessThanOrEqual(budget);
        expect(term.fullscreenFrames()).toBe(0);
        if (budget >= 5) {
          expect(term.rawBytes().toString()).toContain("┗");
          expect(tail.length).toBeGreaterThan(0);
        }
      } finally { await term.unmount(); }
    }
  });
}

test("#1300 several complete user blocks share the volatile budget", async () => {
  const blocks = projectTranscript(Array.from({ length: 8 }, (_, index) => ({ type: "user_message" as const, text: `prompt ${index}` })));
  const tail = transcriptTail(blocks, 80, 18, true);
  expect(tail).toHaveLength(3);
  const term = renderOnFakeTty(<Box flexDirection="column">{tail.map((block) => <TranscriptBlockView key={block.key} block={block} width={80} />)}</Box>, { cols: 80, rows: 19 });
  try {
    await term.settle();
    expect(term.maxFrameRows()).toBeLessThanOrEqual(18);
    expect(term.fullscreenFrames()).toBe(0);
    expect(term.rawBytes().toString()).toContain("prompt 7");
  } finally { await term.unmount(); }
});

test("#1300 the rail rides the gated 90ms tick at its native cadence", async () => {
  const session = createSession({ provider: MockProvider.scripted([{ deltas: ["done"], deltaDelayMs: 1600, finish: "stop" }]) });
  const frames: number[] = [];
  const railContent = (_space: { columns: number; rows: number }, frame: number) => {
    frames.push(frame);
    return <Text>rail-frame-{frame}</Text>;
  };
  const view = (blocked: boolean) => <Chat session={session} cwd={process.cwd()} mode="dev" modelLabel="mock" width={120} blocked={blocked} railContent={railContent} />;
  const term = renderOnFakeTty(view(false), { cols: 120, rows: 30 });
  try {
    await term.settle();
    const idleBytes = term.rawBytes().length;
    await sleep(300);
    expect(term.rawBytes().length).toBe(idleBytes);
    expect(new Set(frames).size).toBe(1);
    const turn = session.send("test animation");
    await sleep(400);
    expect(Math.max(...frames)).toBeGreaterThan(0);
    term.rerender(view(true));
    await term.settle();
    const blockedFrame = frames.at(-1);
    const blockedBytes = term.rawBytes().length;
    await sleep(300);
    expect(frames.at(-1)).toBe(blockedFrame);
    expect(term.rawBytes().length).toBe(blockedBytes);
    await turn;
    term.rerender(view(false));
    await term.settle();
    const settledBytes = term.rawBytes().length;
    await sleep(300);
    expect(term.rawBytes().length).toBe(settledBytes);
    expect(term.fullscreenFrames()).toBe(0);
    expect(term.maxFrameRows()).toBeLessThan(30);
  } finally { await term.unmount(); }
});
