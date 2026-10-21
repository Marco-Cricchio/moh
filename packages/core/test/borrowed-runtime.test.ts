/**
 * #784/#944 (ADR-0047): a session that owns no runtime but borrows its
 * parent's — the subagent child — judges through the parent's hooks, and
 * every piece of chrome a borrowed dispatch produces lands in the child's
 * log, never the parent's. Characterization for #1439: the four borrowed
 * seams not pinned elsewhere (tool result, model error, prompt-section
 * replacement, tool-call ask), each with a real `ExtensionRuntime`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension, type ExtensionSetupContext } from "@moh/extension";
import {
  ExtensionRuntime,
  MockProvider,
  createSession,
  type AgentEvent,
  type Provider,
  type Tool,
} from "../src/index";
import { withheldResultText } from "../src/extensions";
import { ProviderRegistry } from "../src/provider-registry";
import { ProviderError } from "../src/types";

function tmpDir(prefix = "moh-borrow-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function runtime(
  setup: (ctx: ExtensionSetupContext) => void,
  apiVersion = "1.10",
): Promise<ExtensionRuntime> {
  const rt = new ExtensionRuntime({ mohHome: tmpDir(), consent: () => true });
  await rt.register(defineExtension({ name: "probe", version: "1.0.0", apiVersion, setup }));
  return rt;
}

const echoTool: Tool = { name: "echo", description: "echoes", inputSchema: undefined, execute: (a: { text: string }) => a.text };
const echoTurn = () => [
  { deltas: [""], finish: "tool_calls" as const, toolCalls: [{ name: "echo", args: { text: "secret payload" } }] },
  { deltas: ["done"], finish: "stop" as const },
];
const stopTurn = () => [{ deltas: ["ok"], finish: "stop" as const }];

const records = (events: AgentEvent[], name: string) =>
  events.filter((e) => e.type === "extension_event" && e.name === name) as Extract<AgentEvent, { type: "extension_event" }>[];

describe("borrowed runtime (#944)", () => {
  test("a borrowed onToolResult withholds in the child, and its chrome is the child's", async () => {
    let ctxRef: ExtensionSetupContext | undefined;
    const rt = await runtime((ctx) => {
      ctxRef = ctx;
      ctx.onToolResult(["echo"], ({ output }) => {
        ctxRef!.appendEvent({ name: "inspected", payload: { len: output.length } });
        return { withhold: { reason: "looks hostile" } };
      });
    });
    const parent = createSession({ provider: MockProvider.scripted(stopTurn()), extensions: rt });
    const child = createSession({
      provider: MockProvider.scripted(echoTurn()),
      tools: { echo: echoTool },
      permissions: { mode: "auto-accept" },
      toolHooks: rt,
    });

    const result = await child.send("child turn");
    expect(result.status).toBe("done");
    const logged = child.history().find((e) => e.type === "tool_result") as Extract<AgentEvent, { type: "tool_result" }>;
    expect(logged.output).toBe(withheldResultText("probe", "looks hostile"));
    expect(logged.ok).toBe(false);
    expect(records(child.history(), "inspected")).toHaveLength(1);
    expect(records(parent.history(), "inspected")).toEqual([]);
    await parent.dispose();
    await child.dispose();
  });

  test("a borrowed onModelError sees the child's identity, and the switch is the child's", async () => {
    const seen: { owner: boolean; id: string }[] = [];
    let ctxRef: ExtensionSetupContext | undefined;
    const rt = await runtime((ctx) => {
      ctxRef = ctx;
      ctx.onModelError((c) => {
        if (c.session) seen.push({ owner: c.session.owner, id: c.session.id });
        ctxRef!.appendEvent({ name: "recovering", payload: { kind: c.errorKind } });
        return { model: "pb" };
      });
    });
    const served: string[] = [];
    const registry = new ProviderRegistry()
      .registerProvider("pa", (): Provider => {
        served.push("pa/m");
        return {
          name: "pa/m",
          capabilities: { caching: false, parallelToolCalls: false, multimodal: false },
          stream: async function* () {
            throw new ProviderError("invalid_request", "invalid_request boom");
          },
        };
      })
      .registerProvider("pb", (): Provider => {
        served.push("pb/m");
        return MockProvider.scripted(stopTurn());
      });
    const parent = createSession({ provider: MockProvider.scripted(stopTurn()), extensions: rt });
    const child = createSession({ provider: "pa", registry, toolHooks: rt });

    const result = await child.send("child turn");
    expect(result.status).toBe("done");
    expect(served).toEqual(["pa/m", "pb/m"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.owner).toBe(false);
    expect(child.history().some((e) => e.type === "model_switched")).toBe(true);
    expect(records(child.history(), "recovering").map((e) => e.payload)).toEqual([{ kind: "invalid_request" }]);
    expect(parent.history().some((e) => e.type === "model_switched")).toBe(false);
    expect(records(parent.history(), "recovering")).toEqual([]);
    await parent.dispose();
    await child.dispose();
  });

  test("a borrowed beforeModelCall replacement logs prompt_override in the child only", async () => {
    const rt = new ExtensionRuntime({ mohHome: tmpDir(), consent: () => true });
    const caps = ["replace-prompt-section:memory"];
    await rt.register(
      {
        name: "mem-ext",
        version: "1.2.0",
        apiVersion: "1.11",
        capabilities: caps,
        setup: (ctx: { beforeModelCall(h: () => unknown): void }) => {
          ctx.beforeModelCall(() => ({ sections: { memory: "borrowed text" } }));
        },
      },
      { bundled: true, manifest: { hash: "mem-ext", path: "mem-ext", capabilities: caps } },
    );
    const system: string[] = [];
    const capture: Provider = {
      name: "capture",
      async *stream(list: any[]) {
        system.push(list[0].parts[0].text);
        yield { type: "text_delta", text: "ok" } as never;
        yield { type: "finish", reason: "stop" } as never;
      },
    };
    const parent = createSession({ provider: MockProvider.scripted(stopTurn()), cwd: tmpDir(), extensions: rt });
    const child = createSession({ provider: capture, cwd: tmpDir(), toolHooks: rt });

    await child.send("child turn");
    expect(system[0]).toContain("borrowed text");
    const overrides = (s: typeof child) => s.history().filter((e) => e.type === "prompt_override");
    expect(overrides(child)).toHaveLength(1);
    expect(overrides(child)[0]).toMatchObject({ section: "memory", extension: "mem-ext", mode: "replaced" });
    expect(overrides(parent)).toEqual([]);
    await parent.dispose();
    await child.dispose();
  });

  test("a borrowed onToolCall ask still reaches the child's consent seam in auto-accept", async () => {
    let asked = 0;
    const rt = await runtime((ctx) => {
      ctx.onToolCall(() => ({ ask: true, reason: "guardrail" }));
    });
    const parent = createSession({ provider: MockProvider.scripted(stopTurn()), extensions: rt });
    const child = createSession({
      provider: MockProvider.scripted(echoTurn()),
      tools: { echo: echoTool },
      permissions: { mode: "normal" },
      toolHooks: rt,
      onPermissionRequest: () => {
        asked += 1;
        return "no";
      },
    });
    child.setSessionMode("auto-accept");

    await child.send("child turn");
    expect(asked).toBe(1);
    expect(child.history().some((e) => e.type === "permission_denied")).toBe(true);
    expect(parent.history().some((e) => e.type === "permission_denied" || e.type === "permission_granted")).toBe(false);
    await parent.dispose();
    await child.dispose();
  });
});
