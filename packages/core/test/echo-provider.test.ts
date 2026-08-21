import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, EchoProvider, lastAssistantText, builtinTools, type AgentEvent } from "../src";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("EchoProvider (issue #39)", () => {
  test("deterministically reflects received tools, system prompt, and messages", async () => {
    const provider = new EchoProvider();
    const session = createSession({ provider, tools: builtinTools(), cwd: mkdtempSync(join(tmpdir(), "echo-")) });
    await session.send("hello echo");
    const reply = lastAssistantText(session.history());
    const parsed = JSON.parse(reply!) as {
      echo: number;
      systemSha256: string;
      tools: string[];
      messages: { role: string; sha256: string }[];
    };
    expect(parsed.echo).toBe(1);
    // The last request the provider saw is inspectable in-process.
    const last = provider.lastRequest;
    expect(last).toBeDefined();
    expect(last!.messages.at(-1)).toEqual({ role: "user", parts: [{ kind: "text", text: "hello echo" }] });
    expect(last!.system).toContain("You are moh");
    expect(last!.tools.map((t) => t.name)).toContain("bash");
    // The reply hashes match what was actually sent.
    expect(parsed.systemSha256).toBe(sha(last!.system));
    expect(parsed.messages.at(-1)).toEqual({ role: "user", sha256: sha("hello echo") });
    // Sorted tool names, stable across runs.
    expect(parsed.tools).toEqual([...last!.tools.map((t) => t.name)].sort());
    await session.dispose();
  });

  test("the system hash changes when an injected instructions file appears (regression guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-inject-"));
    const run = async () => {
      const session = createSession({ provider: new EchoProvider(), tools: builtinTools(), cwd: dir });
      await session.send("ping");
      const parsed = JSON.parse(lastAssistantText(session.history())!) as { systemSha256: string };
      await session.dispose();
      return parsed.systemSha256;
    };
    const before = await run();
    writeFileSync(join(dir, "AGENTS.md"), "UNIQUE-MARKER-9f2a do not guess");
    const after = await run();
    expect(after).not.toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the same input always produces the same summary (determinism)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-det-"));
    const run = async () => {
      const session = createSession({ provider: new EchoProvider(), tools: builtinTools(), cwd: dir });
      await session.send("deterministic?");
      const reply = lastAssistantText(session.history())!;
      await session.dispose();
      return reply;
    };
    expect(await run()).toBe(await run());
    rmSync(dir, { recursive: true, force: true });
  });
});
