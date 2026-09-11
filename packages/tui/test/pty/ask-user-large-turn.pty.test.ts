import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasPython, runPtyRaw } from "./pty-runner";
import { startFakeOpenAi } from "./fake-openai";

/**
 * Regression (session 20260825T062108113Z): with a large open turn, every
 * 90ms spinner tick re-rendered the whole live transcript (unmemoized), so
 * modal arrow keypresses queued behind renders (selection frozen) and
 * memory climbed until macOS killed the process ("killed", SIGKILL/OOM).
 *
 * Assertions are on the RAW pty byte stream: the harness's Screen model
 * is unreliable on huge repaint streams.
 */
const B = (s: string) => btoa(s);
const DOWN = B("\x1b[B");
const RAW = "/tmp/moh-pty-regression-raw.bin";

describe.skipIf(!hasPython)("ask_user modal with a large open turn (PTY regression)", () => {
  test(
    "arrows move the selection promptly and the process survives",
    async () => {
      const { server, url } = startFakeOpenAi();
      try {
        const meta = await runPtyRaw({
          cols: 120,
          rows: 40,
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
            { wait: 0.3, send: B("hello") },
            { wait: 0.4, send: B("\r") },
            // Readiness wait (#236): return as soon as the modal renders its
            // question — the fixed 10s budget outran the whole scripted tool
            // chain on slow hosts, so the arrows arrived before any modal.
            // 45s: "up to", not a fixed sleep — slow CI hosts (containerized
            // runners with 2 vCPU) have been observed needing >15s (#630).
            { wait: 45.0, until: "Q1 — which way?" },
            { wait: 0.3, send: DOWN },
            { wait: 1.5, send: DOWN },
            { wait: 1.5, send: DOWN }, // now on "Other"
            { wait: 4.0 },
          ],
          tail: 40,
          rawDump: RAW,
        });
        expect(meta.aliveAtEnd).toBe(true); // the real crash: SIGKILL ("killed") — meaningful because sampled pre-kill (#236)
        const raw = readFileSync(RAW, "utf8");
        // The inline block rendered its question… (a miss here means the
        // readiness needle never landed: dump the child state and the raw
        // tail so slow-host vs. dead-child is diagnosable from the log).
        if (!raw.includes("Q1 — which way?")) {
          throw new Error(
            `readiness needle never appeared (aliveAtEnd=${meta.aliveAtEnd}, exited=${meta.exited}, ` +
              `exitCode=${meta.exitCode}); raw tail:\n${JSON.stringify(raw.slice(-2000))}`,
          );
        }
        // …and three ↓ keypresses reached the always-last "Other" row.
        expect(raw).toContain("Other");
      } finally {
        server.stop(true);
      }
    },
    70_000,
  );
});
