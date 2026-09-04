/**
 * File mentions (#488): a headless `moh run "… @file …"` expands through
 * the same core path as the TUI — the `user_message` in the session log
 * carries the structured attachment, a denied file produces a visible
 * `mention_warnings` event, and a directory attaches its listing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
// Reuse the e2e harness (isolated HOME/cwd child-process CLI). run.e2e.test.ts
// is imported for its helpers only; bun runs the tests it defines too —
// acceptable: they are the same suite's stable e2e set.
import { harness, readEvents, sessionFiles } from "./run.e2e.test";

describe("moh run file mentions (e2e)", () => {
  test("@file attaches the content snapshot to the logged user_message", () => {
    const { cwd, home, spawn } = harness();
    writeFileSync(join(cwd, "note.ts"), "const answer = 42;\n");
    const res = spawn(["run", "explain @note.ts"]);
    expect(res.code).toBe(0);
    const events = readEvents(readFileSync(sessionFiles(home)[0]!, "utf8"));
    const message = events.find((e: any) => e.type === "user_message")!;
    expect(message.text).toBe("explain @note.ts"); // mention stays in the text
    expect(message.attachments).toEqual([
      { kind: "file", path: "note.ts", mime: "text/plain", content: "const answer = 42;\n", truncated: false },
    ]);
  });

  test("@dir attaches the recursive listing, not the contents", () => {
    const { cwd, home, spawn } = harness();
    mkdirSync(join(cwd, "lib"), { recursive: true });
    writeFileSync(join(cwd, "lib", "a.ts"), "export {};");
    const res = spawn(["run", "map @lib"]);
    expect(res.code).toBe(0);
    const events = readEvents(readFileSync(sessionFiles(home)[0]!, "utf8"));
    const message = events.find((e: any) => e.type === "user_message")!;
    expect(message.attachments).toEqual([
      { kind: "directory", path: "lib", listing: ["a.ts"], truncated: false },
    ]);
  });

  test("a denied file yields a visible mention_warnings event, no attachment", () => {
    const { cwd, home, spawn } = harness();
    writeFileSync(join(cwd, "secret.env"), "hunter2");
    const res = spawn(["run", "--deny", "read:secret.env", "peek @secret.env"]);
    expect(res.code).toBe(0);
    const events = readEvents(readFileSync(sessionFiles(home)[0]!, "utf8"));
    const warnAt = events.findIndex((e: any) => e.type === "mention_warnings");
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(events[warnAt]!.warnings).toEqual([{ path: "secret.env", reason: "denied by permission rule" }]);
    const message = events.find((e: any) => e.type === "user_message")!;
    expect(message.attachments).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain("hunter2");
  });
});

describe("moh run image mentions (e2e, vision note 4)", () => {
  function png(): Buffer {
    const b = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(10, 16);
    b.writeUInt32BE(20, 20);
    b[30] = 0x41;
    return b;
  }

  test("@image.png attaches the typed image to the logged user_message", () => {
    const { cwd, home, spawn } = harness();
    writeFileSync(join(cwd, "shot.png"), png());
    const res = spawn(["run", "describe @shot.png"]);
    expect(res.code).toBe(0);
    const events = readEvents(readFileSync(sessionFiles(home)[0]!, "utf8"));
    const message = events.find((e: any) => e.type === "user_message")!;
    expect(message.attachments).toHaveLength(1);
    const a = message.attachments[0];
    expect(a.kind).toBe("image");
    expect(a.mime).toBe("image/png");
    expect(a.width).toBe(10);
    expect(a.height).toBe(20);
    expect(Buffer.from(a.content, "base64").equals(png())).toBe(true);
  });

  test("an over-cap image yields the visible refusal, no attachment", () => {
    const { cwd, home, spawn } = harness();
    // > 5MB real image bytes (mock provider has no catalog entry, so this
    // exercises the assembly-level cap refusal independent of the gate).
    writeFileSync(join(cwd, "big.png"), Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    const res = spawn(["run", "describe @big.png"]);
    expect(res.code).toBe(0);
    const events = readEvents(readFileSync(sessionFiles(home)[0]!, "utf8"));
    const warn = events.find((e: any) => e.type === "mention_warnings")!;
    expect(warn.warnings[0].reason).toContain("exceeds the 5MB attachment cap");
    const message = events.find((e: any) => e.type === "user_message")!;
    expect(message.attachments).toBeUndefined();
  });
});
