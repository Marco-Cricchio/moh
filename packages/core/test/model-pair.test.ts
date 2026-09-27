import { describe, expect, test } from "bun:test";
import { formatModelPair, selectedModelOf, servingModelOf } from "../src/model-pair";
import { MockProvider } from "../src/mock-provider";
import { createRoute, Endpoint, type RouteTarget } from "../src/route";
import type { Message, Provider } from "../src/types";

/**
 * ADR-0050 (#974): one formatter and one accessor pair for the
 * selected/serving references — the string every surface states, and the
 * reading every "the model in use" consumer must use.
 */

function mockTarget(name: string): RouteTarget {
  return { endpoint: new Endpoint({ name, kind: "mock" }), modelId: `model-${name}` };
}

describe("formatModelPair", () => {
  test("agreement renders the single reference; disagreement renders the arrow", () => {
    expect(formatModelPair("openai/gpt-6-astra", "openai/gpt-6-astra")).toBe("openai/gpt-6-astra");
    expect(formatModelPair("openai/gpt-6-astra", "opencode-go/deepseek-v4.1-flash"))
      .toBe("openai/gpt-6-astra → opencode-go/deepseek-v4.1-flash");
  });

  test("a bare provider name is a pair with itself", () => {
    expect(formatModelPair("mock", "mock")).toBe("mock");
  });
});

describe("the accessor pair", () => {
  test("a provider that is not a route reports one reference from both accessors", () => {
    const provider: Provider = MockProvider.scripted([{ deltas: ["x"], finish: "stop" }]);
    expect(selectedModelOf(provider)).toBe(provider.name);
    expect(servingModelOf(provider)).toBe(provider.name);
  });

  test("a route reports the selection and the stop that serves", async () => {
    const targets = [mockTarget("a"), mockTarget("b")];
    const route = createRoute({
      target: targets[0]!,
      fallbacks: [targets[1]!],
      retries: 0,
      createStream: (target) => {
        const provider = target.endpoint.name === "a"
          ? MockProvider.scripted([{ deltas: [], finish: "stop", error: { kind: "quota_exhausted", message: "quota" } }])
          : MockProvider.scripted([{ deltas: ["served"], finish: "stop" }]);
        return (messages, signal) => provider.stream(messages, signal);
      },
    });
    expect(selectedModelOf(route)).toBe("a/model-a");
    expect(servingModelOf(route)).toBe("a/model-a");

    const messages: Message[] = [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];
    for await (const _ of route.stream(messages, new AbortController().signal)) { /* fall back to b */ }

    expect(selectedModelOf(route)).toBe("a/model-a");
    expect(servingModelOf(route)).toBe("b/model-b");
  });
});
