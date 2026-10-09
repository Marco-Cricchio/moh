import "./faketty/ci-mask";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, SessionStore, builtinTools, createSession } from "@moh/core";
import { Chat } from "../src/Chat";
import { renderOnFakeTty } from "./faketty/render";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bangSession(turns: Parameters<typeof MockProvider.scripted>[0], onPermissionRequest?: (tool: string) => Promise<"yes" | "no">) {
  const cwd = mkdtempSync(join(tmpdir(), "moh-bang-"));
  const home = mkdtempSync(join(tmpdir(), "moh-bang-h-"));
  const store = SessionStore.create(cwd, home);
  const session = createSession({
    provider: MockProvider.scripted(turns),
    tools: builtinTools(),
    permissions: { unrestrictedTools: true },
    ...(onPermissionRequest ? { onPermissionRequest } : {}),
    sink: (event) => store.append(event),
  });
  return session;
}

function history(term: ReturnType<typeof renderOnFakeTty>): string {
  return [...term.screen.scrollback(), ...term.screen.lines()].join("\n");
}

async function waitFor(term: ReturnType<typeof renderOnFakeTty>, needle: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!history(term).includes(needle) && Date.now() < deadline) await sleep(20);
  expect(history(term)).toContain(needle);
}

function chatFor(session: ReturnType<typeof bangSession>, onNotify?: (t: string) => void) {
  return (
    <Chat
      session={session}
      cwd={process.cwd()}
      mode="dev"
      modelLabel="mock"
      width={100}
      onNotify={onNotify}
    />
  );
}

describe("composer bang commands (ADR-0076)", () => {
  test("!cmd runs through the bash tool and shows in the transcript", async () => {
    const session = bangSession([{ deltas: ["ok"], finish: "stop" }]);
    const term = renderOnFakeTty(chatFor(session), { cols: 100, rows: 40 });
    term.write("!echo bang-marker-42");
    await sleep(20);
    term.write("\r");
    await waitFor(term, "bang-marker-42", 15_000);
    term.unmount();
  });

  test("!!cmd auto-sends the output to the model", async () => {
    const session = bangSession([{ deltas: ["ack"], finish: "stop" }]);
    const term = renderOnFakeTty(chatFor(session), { cols: 100, rows: 40 });
    term.write("!!echo autosend-marker-7");
    await sleep(20);
    term.write("\r");
    await waitFor(term, "autosend-marker-7", 15_000);
    await sleep(500);
    // The auto-send's user message reached the log after the tool result.
    const kinds = session.history().map((e) => e.type);
    const resultAt = kinds.lastIndexOf("tool_result");
    const sendAt = kinds.indexOf("user_message");
    expect(sendAt).toBeGreaterThan(-1);
    expect(resultAt).toBeGreaterThan(-1);
    term.unmount();
  });

  test("an active turn refuses the bang visibly", async () => {
    // #1061 hold: a turn that stays open until the test ends — pending is
    // deterministic, never a wall-clock race.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const session = bangSession([{ deltas: ["half"], finish: "stop", hold: { afterDeltas: 0, release: gate } }]);
    const notices: string[] = [];
    const term = renderOnFakeTty(chatFor(session, (t) => notices.push(t)), { cols: 100, rows: 40 });
    void session.send("long turn");
    await sleep(300);
    term.write("!echo nope");
    await sleep(30);
    term.write("\r");
    await sleep(300);
    expect(session.pending()).toBe(true);
    expect(notices.some((t) => t.includes("esc to interrupt"))).toBe(true);
    release();
    term.unmount();
  });

  test("\\! escapes to a literal prompt send", async () => {
    const session = bangSession([{ deltas: ["done"], finish: "stop" }]);
    const term = renderOnFakeTty(chatFor(session), { cols: 100, rows: 40 });
    term.write("\\!literal");
    await sleep(20);
    term.write("\r");
    await waitFor(term, "!literal", 10_000);
    term.unmount();
  });
});
