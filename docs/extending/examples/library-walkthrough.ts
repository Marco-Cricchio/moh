/**
 * Library-usage walkthrough: embed moh with sessionFromConfig, consume the
 * session through the `events` async iterable, and set headless permissions
 * with rule strings (formatRule/parseRule grammar, ADR-0007).
 *
 * Run from the repo root: bun docs/extending/examples/library-walkthrough.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatRule,
  MockProvider,
  overridesFromFlags,
  parseRule,
  sessionFromConfig,
} from "@moh/core";

// 1. An isolated home + cwd: the walkthrough never touches your real
//    ~/.moh or reads a real moh.json.
const home = mkdtempSync(join(tmpdir(), "moh-doc-"));
const cwd = mkdtempSync(join(tmpdir(), "moh-doc-"));

// 2. The rule grammar (ADR-0007): "tool" or "tool:matcher", effect rides
//    on the caller. parseRule/formatRule round-trip.
const allow = parseRule("bash:git status", "allow");
console.log(formatRule(allow)); // -> "bash:git status"

// 3. The single assembly path (ADR-0005): one call reads config, resolves
//    the provider, wires subagents/memory/MCP, creates the store.
//    We pass a scripted provider; without consent seams this is headless.
const provider = MockProvider.scripted([
  {
    deltas: [],
    finish: "tool_calls",
    toolCalls: [{ name: "bash", args: { command: "git status" } }],
  },
  { deltas: ["done"], finish: "stop" },
]);
const assembled = sessionFromConfig({
  cwd,
  home,
  provider,
  overrides: {
    // Same grammar as `moh run --allow bash:git status`; flags merge on
    // top of any moh.json overrides (caller wins):
    permissionFlags: overridesFromFlags(["bash:git status"], []),
  },
});
if ("error" in assembled) throw new Error(assembled.error.message);
const { session, store } = assembled;

// 4. The event log IS the session: consume it as an async iterable while
//    the turn runs, then stop at the turn's `done` event.
async function watch() {
  for await (const event of session.events) {
    console.log(JSON.stringify(event));
    if (event.type === "done") break;
  }
}
const [turn] = await Promise.all([session.send("check the repo"), watch()]);
console.error("turn:", turn.status, "| log file:", store.file);

await session.dispose();
