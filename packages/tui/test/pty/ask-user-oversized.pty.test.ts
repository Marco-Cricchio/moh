import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasPython, runPtyRaw } from "./pty-runner";
import { startFakeOpenAiOversizedAsk as startFakeOpenAi } from "./fake-openai-oversized-ask";

/**
 * Regression (#622): an ask_user box TALLER than the terminal viewport made
 * the whole TUI flicker rapidly — Ink's fullscreen path (output >= rows)
 * emits `clearTerminal + fullStaticOutput + output` on EVERY render, and a
 * steady re-render trickle (typewriter reveal tick, composer cursor blink)
 * kept frames flowing while the user was just reading the question. At
 * ~20Hz the screen wiped and repainted too fast to read or scroll.
 *
 * The fix gates the reveal tick (it no longer runs while the input is
 * blocked) and pauses the composer cursor blink while disabled, so the
 * blocked state produces NO steady frame churn. The regression asserts
 * that after the oversized box opens, an idle window emits only the
 * bounded gate-open transition clears (not a continuous stream).
 */
const RAW = "/tmp/moh-pty-622-raw.bin";

describe.skipIf(!hasPython)("ask_user box taller than the viewport (PTY regression #622)", () => {
  test(
    "oversized box renders stably — no clearTerminal churn while idle",
    async () => {
      const { server, url } = startFakeOpenAi();
      try {
        const meta = await runPtyRaw({
          cols: 100,
          rows: 20, // small viewport: the box below exceeds it
          config: {
            onboarded: true,
            workflowOffered: true,
            mode: "dev",
            provider: "fake",
            endpoints: [
              { name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" },
            ],
          },
          project: { permissions: { overrides: { tools: { bash: "allow" } } } },
          steps: [
            { wait: 2.0 },
            { wait: 0.3, send: Buffer.from("hello").toString("base64") },
            { wait: 0.4, send: Buffer.from("\r").toString("base64") },
            // Readiness: the oversized question painted (#236 pump_until).
            { wait: 45.0, until: "tall box question" },
            // Idle window: no keystrokes — the user is reading. Before the
            // fix this window produced ~20 clearTerminal repaints/second for
            // as long as the gate stayed open; after the fix the steady
            // state emits none. (A handful of clears still occur right at
            // the gate-open transition — gate paint, phase-label flip, one
            // throttled trailing render — bounded and one-shot.)
            { wait: 8.0 },
          ],
          tail: 20,
          rawDump: RAW,
        });
        expect(meta.aliveAtEnd).toBe(true);
        const raw = readFileSync(RAW, "utf8");
        if (!raw.includes("tall box question")) {
          throw new Error(
            `readiness needle never appeared (aliveAtEnd=${meta.aliveAtEnd}, exited=${meta.exited}, ` +
              `exitCode=${meta.exitCode}); raw tail:\n${JSON.stringify(raw.slice(-2000))}`,
          );
        }
        const afterOpen = raw.slice(raw.indexOf("tall box question"));
        // The symptom (#622): continuous clearTerminal+full-reprint frames
        // (flicker). A blocked, idle TUI must not emit any.
        const churn = afterOpen.split("\x1b[2J\x1b[3J\x1b[H").length - 1;
        expect(churn).toBeLessThanOrEqual(4);
      } finally {
        server.stop(true);
      }
    },
    70_000,
  );
});
