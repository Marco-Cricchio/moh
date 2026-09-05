import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOH_VERSION,
  applyUpstreamUpdates,
  checkUpstreamUpdates,
  diffSkillFiles,
  firstPartySkillSources,
  embeddedSkillSources,
  defaultBundleDir,
  EMBEDDED_SKILLS_KEY,
  hashSkillFiles,
  installFirstPartySkills,
  loadFirstPartyManifest,
  versionSatisfied,
  type FirstPartySkillSource,
} from "../src/workflow";
import { discoverSkills, FIRST_PARTY_MANIFEST } from "../src/skills";

const install = installFirstPartySkills;

const mk = (files: Record<string, string>): FirstPartySkillSource => ({
  name: files["SKILL.md"]!.match(/^name:\s?(.+)$/m)![1]!.trim(),
  description: "test",
  files,
});

const skill = (name: string, body = "instructions"): FirstPartySkillSource =>
  mk({ "SKILL.md": `---\nname: ${name}\ndescription: test\n---\n\n# ${name}\n\n${body}\n` });

const hashOf = (home: string, name: string) =>
  hashSkillFiles({ "SKILL.md": readFileSync(join(home, "skills", name, "SKILL.md"), "utf8") });

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), "moh-wf-"));
}

describe("first-party skill install", () => {
  test("fresh install copies files and records the hash", () => {
    const home = freshHome();
    const report = install({ mohHome: home, sources: [skill("plan"), skill("review")] });
    expect(report.installed.sort()).toEqual(["plan", "review"]);
    expect(existsSync(join(home, "skills", "plan", "SKILL.md"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(home, "skills", FIRST_PARTY_MANIFEST), "utf8"));
    expect(Object.keys(manifest.skills).sort()).toEqual(["plan", "review"]);
    expect(statSync(join(home, "skills")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "skills", "plan")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "skills", "plan", "SKILL.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "skills", FIRST_PARTY_MANIFEST)).mode & 0o777).toBe(0o600);
  });

  test("second run is unchanged", () => {
    const home = freshHome();
    install({ mohHome: home, sources: [skill("plan")] });
    const report = install({ mohHome: home, sources: [skill("plan")] });
    expect(report.unchanged).toEqual(["plan"]);
    expect(report.installed).toEqual([]);
  });

  test("user-modified copies are skipped, never overwritten", () => {
    const home = freshHome();
    install({ mohHome: home, sources: [skill("plan", "original")] });
    const file = join(home, "skills", "plan", "SKILL.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("original", "my own version"));
    const report = install({ mohHome: home, sources: [skill("plan", "newer")] });
    expect(report.skippedModified).toEqual(["plan"]);
    expect(readFileSync(file, "utf8")).toContain("my own version");
  });

  test("min-version-gated skills are skipped", () => {
    const home = freshHome();
    const gated: FirstPartySkillSource = {
      ...skill("future"),
      minMohVersion: "99.0.0",
    };
    const report = install({ mohHome: home, sources: [gated] });
    expect(report.skippedMinVersion).toEqual(["future"]);
    expect(existsSync(join(home, "skills", "future"))).toBe(false);
  });

  test("bundled assets ship the workflow skills", () => {
    const sources = firstPartySkillSources();
    expect(sources.map((s) => s.name).sort()).toEqual([
      // #74: reduced set removed; original-vocabulary ports only (NOTICE.md).
      // ask-moh: the router skill (base /ask-moh command reads it from the bundle).
      "ask-moh",
      "code-review",
      "codebase-design",
      "diagnosing-bugs",
      "domain-modeling",
      "gh-manager", // #378: declarative GitHub settings, MIT port (NOTICE.md)
      "grilling",
      "implement",
      "moh-implementation-flow",
      "session-memory",
      "tdd",
      "to-spec",
      "to-tickets",
      "triage",
      "wayfinder",
      "wizard",
      "writing-for-agents",
    ]);
  });

  test("bundled implement skill references its companion flow with installable policy", () => {
    const byName = new Map(firstPartySkillSources().map((source) => [source.name, source]));
    const implement = byName.get("implement")!;
    const flow = byName.get("moh-implementation-flow")!;

    expect(implement.files["SKILL.md"]).toContain("moh-implementation-flow");
    expect(flow.description).toContain("non-trivial implementation work");
    expect(flow.files["SKILL.md"]).toContain("dedicated branch **before exploration**");
    expect(flow.files["SKILL.md"]).toContain("parallel");
    expect(flow.files["SKILL.md"]).toContain("verified vertical slices");
    expect(flow.files["SKILL.md"]).toContain("atomic intermediate commit");
    expect(flow.files["SKILL.md"]).toContain("Creating a PR and merging a branch require an explicit owner request");

    const home = freshHome();
    const report = install({ mohHome: home, sources: [implement, flow] });
    expect(report.installed.sort()).toEqual(["implement", "moh-implementation-flow"]);
    expect(readFileSync(join(home, "skills", "moh-implementation-flow", "SKILL.md"), "utf8")).toContain(
      "verified vertical slices",
    );
  });

  test("companion flow updates unmodified copies and preserves modified copies", () => {
    const flow = firstPartySkillSources().find((source) => source.name === "moh-implementation-flow")!;
    const updated: FirstPartySkillSource = {
      ...flow,
      files: { "SKILL.md": flow.files["SKILL.md"]!.replace("# Moh Implementation Flow", "# Updated Moh Implementation Flow") },
    };

    const unmodifiedHome = freshHome();
    install({ mohHome: unmodifiedHome, sources: [flow] });
    expect(install({ mohHome: unmodifiedHome, sources: [updated] }).updated).toEqual(["moh-implementation-flow"]);

    const modifiedHome = freshHome();
    install({ mohHome: modifiedHome, sources: [flow] });
    const file = join(modifiedHome, "skills", "moh-implementation-flow", "SKILL.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}\nLocal policy note.\n`);
    expect(install({ mohHome: modifiedHome, sources: [updated] }).skippedModified).toEqual(["moh-implementation-flow"]);
    expect(readFileSync(file, "utf8")).toContain("Local policy note.");
  });

  test("generated index exposes the same bundled implement and companion sources", () => {
    const index = JSON.parse(readFileSync(join(defaultBundleDir(), "index.json"), "utf8"));
    const byName = new Map<string, Pick<FirstPartySkillSource, "name" | "files">>(
      index.skills.map((source: FirstPartySkillSource) => [source.name, source]),
    );

    expect(byName.get("implement")?.files["SKILL.md"]).toContain("moh-implementation-flow");
    expect(byName.get("moh-implementation-flow")?.files["SKILL.md"]).toContain("verified vertical slices");
  });

  test("install prunes stale moh-owned skills no longer bundled (#74)", () => {
    const home = freshHome();
    // an old install shipped "plan"; the new bundle does not
    install({ mohHome: home, sources: [skill("plan"), skill("implement")] });
    const report = install({ mohHome: home, sources: [skill("implement")] });
    expect(report.pruned).toEqual(["plan"]);
    expect(existsSync(join(home, "skills", "plan"))).toBe(false);
    expect(existsSync(join(home, "skills", "implement", "SKILL.md"))).toBe(true);
    expect(Object.keys(loadFirstPartyManifest(home).skills)).toEqual(["implement"]);
  });

  test("prune leaves user-modified stale copies on disk but drops ownership", () => {
    const home = freshHome();
    install({ mohHome: home, sources: [skill("plan")] });
    writeFileSync(join(home, "skills", "plan", "SKILL.md"), "user edited");
    const report = install({ mohHome: home, sources: [] });
    expect(report.pruned).toEqual([]);
    expect(report.skippedModified).toEqual(["plan"]);
    expect(existsSync(join(home, "skills", "plan", "SKILL.md"))).toBe(true);
    expect(Object.keys(loadFirstPartyManifest(home).skills)).toEqual([]);
  });

  test("design-core ports keep their companion files", () => {
    const sources = firstPartySkillSources();
    const byName = new Map(sources.map((s) => [s.name, s]));
    expect(byName.get("domain-modeling")?.files["CONTEXT-FORMAT.md"]).toBeTruthy();
    expect(byName.get("domain-modeling")?.files["ADR-FORMAT.md"]).toBeTruthy();
    expect(byName.get("triage")?.files["AGENT-BRIEF.md"]).toBeTruthy();
    expect(byName.get("triage")?.files["OUT-OF-SCOPE.md"]).toBeTruthy();
    expect(byName.get("tdd")?.files["tests.md"]).toBeTruthy();
    expect(byName.get("tdd")?.files["mocking.md"]).toBeTruthy();
    expect(byName.get("codebase-design")?.files["DEEPENING.md"]).toBeTruthy();
    expect(byName.get("codebase-design")?.files["DESIGN-IT-TWICE.md"]).toBeTruthy();
    expect(byName.get("wizard")?.files["template.sh"]).toBeTruthy();
    // #73: flattened from scripts/ (see NOTICE.md)
    expect(byName.get("diagnosing-bugs")?.files["hitl-loop.template.sh"]).toBeTruthy();
  });
});

describe("workflow skill discovery", () => {
  test("exclude hides installed first-party skills; project-level copies still win", () => {
    const home = freshHome();
    const project = mkdtempSync(join(tmpdir(), "moh-wfproj-"));
    install({ mohHome: home, sources: [skill("plan")] });
    mkdirSync(join(project, ".moh", "skills", "mine"), { recursive: true });
    writeFileSync(
      join(project, ".moh", "skills", "mine", "SKILL.md"),
      "---\nname: mine\ndescription: user skill\n---\n",
    );
    const included = discoverSkills({ mohHome: home, projectDir: project }).map((s) => s.name);
    expect(included.sort()).toEqual(["mine", "plan"]);
    const excluded = discoverSkills({ mohHome: home, projectDir: project, firstParty: "exclude" }).map((s) => s.name);
    expect(excluded).toEqual(["mine"]);
  });
});

describe("upstream updates", () => {
  const fetchWith = (index: unknown) => async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(index),
  });

  test("detects updates for unmodified copies only", async () => {
    const home = freshHome();
    install({ mohHome: home, sources: [skill("plan", "v1"), skill("review", "v1")] });
    writeFileSync(
      join(home, "skills", "review", "SKILL.md"),
      readFileSync(join(home, "skills", "review", "SKILL.md"), "utf8").replace("v1", "hacked"),
    );
    const result = await checkUpstreamUpdates({
      mohHome: home,
      fetchImpl: fetchWith({ skills: [skill("plan", "v2"), skill("review", "v2"), skill("unknown", "v2")] }) as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updates.map((u) => u.name)).toEqual(["plan"]);
  });

  test("a non-OK upstream response is an explicit failure, not 'up to date' (#344)", async () => {
    const home = freshHome();
    const result = await checkUpstreamUpdates({
      mohHome: home,
      fetchImpl: async () => ({ ok: false, status: 404, text: async () => "" }) as any,
    });
    expect(result).toEqual({ ok: false, reason: "http 404" });
  });

  test("network failures are explicit failures (callers decide fail-silence)", async () => {
    const home = freshHome();
    const result = await checkUpstreamUpdates({
      mohHome: home,
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("offline");
  });

  test("malformed JSON is an explicit failure", async () => {
    const home = freshHome();
    const result = await checkUpstreamUpdates({
      mohHome: home,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not json{" }) as any,
    });
    expect(result).toEqual({ ok: false, reason: "malformed index" });
  });

  test("a shape-invalid index is an explicit failure", async () => {
    const home = freshHome();
    const result = await checkUpstreamUpdates({
      mohHome: home,
      fetchImpl: fetchWith({ nope: true }) as any,
    });
    expect(result).toEqual({ ok: false, reason: "invalid index" });
  });

  test("an empty-but-valid index is a successful no-updates check", async () => {
    const home = freshHome();
    const result = await checkUpstreamUpdates({ mohHome: home, fetchImpl: fetchWith({ skills: [] }) as any });
    expect(result).toEqual({ ok: true, updates: [] });
  });

  test("#517: an upstream entry equal to the bundled copy is not offered, even when the disk copy differs", async () => {
    const home = freshHome();
    // installed stale at v1; bundle and upstream index both v2
    install({ mohHome: home, sources: [skill("plan", "v1")] });
    const bundled = skill("plan", "v2");
    const result = await checkUpstreamUpdates({
      mohHome: home,
      bundledSources: [bundled],
      fetchImpl: fetchWith({ skills: [skill("plan", "v2")] }) as any,
    });
    expect(result).toEqual({ ok: true, updates: [] });
  });

  test("#517: upstream differing from both bundle and disk is still offered", async () => {
    const home = freshHome();
    install({ mohHome: home, sources: [skill("plan", "v1")] });
    const result = await checkUpstreamUpdates({
      mohHome: home,
      bundledSources: [skill("plan", "v2")],
      fetchImpl: fetchWith({ skills: [skill("plan", "v3")] }) as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updates.map((u) => u.name)).toEqual(["plan"]);
  });

  test("#517: a skill absent from the injected bundle is unaffected (default live-bundle behavior)", async () => {
    const home = freshHome();
    install({ mohHome: home, sources: [skill("plan", "v1")] });
    const result = await checkUpstreamUpdates({
      mohHome: home,
      bundledSources: [skill("other", "v9")],
      fetchImpl: fetchWith({ skills: [skill("plan", "v2")] }) as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updates.map((u) => u.name)).toEqual(["plan"]);
  });

  test("apply respects consent and skips modified copies", async () => {
    const home = freshHome();
    install({ mohHome: home, sources: [skill("plan", "v1"), skill("review", "v1")] });
    const plan = skill("plan", "v2");
    const review = skill("review", "v2");
    const hashOfLocal = (name: string) => hashOf(home, name);
    const report = await applyUpstreamUpdates({
      mohHome: home,
      updates: [
        { name: "plan", currentHash: hashOfLocal("plan"), upstreamHash: hashSkillFiles(plan.files), files: plan.files },
        { name: "review", currentHash: hashOfLocal("review"), upstreamHash: hashSkillFiles(review.files), files: review.files },
      ],
      consent: (u) => u.name === "plan",
    });
    expect(report.applied).toEqual(["plan"]);
    expect(report.declined).toEqual(["review"]);
    expect(readFileSync(join(home, "skills", "plan", "SKILL.md"), "utf8")).toContain("v2");
    expect(readFileSync(join(home, "skills", "review", "SKILL.md"), "utf8")).toContain("v1");
  });

  test("consent receives a diff containing +/- lines", async () => {
    const home = freshHome();
    install({ mohHome: home, sources: [skill("plan", "v1")] });
    const next = skill("plan", "v2");
    const diffs: string[] = [];
    await applyUpstreamUpdates({
      mohHome: home,
      updates: [{ name: "plan", currentHash: hashOf(home, "plan"), upstreamHash: hashSkillFiles(next.files), files: next.files }],
      consent: (_u, diff) => {
        diffs.push(diff);
        return true;
      },
    });
    expect(diffs[0]).toContain("-v1");
    expect(diffs[0]).toContain("+v2");
  });

  test("diffSkillFiles shows added and removed files", () => {
    const diff = diffSkillFiles({ "a.md": "x" }, { "b.md": "y" });
    expect(diff).toContain("--- a/a.md");
    expect(diff).toContain("+++ b/b.md");
  });

  test("#352/SEC-02: a traversal-bearing index entry makes the check fail explicitly", async () => {
    const home = freshHome();
    install({ mohHome: home, sources: [skill("plan", "v1")] });
    const result = await checkUpstreamUpdates({
      mohHome: home,
      fetchImpl: fetchWith({ skills: [{ name: "../../traversed", files: { pwned: "x" } }] }) as any,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("invalid");
    // file-key traversal is rejected too
    const keyResult = await checkUpstreamUpdates({
      mohHome: home,
      fetchImpl: fetchWith({ skills: [{ name: "plan", files: { "../pwned": "x" } }] }) as any,
    });
    expect(keyResult.ok).toBe(false);
  });

  test("#352/SEC-02: apply skips malformed updates without writing outside the skills root", async () => {
    const home = freshHome();
    install({ mohHome: home, sources: [skill("plan", "v1")] });
    const report = await applyUpstreamUpdates({
      mohHome: home,
      updates: [
        { name: "../../traversed", currentHash: hashSkillFiles({}), upstreamHash: hashSkillFiles({ pwned: "x" }), files: { pwned: "x" } },
        { name: "plan", currentHash: hashSkillFiles({}), upstreamHash: hashSkillFiles({ "../pwned": "x" }), files: { "../pwned": "x" } },
      ],
      consent: () => true,
    });
    expect(report.skippedInvalid.sort()).toEqual(["../../traversed", "plan"]);
    expect(report.applied).toEqual([]);
    // Nothing escaped the skills root: no `traversed` dir one level above moh home.
    expect(existsSync(join(home, "traversed"))).toBe(false);
    expect(existsSync(join(home, "skills", "pwned"))).toBe(false);
    expect(existsSync(join(home, "pwned"))).toBe(false);
  });

  test("#352/SEC-02: the bundled installer rejects malformed sources too (defense in depth)", () => {
    const home = freshHome();
    const evil: FirstPartySkillSource = {
      name: "../escape",
      description: "x",
      files: { "SKILL.md": "---\nname: escape\ndescription: x\n---\n" },
    };
    const report = install({ mohHome: home, sources: [evil, skill("plan")] });
    expect(report.skippedInvalid).toEqual(["../escape"]);
    expect(existsSync(join(home, "skills", "escape"))).toBe(false);
    expect(report.installed).toEqual(["plan"]);
  });
});

describe("embedded skills bundle (binary run, #267)", () => {
  const GLOBAL_KEY = EMBEDDED_SKILLS_KEY;

  /** Writes skill files to a temp "extracted assets" dir and returns the registry. */
  function extractedBundle(skills: FirstPartySkillSource[]): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), "moh-emb-"));
    const registry: Record<string, string> = {};
    for (const s of skills) {
      mkdirSync(join(dir, s.name), { recursive: true });
      for (const [rel, content] of Object.entries(s.files)) {
        writeFileSync(join(dir, s.name, rel), content);
        registry[`${s.name}/${rel}`] = join(dir, s.name, rel);
      }
    }
    return registry;
  }

  test("embeddedSkillSources reads skills from the extracted-asset registry", () => {
    const registry = extractedBundle([skill("plan", "body"), skill("review", "body")]);
    registry["plan/nested/extra.md"] = "ignored"; // nested keys: disk reader is flat, embedded must match
    const sources = embeddedSkillSources(registry);
    expect(sources.map((s) => s.name)).toEqual(["plan", "review"]);
    expect(sources[0]!.files["SKILL.md"]).toContain("body");
    expect(Object.keys(sources[0]!.files)).toEqual(["SKILL.md"]);
  });

  test("install uses the embedded registry when present, disk bundle otherwise", () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g[GLOBAL_KEY];
    const home = freshHome();
    try {
      g[GLOBAL_KEY] = extractedBundle([skill("plan", "embedded")]);
      const report = install({ mohHome: home });
      expect(report.installed).toEqual(["plan"]);
      expect(readFileSync(join(home, "skills", "plan", "SKILL.md"), "utf8")).toContain("embedded");
    } finally {
      if (prev === undefined) delete g[GLOBAL_KEY];
      else g[GLOBAL_KEY] = prev;
    }
  });

  test("embedded upgrade-in-place keeps hash-manifest semantics", () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g[GLOBAL_KEY];
    const home = freshHome();
    try {
      g[GLOBAL_KEY] = extractedBundle([skill("plan", "v1")]);
      install({ mohHome: home });
      writeFileSync(join(home, "skills", "plan", "SKILL.md"), "user edit");
      g[GLOBAL_KEY] = extractedBundle([skill("plan", "v2")]);
      const report = install({ mohHome: home });
      expect(report.skippedModified).toEqual(["plan"]);
      expect(readFileSync(join(home, "skills", "plan", "SKILL.md"), "utf8")).toBe("user edit");
    } finally {
      if (prev === undefined) delete g[GLOBAL_KEY];
      else g[GLOBAL_KEY] = prev;
    }
  });
});

describe("versionSatisfied", () => {
  test("compares loosely", () => {
    expect(versionSatisfied("0.1.0", MOH_VERSION)).toBe(true);
    expect(versionSatisfied("0.1", "0.1.0")).toBe(true);
    expect(versionSatisfied("1.0.0", "0.1.0")).toBe(false);
  });
});
