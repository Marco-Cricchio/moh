import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/index";
import { renameSession } from "../src/session-store";

/**
 * ADR-0058 (#1105): no secret may ever reach the session JSONL logs in
 * cleartext. The redaction is an invariant of the log writer — applied at
 * the single write seam, on every event, with no opt-out.
 */
describe("session log secret redaction (ADR-0058)", () => {
  function tempStore(): { store: SessionStore; home: string } {
    const home = mkdtempSync(join(tmpdir(), "moh-redact-"));
    const cwd = mkdtempSync(join(tmpdir(), "moh-redact-proj-"));
    return { store: SessionStore.create(cwd, home), home };
  }

  const SECRET = "sk-abcdefghijklmnopqrstuvwx";

  test("tool_result content with a secret key is redacted on disk, not in memory", () => {
    const { store } = tempStore();
    const event = {
      type: "tool_result" as const,
      callId: "c1",
      ok: true,
      output: `GITHUB_TOKEN=${SECRET}`,
    };
    store.append(event as never);
    // In memory: untouched.
    expect((event as { output: string }).output).toBe(`GITHUB_TOKEN=${SECRET}`);
    // On disk: masked.
    expect(readFileSync(store.file, "utf8")).not.toContain(SECRET);
    expect(readFileSync(store.file, "utf8")).toContain("[redacted]");
  });

  test("user_message, assistant_delta and tool_call payloads are redacted", () => {
    const { store } = tempStore();
    store.append({ type: "user_message", text: `use ${SECRET} please` } as never);
    store.append({ type: "assistant_delta", text: `ok, testing ${SECRET}` } as never);
    store.append({ type: "tool_call", callId: "c2", name: "bash", args: { cmd: `echo ${SECRET}`, token: "abcdefgh1234567890" } } as never);
    const raw = readFileSync(store.file, "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain('"token":"[redacted]"');
  });

  test("key-based masking applies to secret-shaped keys in any payload", () => {
    const { store } = tempStore();
    store.append({
      type: "tool_result",
      callId: "c3",
      ok: true,
      output: "config:",
    } as never);
    store.append({
      type: "extension_event",
      name: "x",
      payload: { apiKey: SECRET },
    } as never);
    const raw = readFileSync(store.file, "utf8");
    expect(raw).not.toContain(SECRET);
  });

  test("PEM private keys and Bearer headers in free text are masked", () => {
    const { store } = tempStore();
    store.append({
      type: "user_message",
      text: [
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIBOgIBAAJBAK",
        "-----END RSA PRIVATE KEY-----",
        "curl -H 'Authorization: Bearer abcdef1234567890abcdef'",
      ].join("\n"),
    } as never);
    const raw = readFileSync(store.file, "utf8");
    expect(raw).not.toContain("MIIBOgIBAAJBAK");
    expect(raw).not.toContain("abcdef1234567890abcdef");
  });

  test("direct chrome writers are redacted too — a secret in a session rename never lands", () => {
    const { store, home } = tempStore();
    store.append({ type: "user_message", text: "hi" } as never);
    store.dispose();
    renameSession(store.file, `my key is ${SECRET}`);
    const raw = readFileSync(store.file, "utf8");
    expect(raw).not.toContain(SECRET);
  });

  test("the miss-report lands in the session's own moh home, not the process home", () => {
    const { store, home } = tempStore();
    store.append({ type: "user_message", text: "hi" } as never);
    store.dispose();
    renameSession(store.file, "signature: 'abcdefghijklmnopqrstuvwxyz0123'");
    expect(existsSync(join(home, "secret-redaction-misses.log"))).toBe(true);
  });

  test("lookalikes that passed unmasked leave a content-free miss-report line", () => {
    const { store, home } = tempStore();
    store.append({
      type: "user_message",
      text: "signature: 'abcdefghijklmnopqrstuvwxyz0123'",
    } as never);
    store.dispose();
    const missesFile = join(home, "secret-redaction-misses.log");
    expect(existsSync(missesFile)).toBe(true);
    const raw = readFileSync(missesFile, "utf8");
    expect(raw).toContain("hash-like-assignment");
    // Content-free: the value itself never appears.
    expect(raw).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  test("cyclic payloads keep the pre-existing writer contract; the miss-report never throws", () => {
    const { store } = tempStore();
    const payload: Record<string, unknown> = { name: "cycle" };
    payload.self = payload;
    // The pass is transparent to serializability: an event a plain
    // JSON.stringify would reject is rejected identically (extension
    // events are serialize-checked before they reach the store).
    expect(() =>
      store.append({ type: "extension_event", name: "x", payload } as never),
    ).toThrow();
    const { noteSecretRedactionMisses } = require("../src/redact");
    expect(() =>
      noteSecretRedactionMisses("/nonexistent-root-xyz", [{ category: "c", length: 1 }]),
    ).not.toThrow();
  });
});
