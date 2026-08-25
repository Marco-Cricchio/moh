import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, createSession } from "@moh/core";
import { activeCommands, runSlashCommand, type SlashContext } from "../src/commands";
import { DEFAULT_USER_CONFIG, loadUserConfig, saveUserConfig, userConfigFile } from "../src/user-config";

/** The test-side enrichment of SlashContext: the notices channel and config file. */
type TestSlashContext = SlashContext & { notices: () => string[]; cfgFile: string };

function makeCtx(over: Partial<SlashContext> = {}): TestSlashContext {
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
  return Object.assign(ctx, { notices: () => notices, cfgFile }) as TestSlashContext;
}

describe("workflow slash command", () => {
  test("/workflow on installs first-party skills and persists the toggle", () => {
    const ctx = makeCtx() as any;
    expect(runSlashCommand("/workflow on", ctx)).toBe(true);
    expect(ctx.config.workflow.enabled).toBe(true);
    // persisted
    expect(loadUserConfig(ctx.cfgFile).workflow.enabled).toBe(true);
    // first-party skills installed under ~/.moh/skills (#74: original vocabulary)
    const skill = readFileSync(join(ctx.mohHome, "skills", "tdd", "SKILL.md"), "utf8");
    expect(skill).toContain("name: tdd");
    expect(existsSync(join(ctx.mohHome, "skills", "plan"))).toBe(false);
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
    expect(activeCommands({ config: DEFAULT_USER_CONFIG }).map((c) => c.name)).toEqual(["workflow", "ask-moh", "model"]);
    runSlashCommand("/workflow on", ctx);
    const names = activeCommands({ config: ctx.config }).map((c) => c.name);
    for (const n of ["implement", "tdd", "code-review", "diagnosing-bugs", "grilling", "wayfinder", "frontier", "skills"]) {
      expect(names).toContain(n);
    }
  });

  test("/tdd routes the prompt through the skill", async () => {
    const sent: string[] = [];
    const ctx = makeCtx({
      session: { send: (t: string) => (sent.push(t), Promise.resolve(null)) },
    } as any) as any;
    runSlashCommand("/workflow on", ctx);
    expect(runSlashCommand("/tdd build a thing", ctx)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('"tdd" skill');
    expect(sent[0]).toContain("build a thing");
  });

  test("plain text and unknown commands are not consumed", () => {
    const ctx = makeCtx() as any;
    expect(runSlashCommand("hello world", ctx)).toBe(false);
    expect(runSlashCommand("/nosuchcommand", ctx)).toBe(false);
  });
});

describe("/model slash command (#166)", () => {
  function sessionCtx() {
    const session = createSession({
      provider: "alpha/one",
      endpoints: [
        { name: "alpha", type: "openai-compat", baseUrl: "http://localhost:1/v1", defaultModel: "one" },
        { name: "beta", type: "openai-compat", baseUrl: "http://localhost:2/v1", defaultModel: "two" },
      ],
    });
    const ctx = makeCtx({
      session,
      activeProviderType: () => "anthropic", // stub: catalog display (alpha is openai-compat, no catalog)
      onModelSwitched: (m) => switchedTo.push(m),
    }) as any;
    const switchedTo: string[] = [];
    (ctx as any).switchedTo = switchedTo;
    return ctx;
  }

  test("/model with no args shows the active model, the catalog, and the usage hint", () => {
    const ctx = sessionCtx();
    expect(runSlashCommand("/model", ctx)).toBe(true);
    const notices = ctx.notices();
    expect(notices[0]).toContain("active model: alpha/one");
    expect(notices.some((n: string) => n.includes("anthropic catalog"))).toBe(true);
    expect(notices.some((n: string) => n.includes("claude"))).toBe(true);
    expect(notices.at(-1)).toContain("usage: /model");
  });

  test("/model <ref> switches and notifies next-turn semantics", () => {
    const ctx = sessionCtx();
    expect(runSlashCommand("/model beta/two", ctx)).toBe(true);
    expect(ctx.session.activeModel).toBe("beta/two");
    expect(ctx.notices().at(-1)).toContain("beta/two");
    expect(ctx.notices().at(-1)).toContain("next turn");
    expect(ctx.switchedTo).toEqual(["beta/two"]);
  });

  test("failed switch surfaces the error; free-text ids on custom providers still resolve via profiles", () => {
    const ctx = sessionCtx();
    expect(runSlashCommand("/model nope/x", ctx)).toBe(true);
    expect(ctx.notices().at(-1)).toContain("✗");
    expect(ctx.session.activeModel).toBe("alpha/one");
    // free-text model on a declared endpoint
    expect(runSlashCommand("/model alpha/custom-free-text", ctx)).toBe(true);
    expect(ctx.session.activeModel).toBe("alpha/custom-free-text");
  });

  test("/model without an open session notifies", () => {
    const ctx = makeCtx();
    expect(runSlashCommand("/model", ctx)).toBe(true);
    expect(ctx.notices()[0]).toContain("needs an open session");
  });

  test("bare /model opens the picker modal when a UI offers it (#181)", () => {
    let opened = 0;
    const session = createSession({
      provider: "alpha/one",
      endpoints: [{ name: "alpha", type: "openai-compat", baseUrl: "http://localhost:9/v1", defaultModel: "one" }],
    });
    const ctx = makeCtx({ session, onOpenModelPicker: () => (opened += 1) });
    expect(runSlashCommand("/model", ctx)).toBe(true);
    expect(opened).toBe(1);
    expect((ctx as any).notices()).toHaveLength(0); // no text dump
  });
});

describe("ask-moh slash command", () => {
  function askCtx(workflowEnabled = false) {
    const sent: unknown[] = [];
    const ctx = makeCtx({
      session: { send: (t: string, o?: unknown) => (sent.push([t, o]), Promise.resolve(null)) } as any,
    }) as any;
    if (workflowEnabled) runSlashCommand("/workflow on", ctx);
    return { ctx, sent };
  }

  test("/ask-moh is a base command: works with workflow mode off", () => {
    const { ctx } = askCtx();
    expect(activeCommands(ctx).find((c) => c.name === "ask-moh")).toBeTruthy();
    expect(runSlashCommand("/ask-moh which skill for a bug?", ctx)).toBe(true);
    expect(ctx.notices()).toHaveLength(0); // routed to the session, no error
  });

  test("the sent text is the clean question; the SKILL.md rides the prompt option (ADR-0011)", () => {
    const { ctx, sent } = askCtx();
    runSlashCommand("/ask-moh which skill for a bug?", ctx);
    expect(sent).toHaveLength(1);
    const [text, options] = sent[0] as unknown as [string, { prompt?: { name: string; text: string } }];
    expect(text).toBe("which skill for a bug?\n\n(Workflow mode is currently off. The ask-moh skill's workflow-mode gate applies as written.)");
    expect(text).not.toContain("## Workflow mode gate"); // no SKILL.md blob in the user message
    expect(options?.prompt?.name).toBe("ask-moh");
    expect(options.prompt!.text).toContain("## Workflow mode gate"); // verbatim body, frontmatter stripped
    expect(options.prompt!.text).not.toContain("---\nname: ask-moh"); // frontmatter gone
  });

  test("an empty question falls back to the default routing question", () => {
    const { ctx, sent } = askCtx();
    runSlashCommand("/ask-moh", ctx);
    const [text] = sent[0] as unknown as [string];
    expect(text).toContain("Which skill or flow fits my situation?");
  });

  test("workflow state is injected as on after /workflow on", () => {
    const { ctx, sent } = askCtx(true);
    runSlashCommand("/ask-moh route me", ctx);
    expect((sent[0] as unknown as [string])[0]).toContain("Workflow mode is currently on");
  });

  test("/ask-moh without an open session notifies", () => {
    const ctx = makeCtx();
    expect(runSlashCommand("/ask-moh hi", ctx)).toBe(true);
    expect(ctx.notices()[0]).toContain("needs an open session");
  });
});
