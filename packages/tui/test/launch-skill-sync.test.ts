import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
  return mkdtempSync(join(tmpdir(), "moh-launch-sync-"));
}

describe("launch skill sync (#385)", () => {
  test("installs bundled skills when workflow mode is enabled", () => {
    resetLaunchSkillSyncForTest();
    const home = makeHome();
    const report = launchSkillSync({
      mohHome: home,
      workflowEnabled: true,
      install: () => installFirstPartySkills({ mohHome: home, sources: [skill("gh-manager")] }),
    });
    expect(report?.installed).toEqual(["gh-manager"]);
    expect(existsSync(join(home, "skills", "gh-manager", "SKILL.md"))).toBe(true);
    expect(Object.keys(loadFirstPartyManifest(home).skills)).toEqual(["gh-manager"]);
  });

  test("is a no-op when workflow mode is off", () => {
    resetLaunchSkillSyncForTest();
    const home = makeHome();
    const report = launchSkillSync({
      mohHome: home,
      workflowEnabled: false,
      install: () => {
        throw new Error("must not run");
      },
    });
    expect(report).toBeNull();
    expect(loadFirstPartyManifest(home).skills).toEqual({});
  });

  test("runs only once per process", () => {
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

  test("never overwrites a user-modified copy", () => {
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
      install: () =>
        installFirstPartySkills({
          mohHome: home,
          sources: [
            { ...source, files: { ...source.files, "SKILL.md": `${source.files["SKILL.md"]}\nnewer` } },
          ],
        }),
    });
    expect(report?.skippedModified).toEqual(["gh-manager"]);
    expect(report?.updated).toEqual([]);
  });

  test("returns null (fail-silent) when the install throws", () => {
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

  test("hash semantics: unchanged bundle leaves copies alone", () => {
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

  test("default seam: production install path runs against the real bundle", () => {
    resetLaunchSkillSyncForTest();
    const home = makeHome();
    // No `install` injection: the default calls installFirstPartySkills
    // with the shipped sources (dev checkout: the on-disk bundle) — the
    // exact code path production exercises at launch.
    const report = launchSkillSync({ mohHome: home, workflowEnabled: true });
    expect(report).not.toBeNull();
    expect(report!.unchanged.length + report!.installed.length + report!.updated.length).toBeGreaterThan(0);
    // The shipped bundle is idempotent: a second process-launch run
    // (simulated via the reset) sees everything unchanged.
    resetLaunchSkillSyncForTest();
    const second = launchSkillSync({ mohHome: home, workflowEnabled: true });
    expect(second!.installed).toEqual([]);
  });
});
