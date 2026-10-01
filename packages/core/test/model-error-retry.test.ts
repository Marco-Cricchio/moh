/**
 * ADR-0059 / #1109: the retry-on-model-error seam. A provider call that
 * fails with an error the Route does not already handle consults the
 * extensions' `onModelError` hooks; a proposed alternative ref applies
 * exactly like the manual switch and the call is retried on it within
 * the same turn. No answer (or no runtime) keeps the historical
 * behavior: the turn ends with the error, byte-identical.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension, type ExtensionSetupContext } from "@moh/extension";
import { ExtensionRuntime, MockProvider, createSession, type AgentEvent, type Provider } from "../src/index";
import { ProviderRegistry } from "../src/provider-registry";
import { ProviderError } from "../src/types";

function tmpDir(prefix = "moh-mer-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function ok(text = "recovered"): Provider {
  return {
    name: "pb/m",
    capabilities: { caching: false, parallelToolCalls: false, multimodal: false },
    stream: async function* () {
      yield { type: "text_delta", text } as never;
      yield { type: "finish", reason: "stop" } as never;
    },
  };
}

function failing(kind: "invalid_request" | "quota_exhausted" | "network", name = "pa/m"): Provider {
  return {
    name,
    capabilities: { caching: false, parallelToolCalls: false, multimodal: false },
    stream: async function* () {
      throw new ProviderError(kind, `${kind} boom`);
    },
  };
}

function registry(served: string[]): ProviderRegistry {
  return new ProviderRegistry()
    .registerProvider("pa", () => {
      served.push("pa/m");
      return failing("invalid_request");
    })
    .registerProvider("pb", () => {
      served.push("pb/m");
      return ok();
    });
}

async function runtime(
  setup: (ctx: ExtensionSetupContext) => void,
  home = tmpDir(),
): Promise<ExtensionRuntime> {
  const rt = new ExtensionRuntime({ mohHome: home, consent: () => true });
  await rt.register(defineExtension({ name: "probe", version: "1.0.0", apiVersion: "1.10", setup }));
  return rt;
}

describe("onModelError (ADR-0059)", () => {
  test("a proposed alternative keeps the turn alive and serves it", async () => {
    const served: string[] = [];
    const seen: { model: string; errorKind: string }[] = [];
    const rt = await runtime((ctx) =>
      ctx.onModelError((c) => {
        seen.push({ model: c.model, errorKind: c.errorKind });
        return { model: "pb" };
      }),
    );
    const session = createSession({ provider: "pa", registry: registry(served), extensions: rt });

    const result = await session.send("recover");

    expect(result.status).toBe("done");
    // The hook saw the failing serving ref and the normalized kind.
    expect(seen).toEqual([{ model: "pa/m", errorKind: "invalid_request" }]);
    expect(served).toEqual(["pa/m", "pb/m"]);
    const types = session.history().map((e) => e.type);
    expect(types).toContain("model_switched");
    // The retry happened in the same turn: exactly one done.
    expect(types.filter((t) => t === "done").length).toBe(1);
    // The failure is still recorded, plus the switch chrome.
    expect(session.history().some((e) => e.type === "model_switched")).toBe(true);
  });

  test("no answering hook (or no runtime) ends the turn with the error, as today", async () => {
    const served: string[] = [];
    const calls: string[] = [];
    const silent = await runtime((ctx) => ctx.onModelError(() => {
      calls.push("silent");
    }));
    const s1 = createSession({ provider: "pa", registry: registry(served), extensions: silent });
    const r1 = await s1.send("die");
    expect(r1.status).toBe("error");
    expect(served).toEqual(["pa/m"]);
    expect(calls).toEqual(["silent"]);
    const types1 = s1.history().map((e) => e.type);
    expect(types1).not.toContain("model_switched");
    expect((s1.history().at(-1) as Extract<AgentEvent, { type: "error" }>).reason).toBe("invalid_request");

    const noRt = createSession({ provider: "pa", registry: registry(served) });
    const r2 = await noRt.send("die");
    expect(r2.status).toBe("error");
    expect(served).toEqual(["pa/m", "pa/m"]);
  });

  test("Route-handled kinds never reach the seam", async () => {
    const served: string[] = [];
    let consulted = 0;
    const rt = await runtime((ctx) =>
      ctx.onModelError(() => {
        consulted += 1;
        return { model: "pb" };
      }),
    );
    const reg = new ProviderRegistry().registerProvider("pa", () => {
      served.push("pa/m");
      return failing("quota_exhausted", "pa/m");
    });
    const session = createSession({ provider: "pa", registry: reg, extensions: rt });
    const result = await session.send("blocked");
    expect(result.status).toBe("error");
    expect(consulted).toBe(0);
    expect(session.history().some((e) => e.type === "model_switched")).toBe(false);
  });

  test("a proposal that fails the fit guard records switch_refused and does not retry on that ref", async () => {
    const rt0 = new ExtensionRuntime({ mohHome: tmpDir(), consent: () => true });
    const reg = await rt0.register(defineExtension({
      name: "probe",
      version: "1.0.0",
      apiVersion: "1.10",
      setup: (ctx) => ctx.onModelError(() => ({ model: "openrouter/mistralai/mistral-nemo" })),
    }));
    // Turn 1 measures a context far above mistral-nemo's window; turn 2
    // fails. The session's fit guard must refuse the proposal exactly as
    // it refuses /model.
    const bigThenFail = MockProvider.scripted([
      { deltas: ["measured"], finish: "stop", usage: { inputTokens: 234_666, outputTokens: 1 } },
      { deltas: [], finish: "stop", error: { kind: "invalid_request", message: "invalid_request boom" } },
    ]);
    const session = createSession({
      provider: bigThenFail,
      endpoints: [{ name: "openrouter", type: "openrouter", defaultModel: "mistralai/mistral-nemo" }],
      extensions: rt0,
    });
    await session.send("measure");
    const result = await session.send("fit-refused");
    expect(result.status).toBe("error");
    const refused = session.history().filter((e) => e.type === "switch_refused");
    expect(refused.length).toBe(1);
    expect(session.history().some((e) => e.type === "model_switched")).toBe(false);
  });

  test("an unresolvable proposed ref is a visible extension_failed and the turn ends", async () => {
    const served: string[] = [];
    const rt = await runtime((ctx) => ctx.onModelError(() => ({ model: "nope/ghost" })));
    const session = createSession({ provider: "pa", registry: registry(served), extensions: rt });
    const result = await session.send("ghost");
    expect(result.status).toBe("error");
    const failed = session.history().find((e) => e.type === "extension_failed") as Extract<
      AgentEvent,
      { type: "extension_failed" }
    >;
    expect(failed.reason).toBe("invalid_model");
    expect(session.history().some((e) => e.type === "model_switched")).toBe(false);
  });

  test("a hook that throws is fail-open: the turn ends with the original error", async () => {
    const served: string[] = [];
    const rt = await runtime((ctx) =>
      ctx.onModelError(() => {
        throw new Error("hook blew up");
      }),
    );
    const session = createSession({ provider: "pa", registry: registry(served), extensions: rt });
    const result = await session.send("throwing");
    expect(result.status).toBe("error");
    const failed = session.history().find((e) => e.type === "extension_failed") as Extract<
      AgentEvent,
      { type: "extension_failed" }
    >;
    expect(failed.reason).toBe("hook");
    expect(session.history().some((e) => e.type === "model_switched")).toBe(false);
  });

  test("a proposal that resolves to the serving provider is a refused no-op (#1111)", async () => {
    const served: string[] = [];
    let consulted = 0;
    // "pa" resolves to the provider that is already serving ("pa/m"): a
    // different literal ref, the same endpoint. Applying it is a silent
    // no-op switch — so the proposal must count as refused: no retry, no
    // chrome, and no consultation budget spent on it.
    const rt = await runtime((ctx) =>
      ctx.onModelError(() => {
        consulted += 1;
        return { model: "pa" };
      }),
    );
    const session = createSession({ provider: "pa", registry: registry(served), extensions: rt });
    const result = await session.send("noop");
    expect(result.status).toBe("error");
    // The second "pa/m" is the provider instance the no-op switch
    // constructs before discovering nothing moves — no retry serves it.
    expect(served).toEqual(["pa/m", "pa/m"]);
    expect(session.history().some((e) => e.type === "model_switched")).toBe(false);
    expect((session.history().at(-1) as Extract<AgentEvent, { type: "error" }>).reason).toBe("invalid_request");

    // A later turn on the same session gets a full budget: the no-op did
    // not spend it. The hook now proposes a real alternative, and the turn
    // recovers exactly as a fresh proposal would.
    const served2: string[] = [];
    let consults2 = 0;
    const rt2 = await runtime((ctx) =>
      ctx.onModelError(() => {
        consults2 += 1;
        return { model: consults2 === 1 ? "pa" : "pb" };
      }),
    );
    const session2 = createSession({ provider: "pa", registry: registry(served2), extensions: rt2 });
    const r1 = await session2.send("noop-then-real");
    expect(r1.status).toBe("error");
    const r2 = await session2.send("real-now");
    expect(r2.status).toBe("done");
    expect(served2).toEqual(["pa/m", "pa/m", "pb/m"]);
    expect(consults2).toBe(2);
  });

  test("the consultation budget is turn-scoped", async () => {
    const served: string[] = [];
    // Each retry proposes the next candidate in a chain of distinct
    // providers (re-proposing the serving provider is a refused no-op
    // since #1111, so distinct refs are what spend the budget): each
    // retry fails again, until the budget stops the loop.
    let consulted = 0;
    const candidates = ["pb", "pc", "pd", "pe"];
    let nth = 0;
    const rt = await runtime((ctx) =>
      ctx.onModelError(() => {
        consulted += 1;
        return { model: candidates[nth++] ?? "pf" };
      }),
    );
    const reg = new ProviderRegistry()
      .registerProvider("pa", () => {
        served.push("pa/m");
        return failing("invalid_request", "pa/m");
      });
    for (const name of ["pb", "pc", "pd", "pe", "pf"]) {
      reg.registerProvider(name, () => {
        served.push(`${name}/m`);
        return failing("invalid_request", `${name}/m`);
      });
    }
    const session = createSession({ provider: "pa", registry: reg, extensions: rt });
    const result = await session.send("loop");
    expect(result.status).toBe("error");
    // pa + the 4 budgeted retries, then the budget ends the turn (#1110: 4).
    expect(served).toEqual(["pa/m", "pb/m", "pc/m", "pd/m", "pe/m"]);
    expect(consulted).toBe(4);
  });
});
