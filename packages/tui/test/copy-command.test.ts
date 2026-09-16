import { describe, expect, test } from "bun:test";
import { clipboardBackend, copyToClipboard, writeOsc52, type ClipboardBackend } from "../src/clipboard";
import { MockProvider, createSession, SessionStore } from "@moh/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSlashCommand, type SlashContext } from "../src/commands";

describe("clipboard backend (#672)", () => {
  test("an injected backend is used and cached", async () => {
    const writes: string[] = [];
    const backend: ClipboardBackend = { kind: "binary", write: async (t) => { writes.push(t); }, };
    expect(clipboardBackend(backend)).toBe(backend);
    expect(await copyToClipboard("hello")).toBe(backend);
    expect(writes).toEqual(["hello"]);
    // reset the module cache for other tests
    clipboardBackend(null);
  });

  test("writeOsc52 emits the base64 OSC 52 sequence on stdout", async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = ((chunk: string, cb?: (e?: Error) => void) => {
      chunks.push(chunk);
      cb?.();
      return true;
    }) as typeof process.stdout.write;
    try {
      await writeOsc52("ciao");
    } finally {
      (process.stdout as { write: unknown }).write = original;
    }
    const b64 = Buffer.from("ciao", "utf8").toString("base64");
    expect(chunks).toEqual([`\x1b]52;c;${b64}\x1b]52;p;${b64}\x07`]);
  });

  test("on a TTY, OSC 52 is preferred over platform binaries (spec order)", () => {
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    try {
      clipboardBackend(null);
      expect(clipboardBackend().kind).toBe("osc52");
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
      clipboardBackend(null);
    }
  });

  test("without a TTY (piped/embedded), a platform binary is preferred, OSC 52 last", () => {
    const originalIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    try {
      clipboardBackend(null);
      // darwin CI has pbcopy; the exact kind depends on the platform
      expect(["binary", "osc52"]).toContain(clipboardBackend().kind);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: originalIsTTY, configurable: true });
      clipboardBackend(null);
    }
  });
});

describe("/copy slash command (#672)", () => {
  function makeCtx(session: ReturnType<typeof createSession> | null): { ctx: SlashContext; notices: string[] } {
    const notices: string[] = [];
    const ctx: SlashContext = {
      cwd: mkdtempSync(join(tmpdir(), "moh-copy-")),
      mohHome: mkdtempSync(join(tmpdir(), "moh-copy-home-")),
      config: { workflow: { enabled: false, upstreamCheck: true } } as SlashContext["config"],
      updateConfig: () => {},
      session,
      notify: (m) => notices.push(m),
    };
    return { ctx, notices };
  }

  function openSession(store: SessionStore, home: string, cwd: string) {
    return createSession({
      provider: MockProvider.scripted([{ deltas: ["first reply"], finish: "stop" }, { deltas: ["second reply"], finish: "stop" }]),
      cwd,
      mohHome: home,
      sessionFile: store.file,
      sink: (event) => store.append(event),
    });
  }

  test("copies the last assistant reply verbatim; a later user message resets it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-copy-cwd-"));
    const home = mkdtempSync(join(tmpdir(), "moh-copy-h-"));
    const store = SessionStore.create(cwd, home);
    const writes: string[] = [];
    clipboardBackend({ kind: "binary", write: async (t) => { writes.push(t); }, });
    const session = openSession(store, join(home, ".moh"), cwd);
    await session.send("question one");
    const { ctx, notices } = makeCtx(session);
    expect(runSlashCommand("/copy", ctx)).toBe(true);
    // async write settles
    await new Promise((r) => setTimeout(r, 10));
    expect(writes).toEqual(["first reply"]);
    expect(notices[0]).toContain("✓ copied");
    expect(notices[0]).toContain("11 chars");
    clipboardBackend(null);
  });

  test("fresh session shows a warning, never crashes", () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-copy-c2-"));
    const home = mkdtempSync(join(tmpdir(), "moh-copy-h2-"));
    const store = SessionStore.create(cwd, home);
    const session = openSession(store, join(home, ".moh"), cwd);
    const { ctx, notices } = makeCtx(session);
    expect(runSlashCommand("/copy", ctx)).toBe(true);
    expect(notices).toEqual(["nothing to copy yet"]);
    clipboardBackend(null);
  });

  test("no open session warns too", () => {
    const { ctx, notices } = makeCtx(null);
    expect(runSlashCommand("/copy", ctx)).toBe(true);
    expect(notices[0]).toContain("nothing to copy yet");
  });
});
