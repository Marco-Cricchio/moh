import { describe, expect, test } from "bun:test";
import {
  applyChanges,
  parseReposConfig,
  planRepo,
  readLiveRepo,
  renderPlan,
  type GhMutator,
  type LiveRepo,
  type ShellRunner,
} from "../src/github-settings";

const live = (over: Partial<LiveRepo> = {}): LiveRepo => ({
  name: "acme/widget",
  description: "",
  visibility: "public",
  labels: [],
  branchProtection: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

describe("parseReposConfig", () => {
  test("accepts a valid declaration", () => {
    const cfg = parseReposConfig({
      repos: [
        {
          name: "acme/widget",
          description: "The widget",
          visibility: "private",
          labels: [{ name: "bug", color: "d73a4a", description: "Something broken" }],
          branchProtection: { requiredChecks: ["ci"], requiredReviews: 1 },
        },
      ],
    });
    expect(cfg.repos[0]!.name).toBe("acme/widget");
    expect(cfg.repos[0]!.branchProtection!.branch).toBe("main");
  });

  test("rejects a repo name without owner", () => {
    expect(() => parseReposConfig({ repos: [{ name: "widget" }] })).toThrow();
  });

  test("rejects a non-hex label color", () => {
    expect(() => parseReposConfig({ repos: [{ name: "a/b", labels: [{ name: "x", color: "#fff" }] }] })).toThrow();
  });

  test("rejects an empty repo list", () => {
    expect(() => parseReposConfig({ repos: [] })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Plan / diff engine
// ---------------------------------------------------------------------------

describe("planRepo", () => {
  test("empty plan when live state matches", () => {
    const plan = planRepo(
      {
        name: "acme/widget",
        description: "D",
        visibility: "public",
        labels: [{ name: "bug", color: "d73a4a" }],
        branchProtection: { branch: "main", requiredChecks: ["ci"], requiredReviews: 1, dismissStaleReviews: true },
      },
      live({
        description: "D",
        labels: [{ name: "bug", color: "d73a4a", description: "" }],
        branchProtection: {
          branch: "main",
          requiredChecks: ["ci"],
          requiredReviews: 1,
          dismissStaleReviews: true,
          allowForcePushes: false,
        },
      }),
    );
    expect(plan.changes).toEqual([]);
    expect(renderPlan(plan.changes)).toContain("No changes");
  });

  test("patches only drifted repo fields", () => {
    const plan = planRepo(
      { name: "acme/widget", description: "New", visibility: "private" },
      live({ description: "Old" }),
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!.action).toBe("update-repo");
    expect(plan.changes[0]!.summary).toContain('description → "New"');
    expect(plan.changes[0]!.summary).toContain("visibility public → private");
  });

  test("adds missing labels, updates drifted ones, never deletes undeclared", () => {
    const plan = planRepo(
      {
        name: "acme/widget",
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "docs", color: "0075ca" },
        ],
      },
      live({
        labels: [
          { name: "bug", color: "000000", description: "" },
          { name: "legacy", color: "eeeeee", description: "" },
        ],
      }),
    );
    const actions = plan.changes.map((c) => `${c.action}:${"label" in c ? c.label.name : ""}`);
    expect(actions).toEqual(["update-label:bug", "add-label:docs"]);
  });

  test("protection change when absent, drifted, or on another branch", () => {
    const declared = { branchProtection: { branch: "main", requiredChecks: ["ci"] } };
    expect(planRepo({ name: "a/b", ...declared }, live()).changes[0]!.action).toBe("put-protection");
    expect(
      planRepo(
        { name: "a/b", ...declared },
        live({
          branchProtection: {
            branch: "main",
            requiredChecks: ["ci", "lint"],
            requiredReviews: 0,
            dismissStaleReviews: false,
            allowForcePushes: false,
          },
        }),
      ).changes,
    ).toHaveLength(1);
    // Declared protection on a branch live has unprotected → change.
    expect(
      planRepo(
        { name: "a/b", branchProtection: { branch: "release", requiredChecks: ["ci"] } },
        live({
          branchProtection: {
            branch: "main",
            requiredChecks: ["ci"],
            requiredReviews: 0,
            dismissStaleReviews: false,
            allowForcePushes: false,
          },
        }),
      ).changes,
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Apply (mutator seam — no network)
// ---------------------------------------------------------------------------

describe("applyChanges", () => {
  test("issues one correct API call per change, in order", async () => {
    const calls: Array<[string, string, any]> = [];
    const mutate: GhMutator = async (verb, path, body) => {
      calls.push([verb, path, body]);
    };
    const plan = planRepo(
      {
        name: "acme/widget",
        visibility: "private",
        labels: [{ name: "bug", color: "d73a4a" }],
        branchProtection: { branch: "main", requiredChecks: ["ci"], requiredReviews: 2, allowForcePushes: true },
      },
      live(),
    );
    const applied = await applyChanges(plan.changes, mutate);
    expect(applied).toHaveLength(plan.changes.length);
    expect(calls.map(([v, p]) => `${v} ${p}`)).toEqual([
      "PATCH repos/acme/widget",
      "POST repos/acme/widget/labels",
      "PUT repos/acme/widget/branches/main/protection",
    ]);
    expect(calls[0]![2]).toEqual({ private: true });
    expect(calls[1]![2]).toEqual({ name: "bug", color: "d73a4a", description: "" });
    expect(calls[2]![2].required_pull_request_reviews.required_approving_review_count).toBe(2);
    expect(calls[2]![2].allow_force_pushes).toBe(true);
  });

  test("update-label PATCHes the label by name", async () => {
    const calls: Array<[string, string]> = [];
    await applyChanges(
      [
        {
          repo: "a/b",
          action: "update-label",
          summary: "~ label bug",
          label: { name: "bug", color: "d73a4a", description: "x" },
        },
      ],
      async (verb, path) => {
        calls.push([verb, path]);
      },
    );
    expect(calls).toEqual([["PATCH", "repos/a/b/labels/bug"]]);
  });

  test("stops at the first failure, keeping earlier applications visible", async () => {
    const applied = applyChanges(
      [
        { repo: "a/b", action: "add-label", summary: "one", label: { name: "x", color: "000000" } },
        { repo: "a/b", action: "update-label", summary: "two", label: { name: "y", color: "000000" } },
      ],
      async (_verb, path) => {
        if (path.endsWith("/labels/y")) throw new Error("boom");
      },
    );
    await expect(applied).rejects.toThrow("boom");
  });
});

// ---------------------------------------------------------------------------
// Live-state reader (fake runner — no network)
// ---------------------------------------------------------------------------

describe("readLiveRepo", () => {
  const fakeRunner =
    (handler: (path: string) => { code: number; stdout: string; stderr?: string }): ShellRunner =>
    async (cmd) => {
      const path = cmd[cmd.length - 1]!;
      const r = handler(path);
      return { code: r.code, stdout: r.stdout, stderr: r.stderr ?? "" };
    };

  test("projects repo, labels and protection", async () => {
    const run = fakeRunner((path) => {
      if (path === "repos/acme/widget") {
        return { code: 0, stdout: JSON.stringify({ description: "D", private: true }) };
      }
      if (path.startsWith("repos/acme/widget/labels")) {
        return { code: 0, stdout: JSON.stringify([{ name: "bug", color: "D73A4A", description: "" }]) };
      }
      if (path.endsWith("/protection")) {
        return {
          code: 0,
          stdout: JSON.stringify({
            required_status_checks: { contexts: ["ci"] },
            required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true },
            allow_force_pushes: { enabled: false },
          }),
        };
      }
      return { code: 1, stdout: "", stderr: "not found" };
    });
    const repo = await readLiveRepo("acme/widget", "main", run);
    expect(repo.visibility).toBe("private");
    expect(repo.labels[0]!.color).toBe("d73a4a");
    expect(repo.branchProtection?.requiredReviews).toBe(1);
  });

  test("missing protection projects as null (404 is not an error)", async () => {
    const run = fakeRunner((path) => {
      if (path === "repos/a/b") return { code: 0, stdout: JSON.stringify({}) };
      if (path.startsWith("repos/a/b/labels")) return { code: 0, stdout: JSON.stringify([]) };
      return { code: 1, stdout: "", stderr: "404" };
    });
    expect((await readLiveRepo("a/b", "main", run)).branchProtection).toBeNull();
  });

  test("reads the protection of the requested branch, not just main", async () => {
    const seen: string[] = [];
    const run = fakeRunner((path) => {
      seen.push(path);
      if (path === "repos/a/b") return { code: 0, stdout: JSON.stringify({}) };
      if (path.startsWith("repos/a/b/labels")) return { code: 0, stdout: JSON.stringify([]) };
      if (path.endsWith("branches/release/protection")) {
        return { code: 0, stdout: JSON.stringify({ required_status_checks: { contexts: ["ci"] } }) };
      }
      return { code: 1, stdout: "", stderr: "" };
    });
    const repo = await readLiveRepo("a/b", "release", run);
    expect(seen.some((p) => p.includes("branches/release/protection"))).toBe(true);
    expect(repo.branchProtection?.branch).toBe("release");
  });

  test("repo fetch failure surfaces as GithubSettingsError", async () => {
    const run = fakeRunner(() => ({ code: 1, stdout: "", stderr: "gh not authed" }));
    await expect(readLiveRepo("a/b", "main", run)).rejects.toThrow("gh not authed");
  });
});
