/**
 * The team extension's skeleton (ADR-0074, #1220): manifest + manifest
 * authority, the consented registration, the enable question naming the
 * envelope, and one spawned child through the ADR-0055 API.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DevelopmentLaneStore,
  ExtensionRuntime,
  MockProvider,
  createSession,
  type AgentEvent,
  type ExtensionConsentRequest,
  type Tool,
} from "@moh/core";
import { readFileSync, writeFileSync } from "node:fs";
import { createTeamExtension, TEAM_NAME, TEAM_VERSION, teamManifestAuthority } from "../src/index";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "moh-team-"));
}

function runtime(consented: (request: ExtensionConsentRequest) => boolean = () => true): ExtensionRuntime {
  return new ExtensionRuntime({ mohHome: tempDir(), consent: consented });
}

const echoTool: Tool = {
  name: "echo",
  description: "echo",
  inputSchema: undefined,
  async execute(args: unknown) {
    return `echo:${JSON.stringify(args)}`;
  },
} as unknown as Tool;

function tap(session: { events: AsyncIterable<AgentEvent> }): AgentEvent[] {
  const events: AgentEvent[] = [];
  void (async () => {
    for await (const event of session.events) events.push(event);
  })();
  return events;
}

describe("team extension manifest (#1220, ADR-0074)", () => {
  test("the physical manifest declares exactly the spawn-subagent grant and its reasoning", () => {
    const raw = JSON.parse(readFileSync(teamManifestAuthority().path, "utf8"));
    expect(raw.name).toBe(TEAM_NAME);
    expect(raw.version).toBe(TEAM_VERSION);
    expect(raw.entry).toEqual(["src/index.ts"]);
    expect(raw.capabilities).toEqual(["spawn-subagent", "contribute-tool:team", "contribute-panels"]);
    // The enable question's NOT-do list lives in the manifest reasoning.
    expect(raw.reasoning).toContain("peer messaging");
    expect(raw.reasoning).toContain("spawn grandchildren");
  });

  test("the manifest authority hashes the bytes on disk with the declared capabilities", () => {
    const authority = teamManifestAuthority();
    expect(authority.capabilities).toEqual(["spawn-subagent", "contribute-tool:team", "contribute-panels"]);
    expect(authority.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(authority.reasoning).toContain("up to 10 concurrent children");
  });
});

describe("enable consent (#1220, ADR-0053/0055 style)", () => {
  test("the question names the envelope — capability sentence plus the reasoning — and a yes exposes the spawn API", async () => {
    const asked: ExtensionConsentRequest[] = [];
    const rt = runtime((request) => {
      asked.push(request);
      return true;
    });
    let ctx: import("@moh/extension").ExtensionSetupContext | null = null;
    const def = createTeamExtension();
    const manifest = teamManifestAuthority();
    await rt.register(
      {
        ...def,
        setup: (setupCtx: import("@moh/extension").ExtensionSetupContext) => {
          ctx = setupCtx;
          return def.setup(setupCtx);
        },
      },
      { manifest },
    );
    await rt.ready();

    expect(asked).toHaveLength(1);
    expect(asked[0]!.name).toBe(TEAM_NAME);
    expect(asked[0]!.capabilities).toEqual(["spawn-subagent", "contribute-tool:team", "contribute-panels"]);
    expect(asked[0]!.reasoning).toContain("peer messaging");
    expect(typeof ctx!.spawnSubagent).toBe("function");
    expect(typeof ctx!.subagentActivity).toBe("function");

    const instance = rt.instances.find((i) => i.def.name === TEAM_NAME);
    expect(instance).toBeDefined();
    expect(instance!.grantedCapabilities).toEqual(["spawn-subagent", "contribute-tool:team", "contribute-panels"]);
  });

  test("the enable is remembered; removing the stored consent removes the capability", async () => {
    const home = tempDir();
    const rt1 = new ExtensionRuntime({ mohHome: home, consent: () => true });
    expect(await rt1.register(createTeamExtension(), { manifest: teamManifestAuthority() })).toBe(true);
    await rt1.ready();
    expect(rt1.instances).toHaveLength(1);

    // The remembered answer: same home, nobody to ask — still enabled.
    const rt2 = new ExtensionRuntime({ mohHome: home });
    expect(await rt2.register(createTeamExtension(), { manifest: teamManifestAuthority() })).toBe(true);
    await rt2.ready();

    // Disable: the stored consent is gone, so the next load is refused and
    // the spawn capability is gone with it (headless = nobody to re-ask).
    const storeFile = join(home, "extensions.json");
    const store = JSON.parse(readFileSync(storeFile, "utf8")) as { consents: Record<string, true> };
    store.consents = {};
    writeFileSync(storeFile, JSON.stringify(store));
    const rt3 = new ExtensionRuntime({ mohHome: home });
    expect(await rt3.register(createTeamExtension(), { manifest: teamManifestAuthority() })).toBe(false);
    await rt3.ready();
    expect(rt3.instances).toHaveLength(0);
  });

  test("a declined consent leaves nothing loaded — the disabled extension contributes nothing", async () => {
    const rt = runtime(() => false);
    const ok = await rt.register(createTeamExtension());
    await rt.ready();
    expect(ok).toBe(false);
    expect(rt.instances).toHaveLength(0);
  });

  test("a second registration of the same extension is refused (taken)", async () => {
    const rt = runtime();
    expect(await rt.register(createTeamExtension())).toBe(true);
    expect(await rt.register(createTeamExtension())).toBe(false);
    expect(rt.consumeLoadEvents().find((e) => e.type === "extension_failed")).toMatchObject({
      name: TEAM_NAME,
      reason: "taken",
    });
  });

  test("code capabilities beyond the manifest refuse loudly (ADR-0061 subset rule)", async () => {
    const rt = runtime();
    const rogue = { ...createTeamExtension(), capabilities: ["spawn-subagent", "observe"] };
    const ok = await rt.register(rogue, { manifest: { ...teamManifestAuthority() } });
    await rt.ready();
    expect(ok).toBe(false);
    expect(rt.instances).toHaveLength(0);
  });
});

describe("one-member team end to end (#1221, ADR-0055)", () => {
  function teamSession(
    rt: ExtensionRuntime,
    posture: { mode: "yolo" | "normal"; answer?: "yes" | "no" } = { mode: "yolo" },
  ) {
    return createSession({
      provider: MockProvider.scripted([
        {
          deltas: ["handing it to the team"],
          finish: "tool_calls",
          toolCalls: [{ name: "team", args: { task: "fix the flaky width test" } }],
        },
        { deltas: ["the team reports: "], finish: "stop" },
      ]),
      extensions: rt,
      subagents: {
        home: tempDir(),
        provider: MockProvider.scripted([
          { deltas: ["child answer"], finish: "stop", usage: { inputTokens: 3, outputTokens: 1 } },
        ]),
      },
      // ADR-0074: native spawn defaults "ask" — yolo/auto-accept lifts it,
      // normal mode asks (the consent posture the enable does not remove).
      ...(posture.mode === "yolo"
        ? { permissions: { unrestrictedTools: true } }
        : { onPermissionRequest: () => posture.answer ?? "yes" }),
    });
  }

  async function runTeamSession(
    posture: { enabled?: boolean; mode?: "yolo" | "normal"; answer?: "yes" | "no" } = {},
  ) {
    const { enabled = true, mode = "yolo", answer } = posture;
    const rt = runtime(() => enabled);
    if (enabled) await rt.register(createTeamExtension(), { manifest: teamManifestAuthority() });
    const session = teamSession(rt, { mode, answer });
    const events = tap(session);
    const turn = await session.send("work on the flaky width test with the team");
    await session.dispose();
    return { events, turn };
  }

  test("an English ask drives the model through the team tool and one builder child, end to end", async () => {
    const { events, turn } = await runTeamSession();

    const contributed = events.find((e) => e.type === "tool_contributed") as { tool?: string } | undefined;
    expect(contributed?.tool).toBe("team");

    // One spawned child, working on the task.
    const spawn = events.find((e) => e.type === "subagent_spawn") as Extract<AgentEvent, { type: "subagent_spawn" }> | undefined;
    expect(spawn?.name).toBe("builder");
    expect(spawn?.requester).toEqual({ kind: "extension", extension: TEAM_NAME });
    // The envelope limits ride the record: applied tool list (none named),
    // effective permission mode, resolved iteration cap.
    expect(spawn?.limits.mode).toBeDefined();
    expect(spawn?.limits.maxIterations).toBeGreaterThan(0);

    const result = events.find((e) => e.type === "subagent_result") as Extract<AgentEvent, { type: "subagent_result" }> | undefined;
    expect(result?.status).toBe("done");

    // The child's outcome flowed back into the parent's turn.
    expect(turn.status).toBe("done");
    const toolResult = events.find((e) => e.type === "tool_result") as { output?: string } | undefined;
    expect(toolResult?.output).toContain("child answer");
  });

  test("the extension reads the child's activity (child-tail shape, no provider reasoning) and records the outcome", async () => {
    const { events } = await runTeamSession();

    const done = events.find((e) => e.type === "extension_event" && (e as { name?: string }).name === "team_member_done") as
      | { payload: { callId: string; member: string; status: string; activity?: { currentTool: string | null; lastActivityAt: number | null } } }
      | undefined;
    expect(done).toBeDefined();
    expect(done!.payload.member).toBe("builder");
    expect(done!.payload.status).toBe("done");
    // The child-tail shape: tool in flight + monotonic timestamp — never
    // the provider reasoning.
    if (done!.payload.activity) {
      expect(Object.keys(done!.payload.activity).every((k) => ["currentTool", "lastActivityAt"].includes(k))).toBe(true);
    }
  });

  test("a live session drives the roster: the member settles to done in the panel", async () => {
    const rt = runtime();
    await rt.register(createTeamExtension(), { manifest: teamManifestAuthority() });
    await rt.ready();
    const panel = rt.panels()[0]!;
    expect(String(panel.render())).toContain("no members yet");

    const session = teamSession(rt, { mode: "yolo" });
    const events = tap(session);
    await session.send("work on the flaky width test with the team");
    await session.dispose();

    const frame = String(panel.render());
    expect(frame).toContain("team: 1 member");
    expect(frame).toContain("✓ builder");
    // The detail view opens on the client's forwarded return key.
    expect(panel.onKey!("\r", { input: "\r", return: true })).toBe(true);
    const detail = String(panel.render());
    expect(detail).toContain("builder · builder");
    expect(detail).not.toContain("reasoning");
  });

  test("normal mode: the team call asks first (the ADR-0055 consent posture) and a yes drives the same loop", async () => {
    const { events, turn } = await runTeamSession({ mode: "normal", answer: "yes" });

    const asked = events.find((e) => e.type === "permission_requested") as { tool?: string } | undefined;
    expect(asked?.tool).toBe("team");
    expect(events.find((e) => e.type === "permission_granted")).toBeDefined();
    expect(events.find((e) => e.type === "subagent_spawn")).toBeDefined();
    expect(turn.status).toBe("done");
  });

  test("normal mode: a no denies the team call and nothing spawns", async () => {
    const { events } = await runTeamSession({ mode: "normal", answer: "no" });

    expect(events.find((e) => e.type === "permission_requested")).toBeDefined();
    expect(events.find((e) => e.type === "permission_denied")).toBeDefined();
    expect(events.find((e) => e.type === "subagent_spawn")).toBeUndefined();
  });

  test("a declined consent contributes no team tool — the ask falls through to a normal turn", async () => {
    const { events, turn } = await runTeamSession({ enabled: false });
    expect(events.find((e) => e.type === "tool_contributed")).toBeUndefined();
    expect(events.find((e) => e.type === "subagent_spawn")).toBeUndefined();
    expect(turn.status).toBe("done");
  });

  test("a malformed team call is refused without spawning", async () => {
    const rt = runtime();
    await rt.register(createTeamExtension(), { manifest: teamManifestAuthority() });
    const session = createSession({
      provider: MockProvider.scripted([
        {
          deltas: ["calling the team"],
          finish: "tool_calls",
          toolCalls: [{ name: "team", args: { other: true } }],
        },
        { deltas: ["ok"], finish: "stop" },
      ]),
      extensions: rt,
      subagents: { home: tempDir(), provider: MockProvider.scripted([{ deltas: ["should not run"], finish: "stop" }]) },
      permissions: { unrestrictedTools: true },
    });
    const events = tap(session);
    await session.send("do it with the team");
    await session.dispose();
    expect(events.find((e) => e.type === "subagent_spawn")).toBeUndefined();
    const toolResult = events.find((e) => e.type === "tool_result") as { output?: string } | undefined;
    expect(toolResult?.output).toContain("pass `task`");
  });
});

describe("spawn through the ADR-0055 API (#1220)", () => {
  test("an enabled team extension spawns a trivial child end-to-end", async () => {
    const rt = runtime();
    let spawn: NonNullable<import("@moh/extension").ExtensionSetupContext["spawnSubagent"]> | null = null;
    const def = createTeamExtension();
    await rt.register({
      ...def,
      setup: (ctx: import("@moh/extension").ExtensionSetupContext) => {
        spawn = ctx.spawnSubagent!;
        return def.setup(ctx);
      },
    });
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      tools: { echo: echoTool },
      extensions: rt,
      subagents: {
        home: tempDir(),
        provider: MockProvider.scripted([{ deltas: ["child answer"], finish: "stop", usage: { inputTokens: 3, outputTokens: 1 } }]),
      },
    });
    const events = tap(session);
    const result = await spawn!({ task: "echo something" });
    expect(result.status).toBe("done");
    expect(result.output).toBe("child answer");

    const spawned = events.find((e) => e.type === "subagent_spawn") as
      | Extract<AgentEvent, { type: "subagent_spawn" }>
      | undefined;
    expect(spawned?.requester).toEqual({ kind: "extension", extension: TEAM_NAME });

    // /extensions (#1131): the live surface names the extension with its
    // grant list — the modal and the headless notify fallback read this.
    const live = session.extensionLiveInfo().find((i) => i.name === TEAM_NAME);
    expect(live?.capabilities).toEqual(["spawn-subagent", "contribute-tool:team", "contribute-panels"]);
    await session.dispose();
  });
});

describe("steering: write-into-child (#1222, ADR-0055)", () => {
  function steeringRt() {
    const rt = runtime(() => true);
    return rt.register(createTeamExtension(), { manifest: teamManifestAuthority() }).then(() => rt);
  }

  function steeringSession(rt: ExtensionRuntime) {
    return createSession({
      provider: MockProvider.scripted([
        {
          deltas: ["handing it to the team"],
          finish: "tool_calls",
          toolCalls: [{ name: "team", args: { task: "rename the export" } }],
        },
        {
          deltas: ["relaying the correction"],
          finish: "tool_calls",
          toolCalls: [{ name: "team", args: { member: "builder", message: "rename it differently" } }],
        },
        { deltas: ["the member took the correction"], finish: "stop" },
      ]),
      extensions: rt,
      subagents: {
        home: tempDir(),
        provider: MockProvider.scripted([
          { deltas: ["first answer"], finish: "stop" },
          { deltas: ["corrected answer"], finish: "stop" },
        ]),
      },
      permissions: { unrestrictedTools: true },
    });
  }

  test("the lead relays a correction; the member's next turn keeps its context and the outcome flows back", async () => {
    const rt = await steeringRt();
    const session = steeringSession(rt);
    const events = tap(session);
    const turn = await session.send("rename the export with the team — actually, rename it differently");
    await session.dispose();

    expect(turn.status).toBe("done");
    // The steering write is chrome in the parent's log.
    const steer = events.find((e) => e.type === "subagent_steer") as Extract<AgentEvent, { type: "subagent_steer" }> | undefined;
    expect(steer?.extension).toBe(TEAM_NAME);
    // Ids and counts only — the words live in the child log (and in the
    // team tool_call args the parent already holds).
    expect(steer?.messageChars).toBe("rename it differently".length);
    expect(steer?.callId).toBe((events.find((e) => e.type === "subagent_spawn") as Extract<AgentEvent, { type: "subagent_spawn" }>)?.callId);
    // The tool result of the steering call carries the post-steering outcome.
    const results = events.filter((e) => e.type === "tool_result") as { output?: string }[];
    expect(results[1]?.output).toContain("corrected answer");
    // The extension's own record of what it read.
    const memberSteer = events.find((e) => e.type === "extension_event" && (e as { name?: string }).name === "team_member_steer") as
      | { extension?: string; payload?: { member?: string; status?: string; activity?: unknown } }
      | undefined;
    expect(memberSteer?.extension).toBe(TEAM_NAME);
    expect(memberSteer?.payload?.member).toBe("builder");
    expect(memberSteer?.payload?.status).toBe("done");
    // The child-tail activity the extension read after the steered turn.
    expect(memberSteer?.payload?.activity).not.toBeNull();
  });

  test("steering an unknown member is refused didactically — the member set is the lead's, not the model's", async () => {
    const rt = await steeringRt();
    const session = createSession({
      provider: MockProvider.scripted([
        {
          deltas: ["who?"],
          finish: "tool_calls",
          toolCalls: [{ name: "team", args: { member: "ghost", message: "hello" } }],
        },
        { deltas: ["refused"], finish: "stop" },
      ]),
      extensions: rt,
      subagents: { home: tempDir(), provider: MockProvider.scripted([{ deltas: ["c"], finish: "stop" }]) },
      permissions: { unrestrictedTools: true },
    });
    const events = tap(session);
    await session.send("tell ghost hello");
    await session.dispose();
    const result = events.find((e) => e.type === "tool_result") as { output?: string } | undefined;
    expect(result?.output).toContain("no member \"ghost\"");
    expect(result?.output).toContain("no members yet");
    expect(events.some((e) => e.type === "subagent_steer")).toBe(false);
  });

  test("star-shaped: the member never receives the team tool — it cannot address another member", async () => {
    const rt = await steeringRt();
    const childToolNames: string[][] = [];
    const childProvider: import("@moh/core").Provider = {
      name: "mock",
      async *stream(_messages: unknown, _signal: unknown, tools?: readonly { name: string }[]) {
        childToolNames.push((tools ?? []).map((t) => t.name));
        yield { type: "model_call_start", model: "mock" };
        yield { type: "text_delta", text: "c" };
        yield { type: "finish", reason: "stop" };
      },
    } as unknown as import("@moh/core").Provider;
    const session = createSession({
      provider: MockProvider.scripted([
        { deltas: ["spawn"], finish: "tool_calls", toolCalls: [{ name: "team", args: { task: "t" } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      tools: { echo: echoTool },
      extensions: rt,
      subagents: { home: tempDir(), provider: childProvider },
      permissions: { unrestrictedTools: true },
    });
    const events = tap(session);
    await session.send("work with the team");
    await session.dispose();
    expect(childToolNames.length).toBeGreaterThan(0);
    for (const names of childToolNames) {
      expect(names).toContain("echo");
      expect(names).not.toContain("team");
    }
    void events;
  });
});

describe("composition by complexity — scoped roles + lanes (#1224, ADR-0074)", () => {
  function composeSession(
    teamArgs: Record<string, unknown>,
    opts: { childTurns?: number; followUp?: { name: string; args: Record<string, unknown> } } = {},
  ) {
    const childTurns = opts.childTurns ?? 3;
    const providerScript: { deltas: string[]; finish: "stop" | "tool_calls"; toolCalls?: { name: string; args: Record<string, unknown> }[] }[] = [
      {
        deltas: ["composing the team"],
        finish: "tool_calls",
        toolCalls: [{ name: "team", args: teamArgs }],
      },
      ...(opts.followUp
        ? [
            {
              deltas: ["adjusting"],
              finish: "tool_calls" as const,
              toolCalls: [{ name: "team", args: opts.followUp.args }],
            },
          ]
        : []),
      { deltas: ["the team reports"], finish: "stop" as const },
    ];
    const rt = runtime();
    void rt.register(createTeamExtension(), { manifest: teamManifestAuthority() });
    const session = createSession({
      provider: MockProvider.scripted(providerScript),
      extensions: rt,
      subagents: {
        home: tempDir(),
        provider: MockProvider.scripted(
          Array.from({ length: childTurns }, () => ({ deltas: ["member work done"], finish: "stop" as const, usage: { inputTokens: 3, outputTokens: 1 } })),
        ),
      },
      permissions: { unrestrictedTools: true },
    });
    const events = tap(session);
    return { session, events };
  }

  test("a complex ask composes scoped builders and a read-only reviewer; the decision is recorded", async () => {
    const { events, session } = composeSession({
      brief: "Ship the settings page",
      compose: [
        { role: "builder", name: "ui", scope: "src/client/**", task: "build the settings UI" },
        { role: "builder", name: "api", scope: "src/api/**", task: "expose the settings endpoint" },
        { role: "reviewer", task: "review the settings change end to end" },
      ],
    });
    await session.send("ship the settings page with the team");
    await session.dispose();

    const composed = events.find((e) => e.type === "extension_event" && (e as { name?: string }).name === "team_composed") as
      | { payload: { members: { name: string; role: string; scope?: string }[]; dispatched: number } }
      | undefined;
    expect(composed).toBeDefined();
    expect(composed!.payload.members.map((m) => m.name)).toEqual(["ui", "api", "reviewer-1"]);
    expect(composed!.payload.dispatched).toBe(3);

    const spawns = events.filter((e) => e.type === "subagent_spawn") as Extract<AgentEvent, { type: "subagent_spawn" }>[];
    expect(spawns).toHaveLength(3);
    const byName = new Map(spawns.map((s) => [s.name, s]));
    // Builders are scoped to disjoint paths; the reviewer is read-only by scope.
    expect(byName.get("ui")!.limits.pathScopes).toEqual(["src/client/**"]);
    expect(byName.get("api")!.limits.pathScopes).toEqual(["src/api/**"]);
    expect(byName.get("reviewer-1")!.limits.pathScopes).toEqual([]);
    // Every member's outcome lands in the log.
    const dones = events.filter((e) => e.type === "extension_event" && (e as { name?: string }).name === "team_member_done");
    expect(dones).toHaveLength(3);
  });

  test("overlapping builder scopes are refused loudly; no child is created", async () => {
    const { events, session } = composeSession({
      compose: [
        { role: "builder", scope: "src/**", task: "a" },
        { role: "builder", scope: "src/**", task: "b" },
      ],
    });
    await session.send("split the work");
    await session.dispose();
    expect(events.find((e) => e.type === "subagent_spawn")).toBeUndefined();
    const toolResult = events.find((e) => e.type === "tool_result") as { output?: string } | undefined;
    expect(toolResult?.output).toContain("overlapping builder scopes");
  });

  test("a reviewer with a scope is refused — read-only is the role itself", async () => {
    const { events, session } = composeSession({
      compose: [{ role: "reviewer", scope: "src/**", task: "review" }],
    });
    await session.send("review with the team");
    await session.dispose();
    expect(events.find((e) => e.type === "subagent_spawn")).toBeUndefined();
    const toolResult = events.find((e) => e.type === "tool_result") as { output?: string } | undefined;
    expect(toolResult?.output).toContain("carries no scope or lane");
  });

  test("a simple ask composes one unscoped builder — the hybrid's single member", async () => {
    const { events, session } = composeSession({
      compose: [{ role: "builder", task: "fix the typo" }],
    }, { childTurns: 1 });
    await session.send("small fix with the team");
    await session.dispose();
    const spawns = events.filter((e) => e.type === "subagent_spawn") as Extract<AgentEvent, { type: "subagent_spawn" }>[];
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.name).toBe("builder-1");
    // No scope named: the child keeps the plain spawn posture (the hybrid).
    expect(spawns[0]!.limits.pathScopes).toBeUndefined();
  });

  test("the composed roster drives the bag: lanes ride the member's spawn, blockedBy order holds", async () => {
    const projectDir = tempDir();
    const childHome = tempDir();
    const store = new DevelopmentLaneStore({ cwd: projectDir, home: childHome });
    const group = store.createFeatureGroup({ name: "team-lanes-it", targetRef: "develop" });
    store.createLane({
      featureGroupId: group.id,
      sessionId: "session-lane",
      worktreePath: join(projectDir, "wt-a"),
      branchRef: "feat/team-ext-4-scratch-a",
      baseRef: "develop",
      baseRevision: "abc",
      targetRef: "develop",
      relation: "independent",
    });

    const rt = runtime();
    void rt.register(createTeamExtension(), { manifest: teamManifestAuthority() });
    const session = createSession({
      cwd: projectDir,
      provider: MockProvider.scripted([
        {
          deltas: ["planning"],
          finish: "tool_calls",
          toolCalls: [{ name: "team", args: { plan: [{ title: "first" }, { title: "second", blockedBy: ["t1"] }] } }],
        },
        {
          deltas: ["composing"],
          finish: "tool_calls",
          toolCalls: [{ name: "team", args: { compose: [{ role: "builder", name: "lane-a", lane: "feat/team-ext-4-scratch-a" }], work: "work the bag" } }],
        },
        { deltas: ["done"], finish: "stop" },
      ]),
      extensions: rt,
      subagents: {
        home: childHome,
        lanes: { cwd: projectDir },
        provider: MockProvider.scripted([
          { deltas: ["member work done"], finish: "stop" },
          { deltas: ["member work done"], finish: "stop" },
        ]),
      },
      permissions: { unrestrictedTools: true },
    });
    const events = tap(session);
    await session.send("split the plan across the team");
    await session.dispose();

    const claimed = events
      .filter((e) => e.type === "extension_event" && (e as { name?: string }).name === "team_task_claimed")
      .map((e) => (e as { payload: { id: string; member: string } }).payload);
    // Blocked-by order: t2 is claimed only after t1 completes; the lane
    // builder owns both claims.
    expect(claimed).toEqual([
      { id: "t1", member: "lane-a" },
      { id: "t2", member: "lane-a" },
    ]);
    // One spawn, one steer: the second task rides the member's live session.
    expect(events.filter((e) => e.type === "subagent_spawn")).toHaveLength(1);
    expect(events.find((e) => e.type === "subagent_steer")).toBeDefined();
    // The lane bound on the member's first prompt: the child runs in the
    // lane's worktree and the binding is recorded.
    const spawn = events.find((e) => e.type === "subagent_spawn") as Extract<AgentEvent, { type: "subagent_spawn" }> | undefined;
    const childLog = readFileSync(spawn!.log, "utf8");
    expect(childLog).toContain("lane: feat/team-ext-4-scratch-a");
    expect(events.find((e) => e.type === "lane_created")).toBeDefined();
  });

  test("a pinned lane that does not exist degrades visibly: the member works un-laned, the skip is recorded (#1224 follow-up)", async () => {
    // Lanes support is on (so the core judges the lane line) but no lane
    // matches: this is the friction case the follow-up removes.
    const rt = runtime();
    void rt.register(createTeamExtension(), { manifest: teamManifestAuthority() });
    const projectDir = tempDir();
    const session = createSession({
      cwd: projectDir,
      provider: MockProvider.scripted([
        { deltas: ["composing"], finish: "tool_calls", toolCalls: [{ name: "team", args: { compose: [{ role: "builder", name: "wisher", lane: "feat/never-created", task: "build the thing" }] } }] },
        { deltas: ["done"], finish: "stop" },
      ]),
      extensions: rt,
      subagents: {
        home: tempDir(),
        lanes: { cwd: projectDir },
        provider: MockProvider.scripted([
          { deltas: ["member work done"], finish: "stop" },
          { deltas: ["member work done"], finish: "stop" },
        ]),
      },
      permissions: { unrestrictedTools: true },
    });
    const events = tap(session);
    await session.send("run it with the team");
    await session.dispose();

    // The skip is chrome in the log, reconstructable on replay.
    const skipped = events.find((e) => e.type === "extension_event" && (e as { name?: string }).name === "team_lane_skipped") as
      | { payload: { member: string; lane: string } }
      | undefined;
    expect(skipped).toBeDefined();
    expect(skipped!.payload).toEqual({ member: "wisher", lane: "feat/never-created" });
    // One un-laned spawn: the refused probe never created a child, so the
    // retry is the only subagent_spawn in the log.
    const spawns = events.filter((e) => e.type === "subagent_spawn") as Extract<AgentEvent, { type: "subagent_spawn" }>[];
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.name).toBe("wisher");
    expect(spawns[0]!.limits.pathScopes).toBeUndefined();
    // The tool result tells the model, so the model can tell the user —
    // the degradation is never silent, and never a hard error. Both
    // doors are named: the agent's (bash, consented per the session
    // mode) and the human's (/lanes).
    const toolResult = events.filter((e) => e.type === "tool_result").map((e) => String((e as { output?: string }).output)).join("\n");
    expect(toolResult).toContain("works without its lane");
    expect(toolResult).toContain("moh lanes start");
    expect(toolResult).toContain("/lanes");
    expect(toolResult).toContain("member work done");
  });
});
