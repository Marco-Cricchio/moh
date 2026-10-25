import { appendFileSync } from "node:fs";

/**
 * #1679 diagnostic, off unless `MOH_SESSION_PROBE=<file>` is set: one JSON
 * line per stage of session construction, with the time since the previous
 * stage of the same process. A stage that took seconds shows as a large
 * `sincePrevMs` on the line that ends it, so a stall is localized to the
 * code between two named stages. Counts constructions (`n`; the
 * `createSession` line carries the number of the construction it starts) so
 * interleaved sessions can be told apart.
 *
 * The first stage also starts a heartbeat on a worker thread: one epoch-ms
 * line every 100 ms in `<file>.heartbeat`. A stall of the main thread with a
 * heartbeat that keeps ticking means the main thread is blocked in code; a
 * heartbeat that stops with it means the whole process was not running (the
 * OS). Never changes behaviour (the worker is unref'd) and never throws.
 */
let last = performance.now();
let constructions = 0;
let heartbeat: Worker | undefined;
let heartbeatFile: string | undefined;

/** The worker body, as a blob: nothing for a bundler to follow and no file to ship. */
const HEARTBEAT_SOURCE = `
  const { appendFileSync } = require("node:fs");
  let timer;
  self.onmessage = (event) => {
    const file = event.data;
    clearInterval(timer);
    timer = setInterval(() => {
      try { appendFileSync(file, Date.now() + "\\n"); } catch {}
    }, 100);
  };
`;

function startHeartbeat(file: string): void {
  if (heartbeat && heartbeatFile === file) return;
  try {
    if (!heartbeat) {
      heartbeat = new Worker(URL.createObjectURL(new Blob([HEARTBEAT_SOURCE], { type: "text/javascript" })));
      (heartbeat as unknown as { unref?: () => void }).unref?.();
    }
    heartbeatFile = file;
    heartbeat.postMessage(`${file}.heartbeat`);
  } catch {
    // diagnostic only
  }
}

export function probeStage(stage: string): void {
  const file = process.env.MOH_SESSION_PROBE;
  if (!file) return;
  startHeartbeat(file);
  try {
    const now = performance.now();
    if (stage === "ctor:start") constructions += 1;
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), n: stage === "createSession" ? constructions + 1 : constructions, stage, sincePrevMs: Math.round((now - last) * 10) / 10 })}\n`,
    );
    last = performance.now();
  } catch {
    // diagnostic only
  }
}
