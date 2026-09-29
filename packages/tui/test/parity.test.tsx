import "./faketty/ci-mask";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { MockProvider, builtinTools } from "@moh/core";
import { Chat } from "../src/Chat";
import { makeSession } from "../src/factory";
import { renderOnFakeTty } from "./faketty/render";
import { unwrap } from "./helpers";
import { canonicalContentRows, firstDivergence, parityMockTurns, paritySseChunks, PARITY } from "./parity-scenario";
import { hasPython, runPtyRaw } from "./pty/pty-runner";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const history = (term: ReturnType<typeof renderOnFakeTty>) => [...term.screen.scrollback(), ...term.screen.lines()];

async function waitFor(term: ReturnType<typeof renderOnFakeTty>, needle: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!history(term).join("\n").includes(needle) && Date.now() < deadline) await sleep(20);
  expect(history(term).join("\n")).toContain(needle);
}

function startParityServer(): { server: ReturnType<typeof Bun.serve>; url: string } {
  let call = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      call += 1;
      const chunks = paritySseChunks(call);
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        async start(controller) {
          for (const delta of chunks) {
            const finish_reason = call === 1 ? "tool_calls" : "stop";
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
    <Chat session={session} cwd={cwd} mode="dev" modelLabel="mock" width={PARITY.cols} reveal={{ tickMs: 5, charsPerTick: 400, catchupChars: 4000 }} />,
    { cols: PARITY.cols, rows: PARITY.rows },
  );
  await waitFor(term, "⏎ send");
  term.write(PARITY.prompt);
  await sleep(20);
  term.write("\r");
  await waitFor(term, PARITY.final);
  await term.settle();
  const result = { screen: term.screen.lines(), scrollback: term.screen.scrollback() };
  await term.unmount();
  return result;
}

describe.skipIf(!hasPython)("fake terminal / real PTY parity (#1062)", () => {
  test("the shared Markdown + tool + oversized-paragraph scenario matches physical rows and scrollback", async () => {
    const fake = await runFakeTerminal();
    const { server, url } = startParityServer();
    const rawPath = "/tmp/moh-parity-1062.bin";
    try {
      const pty = await runPtyRaw({
        cols: PARITY.cols,
        rows: PARITY.rows,
        config: {
          onboarded: true,
          workflowOffered: true,
          mode: "dev",
          yolo: true,
          provider: "fake",
          endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
        },
        project: { permissions: { overrides: { tools: { bash: "allow" } } } },
        steps: [
          { wait: 10, until: "New session", untilOnScreen: true },
          { wait: 0.2, send: btoa(PARITY.prompt) },
          { wait: 0.2, send: btoa("\r") },
          { wait: 15, until: PARITY.final, untilOnScreen: true },
        ],
        tail: PARITY.rows,
        rawDump: rawPath,
      });
      const fakeScreen = canonicalContentRows(fake.screen);
      const ptyScreen = canonicalContentRows(pty.lines.map((line) => line.text));
      const fakeScrollback = canonicalContentRows(fake.scrollback);
      const ptyScrollback = canonicalContentRows(pty.scrollback ?? []);
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
    }
  }, 90_000);

  test("MUT-PARITY-DIVERGENCE: the comparator rejects one fake-only row", () => {
    const fake = ["PARITY-BEFORE", "PARITY-FINAL", "FAKE-ONLY-ROW"];
    const pty = ["PARITY-BEFORE", "PARITY-FINAL"];
    const divergence = firstDivergence(fake, pty);
    expect(divergence).toContain("row 2");
    expect(divergence).toContain("FAKE-ONLY-ROW");
  });
});
