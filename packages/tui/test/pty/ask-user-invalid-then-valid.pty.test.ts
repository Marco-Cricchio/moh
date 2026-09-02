import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { hasPython, runPtyRaw } from "./pty-runner";
import { startFakeOpenAi } from "./fake-openai-invalid-ask";

/**
 * Regression (session 20260902T020857899Z): an ask_user call with an
 * invalid payload (header > 12 chars) failed validation with a visible
 * error result; the model retried with a valid 4-question set; while the
 * user pressed ↑/↓/tab through the block, the whole TUI froze (no arrow
 * response, no typing). Suspect: the block's useInput has no active flag,
 * so both the textarea and the block consume the same keys — the textarea
 * inserts text and re-renders per keystroke under the block.
 */
const B = (s: string) => btoa(s);
const UP = B("\x1b[A");
const DOWN = B("\x1b[B");
const TAB = B("\t");
const RAW = "/tmp/moh-pty-ask-invalid-raw.bin";

describe.skipIf(!hasPython)("ask_user invalid-then-valid (PTY regression)", () => {
  test(
    "arrows and typing stay responsive after a failed ask_user retry",
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
          steps: [
            { wait: 2.0 },
            // A long first message (wraps to several visual lines): its
            // history entry is what ↑ loads into the composer while the
            // ask_user block is open — the freeze scenario.
            { wait: 0.3, send: B("una domanda molto lunga che quando viene richiamata dallo storico occupa piu di una riga visiva del composer e spinge in alto il layout della chat") },
            { wait: 0.4, send: B("\r") },
            // First ask_user: invalid (header > 12) → error result; the fake
            // model then sends the valid 4-question set.
            { wait: 15.0, until: "Q1 — which way?" },
            // Stress: rapid arrows (the first ↑ loads the long history
            // draft into the composer while the block is open) + typed chars.
            { wait: 0.5, send: UP },
            { wait: 0.2, send: DOWN },
            { wait: 0.1, send: UP },
            { wait: 0.1, send: DOWN },
            { wait: 0.1, send: UP + UP },
            { wait: 0.1, send: DOWN + DOWN },
            { wait: 0.3, send: B("x") },
            { wait: 0.1, send: B("y") },
            { wait: 0.3, send: TAB },
            { wait: 0.3, send: UP },
            { wait: 0.1, send: DOWN },
            { wait: 0.1, send: DOWN + DOWN },
            { wait: 2.0, send: B("z") },
            { wait: 2.0 },
          ],
          tail: 40,
          rawDump: RAW,
        });
        expect(meta.aliveAtEnd).toBe(true);
        const raw = readFileSync(RAW, "utf8");
        expect(raw).toContain("Q1 — which way?");
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
