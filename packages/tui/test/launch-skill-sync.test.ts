import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFirstPartyManifest, installFirstPartySkills } from "@moh/core";
import { launchSkillSync, resetLaunchSkillSyncForTest } from "../src/launch-skill-sync";

const skill = (name: string) => ({
  name,
  description: `${name} skill`,
  files: { "SKILL.md": `---\nname: ${name}\ndescription: ${name} skill\n---\n\nbody` },
});

function makeHome(): string {
  const home = join(tmpdir(), `moh-launch-sync-${crypto.randomUUID()}`);
  mkdirSync(join(home, "skills"), { recursive: true });
  return home;
}

describe("launch skill sync (#385)", () => {
  it("installs bundled skills when workflow mode is enabled", () => {
    resetLaunchSkillSyncForTest();
    const home = makeHome();
    const report = launchSkillSync({
      mohHome: home,
      workflowEnabled: true,
      install: () => installFirstPartySkills({
        mohHome: home,
        sources: [skill("gh-manager")],
      }),
    });
    expect(report?.installed).toEqual(["gh-manager"]);
    expect(existsSync(join(home, "skills", "gh-manager", "SKILL.md"))).toBe(true);
    expect(Object.keys(loadFirstPartyManifest(home).skills)).toEqual(["gh-manager"]);
  });

  it("is a no-op when workflow mode is off", () => {
    resetLaunchSkillSyncForTest();
    const home = makeHome();
    const report = launchSkillSync({ mohHome: home, workflowEnabled: false, install: () => {
      throw new Error("must not run");
    } });
    expect(report).toBeNull();
    expect(loadFirstPartyManifest(home).skills).toEqual({});
  });

  it("runs only once per process", () => {
    resetLaunchSkillSyncForTest();
    const home = makeHome();
    let calls = 0;
    const install = () => {
      calls++;
      return installFirstPartySkills({ mohHome: home, sources: [] });
    };
    launchSkillSync({ mohHome: home, workflowEnabled: true, install });
    launchSkillSync({ mohHome: home, workflowEnabled: true, install });
    expect(calls).toBe(1);
  });

  it("never overwrites a user-modified copy", () => {
    resetLaunchSkillSyncForTest();
    const home = makeHome();
    const source = skill("gh-manager");
    // First install, then a user edit to the installed copy.
    installFirstPartySkills({ mohHome: home, sources: [source] });
    writeFileSync(
      join(home, "skills", "gh-manager", "SKILL.md"),
      "---\nname: gh-manager\ndescription: my customized copy\n---\n\nbody",
    );
    const report = launchSkillSync({
      mohHome: home,
      workflowEnabled: true,
      install: () => installFirstPartySkills({
        mohHome: home,
        sources: [{ ...source, files: { ...source.files, "SKILL.md": `${source.files["SKILL.md"]}\nnewer` } }],
      }),
    });
    expect(report?.skippedModified).toEqual(["gh-manager"]);
    expect(report?.updated).toEqual([]);
  });

  it("returns null (fail-silent) when the install throws", () => {
    resetLaunchSkillSyncForTest();
    const home = makeHome();
    const report = launchSkillSync({
      mohHome: home,
      workflowEnabled: true,
      install: () => {
        throw new Error("unwritable ~/.moh");
      },
    });
    expect(report).toBeNull();
  });

  it("hash semantics: unchanged bundle leaves copies alone", () => {
    resetLaunchSkillSyncForTest();
    const home = makeHome();
    const source = skill("moh-implementation-flow");
    const install = () => installFirstPartySkills({ mohHome: home, sources: [source] });
    launchSkillSync({ mohHome: home, workflowEnabled: true, install });
    resetLaunchSkillSyncForTest();
    const second = launchSkillSync({ mohHome: home, workflowEnabled: true, install });
    expect(second?.unchanged).toEqual(["moh-implementation-flow"]);
    expect(second?.installed).toEqual([]);

  });
});
