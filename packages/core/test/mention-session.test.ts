/**
 * File mentions (#488, vision note 3): `@path` tokens in a sent message
 * become structured attachments on the `user_message` event, gated by
 * read-permission rules; denied files produce a visible warning event.
 * The text stays as typed — contents ride the attachments.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, MockProvider } from "../src/index";
import type { Message, Provider, StreamEvent } from "../src/types";

function captureProvider(): { users: Message[]; provider: Provider } {
  const users: Message[] = [];
  const provider: Provider = {
    name: "capture",
    async *stream(messages: Message[]): AsyncIterable<StreamEvent> {
      users.push(...messages.filter((m) => m.role === "user"));
      yield { type: "finish", reason: "stop" } as const;
    },
  };
  return { users, provider };
}

describe("file mentions (#488)", () => {
  test("send with @file attaches the snapshot; the text stays as typed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-mention-session-"));
    try {
      writeFileSync(join(dir, "note.ts"), "const answer = 42;\n");
      const { users, provider } = captureProvider();
      const session = createSession({ provider, cwd: dir });
      await session.send("explain @note.ts");

      const event = session.history().find((e) => e.type === "user_message") as any;
      expect(event.text).toBe("explain @note.ts");
      expect(event.attachments).toEqual([
        { kind: "file", path: "note.ts", mime: "text/plain", content: "const answer = 42;\n", truncated: false },
      ]);

      // The provider saw the text plus one attachment text part.
      const last = users[users.length - 1]!;
      expect(last.parts).toHaveLength(2);
      expect((last.parts[1] as any).text).toContain('kind="file" path="note.ts"');
      expect((last.parts[1] as any).text).toContain("const answer = 42;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no mentions: no attachments field, wire unchanged", async () => {
    const { users, provider } = captureProvider();
    const session = createSession({ provider });
    await session.send("plain message");
    const event = session.history().find((e) => e.type === "user_message") as any;
    expect(event.attachments).toBeUndefined();
    const last = users[users.length - 1]!;
    expect(last.parts).toHaveLength(1);
  });

  test("denied file: mention_warnings event, no attachment in the log or on the wire", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-mention-denied-"));
    try {
      writeFileSync(join(dir, "secret.env"), "hunter2");
      const { users, provider } = captureProvider();
      const session = createSession({
        provider,
        cwd: dir,
        permissions: { runtimeRules: [{ tool: "read", args: "secret.env", effect: "deny", tier: "runtime" }] },
      });
      await session.send("peek @secret.env");

      const types = session.history().map((e) => e.type);
      const warnAt = types.indexOf("mention_warnings");
      expect(warnAt).toBeGreaterThanOrEqual(0);
      expect(types[warnAt + 1]).toBe("user_message"); // warning lands right before the message
      const warn = session.history()[warnAt] as any;
      expect(warn.warnings).toEqual([{ path: "secret.env", reason: "denied by permission rule" }]);

      const event = session.history().find((e) => e.type === "user_message") as any;
      expect(event.attachments).toBeUndefined();
      const last = users[users.length - 1]!;
      expect(last.parts).toHaveLength(1);
      expect(JSON.stringify(last)).not.toContain("hunter2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("@dir attaches the listing only; attachments survive replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-mention-dir-"));
    try {
      mkdirSync(join(dir, "lib"), { recursive: true });
      writeFileSync(join(dir, "lib", "a.ts"), "export {};");
      const { users, provider } = captureProvider();
      const session = createSession({ provider, cwd: dir });
      await session.send("map @lib");

      const event = session.history().find((e) => e.type === "user_message") as any;
      expect(event.attachments[0]).toEqual({ kind: "directory", path: "lib", listing: ["a.ts"], truncated: false });

      // Replay rebuilds the same user message parts (resume/fork inherit).
      const { replayMessages } = await import("../src/session-store");
      const messages = replayMessages(session.history());
      const rebuilt = messages.find((m) => m.role === "user" && m.parts.some((p) => (p as any).text?.includes('kind="directory"')));
      expect(rebuilt).toBeDefined();
      expect((rebuilt!.parts[1] as any).text).toContain('path="lib"');
      expect((rebuilt!.parts[1] as any).text).toContain("a.ts");
      expect(users.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
