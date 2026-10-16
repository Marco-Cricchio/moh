// S0.3/B5 TUI frame scripts.
//
//   bun scripts/ablation-baseline/tui.ts <outDir>
//
// Drives the real TUI inside a pseudo terminal (the existing PTY harness)
// with key-sequence scripts: every overlay of the `Overlay` union that a
// deterministic fixture can reach, the Settings sub-modal return path, a
// tool permission prompt, a `!` bang command, an `@file` mention and
// `/tree`. Each visit snapshots the physical screen at a named checkpoint;
// <outDir>/tui/<scenario>.json holds the normalized frames.
//
// Runs sequentially (one PTY at a time) and needs python3 (the harness).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Normalizer } from "./normalize";
import { runPtyRaw, python3, DEV_CONFIG, type PtySpec } from "../../packages/tui/test/pty/pty-runner";
import { startFakeOpenAiTurns } from "../../packages/tui/test/pty/fake-openai-turns";
import { hermetic } from "./tui-hermetic";

const REPO = join(import.meta.dir, "..", "..");

const B = (s: string): string => Buffer.from(s, "utf8").toString("base64");

/** Fake openai-compat SSE server: one scripted turn per call, driven by a
 * list of {toolCall?, text} entries. */
function startFakeServer(turns: Array<{ toolCall?: { name: string; args: unknown }; text: string }>): {
  url: string;
  stop: () => void;
} {
  let call = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      const turn = turns[Math.min(call, turns.length - 1)]!;
      call += 1;
      const encoder = new TextEncoder();
      const chunk = (delta: Record<string, unknown>, finish: string | null = null): Uint8Array =>
        encoder.encode(
          `data: ${JSON.stringify({ id: `t${call}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
        );
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(chunk({ role: "assistant" }));
          controller.enqueue(chunk({ content: `${turn.text}\n` }));
          if (turn.toolCall) {
            controller.enqueue(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${call}`,
                    type: "function",
                    function: { name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.args) },
                  },
                ],
              }),
            );
            controller.enqueue(chunk({}, "tool_calls"));
          } else {
            controller.enqueue(chunk({}, "stop"));
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

export interface Scenario {
  name: string;
  spec: (ctx: { url: string }) => PtySpec;
}

export const scenarios: Scenario[] = [
  {
    name: "onboarding-fresh",
    spec: () => ({
      cols: 100,
      rows: 30,
      steps: [
        { send: B("\x1b") }, // end the intro (it settles at ~3.15s)
        { wait: 8.0, until: "enter select · s skip", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "onboarding" },
        { wait: 0.3, send: B("\x03") },
        { wait: 0.5, send: B("\x03") },
      ],
      tail: 30,
    }),
  },
  {
    name: "workflow-offer",
    spec: () => ({
      cols: 100,
      rows: 30,
      config: { onboarded: true, updateCheck: false },
      project: {},
      steps: [
        { wait: 5.0 }, // let the random startup intro settle
        { wait: 8.0, until: "workflow mode", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "workflow-offer" },
        { wait: 0.3, send: B("\x1b") },
      ],
      tail: 30,
    }),
  },
  {
    name: "handoff-onboarding",
    spec: () => ({
      cols: 100,
      rows: 30,
      config: { ...DEV_CONFIG, updateCheck: false },
      bareProject: true,
      steps: [
        { wait: 5.0 }, // let the random startup intro settle
        { wait: 8.0, until: "Continue work from this project", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "handoff-onboarding" },
        { wait: 0.3, send: B("\x1b") },
      ],
      tail: 30,
    }),
  },
  {
    name: "overlay-walk",
    spec: ({ url }) => ({
      cols: 100,
      rows: 30,
      timeoutMs: 150_000,
      fixedTempNames: true,
      config: {
        ...DEV_CONFIG,
        // Workflow on: the frontier overlay (ctrl+f) needs it.
        workflow: { enabled: true },
        provider: "fake",
        endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
      },
      project: { permissions: { overrides: { tools: { bash: "allow" } } } },
      steps: [
        { wait: 5.0 }, // let the random startup intro settle
        { wait: 8.0, until: "New session", untilFromBuffer: true },
        { wait: 0.3, send: B("one") },
        { wait: 0.4, send: B("\r") },
        { wait: 10.0, until: "TURN-1-MARKER", untilOnScreen: true },
        { wait: 8.0, until: "done", untilOnScreen: true }, // the turn settled
        { wait: 0.4, send: B("\x13") }, // ctrl+s → settings
        { wait: 8.0, until: "Remove provider", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "settings" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 0.4, send: B("\x0b") }, // ctrl+k → commands
        { wait: 8.0, until: "this command list", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "commands" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 0.4, send: B("\x1b[104;5u") }, // CSI-u ctrl+h → manual (0x08 is backspace on legacy terms)
        { wait: 8.0, until: "type to filter", untilFromBuffer: true },
        { checkpoint: "manual" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 0.4, send: B("\x0e") }, // ctrl+n → notes
        { wait: 8.0, until: "no notes yet", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "notes" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 0.4, send: B("\x0c") }, // ctrl+l → model picker
        { wait: 8.0, until: "filter:", untilFromBuffer: true },
        // The picker's list fetch and the live refresh change its layout while
        // they run ("fetching models…"): wait for the settled picker.
        { wait: 8.0, until: "no list from fake", untilOnScreen: true },
        { wait: 8.0, until: "nothing to refresh", untilOnScreen: true },
        { checkpoint: "model" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 0.4, send: B("\x06") }, // ctrl+f → frontier (workflow on in dev mode)
        { wait: 8.0, until: "frontier", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "frontier" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 1.0, send: B("/tree") },
        { wait: 1.0, send: B("\r") },
        { wait: 0.6, send: B("\r") },
        { wait: 8.0, until: "switch here", untilOnScreen: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "tree" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 1.0, send: B("/mpm") },
        { wait: 1.0, send: B("\r") },
        { wait: 0.6, send: B("\r") },
        { wait: 8.0, until: "project map", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "mpm" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 1.0, send: B("/session") },
        { wait: 1.0, send: B("\r") },
        { wait: 0.6, send: B("\r") },
        { wait: 8.0, until: "usage by model", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "session" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 1.0, send: B("/retro") },
        { wait: 1.0, send: B("\r") },
        { wait: 0.6, send: B("\r") },
        { wait: 8.0, until: "retro findings", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "retro" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 1.0, send: B("/lanes") },
        { wait: 1.0, send: B("\r") },
        { wait: 0.6, send: B("\r") },
        { wait: 8.0, until: "no feature groups yet", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "lanes" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 1.0, send: B("/jev") },
        { wait: 1.0, send: B("\r") },
        { wait: 0.6, send: B("\r") },
        { wait: 8.0, until: "Jev is not active in this session.", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "jev" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 1.0, send: B("/extensions") },
        { wait: 1.0, send: B("\r") },
        { wait: 0.6, send: B("\r") },
        { wait: 8.0, until: "extensions", untilOnScreen: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "extensions" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 1.0, send: B("/browser") },
        { wait: 1.0, send: B("\r") },
        { wait: 0.6, send: B("\r") },
        { wait: 8.0, until: "browser setup", untilFromBuffer: true },
        { checkpoint: "browser" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 0.4, send: B("\x11") }, // ctrl+q → quota
        { wait: 8.0, until: "usage quota", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "quota" },
        { wait: 0.5, send: B("\x1b") },
        { wait: 0.4, send: B("\x12") }, // ctrl+r → rename
        { wait: 8.0, until: "rename session", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "rename" },
        { wait: 0.5, send: B("\x1b") },
      ],
      tail: 30,
    }),
  },
  {
    name: "stranded",
    spec: () => ({
      cols: 100,
      rows: 30,
      config: { ...DEV_CONFIG, updateCheck: false },
      seedStranded: true,
      fixedTempNames: true,
      steps: [
        { wait: 5.0 }, // let the random startup intro settle
        { wait: 8.0, until: "older data kept in", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "stranded-row" },
        { wait: 0.4, send: B("\x1b[B") }, // row 0 "New session" → the warning row
        { wait: 0.4, send: B("\r") },
        { wait: 8.0, until: "older project data", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "stranded-modal" },
        { wait: 0.5, send: B("\x1b") },
      ],
      tail: 30,
    }),
  },
  {
    name: "settings-submodal-return",
    spec: ({ url }) => ({
      cols: 100,
      rows: 30,
      config: {
        ...DEV_CONFIG,
        provider: "fake",
        endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
      },
      steps: [
        { wait: 5.0 }, // let the random startup intro settle
        { wait: 8.0, until: "New session", untilFromBuffer: true },
        { wait: 0.4, send: B("\x13") }, // ctrl+s → settings
        { wait: 8.0, until: "Remove provider", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "settings-open" },
        { wait: 0.4, send: B("\x1b[B") }, // down to "My themes…"
        { wait: 0.4, send: B("\r") }, // open the theme studio sub-modal
        { wait: 8.0, until: "My themes…", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "theme-studio" },
        { wait: 0.5, send: B("\x1b") }, // back to settings
        { wait: 8.0, until: "Remove provider", untilFromBuffer: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "settings-back" },
        { wait: 0.5, send: B("\x1b") }, // back to chat
      ],
      tail: 30,
    }),
  },
  {
    name: "permission-prompt",
    spec: ({ url }) => ({
      cols: 100,
      rows: 30,
      config: {
        ...DEV_CONFIG,
        updateCheck: false,
        provider: "fake",
        endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
      },
      project: { permissions: { overrides: { tools: { bash: "ask" } } } },
      steps: [
        { wait: 5.0 }, // let the random startup intro settle
        { wait: 8.0, until: "New session", untilFromBuffer: true },
        { wait: 0.3, send: B("run it") },
        { wait: 0.4, send: B("\r") },
        { wait: 12.0, until: "a always", untilOnScreen: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "permission-prompt" },
        { wait: 0.4, send: B("y") },
        { wait: 10.0, until: "PERMISSION-ALLOWED", untilOnScreen: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "permission-allowed" },
      ],
      tail: 30,
    }),
  },
  {
    name: "bang-command",
    spec: ({ url }) => ({
      cols: 100,
      rows: 30,
      config: {
        ...DEV_CONFIG,
        updateCheck: false,
        // Workflow on: the frontier overlay (ctrl+f) needs it.
        workflow: { enabled: true },
        provider: "fake",
        endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
      },
      project: { permissions: { overrides: { tools: { bash: "allow" } } } },
      steps: [
        { wait: 5.0 }, // let the random startup intro settle
        { wait: 8.0, until: "New session", untilFromBuffer: true },
        { wait: 0.3, send: B("one") },
        { wait: 0.4, send: B("\r") },
        { wait: 10.0, until: "TURN-1-MARKER", untilOnScreen: true },
        { wait: 8.0, until: "done", untilOnScreen: true }, // the turn settled
        { wait: 0.4, send: B("!echo bang-ok") },
        { wait: 0.4, send: B("\r") },
        { wait: 10.0, until: "bang-ok", untilOnScreen: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "bang" },
      ],
      tail: 30,
    }),
  },
  {
    name: "mention-attach",
    spec: ({ url }) => ({
      cols: 100,
      rows: 30,
      config: {
        ...DEV_CONFIG,
        updateCheck: false,
        provider: "fake",
        endpoints: [{ name: "fake", type: "openai-compat", baseUrl: url, apiKey: "test-key", defaultModel: "fake-model" }],
      },
      files: { "notes.txt": B("the note body\n") },
      steps: [
        { wait: 5.0 }, // let the random startup intro settle
        { wait: 8.0, until: "New session", untilFromBuffer: true },
        { wait: 0.3, send: B("one") },
        { wait: 0.4, send: B("\r") },
        { wait: 10.0, until: "TURN-1-MARKER", untilOnScreen: true },
        { wait: 8.0, until: "done", untilOnScreen: true }, // the turn settled
        { wait: 0.4, send: B("summarize @notes.txt") },
        { wait: 8.0, until: "notes.txt", untilOnScreen: true },
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "mention-typed" },
        { wait: 0.4, send: B("\r") },
        { wait: 0.6, send: B("\r") },
        { wait: 10.0, until: "TURN-2-MARKER", untilOnScreen: true },
        { wait: 8.0, until: "done", untilOnScreen: true }, // the turn settled
        { wait: 0.5 }, // settle: capture a repaint that finished
        { checkpoint: "mention-sent" },
      ],
      tail: 30,
    }),
  },
];

async function main(): Promise<number> {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: tui.ts <outDir>");
    process.exit(2);
  }
  if (!python3) {
    console.error("python3 not found on PATH — the PTY harness cannot run");
    return 2;
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "tui"), { recursive: true });

  // One turn server per scenario kind, started lazily and kept alive for the
  // whole run (the harness's runPtyRaw is async, so the parent event loop
  // keeps serving while the child TUI fetches).
  const turnsServer = startFakeOpenAiTurns(4);
  const permissionServer = startFakeServer([
    { toolCall: { name: "bash", args: { command: "echo permissioned" } }, text: "asking " },
    { text: "PERMISSION-ALLOWED" },
  ]);
  const bangServer = startFakeServer([{ text: "TURN-1-MARKER bang scenario" }]);
  const mentionServer = startFakeServer([{ text: "TURN-1-MARKER mention scenario" }, { text: "TURN-2-MARKER mention answered" }]);

  const urlFor = (name: string): string => {
    if (name === "overlay-walk" || name === "settings-submodal-return") return turnsServer.url;
    if (name === "permission-prompt") return permissionServer.url;
    if (name === "bang-command") return bangServer.url;
    return mentionServer.url;
  };

  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx !== -1 ? process.argv.slice(onlyIdx + 1) : [];
  const selected = scenarios.filter((s) => only.length === 0 || only.includes(s.name));

  let failures = 0;
  try {
    for (const scenario of selected) {
      process.stderr.write(`[b5] ${scenario.name} … `);
      try {
        const meta = await runPtyRaw({ ...hermetic(scenario.spec({ url: urlFor(scenario.name) })), meta: true });
        // Sentinel prefixes: the harness's temp home/cwd are unknown here,
        // and the screens under test never print absolute paths.
        const norm = new Normalizer({ home: meta.home ?? "/\u0000none", cwd: meta.cwd ?? "/\u0000none" });
        const frames: Record<string, string[]> = {};
        for (const [name, snap] of Object.entries(meta.checkpoints ?? {})) {
          frames[name] = snap.lines.map((l) => norm.text(l.text, "display"));
        }
        const payload = {
          scenario: scenario.name,
          exited: meta.exited,
          exitCode: meta.exitCode,
          frames,
        };
        writeFileSync(join(outDir, "tui", `${scenario.name}.json`), JSON.stringify(payload, null, 2) + "\n");
        process.stderr.write(`ok (${Object.keys(frames).length} checkpoints)\n`);
      } catch (e) {
        failures += 1;
        process.stderr.write(`FAILED: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  } finally {
    turnsServer.server.stop(true);
    permissionServer.stop();
    bangServer.stop();
    mentionServer.stop();
  }
  console.log(`tui: ${selected.length} scenarios, ${failures} failures`);
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
