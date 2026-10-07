import { describe, expect, test } from "bun:test";
import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, createSession } from "@moh/core";
import { Chat } from "../src/Chat";
import { ExtensionsRail } from "../src/ExtensionsRail";
import { stripAnsi, waitForCondition } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("top-anchored right rail", () => {
  test("transcript and rail share the top viewport before, during and after settling; composer stays full-width", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const session = createSession({ provider: MockProvider.scripted([
      { deltas: ["earlier reply"], finish: "stop" },
      { deltas: ["streaming answer", " settled answer"], finish: "stop", hold: { afterDeltas: 1, release: gate } },
    ]) });
    await session.send("earlier question");
    let tall = false;
    const rail = (space: { columns: number; rows: number }) => <ExtensionsRail
      panels={[{ extension: "ops", name: "status", description: "", render: () => <Text>{tall ? "rail body\nsecond row\nthird row" : "rail body"}</Text> }]}
      collapsed={new Set()} columns={space.columns} rows={space.rows}
    />;
    const cwd = mkdtempSync(join(tmpdir(), "moh-rail-"));
    const node = () => <Chat session={session} cwd={cwd} mode="dev" modelLabel="mock" width={100} railContent={rail} reveal={{ charsPerTick: 10000 }} />;
    const i = render(node());
    Object.defineProperty(i.stdout, "columns", { value: 100, configurable: true });
    Object.defineProperty(i.stdout, "rows", { value: 30, configurable: true });
    i.stdout.emit("resize");
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    const geometry = (text: string) => {
      const lines = frame().split("\n");
      const railHeader = lines.findIndex((line) => line.includes("status ops"));
      const railTop = railHeader - 1;
      const composer = lines.findIndex((line) => line.includes("shift+enter"));
      expect(railTop).toBe(0);
      expect(lines[railHeader]!.indexOf("status ops")).toBeGreaterThan(60);
      const transcript = lines.findIndex((line) => line.includes(text));
      expect(transcript).toBeGreaterThanOrEqual(railTop);
      expect(transcript).toBeLessThan(composer);
      expect(lines[transcript]!.indexOf(text)).toBeLessThan(60);
      expect(lines[railTop]!).toContain("History:");
      expect(lines[composer - 1]!.length).toBeGreaterThan(95);
      expect(lines.slice(composer).some((line) => line.includes("rail body") || line.includes("status ops"))).toBe(false);
      expect(lines.length).toBeLessThan(30);
      return composer;
    };
    try {
      await waitForCondition(() => frame().includes("status ops") && frame().includes("rail body"), () => frame());
      const before = geometry("earlier question");
      const send = session.send("new question");
      await waitForCondition(() => frame().includes("streaming answer"), () => frame());
      expect(geometry("new question")).toBe(before);
      tall = true;
      i.rerender(node());
      await waitForCondition(() => frame().includes("third row") && frame().includes("status ops"), () => frame());
      expect(geometry("new question")).toBe(before);
      release();
      await send;
      await waitForCondition(() => frame().includes("settled answer"), () => frame());
      expect(geometry("new question")).toBe(before);
      // Closing resumes the mounted Static ledger, without losing history.
      i.rerender(<Chat session={session} cwd={tmpdir()} mode="dev" modelLabel="mock" width={100} />);
      await sleep(50);
      expect(frame()).toContain("earlier question");
      expect(frame()).toContain("settled answer");
      expect(frame()).not.toContain("status ops");
    } finally {
      release();
      i.unmount();
      await session.dispose();
    }
  }, 15000);

  test("long streaming and settled replies stay inside the left viewport", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const session = createSession({ provider: MockProvider.scripted([{
      deltas: [Array.from({ length: 260 }, (_, n) => `row${n.toString().padStart(3, "0")}`).join("\n"), "\nfinal row"],
      finish: "stop",
      hold: { afterDeltas: 1, release: gate },
    }]) });
    const i = render(<Chat session={session} cwd={tmpdir()} mode="dev" modelLabel="mock" width={100}
      reveal={{ charsPerTick: 10000 }}
      railContent={(space) => <ExtensionsRail panels={[{ extension: "ops", name: "status", description: "", render: () => <Text>rail body</Text> }]}
        collapsed={new Set()} columns={space.columns} rows={space.rows} />}
    />);
    Object.defineProperty(i.stdout, "rows", { value: 30, configurable: true });
    i.stdout.emit("resize");
    const frame = () => stripAnsi(i.lastFrame() ?? "");
    const assertViewport = (text: string) => {
      const lines = frame().split("\n");
      expect(lines.findIndex((line) => line.includes("status ops"))).toBe(1);
      expect(lines.findIndex((line) => line.includes(text))).toBeLessThan(lines.findIndex((line) => line.includes("shift+enter")));
      expect(lines.find((line) => line.includes(text))!.indexOf(text)).toBeLessThan(60);
      expect(lines.length).toBeLessThan(30);
      expect(frame()).not.toContain("row000");
    };
    try {
      const send = session.send("long reply please");
      await waitForCondition(() => frame().includes("row259") && frame().includes("status ops"), () => frame());
      assertViewport("row259");
      release();
      await send;
      await waitForCondition(() => frame().includes("final row"), () => frame());
      assertViewport("final row");
    } finally {
      release();
      i.unmount();
      await session.dispose();
    }
  }, 15000);

  test("opening over printed history and repainting reasoning/mode/width never emits Static beside the rail", async () => {
    const session = createSession({ provider: MockProvider.scripted([{ reasoning: { deltas: ["historical premise"] }, deltas: ["historical answer"], finish: "stop" }]) });
    let open = false;
    let show = false;
    let mode: "dev" | "vibe" = "dev";
    let width = 100;
    let wide = false;
    const node = () => <Chat session={session} cwd={tmpdir()} mode={mode} modelLabel="reasoner" width={width}
      showReasoning={show} onRailWideChange={(value) => { wide = value; }}
      railContent={open ? (space) => <ExtensionsRail panels={[{ extension: "ops", name: "status", description: "", render: () => <Text>rail body</Text> }]}
        collapsed={new Set()} columns={space.columns} rows={space.rows} /> : null} />;
    const i = render(node());
    Object.defineProperty(i.stdout, "rows", { value: 40, configurable: true });
    i.stdout.emit("resize");
    // This harness accumulates Static despite clear-screen; isolate the
    // interactive frame from the visible history-access marker.
    const frame = () => {
      const output = stripAnsi(i.lastFrame() ?? "");
      const start = output.lastIndexOf("History:");
      return start < 0 ? output : output.slice(start);
    };
    const assertRail = () => {
      expect(frame().split("\n")[0]).toContain("History:");
      expect(frame().split("\n")[1]).toContain("status ops");
      expect(frame().split("historical answer")).toHaveLength(2);
    };
    try {
      await session.send("historical question");
      await waitForCondition(() => frame().includes("historical answer"), frame);
      open = true;
      i.rerender(node());
      await waitForCondition(() => frame().includes("status ops"), frame);
      await sleep(80);
      assertRail();
      show = true;
      i.rerender(node());
      await waitForCondition(() => frame().includes("historical premise"), frame);
      assertRail();
      mode = "vibe";
      i.rerender(node());
      await sleep(80);
      assertRail();
      width = 110;
      Object.defineProperty(i.stdout, "columns", { value: width, configurable: true });
      i.stdout.emit("resize");
      i.rerender(node());
      await sleep(240);
      assertRail();
      show = false;
      i.rerender(node());
      await sleep(80);
      expect(frame()).not.toContain("historical premise");
      assertRail();
      expect(wide).toBe(true);
      Object.defineProperty(i.stdout, "rows", { value: 18, configurable: true });
      i.stdout.emit("resize");
      await waitForCondition(() => !wide, frame);
      expect(frame()).not.toContain("status ops");
    } finally {
      i.unmount();
      await session.dispose();
    }
  });

});
