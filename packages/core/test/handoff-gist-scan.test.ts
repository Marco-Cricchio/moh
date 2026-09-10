import { describe, expect, test } from "bun:test";
import { discoverGistHandoffs, type GhCall, type GhRunner } from "../src/handoff-gist";

function fakeGh(responses: Array<{ args: string[]; exitCode?: number; stdout?: string; stderr?: string }>): GhRunner & { calls: GhCall[] } {
  const calls: GhCall[] = [];
  const runner: GhRunner = async (call) => {
    calls.push(call);
    const response = responses.find((candidate) => candidate.args.every((arg, index) => call.args[index] === arg));
    return response
      ? { exitCode: response.exitCode ?? 0, stdout: response.stdout ?? "", stderr: response.stderr ?? "" }
      : { exitCode: 1, stdout: "", stderr: `unexpected: ${call.args.join(" ")}` };
  };
  return Object.assign(runner, { calls });
}

function payload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 2, kind: "raw", sessionId: "session", updatedAt: "2026-09-03T00:00:00.000Z",
    git: { branch: "develop", head: "abc", dirty: false }, turns: 2,
    lastUserMessage: "Continue the migration", lastAssistantMessage: "Done",
    files: [], tests: [], counts: { toolCalls: 0, errors: 0, cancelled: 0 },
    repoUrl: "https://github.com/acme/project.git", ...overrides,
  });
}

const list = (...rows: Array<[string, string, string]>) =>
  `ID\tDESCRIPTION\tFILES\tVISIBILITY\tUPDATED\n${rows.map(([id, description, updated]) => `${id}\t${description}\t1 file\tsecret\t${updated}`).join("\n")}\n`;

describe("discoverGistHandoffs", () => {
  test("filters the authenticated user's tagged gists, fetches candidates, and returns their handoff summary", async () => {
    const gh = fakeGh([
      { args: ["api", "user"], stdout: "marco\n" },
      { args: ["gist", "list"], stdout: list(
        ["one", "moh:handoff:project-a:marco", "2026-09-01T00:00:00Z"],
        ["two", "moh:handoff:project-b:other", "2026-09-02T00:00:00Z"],
        ["three", "ordinary gist", "2026-09-02T00:00:00Z"],
      ) },
      { args: ["gist", "view", "one"], stdout: payload() },
    ]);

    await expect(discoverGistHandoffs({ gh })).resolves.toEqual([{
      projectSlug: "project-a", updatedAt: "2026-09-03T00:00:00.000Z",
      git: { branch: "develop", head: "abc", dirty: false },
      lastUserMessage: "Continue the migration", repoUrl: "https://github.com/acme/project.git",
      url: "https://gist.github.com/one",
    }]);
    expect(gh.calls.map((call) => call.args)).toEqual([
      ["api", "user", "--jq", ".login"], ["gist", "list", "--limit", "1000"], ["gist", "view", "one", "--filename", "handoff.json", "--raw"],
    ]);
  });

  test("collapses duplicate tags to the newest listed gist before fetching content", async () => {
    const gh = fakeGh([
      { args: ["api", "user"], stdout: "marco\n" },
      { args: ["gist", "list"], stdout: list(
        ["old", "moh:handoff:project:marco", "2026-09-01T00:00:00Z"],
        ["new", "moh:handoff:project:marco", "2026-09-02T00:00:00Z"],
      ) },
      { args: ["gist", "view", "new"], stdout: payload({ updatedAt: "2026-09-02T00:00:00.000Z" }) },
    ]);

    const offers = await discoverGistHandoffs({ gh });
    expect(offers).toHaveLength(1);
    expect(offers[0]?.url).toBe("https://gist.github.com/new");
    expect(gh.calls.some((call) => call.args.includes("old"))).toBe(false);
  });

  test.each([
    ["gh missing", [{ args: ["api", "user"], exitCode: 127, stderr: "executable file not found" }]],
    ["offline", [{ args: ["api", "user"], stdout: "marco\n" }, { args: ["gist", "list"], exitCode: 1, stderr: "network unreachable" }]],
    ["zero gists", [{ args: ["api", "user"], stdout: "marco\n" }, { args: ["gist", "list"], stdout: list() }]],
  ])("returns an empty list when %s", async (_name, responses) => {
    await expect(discoverGistHandoffs({ gh: fakeGh(responses) })).resolves.toEqual([]);
  });
});
