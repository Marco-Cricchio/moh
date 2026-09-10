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

const list = (...rows: Array<[string, string, string, boolean?]>) =>
  JSON.stringify(rows.map(([id, description, updated, isPublic = false]) => ({ id, description, updated_at: updated, public: isPublic })));

const scanArgs = ["api", "--paginate", "--slurp", "user/gists?per_page=100"];

describe("discoverGistHandoffs", () => {
  test("filters the authenticated user's tagged gists, fetches candidates, and returns their handoff summary", async () => {
    const gh = fakeGh([
      { args: ["api", "user"], stdout: "marco\n" },
      { args: scanArgs, stdout: list(
        ["one", "moh:handoff:project-a:marco", "2026-09-01T00:00:00Z"],
        ["two", "moh:handoff:project-b:other", "2026-09-02T00:00:00Z"],
        ["three", "ordinary gist", "2026-09-02T00:00:00Z"],
        ["public", "moh:handoff:public:marco", "2026-09-02T00:00:00Z", true],
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
      ["api", "user", "--jq", ".login"], scanArgs, ["gist", "view", "one", "--filename", "handoff.json", "--raw"],
    ]);
  });

  test("collapses duplicate tags to the newest listed gist before fetching content", async () => {
    const gh = fakeGh([
      { args: ["api", "user"], stdout: "marco\n" },
      { args: scanArgs, stdout: list(
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

  test("skips an unreachable candidate while retaining other offers", async () => {
    const gh = fakeGh([
      { args: ["api", "user"], stdout: "marco\n" },
      { args: scanArgs, stdout: list(["bad", "moh:handoff:bad:marco", "2026-09-02T00:00:00Z"], ["good", "moh:handoff:good:marco", "2026-09-01T00:00:00Z"]) },
      { args: ["gist", "view", "bad"], exitCode: 1, stderr: "gone" },
      { args: ["gist", "view", "good"], stdout: payload() },
    ]);
    await expect(discoverGistHandoffs({ gh })).resolves.toMatchObject([{ projectSlug: "good" }]);
  });

  test.each([
    ["gh missing", [{ args: ["api", "user"], exitCode: 127, stderr: "executable file not found" }]],
    ["offline", [{ args: ["api", "user"], stdout: "marco\n" }, { args: scanArgs, exitCode: 1, stderr: "network unreachable" }]],
    ["zero gists", [{ args: ["api", "user"], stdout: "marco\n" }, { args: scanArgs, stdout: list() }]],
  ])("returns an empty list when %s", async (_name, responses) => {
    await expect(discoverGistHandoffs({ gh: fakeGh(responses) })).resolves.toEqual([]);
  });
});
