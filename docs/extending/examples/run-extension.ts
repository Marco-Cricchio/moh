/**
 * Host-side walkthrough: load the no-rm-rf extension, run a scripted turn
 * where the model tries `rm -rf /`, and watch the veto deny it.
 *
 * Run from the repo root: bun docs/extending/examples/run-extension.ts
 */
import {
  builtinTools,
  createSession,
  ExtensionRuntime,
  MockProvider,
  type AgentEvent,
} from "@moh/core";
import { join } from "node:path";

// 1. The runtime owns loading + policy. Consent and dependency
//    authorization are explicit host seams (here: just say yes).
const extensions = new ExtensionRuntime({ consent: () => true });
const loaded = await extensions.registerFile(
  join(import.meta.dir, "no-rm-rf.mjs"),
);
if (!loaded) throw new Error("extension failed to load");

// 2. A session with a scripted provider whose first turn calls bash.
const provider = MockProvider.scripted([
  {
    deltas: [],
    finish: "tool_calls",
    toolCalls: [{ name: "bash", args: { command: "rm -rf /tmp/scratch" } }],
  },
  { deltas: ["I can't do that."], finish: "stop" },
]);

const session = createSession({
  provider,
  cwd: process.cwd(),
  tools: builtinTools(),
  permissions: {
    mode: "auto-accept",
    // note: auto-accept only skips the user ask — an extension veto still
    // applies (extensions can only restrict, never widen).
  },
  extensions,
  sink: (event: AgentEvent) => console.log(JSON.stringify(event)),
});

// 3. Run one turn; the denied call comes back as a tool_result the model sees.
const result = await session.send("clean up /tmp/scratch");
console.error("turn:", result.status);

await session.dispose();
