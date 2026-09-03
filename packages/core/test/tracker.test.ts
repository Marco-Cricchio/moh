import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRACKER_DIR,
  ghTracker,
  localMarkdownTracker,
  projectFrontier,
  resolveTracker,
  trackerTools,
  type ShellRunner,
} from "../src/tracker";

const fakeRunner =
  (handler: (cmd: string[]) => { code: number; stdout: string; stderr?: string }): ShellRunner =>
  async (cmd) => {
    const r = handler(cmd);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? "" };
  };

describe("local markdown tracker", () => {
  function trackerWith(issues: string[]): ReturnType<typeof localMarkdownTracker> {
    const dir = mkdtempSync(join(tmpdir(), "moh-trk-"));
    mkdirSync(dir, { recursive: true });
    for (const md of issues) writeFileSync(join(dir, `${md.match(/^id:\s?(.+)$/m)![1]!.trim()}.md`), md);
    return localMarkdownTracker(dir);
  }

  test("lists issues with frontmatter fields", async () => {
    const t = trackerWith([
      "---\nid: 1\ntitle: First issue\nlabels: p0,bug\nblocked-by: 2\n---\n\nbody\n",
      "---\nid: 2\ntitle: Second issue\nstate: closed\nclaimed-by: alice\n---\n\nbody\n",
    ]);
    const issues = await t.list();
    expect(issues).toHaveLength(2);
    const one = issues.find((i) => i.id === "1")!;
    expect(one.title).toBe("First issue");
    expect(one.labels).toEqual(["p0", "bug"]);
    expect(one.blockedBy).toEqual(["2"]);
    expect(one.state).toBe("open");
    const two = issues.find((i) => i.id === "2")!;
    expect(two.state).toBe("closed");
    expect(two.assignees).toEqual(["alice"]);
  });

  test("claim writes claimed-by without touching the body", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-trk-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "7.md"), "---\nid: 7\ntitle: Claimable\n---\n\nsome body\n");
    const t = localMarkdownTracker(dir);
    await t.claim("7");
    const after = readFileSync(join(dir, "7.md"), "utf8");
    expect(after).toContain("claimed-by: @me");
    expect(after).toContain("some body");
    expect((await t.list()).find((i) => i.id === "7")!.assignees).toEqual(["@me"]);
  });

  test("claiming a closed or unknown issue fails", async () => {
    const t = trackerWith(["---\nid: 9\ntitle: done\nstate: closed\n---\n"]);
    await expect(t.claim("9")).rejects.toThrow("not open");
    await expect(t.claim("nope")).rejects.toThrow("no tracker issue");
  });

  test("unclaim removes only the current user from claimed-by", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-trk-"));
    writeFileSync(join(dir, "7.md"), "---\nid: 7\ntitle: Busy\nclaimed-by: @me, alice\n---\n\nbody\n");
    const t = localMarkdownTracker(dir);
    await t.unclaim("7");
    const after = readFileSync(join(dir, "7.md"), "utf8");
    expect(after).toContain("claimed-by: alice");
    expect(after).not.toContain("@me");
    expect(after).toContain("body");
  });

  test("unclaim on an issue without the current user is a safe no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-trk-"));
    writeFileSync(join(dir, "8.md"), "---\nid: 8\ntitle: Theirs\nclaimed-by: alice\n---\n\nbody\n");
    const t = localMarkdownTracker(dir);
    await t.unclaim("8");
    expect((await t.list()).find((i) => i.id === "8")!.assignees).toEqual(["alice"]);
  });
});

describe("gh backend", () => {
  test("lists via gh --json and claims with --add-assignee @me", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((cmd) => {
      calls.push(cmd);
      if (cmd[1] === "issue" && cmd[2] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 5, title: "Fix thing", state: "OPEN", labels: [{ name: "bug" }], assignees: [] },
            { number: 6, title: "Done", state: "CLOSED", labels: [], assignees: [{ login: "bob" }] },
          ]),
        };
      }
      return { code: 0, stdout: "" };
    });
    const t = ghTracker("owner/repo", run);
    const issues = await t.list();
    expect(issues[0]).toEqual({ id: "5", title: "Fix thing", state: "open", labels: ["bug"], assignees: [], blockedBy: [] });
    // Regression: `gh --json` emits uppercase states — a CLOSED issue must
    // project closed, never open (the bug that made every closed issue
    // look open in tracker_list and the frontier panel).
    expect(issues[1]).toEqual({ id: "6", title: "Done", state: "closed", labels: [], assignees: ["bob"], blockedBy: [] });
    await t.claim("5");
    expect(calls.at(-1)).toContain("--add-assignee");
    expect(calls.at(-1)).toContain("@me");
  });

  test("reads the exact parent-map Wayfinder frontier and comments only explicitly", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((cmd) => {
      calls.push(cmd);
      if (cmd.some((part) => part.endsWith("/issues/7/parent") || part.endsWith("/issues/8/parent"))) return { code: 0, stdout: JSON.stringify({ number: 2 }) };
      if (cmd.some((part) => part.endsWith("/issues/2/sub_issues"))) return {
        code: 0,
        stdout: JSON.stringify([
          { number: 7, title: "Claimed", url: "https://x/7", state: "OPEN", labels: [{ name: "wayfinder:task" }], assignees: [{ login: "me" }], issue_dependencies_summary: { blocked_by: 0 } },
          { number: 8, title: "Ready", url: "https://x/8", state: "OPEN", labels: [{ name: "wayfinder:research" }], assignees: [], issue_dependencies_summary: { blocked_by: 0 } },
          { number: 9, title: "Blocked", url: "https://x/9", state: "OPEN", labels: [{ name: "wayfinder:task" }], assignees: [], issue_dependencies_summary: { blocked_by: 1 } },
        ]),
      };
      return { code: 0, stdout: "" };
    });
    const t = ghTracker("owner/repo", run);
    const snapshot = await t.wayfinderSnapshot!(["7", "8"]);
    expect(snapshot?.mapId).toBe("2");
    expect(projectFrontier(snapshot!.issues).ready.map((issue) => issue.id)).toEqual(["8"]);
    expect(projectFrontier(snapshot!.issues).blocked.map((issue) => issue.id)).toEqual(["9"]);
    await t.comment!("7", "handoff url");
    expect(calls.at(-1)).toEqual(["gh", "issue", "comment", "7", "--repo", "owner/repo", "--body", "handoff url"]);
  });

  test("unclaims with gh --remove-assignee @me", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((cmd) => {
      calls.push(cmd);
      if (cmd[1] === "issue" && cmd[2] === "list") return { code: 0, stdout: "[]" };
      return { code: 0, stdout: "" };
    });
    await ghTracker("owner/repo", run).unclaim("5");
    expect(calls.at(-1)).toEqual(["gh", "issue", "edit", "5", "--repo", "owner/repo", "--remove-assignee", "@me"]);
  });
});

describe("resolveTracker", () => {
  test("local markdown wins over git remotes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-res-"));
    mkdirSync(join(cwd, TRACKER_DIR), { recursive: true });
    const t = await resolveTracker({ cwd, run: async () => ({ code: 1, stdout: "", stderr: "" }) });
    expect(t?.kind).toBe("local-markdown");
  });

  test("github / gitlab remotes pick their backend", async () => {
    const run = fakeRunner((cmd) =>
      cmd[0] === "git"
        ? { code: 0, stdout: "git@github.com:owner/repo.git\n" }
        : { code: 0, stdout: "[]" },
    );
    expect((await resolveTracker({ cwd: "/tmp", run }))?.kind).toBe("gh");
    const runGlab = fakeRunner((cmd) =>
      cmd[0] === "git" ? { code: 0, stdout: "https://gitlab.com/owner/repo.git\n" } : { code: 0, stdout: "[]" },
    );
    expect((await resolveTracker({ cwd: "/tmp", run: runGlab }))?.kind).toBe("gitlab");
    expect(await resolveTracker({ cwd: "/tmp", run: async () => ({ code: 1, stdout: "", stderr: "" }) })).toBeNull();
  });
});

describe("frontier projection", () => {
  const issue = (id: string, over: Partial<Parameters<typeof projectFrontier>[0][number]> = {}) => ({
    id,
    title: `t${id}`,
    state: "open" as const,
    labels: [],
    assignees: [],
    blockedBy: [],
    ...over,
  });

  test("partitions claimed / ready / blocked using dependency data", () => {
    const frontier = projectFrontier([
      issue("1", { assignees: ["me"] }),
      issue("2"),
      issue("3", { blockedBy: ["2"] }),
      issue("4", { state: "closed" }),
      issue("5", { blockedBy: ["4"] }), // blocker closed → ready
    ]);
    expect(frontier.deps).toBe(true);
    expect(frontier.inProgress.map((i) => i.id)).toEqual(["1"]);
    expect(frontier.ready.map((i) => i.id).sort()).toEqual(["2", "5"]);
    expect(frontier.blocked.map((i) => i.id)).toEqual(["3"]);
  });

  test("without dependency data everything unclaimed is ready (flat)", () => {
    const frontier = projectFrontier([issue("1", { assignees: ["me"] }), issue("2")]);
    expect(frontier.deps).toBe(false);
    expect(frontier.blocked).toEqual([]);
    expect(frontier.ready.map((i) => i.id)).toEqual(["2"]);
  });
});

describe("tracker tools", () => {
  const backend = localMarkdownTracker((() => {
    const dir = mkdtempSync(join(tmpdir(), "moh-trk-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.md"), "---\nid: 1\ntitle: One\n---\n");
    return dir;
  })());

  test("tracker_list formats open issues by default", async () => {
    const tools = trackerTools(backend);
    expect(Object.keys(tools).sort()).toEqual(["tracker_claim", "tracker_list"]);
    const out = await tools.tracker_list!.execute({ state: undefined }, { signal: new AbortController().signal, cwd: "/tmp", onProgress: () => {} });
    expect(out).toContain("#1");
    expect(out).toContain("One");
  });

  test("tracker_claim delegates to the backend", async () => {
    const tools = trackerTools(backend);
    const out = await tools.tracker_claim!.execute({ id: "1" }, { signal: new AbortController().signal, cwd: "/tmp", onProgress: () => {} });
    expect(out).toBe("claimed #1");
    expect((await backend.list())[0]!.assignees).toEqual(["@me"]);
  });
});
