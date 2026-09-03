import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffRunner, type HandoffTransport, type TrackerBackend } from "@moh/core";
import { handoffCommand } from "../src/handoff";

function streams() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: { write: (text: string) => { stdout += text; return true; } } as any,
    stderr: { write: (text: string) => { stderr += text; return true; } } as any,
    read: () => ({ stdout, stderr }),
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "moh-handoff-cli-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(cwd, "moh.json"), JSON.stringify({ handoff: { transport: "gist" } }));
  const file = HandoffRunner.artifactFile(cwd, join(home, ".moh"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({
    version: 1, kind: "raw", sessionId: "s", updatedAt: new Date().toISOString(), git: {}, turns: 1,
    lastUserMessage: "", lastAssistantMessage: "", files: [], tests: [], counts: { toolCalls: 0, errors: 0, cancelled: 0 },
    wayfinderLinks: [{ id: "7", relations: ["claimed"] }, { id: "8", relations: ["mentioned"] }],
  }));
  const comments: string[] = [];
  const tracker: TrackerBackend = {
    kind: "gh", async list() { return []; }, async claim() {}, async unclaim() {},
    async wayfinderSnapshot() { return { mapId: "1", issues: [
      { id: "7", title: "Claimed", state: "open", labels: ["wayfinder:task"], assignees: ["me"], blockedBy: [] },
      { id: "8", title: "Mentioned", state: "open", labels: ["wayfinder:task"], assignees: [], blockedBy: [] },
    ] }; },
    async comment(id) { comments.push(id); },
  };
  const transport: HandoffTransport = { async publish() { return { ok: true, url: "https://gist/x" }; }, async fetch() { return { ok: false, error: { reason: "no-artifact" } }; } };
  return { cwd, home, tracker, transport, comments };
}

describe("moh handoff (#439)", () => {
  test("publishes without any tracker write by default", async () => {
    const fixture = setup(); const io = streams();
    expect(await handoffCommand({ argv: [], ...fixture, ...io })).toBe(0);
    expect(fixture.comments).toEqual([]);
    expect(io.read().stdout).toContain("handoff published: https://gist/x");
  });

  test("--notify-ticket writes only successfully claimed Wayfinder tickets after publish", async () => {
    const fixture = setup(); const io = streams();
    expect(await handoffCommand({ argv: ["--notify-ticket"], ...fixture, ...io })).toBe(0);
    expect(fixture.comments).toEqual(["7"]);
    expect(io.read().stdout).toContain("notified 1 claimed Wayfinder ticket");
  });

  test("a failed publish cannot notify a tracker ticket", async () => {
    const fixture = setup(); const io = streams();
    const transport: HandoffTransport = { ...fixture.transport, async publish() { return { ok: false, error: { reason: "failed", message: "offline" } }; } };
    expect(await handoffCommand({ argv: ["--notify-ticket"], ...fixture, transport, ...io })).toBe(1);
    expect(fixture.comments).toEqual([]);
  });
});
