import "./faketty/ci-mask";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { ThemeProvider, THEMES } from "../src/themes";
import { join } from "node:path";
import { MockProvider, builtinTools } from "@moh/core";
import { Chat } from "../src/Chat";
import { makeSession } from "../src/factory";
import { renderOnFakeTty } from "./faketty/render";
import { effectsFlushed, unwrap } from "./helpers";
import { canonicalContentRows, firstDivergence, parityMockTurns, paritySseChunks, PARITY } from "./parity-scenario";
import { hasPython, runPtyRaw } from "./pty/pty-runner";

import { freezeParityClock } from "./fixtures/parity-clock";

const chalk = createRequire(import.meta.resolve("ink"))("chalk").default as { level: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const history = (term: ReturnType<typeof renderOnFakeTty>) => [...term.screen.scrollback(), ...term.screen.lines()];

async function waitFor(term: ReturnType<typeof renderOnFakeTty>, needle: string): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (!history(term).join("\n").includes(needle) && performance.now() < deadline) await sleep(20);
  expect(history(term).join("\n")).toContain(needle);
}

function startParityServer(): { server: ReturnType<typeof Bun.serve>; url: string } {
  let call = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(_req) {
      call += 1;
      const chunks = paritySseChunks(call);
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        async start(controller) {
          for (const delta of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              id: `parity-${call}`,
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta, finish_reason: null }],
            })}\n\n`));
            await Bun.sleep(15);
          }
          const finish_reason = call === 1 ? "tool_calls" : "stop";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            id: `parity-${call}`, object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason }],
          })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}/v1` };
}

async function runFakeTerminal() {
  const cwd = mkdtempSync(join(tmpdir(), "moh-parity-fake-"));
  const home = mkdtempSync(join(tmpdir(), "moh-parity-fake-h-"));
  const { session } = unwrap(makeSession({
    cwd,
    home,
    provider: MockProvider.scripted(parityMockTurns),
    tools: builtinTools(),
    permissionMode: "auto-accept",
  }));
  const term = renderOnFakeTty(
    <ThemeProvider value={THEMES[PARITY.theme]}>
      <Chat session={session} cwd={cwd} mode="dev" modelLabel="mock" width={PARITY.cols} reveal={{ tickMs: 5, charsPerTick: 400, catchupChars: 4000 }} />
    </ThemeProvider>,
    { cols: PARITY.cols, rows: PARITY.rows },
  );
  try {
    await waitFor(term, "⏎ send");
    await effectsFlushed();
    term.write(PARITY.prompt);
    await waitFor(term, PARITY.prompt);
    await effectsFlushed();
    term.write("\r");
    await waitFor(term, PARITY.final);
    await term.settle();
    return { screen: term.screen.lines(), scrollback: term.screen.scrollback(), raw: term.rawBytes() };
  } finally {
    try { await term.unmount(); }
    finally {
      await session.dispose();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
}

describe.skipIf(!hasPython)("fake terminal / real PTY parity (#1062)", () => {
  test("the shared Markdown + tool + oversized-paragraph scenario matches physical rows and scrollback", async () => {
    const previousNoColor = process.env.NO_COLOR;
    const previousColorLevel = chalk.level;
    chalk.level = 3;
    delete process.env.NO_COLOR;
    const restoreClock = freezeParityClock();
    let fake: Awaited<ReturnType<typeof runFakeTerminal>>;
    try { fake = await runFakeTerminal(); }
    finally {
      restoreClock();
      chalk.level = previousColorLevel;
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
    const { server, url } = startParityServer();
    const artifacts = mkdtempSync(join(tmpdir(), "moh-parity-"));
    const rawPath = join(artifacts, "terminal.bin");
    const clockReceipt = join(artifacts, "clock.json");
    try {
      const pty = await runPtyRaw({
        env: {
          NO_COLOR: null, FORCE_COLOR: null,
          MOH_PARITY_CLOCK: "1",
          MOH_PARITY_CLOCK_RECEIPT: clockReceipt,
          BUN_OPTIONS: `--preload ${join(import.meta.dir, "fixtures/parity-clock.ts")}`,
        },
        cols: PARITY.cols,
        rows: PARITY.rows,
        config: {
          onboarded: true,
          workflowOffered: true,
          mode: "dev",
          theme: PARITY.theme,
          yolo: true,
          provider: "fake",
          endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
        },
        project: { permissions: { overrides: { tools: { bash: "allow" } } } },
        steps: [
          { wait: 10, until: "New session", untilOnScreen: true },
          { send: btoa(PARITY.prompt) },
          { wait: 5, until: PARITY.prompt, untilOnScreen: true },
          { send: btoa("\r") },
          { wait: 15, until: PARITY.final, untilOnScreen: true },
        ],
        tail: PARITY.rows,
        rawDump: rawPath,
      });
      expect(JSON.parse(readFileSync(clockReceipt, "utf8"))).toEqual({ now: PARITY.clockMs });
      expect(fake.raw.toString()).toMatch(/\x1b\[38;2;/);
      expect(readFileSync(rawPath, "utf8")).toMatch(/\x1b\[38;2;/);
      const fakeScreen = canonicalContentRows(fake.screen);
      const ptyScreen = canonicalContentRows(pty.lines.map((line) => line.text));
      const fakeScrollback = canonicalContentRows(fake.scrollback);
      const ptyScrollback = canonicalContentRows(pty.scrollback ?? []);
      const toolRow = fakeScrollback.find((row) => row.includes("✓ bash printf parity-tool"));
      expect(toolRow).toBeDefined();
      expect(toolRow).toEndWith("· 0s");
      const screenDivergence = firstDivergence(fakeScreen, ptyScreen);
      const scrollbackDivergence = firstDivergence(fakeScrollback, ptyScrollback);
      expect(screenDivergence, `physical screen parity divergence: ${screenDivergence ?? "unknown"}`).toBeNull();
      expect(scrollbackDivergence, `native scrollback parity divergence: ${scrollbackDivergence ?? "unknown"}`).toBeNull();
      expect(fakeScreen.join("\n")).toContain(PARITY.final);
      expect(ptyScreen.join("\n")).toContain(PARITY.final);
      // The parity test deliberately does not cover a real terminal
      // interpreting a new control/graphics sequence differently from our
      // VtScreen model; image protocol and byte-level NO_COLOR remain the
      // process-boundary tests in the T8 gate.
      expect(readFileSync(rawPath).length).toBeGreaterThan(0);
    } finally {
      server.stop(true);
      rmSync(artifacts, { recursive: true, force: true });
    }
  }, 90_000);

  test("MUT-PARITY-DIVERGENCE: the comparator rejects one fake-only row", () => {
    const fake = ["PARITY-BEFORE", "PARITY-FINAL", "FAKE-ONLY-ROW"];
    const pty = ["PARITY-BEFORE", "PARITY-FINAL"];
    const divergence = firstDivergence(fake, pty);
    expect(divergence).toContain("row 2");
    expect(divergence).toContain("FAKE-ONLY-ROW");
  });

  test("MUT-PARITY-METADATA: duration and internal padding remain significant", () => {
    const row = " ✓ bash printf parity-tool      · 0s";
    const baseline = canonicalContentRows([row]);
    for (const changed of [row.replace("0s", "1s"), row.replace("      ·", "     ·")]) {
      expect(firstDivergence(baseline, canonicalContentRows([changed]))).toContain("row 0");
    }
  });

});
