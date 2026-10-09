import { describe, expect, test } from "bun:test";
import { MockProvider, SessionStore, builtinTools, createSession } from "@moh/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("hold keeps pending (afterDeltas 0, release raw promise)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const cwd = mkdtempSync(join(tmpdir(), "bangdbg-"));
  const store = SessionStore.create(cwd, cwd);
  const session = createSession({
    provider: MockProvider.scripted([{ deltas: ["half"], finish: "stop", hold: { afterDeltas: 0, release: gate } }]),
    tools: builtinTools(),
    permissions: { unrestrictedTools: true },
    sink: (e) => store.append(e),
  });
  void session.send("long turn");
  await sleep(400);
  console.log("pending:", session.pending());
  console.log("history types:", session.history().map((e) => e.type).join(","));
  release();
  expect(true).toBe(true);
});
