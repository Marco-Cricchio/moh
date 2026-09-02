/**
 * Session Handoff T2 (#435): the HandoffTransport seam, the exit-time
 * publish helper, and the secret-gist transport against a fake gh
 * runner. No test shells out to real `gh` or the network (#433 testing
 * decisions); exit-path degradation follows the exit-work budget prior
 * art (packages/tui/test/exit-work.test.ts, #341).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  publishHandoffAtExit,
  readRawHandoff,
  type HandoffPayload,
  type HandoffTransport,
  type HandoffTransportError,
} from "../src/handoff-transport";
import { createGistHandoffTransport, handoffGistTag, type GhRunner } from "../src/handoff-gist";
import type { RawHandoff } from "../src/handoff";

const TMP = join(import.meta.dir, "tmp-handoff-t2");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function artifact(write: boolean): { file: string; handoff: RawHandoff } {
  mkdirSync(TMP, { recursive: true });
  const handoff: RawHandoff = {
    version: 1,
    kind: "raw",
    sessionId: "s-1",
    updatedAt: "2026-09-02T10:00:00.000Z",
    git: { branch: "develop", head: "abc123", dirty: false },
    turns: 3,
    lastUserMessage: "fix the bug",
    lastAssistantMessage: "done",
    files: ["src/a.ts"],
    tests: ["bun test a"],
    counts: { toolCalls: 4, errors: 0, cancelled: 0 },
  };
  const file = join(TMP, "handoff.json");
  if (write) writeFileSync(file, `${JSON.stringify(handoff)}\n`);
  return { file, handoff };
}

function okTransport(capture: { payload?: HandoffPayload }): HandoffTransport {
  return {
    async publish(payload) {
      capture.payload = payload;
      return { ok: true, url: "https://gist.github.com/abc" };
    },
    async fetch() {
      throw new Error("not used in T2 tests");
    },
  };
}

describe("publishHandoffAtExit", () => {
  test("publishes the raw artifact within the budget", async () => {
    const { file, handoff } = artifact(true);
    const captured: { payload?: HandoffPayload } = {};
    const result = await publishHandoffAtExit({
      artifactFile: file,
      transport: okTransport(captured),
      timeoutMs: 500,
    });
    expect(result).toEqual({ ok: true, url: "https://gist.github.com/abc" });
    expect(captured.payload).toEqual(handoff);
  });

  test("missing artifact is a typed no-artifact error, never a throw", async () => {
    const { file } = artifact(false);
    const result = await publishHandoffAtExit({ artifactFile: file, transport: okTransport({}), timeoutMs: 500 });
    expect(result).toEqual({ ok: false, error: { reason: "no-artifact" } });
  });

  test("a slow transport is bounded by the timeout budget", async () => {
    const { file } = artifact(true);
    const slow: HandoffTransport = {
      async publish() {
        await new Promise(() => {});
      },
      async fetch() {
        throw new Error("unused");
      },
    };
    const start = Date.now();
    const result = await publishHandoffAtExit({ artifactFile: file, transport: slow, timeoutMs: 80 });
    expect(result).toEqual({ ok: false, error: { reason: "timeout" } });
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  test("a rejecting transport surfaces as failed, not a throw", async () => {
    const { file } = artifact(true);
    const throwing: HandoffTransport = {
      async publish() {
        throw new Error("boom");
      },
      async fetch() {
        throw new Error("unused");
      },
    };
    const result = await publishHandoffAtExit({ artifactFile: file, transport: throwing, timeoutMs: 500 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toEqual({ reason: "failed", message: "boom" });
  });

  test("an invalid artifact file (corrupt JSON) reads as no-artifact", () => {
    mkdirSync(TMP, { recursive: true });
    const file = join(TMP, "handoff.json");
    writeFileSync(file, "{not json");
    expect(readRawHandoff(file)).toBeUndefined();
    expect(readRawHandoff(join(TMP, "absent.json"))).toBeUndefined();
  });
});

/** Scriptable fake gh: answers per argv prefix, records every call. */
function fakeGh(
  behavior: Array<{ args: string[]; exitCode?: number; stdout?: string; stderr?: string }>,
): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner: GhRunner = (args) => {
    calls.push(args);
    const hit = behavior.find((b) => b.args.every((a, i) => args[i] === a));
    if (!hit) return { exitCode: 1, stdout: "", stderr: `unhandled gh call: ${args.join(" ")}` };
    return { exitCode: hit.exitCode ?? 0, stdout: hit.stdout ?? "", stderr: hit.stderr ?? "" };
  };
  return Object.assign(runner, { calls });
}

const LIST_NO_GIST = { args: ["gist", "list"], stdout: "ID\tDESCRIPTION\tFILES\tVISIBILITY\tUPDATED\nother\tsome other gist\t1\tsecret\tnow\n" };
const LIST_WITH_GIST = {
  args: ["gist", "list"],
  stdout: "ID\tDESCRIPTION\tFILES\tVISIBILITY\tUPDATED\nabc123\tTAGHERE\t1\tsecret\t2026\nother\tx\t1\tsecret\t2026\n",
};

describe("gist transport", () => {
  test("first publish creates a secret gist tagged with the deterministic tag", async () => {
    const cwd = "/Users/dev/work/my-project";
    const tag = handoffGistTag(cwd, "dev");
    const gh = fakeGh([
      { args: ["api", "user"], stdout: "dev\n" },
      { ...LIST_NO_GIST },
      { args: ["gist", "create"], stdout: "https://gist.github.com/new1\n" },
    ]);
    const transport = createGistHandoffTransport({ cwd, gh });
    const { handoff } = artifact(true);
    const result = await transport.publish(handoff);
    expect(result).toEqual({ ok: true, url: "https://gist.github.com/new1" });
    const create = gh.calls.find((c) => c[0] === "gist" && c[1] === "create")!;
    expect(create).toContain("--secret");
    expect(create[create.indexOf("-d") + 1]).toBe(tag);
    expect(create[create.indexOf("-f") + 1]).toBe("handoff.json");
    expect(create[create.length - 1]).toContain(`"sessionId": "s-1"`);
  });

  test("republish replaces the existing tagged gist (delete then create)", async () => {
    const cwd = "/Users/dev/work/my-project";
    const tag = handoffGistTag(cwd, "dev");
    const gh = fakeGh([
      { args: ["api", "user"], stdout: "dev\n" },
      { args: ["gist", "list"], stdout: `ID\tDESCRIPTION\tFILES\tVISIBILITY\tUPDATED\nabc123\t${tag}\t1\tsecret\t2026\n` },
      { args: ["gist", "delete"], stdout: "" },
      { args: ["gist", "create"], stdout: "https://gist.github.com/new2\n" },
    ]);
    const transport = createGistHandoffTransport({ cwd, gh });
    const { handoff } = artifact(true);
    const result = await transport.publish({ ...handoff, turns: 5 });
    expect(result).toEqual({ ok: true, url: "https://gist.github.com/new2" });
    expect(gh.calls.find((c) => c[1] === "delete")).toContain("abc123");
  });

  test("fetch returns the tagged gist payload", async () => {
    const cwd = "/Users/dev/work/my-project";
    const tag = handoffGistTag(cwd, "dev");
    const { handoff } = artifact(true);
    const gh = fakeGh([
      { args: ["api", "user"], stdout: "dev\n" },
      { args: ["gist", "list"], stdout: `ID\tDESCRIPTION\tFILES\tVISIBILITY\tUPDATED\nabc123\t${tag}\t1\tsecret\t2026\n` },
      { args: ["gist", "view"], stdout: JSON.stringify(handoff) },
    ]);
    const transport = createGistHandoffTransport({ cwd, gh });
    const result = await transport.fetch();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload).toEqual(handoff);
      expect(result.url).toBe("https://gist.github.com/abc123");
    }
  });

  test("gh missing is classified as gh-missing", async () => {
    const gh = fakeGh([{ args: ["api", "user"], exitCode: 127, stderr: "zsh: command not found: gh" }]);
    const transport = createGistHandoffTransport({ cwd: "/x", gh });
    const result = await transport.publish(artifact(true).handoff);
    expect(result).toEqual({ ok: false, error: { reason: "gh-missing" } });
  });

  test("not logged in is classified as not-logged-in", async () => {
    const gh = fakeGh([{ args: ["api", "user"], exitCode: 4, stderr: "gh: To get started with GitHub CLI, please run: gh auth login" }]);
    const transport = createGistHandoffTransport({ cwd: "/x", gh });
    const result = await transport.publish(artifact(true).handoff);
    expect(result).toEqual({ ok: false, error: { reason: "not-logged-in" } });
  });

  test("the gist tag embeds slug and gh user, not absolute paths", () => {
    const tag = handoffGistTag("/Users/dev/work/my-project", "someuser");
    expect(tag.startsWith("moh:handoff:my-project")).toBe(true);
    expect(tag.endsWith(":someuser")).toBe(true);
    expect(tag).not.toContain("/");
  });
});
