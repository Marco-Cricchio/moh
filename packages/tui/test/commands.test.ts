import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider, createSession, readThinkingPreference, setThinkingPreference } from "@moh/core";
import { activeCommands, runSlashCommand, workflowCommands, BASE_COMMANDS, upstreamCheckMessage, type SlashContext } from "../src/commands";
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

describe("new base slash commands (/commands /mode /theme /settings /wayfinder)", () => {
  test("BASE_COMMANDS lists the thirteen base commands alphabetically", () => {
    const names = BASE_COMMANDS.map((c) => c.name);
    expect(names).toEqual(["ask-moh", "commands", "compact", "fork", "help", "mode", "model", "reload", "settings", "theme", "thinking", "wayfinder", "workflow"]);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  test("/commands, /settings open their panels; /mode and /theme call their seams", () => {
    const opened: string[] = [];
    const ctx = makeCtx({
      onOpenCommands: () => opened.push("commands"),
      onOpenSettings: () => opened.push("settings"),
      onCycleMode: () => opened.push("mode"),
      onCycleTheme: () => opened.push("theme"),
    });
    expect(runSlashCommand("/commands", ctx)).toBe(true);
    expect(runSlashCommand("/settings", ctx)).toBe(true);
    expect(runSlashCommand("/mode", ctx)).toBe(true);
    expect(runSlashCommand("/theme", ctx)).toBe(true);
    expect(opened).toEqual(["commands", "settings", "mode", "theme"]);
    expect(ctx.notices()).toHaveLength(0);
  });

  test("/help opens the manual via onOpenManual; /help <id> prints a page (#457)", () => {
    const opened: string[] = [];
    const ctx = makeCtx({ onOpenManual: () => opened.push("manual") });
    expect(runSlashCommand("/help", ctx)).toBe(true);
    expect(opened).toEqual(["manual"]);
    runSlashCommand("/help sessions", ctx);
    expect(ctx.notices()[0]).toContain("# Sessions");
    runSlashCommand("/help nope", ctx);
    expect(ctx.notices()[1]).toContain('no manual page "nope"');
    expect(ctx.notices()[1]).toContain("getting-started");
  });

  test("without the TUI seams /mode and /theme explain instead of failing", () => {
    const ctx = makeCtx();
    expect(runSlashCommand("/mode", ctx)).toBe(true);
    expect(ctx.notices()[0]).toContain("needs the TUI");
    expect(runSlashCommand("/theme", ctx)).toBe(true);
    expect(ctx.notices()[1]).toContain("needs the TUI");
  });

  test("/wayfinder opens the frontier panel only with workflow on", () => {
    let opened = 0;
    const ctx = makeCtx({ onOpenFrontier: () => (opened += 1) });
    expect(runSlashCommand("/wayfinder", ctx)).toBe(true);
    expect(opened).toBe(0);
    expect(ctx.notices()[0]).toContain("workflow on");
    runSlashCommand("/workflow on", ctx);
    expect(runSlashCommand("/wayfinder", ctx)).toBe(true);
    expect(opened).toBe(1);
  });

  test("the workflow alias list no longer contains wayfinder (the base command owns it)", () => {
    const names = workflowCommands().map((c) => c.name);
    expect(names).not.toContain("wayfinder");
    expect(names).not.toContain("frontier");
    expect(names).toContain("skills");
  });
});

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
    expect(activeCommands({ config: DEFAULT_USER_CONFIG }).map((c) => c.name)).toEqual([
      "ask-moh", "commands", "compact", "fork", "help", "mode", "model", "reload", "settings", "theme", "thinking", "wayfinder", "workflow",
    ]);
    runSlashCommand("/workflow on", ctx);
    const names = activeCommands({ config: ctx.config }).map((c) => c.name);
    for (const n of ["implement", "tdd", "code-review", "diagnosing-bugs", "grilling", "to-spec", "to-tickets", "triage", "skills"]) {
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

describe("/reload slash command (hot config reload)", () => {
  test("calls the UI reload seam when a session is open", () => {
    let reloaded = 0;
    const session = createSession({
      provider: "alpha/one",
      endpoints: [{ name: "alpha", type: "openai-compat", baseUrl: "http://localhost:9/v1", defaultModel: "one" }],
    });
    const ctx = makeCtx({ session, onReload: () => (reloaded += 1) });
    expect(runSlashCommand("/reload", ctx)).toBe(true);
    expect(reloaded).toBe(1);
    expect(ctx.notices()).toHaveLength(0);
  });

  test("without a session or without a UI it explains instead", () => {
    const ctx = makeCtx();
    expect(runSlashCommand("/reload", ctx)).toBe(true);
    expect(ctx.notices()[0]).toContain("needs an open session");
    const session = createSession({
      provider: "alpha/one",
      endpoints: [{ name: "alpha", type: "openai-compat", baseUrl: "http://localhost:9/v1", defaultModel: "one" }],
    });
    const ctx2 = makeCtx({ session });
    expect(runSlashCommand("/reload", ctx2)).toBe(true);
    expect(ctx2.notices()[0]).toContain("needs the TUI");
  });

  test("is a base command: available with workflow mode off", () => {
    expect(activeCommands({ config: DEFAULT_USER_CONFIG }).map((c) => c.name)).toContain("reload");
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

describe("/thinking controls (#242)", () => {
  test("show/hide is an immediate temporary display override only", () => {
    let display = false;
    const ctx = makeCtx({
      onThinkingDisplay: (show) => { display = show; },
      thinkingDisplay: () => display,
    });
    expect(runSlashCommand("/thinking show", ctx)).toBe(true);
    expect(display).toBe(true);
    expect(ctx.config.showReasoning).toBe(false); // global preference unchanged
    expect(loadUserConfig(ctx.cfgFile).showReasoning).toBe(false);
    expect(ctx.notices().at(-1)).toContain("requests and saved history are unchanged");

    runSlashCommand("/thinking", ctx);
    expect(ctx.notices().at(-1)).toContain("reasoning display on");
    runSlashCommand("/thinking hide", ctx);
    expect(display).toBe(false);
  });

  test("a supported level persists immediately for the active endpoint", () => {
    let refreshed = 0;
    const ctx = makeCtx({
      session: { activeModel: "ep/claude-fable-5" } as any,
      activeProviderType: () => "anthropic",
      onThinkingLevelChanged: () => { refreshed++; },
    });
    runSlashCommand("/thinking xhigh", ctx);
    expect(readThinkingPreference(ctx.cfgFile, "ep")).toBe("xhigh");
    expect(refreshed).toBe(1);
    expect(ctx.notices().at(-1)).toContain("effective from the next model call");
  });

  test("unsupported levels are explained and never silently mapped or persisted", () => {
    const ctx = makeCtx({
      session: { activeModel: "ep/claude-fable-5" } as any,
      activeProviderType: () => "anthropic",
    });
    // fable offers off/xhigh/max, not medium.
    runSlashCommand("/thinking medium", ctx);
    expect(readThinkingPreference(ctx.cfgFile, "ep")).toBeUndefined();
    expect(ctx.notices().at(-1)).toContain("nothing changed (moh never remaps levels)");

    runSlashCommand("/thinking", ctx);
    expect(ctx.notices().at(-1)).toContain("off, xhigh, max");
  });

  test("models without a declared level map disable selection with an explanation", () => {
    const ctx = makeCtx({
      session: { activeModel: "ep/claude-haiku-4-5" } as any,
      activeProviderType: () => "anthropic",
    });
    runSlashCommand("/thinking high", ctx);
    expect(readThinkingPreference(ctx.cfgFile, "ep")).toBeUndefined();
    expect(ctx.notices().at(-1)).toContain("declares no thinking capability");
  });

  test("#256: a config-declared capability offers exactly its declared levels (openai-compat)", () => {
    const ctx = makeCtx({
      session: {
        activeModel: "local/qwen3",
        endpointProfiles: [{
          name: "local",
          type: "openai-compat",
          baseUrl: "https://example.test/v1",
          capabilities: { thinking: { format: "openai-effort", levels: ["low", "medium", "high"] } },
        }],
      } as any,
    });
    runSlashCommand("/thinking", ctx);
    expect(ctx.notices().at(-1)).toContain("levels offered by local/qwen3: low, medium, high");
    runSlashCommand("/thinking high", ctx);
    expect(readThinkingPreference(ctx.cfgFile, "local")).toBe("high");
    runSlashCommand("/thinking xhigh", ctx);
    expect(readThinkingPreference(ctx.cfgFile, "local")).toBe("high"); // unchanged — never remapped
    expect(ctx.notices().at(-1)).toContain("does not offer level \"xhigh\"");
  });

  test("#256: an unsupported stored preference is visible as provider default, never dropped", () => {
    const ctx = makeCtx({
      session: { activeModel: "ep/claude-fable-5" } as any,
      activeProviderType: () => "anthropic",
    });
    setThinkingPreference(ctx.cfgFile, "ep", "medium");
    runSlashCommand("/thinking", ctx);
    expect(ctx.notices().at(-1)).toContain("provider default (preference medium unsupported by ep/claude-fable-5)");
    expect(readThinkingPreference(ctx.cfgFile, "ep")).toBe("medium"); // still intact
  });

  test("the command is always available outside workflow mode", () => {
    const ctx = makeCtx();
    expect(activeCommands(ctx).map((command) => command.name)).toContain("thinking");
  });
});

describe("/skills update notice sync (#348)", () => {
  function fakeCheck(result: import("@moh/core").UpstreamCheckResult) {
    return async () => result;
  }

  // `/skills` is workflow vocabulary: enable workflow mode for these.
  function skillsCtx(over: Partial<SlashContext> = {}): TestSlashContext {
    const ctx = makeCtx(over);
    ctx.updateConfig({ workflow: { enabled: true, upstreamCheck: true } });
    return ctx;
  }

  test("an explicit check notifies the skill-notice owner even with no updates", async () => {
    let syncs = 0;
    const ctx = skillsCtx({ skillsCheck: fakeCheck({ ok: true, updates: [] }), onSkillUpdatesChanged: () => { syncs++; } });
    runSlashCommand("/skills update", ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(syncs).toBe(1);
    expect(ctx.notices().at(-1)).toBe("skills up to date");
  });

  test("a failed explicit check still notifies (the notice may be stale)", async () => {
    let syncs = 0;
    const ctx = skillsCtx({ skillsCheck: fakeCheck({ ok: false, reason: "http 404" }), onSkillUpdatesChanged: () => { syncs++; } });
    runSlashCommand("/skills update", ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(syncs).toBe(1);
  });

  test("a TUI caller receives the checked plan for its update modal", async () => {
    let opened: import("@moh/core").UpstreamUpdate[] | undefined;
    const ctx = skillsCtx({
      skillsCheck: fakeCheck({ ok: true, updates: [{ name: "tdd", currentHash: "a", upstreamHash: "b", files: {} }] }),
      onOpenSkillUpdates: (updates) => { opened = updates; },
    });
    runSlashCommand("/skills update", ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(opened?.map((update) => update.name)).toEqual(["tdd"]);
    expect(ctx.notices()).toEqual([]);
  });

  test("apply notifies after installing", async () => {
    let syncs = 0;
    const ctx = skillsCtx({
      skillsCheck: fakeCheck({ ok: true, updates: [{ name: "tdd", currentHash: "a", upstreamHash: "b", files: {} }] }),
      onSkillUpdatesChanged: () => { syncs++; },
    });
    runSlashCommand("/skills update", ctx);
    await new Promise((r) => setTimeout(r, 0));
    const before = syncs;
    runSlashCommand("/skills update apply", ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(syncs).toBeGreaterThan(before);
  });
});

describe("/skills update result mapping (#344)", () => {
  test("an unreachable upstream names the reason, never 'up to date'", () => {
    expect(upstreamCheckMessage({ ok: false, reason: "http 404" })).toBe("skills update check failed (http 404)");
    expect(upstreamCheckMessage({ ok: false, reason: "malformed index" })).toBe("skills update check failed (malformed index)");
  });

  test("a checked empty channel is a genuine up-to-date", () => {
    expect(upstreamCheckMessage({ ok: true, updates: [] })).toBe("skills up to date");
  });
});

describe("/compact slash command (#466)", () => {
  test("forces compaction through the session producer and reports the marker", async () => {
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ack"], finish: "stop" }]),
      compaction: { summarizer: async () => "Task state: all green." },
    });
    for (let i = 0; i < 12; i++) await session.send(`turn ${i}`);
    const ctx = makeCtx({ session });
    expect(runSlashCommand("/compact", ctx)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const marker = [...session.history()].reverse().find((e) => e.type === "compaction");
    expect(marker).toBeDefined();
    expect(ctx.notices()).toHaveLength(0);
    await session.dispose();
  });

  test("without a session it explains instead", () => {
    const ctx = makeCtx();
    expect(runSlashCommand("/compact", ctx)).toBe(true);
    expect(ctx.notices()[0]).toContain("needs an open session");
  });

  test("is a base command: available with workflow mode off", () => {
    expect(activeCommands({ config: DEFAULT_USER_CONFIG }).map((c) => c.name)).toContain("compact");
  });
});
