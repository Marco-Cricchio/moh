import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasPython, runPtyRaw } from "./pty-runner";
import { startFakeOpenAiLongSessionAsk as startFakeOpenAi } from "./fake-openai-long-session-ask";

/**
 * Regression (#874): with a LONG session, opening the inline ask_user gate
 * still produced whole-viewport flicker even after the #622 timer fixes.
 * Mechanism: Ink's fullscreen path — when the rendered output is at least
 * the terminal height, every frame is `clearTerminal + fullStaticOutput +
 * output`. #874 caps the sources: the ask block windows its option list,
 * the subagent peek rides the volatile row budget, and idle-frame polls
 * no-op or defer, so a blocked, idle TUI emits no churn even when the
 * transcript alone is taller than the screen.
 *
 * Standard is the same as the #622 test: the bounded gate-open transition
 * may clear a handful of times; the idle window must emit none.
 */
const RAW = "/tmp/moh-pty-874-raw.bin";

describe.skipIf(!hasPython)("long-session ask_user gate (PTY regression #874)", () => {
  test(
    "tall gate over a long transcript renders stably — no clearTerminal churn while idle",
    async () => {
      const { server, url } = startFakeOpenAi();
      try {
        const meta = await runPtyRaw({
          cols: 100,
          rows: 20, // small viewport: the transcript alone exceeds it
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
            { wait: 0.3, send: Buffer.from("hi").toString("base64") },
            { wait: 0.4, send: Buffer.from("\r").toString("base64") },
            // Turn 1 settles with a long transcript (60 paragraphs ≫ 20 rows).
            { wait: 8.0, until: "paragraph 5" },
            // Turn 2 opens the oversized ask gate on top of it. untilOnScreen
            // (#874): once the fix removes the repaint churn, a needle may be
            // painted exactly once, possibly before this step starts.
            { wait: 12.0, until: "tall box question", untilOnScreen: true },
            // Idle/blocked window (≥10s acceptance): the user is reading —
            // before the fix this streamed clearTerminal repaints; after it,
            // none.
            { wait: 10.0 },
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
        const churn = afterOpen.split("\x1b[2J\x1b[3J\x1b[H").length - 1;
        expect(churn).toBeLessThanOrEqual(4);
      } finally {
        server.stop(true);
      }
    },
    90_000,
  );
});
