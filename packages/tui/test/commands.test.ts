import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, createSession } from "@moh/core";
import { activeCommands, runSlashCommand, type SlashContext } from "../src/commands";
import { DEFAULT_USER_CONFIG, loadUserConfig, saveUserConfig, userConfigFile } from "../src/user-config";

function makeCtx(over: Partial<SlashContext> = {}): SlashContext {
  const notices: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "moh-cmd-"));
  const cfgFile = userConfigFile(home);
  let config = { ...DEFAULT_USER_CONFIG };
  const ctx: SlashContext = {
    cwd: mkdtempSync(join(tmpdir(), "moh-cwd-")),
    mohHome: join(home, ".moh"),
    config,
    updateConfig: (patch) => {
      config = { ...config, ...patch };
      saveUserConfig(config, cfgFile);
    },
    session: null,
    notify: (m) => notices.push(m),
    ...over,
  };
  // keep the live config in sync for status checks
  Object.defineProperty(ctx, "config", { get: () => config });
  return Object.assign(ctx, { notices: () => notices, cfgFile });
}

describe("workflow slash command", () => {
  test("/workflow on installs first-party skills and persists the toggle", () => {
    const ctx = makeCtx() as any;
    expect(runSlashCommand("/workflow on", ctx)).toBe(true);
    expect(ctx.config.workflow.enabled).toBe(true);
    // persisted
    expect(loadUserConfig(ctx.cfgFile).workflow.enabled).toBe(true);
    // first-party skills installed under ~/.moh/skills
    const skill = readFileSync(join(ctx.mohHome, "skills", "plan", "SKILL.md"), "utf8");
    expect(skill).toContain("name: plan");
    expect(ctx.notices()[0]).toContain("workflow on");
  });

  test("/workflow off hides skills and leaves base behavior untouched", () => {
    const ctx = makeCtx() as any;
    runSlashCommand("/workflow on", ctx);
    expect(runSlashCommand("/workflow off", ctx)).toBe(true);
    expect(ctx.config.workflow.enabled).toBe(false);
    expect(ctx.notices().at(-1)).toContain("workflow off");
  });

  test("/workflow with no args reports status", () => {
    const ctx = makeCtx() as any;
    runSlashCommand("/workflow", ctx);
    expect(ctx.notices()[0]).toContain("workflow is off");
  });

  test("mid-session toggle refreshes the session skill index", async () => {
    const ctx = makeCtx() as any;
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      cwd: ctx.cwd,
      mohHome: ctx.mohHome,
      firstParty: "exclude",
    });
    ctx.session = session;
    runSlashCommand("/workflow on", ctx);
    await session.send("hi");
  });
});

describe("workflow skill aliases", () => {
  test("aliases only exist while workflow is on", () => {
    const ctx = makeCtx() as any;
    expect(activeCommands({ config: DEFAULT_USER_CONFIG }).map((c) => c.name)).toEqual(["workflow"]);
    runSlashCommand("/workflow on", ctx);
    const names = activeCommands({ config: ctx.config }).map((c) => c.name);
    for (const n of ["plan", "implement", "review", "diagnose", "dream", "frontier", "skills"]) {
      expect(names).toContain(n);
    }
  });

  test("/plan routes the prompt through the skill", async () => {
    const sent: string[] = [];
    const ctx = makeCtx({
      session: { send: (t: string) => (sent.push(t), Promise.resolve(null)) },
    } as any) as any;
    runSlashCommand("/workflow on", ctx);
    expect(runSlashCommand("/plan build a thing", ctx)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"plan" skill');
    expect(sent[0]).toContain("build a thing");
  });

  test("plain text and unknown commands are not consumed", () => {
    const ctx = makeCtx() as any;
    expect(runSlashCommand("hello world", ctx)).toBe(false);
    expect(runSlashCommand("/nosuchcommand", ctx)).toBe(false);
  });
});
