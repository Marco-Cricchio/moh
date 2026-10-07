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
    expect(raw.capabilities).toEqual(["spawn-subagent", "contribute-tool:team"]);
    // The enable question's NOT-do list lives in the manifest reasoning.
    expect(raw.reasoning).toContain("peer messaging");
    expect(raw.reasoning).toContain("spawn grandchildren");
  });

  test("the manifest authority hashes the bytes on disk with the declared capabilities", () => {
    const authority = teamManifestAuthority();
    expect(authority.capabilities).toEqual(["spawn-subagent", "contribute-tool:team"]);
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
    expect(asked[0]!.capabilities).toEqual(["spawn-subagent", "contribute-tool:team"]);
    expect(asked[0]!.reasoning).toContain("peer messaging");
    expect(typeof ctx!.spawnSubagent).toBe("function");
    expect(typeof ctx!.subagentActivity).toBe("function");

    const instance = rt.instances.find((i) => i.def.name === TEAM_NAME);
    expect(instance).toBeDefined();
    expect(instance!.grantedCapabilities).toEqual(["spawn-subagent", "contribute-tool:team"]);
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
    expect(live?.capabilities).toEqual(["spawn-subagent", "contribute-tool:team"]);
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
    expect(steer?.message).toBe("rename it differently");
    expect(steer?.callId).toBe((events.find((e) => e.type === "subagent_spawn") as Extract<AgentEvent, { type: "subagent_spawn" }>)?.callId);
    // The tool result of the steering call carries the post-steering outcome.
    const results = events.filter((e) => e.type === "tool_result") as { output?: string }[];
    expect(results[1]?.output).toContain("corrected answer");
    // The extension's own record of what it read.
    const memberSteer = events.find((e) => e.type === "extension_event" && (e as { name?: string }).name === "team_member_steer") as
      | { extension?: string; payload?: { member?: string; status?: string } }
      | undefined;
    expect(memberSteer?.extension).toBe(TEAM_NAME);
    expect(memberSteer?.payload?.member).toBe("builder");
    expect(memberSteer?.payload?.status).toBe("done");
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
