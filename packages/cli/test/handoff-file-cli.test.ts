import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffRunner, importedHandoffFile, type RawHandoff } from "@moh/core";
import { handoffCommand } from "../src/handoff";

function fixtureHandoff(sessionId = "session-abc"): RawHandoff {
  return {
    version: 1, kind: "raw", sessionId, updatedAt: new Date().toISOString(), git: { branch: "main", head: "a".repeat(40), dirty: false },
    turns: 2, lastUserMessage: "", lastAssistantMessage: "", files: [], tests: [], counts: { toolCalls: 0, errors: 0, cancelled: 0 },
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "moh-handoff-file-cli-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(cwd, "moh.json"), JSON.stringify({ handoff: { transport: "gist" } }));
  const artifact = HandoffRunner.artifactFile(cwd, join(home, ".moh"));
  mkdirSync(join(artifact, ".."), { recursive: true });
  writeFileSync(artifact, JSON.stringify(fixtureHandoff()));
  return { cwd, home };
}

function streams() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (text: string) => { stdout += text; return true; } } as any,
    stderr: { write: (text: string) => { stderr += text; return true; } } as any,
    read: () => ({ stdout, stderr }),
  };
}

describe("moh handoff export/import (#440)", () => {
  test("export writes the artifact to the given file", async () => {
    const { cwd, home } = setup(); const io = streams();
    const out = join(home, "bridge.json");
    expect(await handoffCommand({ argv: ["export", out], cwd, home, ...io })).toBe(0);
    const written = JSON.parse(readFileSync(out, "utf8")) as RawHandoff;
    expect(written.sessionId).toBe("session-abc");
    expect(io.read().stdout).toContain(`handoff exported: ${out}`);
  });

  test("export without a local artifact fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "moh-handoff-file-cli-"));
    const cwd = join(root, "project"); const home = join(root, "home");
    mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true });
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ handoff: { transport: "gist" } }));
    const io = streams();
    expect(await handoffCommand({ argv: ["export", join(home, "x.json")], cwd, home, ...io })).toBe(1);
    expect(io.read().stderr).toContain("no local handoff artifact");
  });

  test("import parks the received export for discovery", async () => {
    const { cwd, home } = setup(); const io = streams();
    const carrier = join(home, "bridge.json");
    writeFileSync(carrier, JSON.stringify(fixtureHandoff("session-remote")));
    expect(await handoffCommand({ argv: ["import", carrier], cwd, home, ...io })).toBe(0);
    expect(io.read().stdout).toContain("handoff imported");
    const parked = JSON.parse(readFileSync(importedHandoffFile(cwd, home), "utf8")) as RawHandoff;
    expect(parked.sessionId).toBe("session-remote");
  });

  test("import rejects an invalid file", async () => {
    const { cwd, home } = setup(); const io = streams();
    const bad = join(home, "bad.json");
    writeFileSync(bad, "nope");
    expect(await handoffCommand({ argv: ["import", bad], cwd, home, ...io })).toBe(1);
    expect(io.read().stderr).toContain("not a valid handoff export");
  });

  test("import of a missing file reports it", async () => {
    const { cwd, home } = setup(); const io = streams();
    expect(await handoffCommand({ argv: ["import", join(home, "gone.json")], cwd, home, ...io })).toBe(1);
    expect(io.read().stderr).toContain("no such file");
  });

  test("export → import round-trip preserves the payload (review nit)", async () => {
    const { cwd, home } = setup(); const io = streams();
    const carrier = join(home, "bridge.json");
    expect(await handoffCommand({ argv: ["export", carrier], cwd, home, ...io })).toBe(0);
    const other = mkdtempSync(join(tmpdir(), "moh-handoff-file-cli-"));
    const cwdB = join(other, "project"); const homeB = join(other, "home");
    mkdirSync(cwdB, { recursive: true }); mkdirSync(homeB, { recursive: true });
    writeFileSync(join(cwdB, "moh.json"), JSON.stringify({ handoff: { transport: "none" } }));
    expect(await handoffCommand({ argv: ["import", carrier], cwd: cwdB, home: homeB, ...io })).toBe(0);
    const parked = JSON.parse(readFileSync(importedHandoffFile(cwdB, homeB), "utf8")) as RawHandoff;
    expect(parked).toEqual(JSON.parse(readFileSync(HandoffRunner.artifactFile(cwd, join(home, ".moh")), "utf8")));
  });

  test("export/import require a file argument", async () => {
    const { cwd, home } = setup(); const io = streams();
    expect(await handoffCommand({ argv: ["export"], cwd, home, ...io })).toBe(2);
    expect(await handoffCommand({ argv: ["import"], cwd, home, ...io })).toBe(2);
  });
});

describe("moh handoff pull <url> (#451, story 17)", () => {
  function pullTransport(payload: RawHandoff | { fail: string }) {
    return {
      async publish() {
        return { ok: false as const, error: { reason: "failed" as const, message: "unused" } };
      },
      async fetch() {
        return { ok: false as const, error: { reason: "failed" as const, message: "unused" } };
      },
      async fetchByUrl(url: string) {
        if (typeof payload === "object" && "fail" in payload) {
          return { ok: false as const, error: { reason: "failed" as const, message: payload.fail } };
        }
        return { ok: true as const, payload, url };
      },
    };
  }

  test("fetches the gist, runs the author check, and parks the payload", async () => {
    const { cwd, home } = setup(); const io = streams();
    const handoff = { ...fixtureHandoff("session-pulled"), author: "me" };
    const result = await handoffCommand({
      argv: ["pull", "https://gist.github.com/abc123"], cwd, home, ...io,
      transport: pullTransport(handoff), ghUser: "me",
    });
    expect(result).toBe(0);
    expect(io.read().stdout).toContain("handoff pulled from https://gist.github.com/abc123");
    const parked = JSON.parse(readFileSync(importedHandoffFile(cwd, home), "utf8")) as RawHandoff;
    expect(parked.sessionId).toBe("session-pulled");
  });

  test("declines a foreign-author payload", async () => {
    const { cwd, home } = setup(); const io = streams();
    const handoff = { ...fixtureHandoff("session-pulled"), author: "someone-else" };
    const result = await handoffCommand({
      argv: ["pull", "abc123"], cwd, home, ...io,
      transport: pullTransport(handoff), ghUser: "me",
    });
    expect(result).toBe(1);
    expect(io.read().stderr).toContain('authored by "someone-else"');
    expect(() => readFileSync(importedHandoffFile(cwd, home))).toThrow();
  });

  test("surfaces fetch failure", async () => {
    const { cwd, home } = setup(); const io = streams();
    const result = await handoffCommand({
      argv: ["pull", "abc123"], cwd, home, ...io,
      transport: pullTransport({ fail: "gh: not found" }),
    });
    expect(result).toBe(1);
    expect(io.read().stderr).toContain("fetch failed");
  });

  test("requires exactly one url argument", async () => {
    const { cwd, home } = setup(); const io = streams();
    expect(await handoffCommand({ argv: ["pull"], cwd, home, ...io })).toBe(2);
    expect(await handoffCommand({ argv: ["pull", "a", "b"], cwd, home, ...io })).toBe(2);
  });
});
