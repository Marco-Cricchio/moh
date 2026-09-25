import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasPython, runPtyRaw } from "./pty-runner";
import { startFakeOpenAi } from "./fake-openai-invalid-ask";

/**
 * Regression from session 20260902T020857899Z: navigation froze after
 * an invalid ask_user was retried. The historical case used an oversized
 * header; headers are now normalized, so this fixture uses one option
 * (still invalid) followed by a valid two-question set.
 */
const B = (s: string) => btoa(s);
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const RAW = "/tmp/moh-pty-ask-invalid-raw.bin";

describe.skipIf(!hasPython)("ask_user invalid-then-valid (PTY regression)", () => {
  test(
    "arrows and typing stay responsive after a failed ask_user retry",
    async () => {
      const { server, url, validationError } = startFakeOpenAi();
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
          steps: [
            { wait: 2.0 },
            // A long first message (wraps to several visual lines): its
            // history entry is what ↑ loads into the composer while the
            // ask_user block is open — the freeze scenario.
            { wait: 0.3, send: B("una domanda molto lunga che quando viene richiamata dallo storico occupa piu di una riga visiva del composer e spinge in alto il layout della chat") },
            { wait: 0.4, send: B("\r") },
            // First ask_user: invalid (one option) → error result; the fake
            // model then sends the valid two-question set.
            // The CI PTY batch runs two full TUI processes on a 2-vCPU
            // runner. Leave enough wall time for the fake-provider retry to
            // reach this readiness signal under that contention.
            { wait: 30.0, until: "Q1 — which way?", untilOnScreen: true },
            // Stress: rapid arrows (the first ↑ loads the long history
            // draft into the composer while the block is open) + typed chars.
            { wait: 0.5, send: B(UP) },
            { wait: 0.2, send: B(DOWN) },
            { wait: 0.1, send: B(UP) },
            { wait: 0.1, send: B(DOWN) },
            { wait: 0.1, send: B(UP + UP) },
            { wait: 0.1, send: B(DOWN + DOWN) },
            { wait: 0.3, send: B("x") },
            { wait: 0.1, send: B("y") },
            { wait: 0.3, send: B(TAB) },
            { wait: 0.3, send: B(UP) },
            { wait: 0.1, send: B(DOWN) },
            { wait: 0.1, send: B(DOWN + DOWN) },
            { wait: 2.0, send: B("z") },
            { wait: 2.0 },
          ],
          tail: 40,
          rawDump: RAW,
        });
        expect(validationError()).toContain("invalid arguments for ask_user:");
        expect(validationError()).toContain("questions.0.options");
        expect(meta.aliveAtEnd).toBe(true);
        const raw = readFileSync(RAW, "utf8");
        expect(raw).toContain("Q1 — which way?");
        expect(raw).toContain("Q2 — how fast?");
        // Responsiveness: a typed char after the stress burst must reach the
        // screen (the last frame contains it) — freeze = nothing changes.
        expect(meta.lines.map((l) => l.text).join("\n")).toContain("z");
      } finally {
        server.stop(true);
      }
    },
    70_000,
  );
});
