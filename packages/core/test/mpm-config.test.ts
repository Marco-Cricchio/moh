import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mpmProjectConfigSchema, readMpmUserConfig, resolveMpmConfig } from "../src/mpm/config";
import { updateUserConfigFile } from "../src/user-config";

function userConfigHome(): string {
  const home = mkdtempSync(join(tmpdir(), "moh-mpm-cfg-"));
  mkdirSync(join(home, ".moh"), { recursive: true });
  return home;
}

describe("mpm config precedence (#618)", () => {
  test("defaults: enabled, default quota, no exclusions", () => {
    const r = resolveMpmConfig({}, undefined);
    expect(r.enabled).toBe(true);
    expect(r.disabledReason).toBeNull();
    expect(r.exclude).toEqual([]);
  });

  test("a user disablement wins over everything", () => {
    expect(resolveMpmConfig({ enabled: false }, { enabled: false }).enabled).toBe(false);
    expect(resolveMpmConfig({ enabled: false }, undefined).disabledReason).toBe("user");
    // Project quota/exclusion "gains" do not resurrect a user disablement.
    const r = resolveMpmConfig({ enabled: false }, { quota: { maxFiles: 5 } });
    expect(r.enabled).toBe(false);
    expect(r.quota.maxFiles).toBeUndefined();
  });

  test("a project may disable or tighten, never enable", () => {
    expect(resolveMpmConfig({}, { enabled: false }).disabledReason).toBe("project");
    // There is no way to express "force on" in the project schema.
    const forced = mpmProjectConfigSchema.safeParse({ enabled: true });
    expect(forced.success).toBe(false);
    const r = resolveMpmConfig({ quota: { maxFiles: 10_000 } }, { quota: { maxFiles: 2_000 } });
    expect(r.enabled).toBe(true);
    expect(r.quota.maxFiles).toBe(2_000);
  });

  test("quotas take the strictest field, exclusions union", () => {
    const r = resolveMpmConfig(
      { quota: { maxFiles: 5_000 }, exclude: ["secrets/**"] },
      { quota: { maxTotalBytes: 1024 }, exclude: ["generated/**"] },
    );
    expect(r.quota).toEqual({ maxFiles: 5_000, maxTotalBytes: 1024 });
    expect(r.exclude.sort()).toEqual(["generated/**", "secrets/**"]);
  });

  test("user config read is tolerant of missing/corrupt/malformed sections", () => {
    const home = userConfigHome();
    const file = join(home, ".moh", "config");
    expect(readMpmUserConfig(file)).toEqual({});
    writeFileSync(file, "{ not json");
    expect(readMpmUserConfig(file)).toEqual({});
    writeFileSync(file, JSON.stringify({ mpm: { enabled: "yes", quota: { maxFiles: -1 }, exclude: [42, ""] } }));
    expect(readMpmUserConfig(file)).toEqual({});
    // Unknown siblings survive a guardian write that sets mpm.
    writeFileSync(file, JSON.stringify({ theme: "dark" }));
    updateUserConfigFile(file, (d) => {
      d.mpm = { enabled: false };
    });
    const data = JSON.parse(readFileSync(file, "utf8"));
    expect(data.theme).toBe("dark");
    expect(data.mpm.enabled).toBe(false);
  });

  test("valid user config round-trips through the guardian", () => {
    const home = userConfigHome();
    const file = join(home, ".moh", "config");
    updateUserConfigFile(file, (d) => {
      d.mpm = { enabled: true, quota: { maxFiles: 100 }, exclude: ["legacy/**"] };
    });
    expect(readMpmUserConfig(file)).toEqual({
      enabled: true,
      quota: { maxFiles: 100 },
      exclude: ["legacy/**"],
    });
  });
});

describe("mpm workspace exclusions (#618)", () => {
  test("extra excludes drop matched files; negation re-includes only extras", async () => {
    const { discoverWorkspace } = await import("../src/mpm/discover");
    const root = mkdtempSync(join(tmpdir(), "moh-mpm-excl-"));
    mkdirSync(join(root, "src/generated"), { recursive: true });
    writeFileSync(join(root, "src/keep.ts"), "export {};\n");
    writeFileSync(join(root, "src/generated/artifact.ts"), "export {};\n");
    // gitignore drops src/generated anyway; a negation in extras re-includes it.
    writeFileSync(join(root, ".gitignore"), "src/generated\n");
    expect(discoverWorkspace(root)).toEqual([".gitignore", "src/keep.ts"]);
    expect(discoverWorkspace(root, ["!src/generated/**", "src/generated/internal"])).toEqual([
      ".gitignore",
      "src/generated/artifact.ts",
      "src/keep.ts",
    ]);
    // Extras can deny what gitignore allows.
    expect(discoverWorkspace(root, ["src/keep.ts"])).toEqual([".gitignore"]);
    // The sensitive denylist stays final — extras never rescue it.
    writeFileSync(join(root, "src/secret.key"), "x");
    expect(discoverWorkspace(root, ["!*.key"])).not.toContain("src/secret.key");
  });
});

describe("mpm session assembly gating (#618)", () => {
  test("user disablement in ~/.moh/config skips MPM wiring in sessionFromConfig", async () => {
    const { sessionFromConfig } = await import("../src/session/from-config");
    const { MpmService, projectMapDir } = await import("../src/mpm/service");
        const dir = mkdtempSync(join(tmpdir(), "moh-mpm-asm-"));
    const cwd = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    // A live projection exists, but the user disabled MPM.
    const service = new MpmService(projectMapDir(join(home, ".moh"), cwd));
    service.rebuild(new Map());
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ mpm: { enabled: false } }));
    const result = sessionFromConfig({ cwd, home, config: { provider: "mock" } });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.session).toBeDefined();
    await result.session.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a never-mapped project gets its initial projection built at assembly", async () => {
    const { sessionFromConfig } = await import("../src/session/from-config");
    const { MpmService, projectMapDir } = await import("../src/mpm/service");
    const { existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "moh-mpm-init-"));
    const cwd = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    writeFileSync(join(cwd, "src", "app.ts"), 'import { helper } from "./util";\nexport function app() { return helper(); }\n');
    writeFileSync(join(cwd, "src", "util.ts"), "export function helper() { return 2; }\n");
    // No manifest exists — the deadlock case: nothing ever built the map.
    const mapDir = projectMapDir(join(home, ".moh"), cwd);
    expect(existsSync(join(mapDir, "manifest.json"))).toBe(false);
    const result = sessionFromConfig({ cwd, home, config: { provider: "mock" } });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    try {
      // The projection was built during assembly and the session activated.
      expect(existsSync(join(mapDir, "manifest.json"))).toBe(true);
      const service = new MpmService(mapDir);
      service.load();
      expect(service.fileCount).toBe(3); // src/app.ts, src/util.ts, moh.json
      expect(service.status).toBe("ready");
      const q = service.query("src/app.ts");
      expect(q).not.toBeNull();
      expect(q!.paths).toContain("src/util.ts");
    } finally {
      await result.session.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("initial build honors resolved exclusion patterns", async () => {
    const { sessionFromConfig } = await import("../src/session/from-config");
    const { MpmService, projectMapDir } = await import("../src/mpm/service");
    const dir = mkdtempSync(join(tmpdir(), "moh-mpm-init-excl-"));
    const cwd = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    writeFileSync(join(cwd, "src", "keep.ts"), "export {};\n");
    writeFileSync(join(cwd, "src", "drop.ts"), "export {};\n");
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ mpm: { exclude: ["src/drop.ts"] } }));
    const result = sessionFromConfig({ cwd, home, config: { provider: "mock" } });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    try {
      const service = new MpmService(projectMapDir(join(home, ".moh"), cwd));
      service.load();
      expect(service.record("src/drop.ts")).toBeNull();
      expect(service.record("src/keep.ts")).not.toBeNull();
    } finally {
      await result.session.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("MPM disabled: a virgin project gets no projection and no wiring", async () => {
    const { sessionFromConfig } = await import("../src/session/from-config");
    const { projectMapDir } = await import("../src/mpm/service");
    const { existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "moh-mpm-init-off-"));
    const cwd = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    writeFileSync(join(cwd, "src", "app.ts"), "export {};\n");
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ mpm: { enabled: false } }));
    const result = sessionFromConfig({ cwd, home, config: { provider: "mock" } });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    try {
      expect(existsSync(join(projectMapDir(join(home, ".moh"), cwd), "manifest.json"))).toBe(false);
    } finally {
      await result.session.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
