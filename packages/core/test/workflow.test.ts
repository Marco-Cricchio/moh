import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOH_VERSION,
  applyUpstreamUpdates,
  checkUpstreamUpdates,
  diffSkillFiles,
  firstPartySkillSources,
  embeddedSkillSources,
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
      "grilling",
      "implement",
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
