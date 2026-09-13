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

describe("mpm config precedence (ADR-0026)", () => {
  test("defaults: disabled (opt-in), default quota, no exclusions", () => {
    const r = resolveMpmConfig({}, undefined);
    expect(r.enabled).toBe(false);
    expect(r.disabledReason).toBe("user");
    expect(r.quota).toEqual({});
    expect(r.exclude).toEqual([]);
  });

  test("an explicit project enabled wins over the user default (either direction)", () => {
    // Global default off, project opts in.
    expect(resolveMpmConfig({}, { enabled: true }).enabled).toBe(true);
    // Global on, project opts out.
    const off = resolveMpmConfig({ enabled: true }, { enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.disabledReason).toBe("project");
  });

  test("inherit: user enabled=true activates; nothing else does", () => {
    expect(resolveMpmConfig({ enabled: true }, undefined).enabled).toBe(true);
    expect(resolveMpmConfig({ enabled: false }, undefined).enabled).toBe(false);
    // A project quota/exclusion gain alone does not activate MPM.
    const r = resolveMpmConfig({}, { quota: { maxFiles: 5 } });
    expect(r.enabled).toBe(false);
    expect(r.disabledReason).toBe("user");
  });

  test("quotas take the strictest field, exclusions union", () => {
    const r = resolveMpmConfig(
      { enabled: true, quota: { maxFiles: 5_000 }, exclude: ["secrets/**"] },
      { quota: { maxTotalBytes: 1024 }, exclude: ["generated/**"] },
    );
    expect(r.quota).toEqual({ maxFiles: 5_000, maxTotalBytes: 1024 });
    expect(r.exclude.sort()).toEqual(["generated/**", "secrets/**"]);
  });

  test("the project schema accepts both enabled values (per-project override)", () => {
    expect(mpmProjectConfigSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(mpmProjectConfigSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(mpmProjectConfigSchema.safeParse({}).success).toBe(true);
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
  test("no user mpm section: MPM stays off (opt-in default) — no wiring, no projection", async () => {
    const { sessionFromConfig } = await import("../src/session/from-config");
    const { projectMapDir } = await import("../src/mpm/service");
    const { existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "moh-mpm-asm-"));
    const cwd = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    writeFileSync(join(cwd, "src", "app.ts"), "export {};\n");
    // No ~/.moh/config mpm section: the opt-in default is disabled.
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

  test("a project opt-in (moh.json mpm.enabled=true) activates MPM over a global default off", async () => {
    const { sessionFromConfig } = await import("../src/session/from-config");
    const { MpmService, projectMapDir } = await import("../src/mpm/service");
    const { existsSync } = await import("node:fs");
    const dir = mkdtempSync(join(tmpdir(), "moh-mpm-proj-on-"));
    const cwd = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", mpm: { enabled: true } }));
    writeFileSync(join(cwd, "src", "app.ts"), "export {};\n");
    // No user section: the project override alone activates MPM. The config
    // param replaces the moh.json read, so mpm rides on it explicitly.
    const result = sessionFromConfig({ cwd, home, config: { provider: "mock", mpm: { enabled: true } } });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    try {
      expect(existsSync(join(projectMapDir(join(home, ".moh"), cwd), "manifest.json"))).toBe(true);
    } finally {
      await result.session.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a user mpm.enabled=true activates MPM wiring in sessionFromConfig", async () => {
    const { sessionFromConfig } = await import("../src/session/from-config");
    const dir = mkdtempSync(join(tmpdir(), "moh-mpm-asm-"));
    const cwd = join(dir, "project");
    const home = join(dir, "home");
    mkdirSync(join(cwd, "src"), { recursive: true });
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    writeFileSync(join(cwd, "src", "app.ts"), "export {};\n");
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ mpm: { enabled: true } }));
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
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock", mpm: { enabled: true } }));
    writeFileSync(join(cwd, "src", "app.ts"), 'import { helper } from "./util";\nexport function app() { return helper(); }\n');
    writeFileSync(join(cwd, "src", "util.ts"), "export function helper() { return 2; }\n");
    // No manifest exists — the deadlock case: nothing ever built the map.
    // The project opts in via moh.json; the user default stays off.
    const mapDir = projectMapDir(join(home, ".moh"), cwd);
    expect(existsSync(join(mapDir, "manifest.json"))).toBe(false);
    const result = sessionFromConfig({ cwd, home, config: { provider: "mock", mpm: { enabled: true } } });
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
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ mpm: { enabled: true, exclude: ["src/drop.ts"] } }));
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
