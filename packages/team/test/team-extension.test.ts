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
    expect(live?.capabilities).toEqual(["spawn-subagent"]);
    await session.dispose();
  });
});
