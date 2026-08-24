import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "@moh/core";
import { App } from "../src/App";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("scrollback session parity with the validated prototype (#183)", () => {
  test("uses block heads and the model/status key bar instead of legacy flat rows", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-scrollback-parity-"));
    const provider = MockProvider.scripted([{ deltas: ["Prototype parity reply"], finish: "stop" }]);
    const app = <App cwd={process.cwd()} home={home} provider={provider} startInChat skipOnboarding />;
    const ink = render(app);
    Object.defineProperty(ink.stdout, "columns", { value: 120, configurable: true });
    Object.defineProperty(ink.stdout, "rows", { value: 40, configurable: true });
    ink.rerender(app);

    await sleep(30);
    ink.stdin.write("check the validated layout");
    await sleep(20);
    ink.stdin.write("\r");
    await sleep(300);

    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("› you");
    expect(frame).toContain("◆ moh");
    expect(frame).toContain("mock");
    expect(frame).toContain("model");
    expect(frame).toContain("mode");
    expect(frame).toContain("theme");
    expect(frame).not.toContain("tab chips · ctrl+k commands · esc stop");
    ink.unmount();
  });

  test("Enter on the send chip submits the current draft", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-scrollback-send-"));
    const provider = MockProvider.scripted([{ deltas: ["sent by chip"], finish: "stop" }]);
    const ink = render(<App cwd={process.cwd()} home={home} provider={provider} startInChat skipOnboarding />);
    await sleep(30);
    ink.stdin.write("chip draft");
    await sleep(20);
    ink.stdin.write("\t");
    await sleep(20);
    ink.stdin.write("\r");
    await sleep(300);
    const frame = stripAnsi(ink.lastFrame() ?? "");
    expect(frame).toContain("chip draft");
    expect(frame).toContain("sent by chip");
    ink.unmount();
  });

  test("tab focuses chips and Enter activates the model chip", async () => {
    const home = mkdtempSync(join(tmpdir(), "moh-scrollback-focus-"));
    const app = <App cwd={process.cwd()} home={home} provider={MockProvider.demo()} startInChat skipOnboarding />;
    const ink = render(app);
    Object.defineProperty(ink.stdout, "columns", { value: 120, configurable: true });
    ink.rerender(app);
    await sleep(30);
    ink.stdin.write("\t"); // send
    ink.stdin.write("\t"); // stop
    ink.stdin.write("\t"); // model
    await sleep(30);
    ink.stdin.write("\r");
    await sleep(80);
    const overlayFrame = stripAnsi(ink.lastFrame() ?? "");
    expect(overlayFrame).toContain("active: mock");
    expect(overlayFrame).not.toContain("type…");
    ink.unmount();
  });
});
