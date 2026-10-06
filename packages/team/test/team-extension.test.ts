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
import { createTeamExtension, TEAM_ENVELOPE, TEAM_NAME, TEAM_VERSION, teamManifestAuthority } from "../src/index";

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
    const raw = JSON.parse(require("node:fs").readFileSync(teamManifestAuthority().path, "utf8"));
    expect(raw.name).toBe(TEAM_NAME);
    expect(raw.version).toBe(TEAM_VERSION);
    expect(raw.entry).toEqual(["src/index.ts"]);
    expect(raw.capabilities).toEqual(["spawn-subagent"]);
    // The enable question's NOT-do list lives in the manifest reasoning.
    expect(raw.reasoning).toContain("peer messaging");
    expect(raw.reasoning).toContain("spawn grandchildren");
  });

  test("the manifest authority hashes the bytes on disk with the declared capabilities", () => {
    const authority = teamManifestAuthority();
    expect(authority.capabilities).toEqual(["spawn-subagent"]);
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
    expect(asked[0]!.capabilities).toEqual(["spawn-subagent"]);
    expect(asked[0]!.reasoning).toContain("peer messaging");
    expect(typeof ctx!.spawnSubagent).toBe("function");
    expect(typeof ctx!.subagentActivity).toBe("function");

    const instance = rt.instances.find((i) => i.def.name === TEAM_NAME);
    expect(instance).toBeDefined();
    expect(instance!.grantedCapabilities).toEqual(["spawn-subagent"]);
  });

  test("the envelope statement is the ticket's own words", () => {
    expect(TEAM_ENVELOPE).toContain("up to 10 concurrent child sessions");
    expect(TEAM_ENVELOPE).toContain("path scopes");
    expect(TEAM_ENVELOPE).toContain("stop");
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
    await session.dispose();
  });
});
