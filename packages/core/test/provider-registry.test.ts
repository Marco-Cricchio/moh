import { describe, expect, test } from "bun:test";
import {
  createSession,
  defaultRegistry,
  loadMohConfig,
  MockProvider,
  ProviderRegistry,
  resolveProvider,
  resolveProviderRef,
  type EndpointProfile,
  type MohConfig,
  type Message,
  type Provider,
  type StreamEvent,
} from "../src/index";

function scriptedProvider(): Provider {
  return MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]);
}

describe("registerProvider", () => {
  test("registers and resolves a custom provider programmatically", () => {
    const registry = new ProviderRegistry();
    registry.registerProvider("my-provider", () => scriptedProvider());
    expect(registry.has("my-provider")).toBe(true);
    const provider = resolveProviderRef("my-provider", registry.freeze(), []);
    expect(provider.name).toBeDefined();
  });

  test("rejects duplicate ids, slash ids, and non-function factories", () => {
    const registry = new ProviderRegistry();
    registry.registerProvider("x", () => scriptedProvider());
    expect(() => registry.registerProvider("x", () => scriptedProvider())).toThrow("already registered");
    expect(() => registry.registerProvider("a/b", () => scriptedProvider())).toThrow('without "/"');
    expect(() => registry.registerProvider("bad", undefined as never)).toThrow("factory must be a function");
  });

  test("registry is frozen per AgentSession at creation", async () => {
    const registry = new ProviderRegistry();
    registry.registerProvider("early", () => scriptedProvider());
    const session = createSession({ provider: "early", registry });
    // Register after the session exists: the frozen snapshot must not see it.
    registry.registerProvider("late", () => scriptedProvider());
    expect(session.registry?.has("early")).toBe(true);
    expect(session.registry?.has("late")).toBe(false);
    const result = await session.send("hi");
    expect(result.status).toBe("done");
  });
});

describe("resolveProvider (moh.json config)", () => {
  test("empty config defaults to the zero-credential mock", () => {
    const provider = resolveProvider({});
    expect(provider.name).toBe("mock");
  });

  test('provider: "mock" works with zero credentials end-to-end', async () => {
    const session = createSession({ provider: "mock" });
    const result = await session.send("hello");
    expect(result.status).toBe("done");
    const text = session
      .history()
      .filter((e) => e.type === "assistant_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toContain("mock provider");
  });

  test("openai-compat profile resolves to a route over the baseUrl endpoint", () => {
    const config: MohConfig = {
      provider: "ollama/qwen3",
      endpoints: [{ name: "ollama", type: "openai-compat", baseUrl: "http://localhost:11434/v1", defaultModel: "qwen3" }],
    };
    const route = resolveProvider(config) as import("../src/index").Route;
    expect(route.ref).toBe("ollama/qwen3");
    expect(route.chain).toEqual(["ollama/qwen3"]);
  });

  test("bare endpoint name uses its defaultModel; explicit model wins", () => {
    const endpoints: EndpointProfile[] = [
      { name: "deepseek", type: "openai-compat", baseUrl: "https://api.deepseek.com/v1", apiKey: "k", defaultModel: "deepseek-chat" },
    ];
    const frozen = defaultRegistry.freeze();
    expect(resolveProviderRef("deepseek", frozen, endpoints).name).toBe("deepseek/deepseek-chat");
    expect(resolveProviderRef("deepseek/deepseek-reasoner", frozen, endpoints).name).toBe("deepseek/deepseek-reasoner");
  });

  test("openai-compat without baseUrl is a hard error", () => {
    const config: MohConfig = {
      provider: "ollama/qwen3",
      endpoints: [{ name: "ollama", type: "openai-compat", defaultModel: "qwen3" }],
    };
    expect(() => resolveProvider(config)).toThrow("requires baseUrl");
  });

  test("unknown ref and missing defaultModel produce clear errors", () => {
    const frozen = defaultRegistry.freeze();
    expect(() => resolveProviderRef("nope/x", frozen, [])).toThrow('unknown provider "nope/x"');
    expect(() => resolveProviderRef("ollama", frozen, [{ name: "ollama", type: "openai-compat", baseUrl: "http://x" }])).toThrow(
      "no defaultModel",
    );
  });

  test("custom profile type resolves through a registered factory", () => {
    const registry = new ProviderRegistry();
    const opts: unknown[] = [];
    registry.registerProvider("acme", (o) => {
      opts.push(o);
      return scriptedProvider();
    });
    const provider = resolveProvider(
      { provider: "acme-1", endpoints: [{ name: "acme-1", type: "acme", apiKey: "k", baseUrl: "https://acme", defaultModel: "m1" }] },
      registry,
    );
    expect(provider.name).toBe("mock");
    // the factory receives the profile's credentials and model
    expect(opts).toEqual([{ apiKey: "k", baseUrl: "https://acme", modelId: "m1" }]);
  });
});

describe("loadMohConfig", () => {
  test("missing file and empty file are the empty config", () => {
    expect(loadMohConfig("/nonexistent/moh.json")).toEqual({});
    expect(loadMohConfig("/nonexistent/moh.json", () => "  \n")).toEqual({});
  });

  test("invalid JSON and schema violations are hard errors", () => {
    expect(() => loadMohConfig("moh.json", () => "{")).toThrow("not valid JSON");
    expect(() =>
      loadMohConfig("moh.json", () => JSON.stringify({ endpoints: [{ name: "" }] })),
    ).toThrow("invalid moh.json");
  });

  test("loads endpoint profiles", () => {
    const config = loadMohConfig(
      "moh.json",
      () => JSON.stringify({ provider: "ollama/qwen3", endpoints: [{ name: "ollama", type: "openai-compat", baseUrl: "http://localhost:11434/v1", defaultModel: "qwen3" }] }),
    );
    expect(config.endpoints?.[0]?.type).toBe("openai-compat");
  });
});

describe("openai-compat profile streams from a local endpoint (e2e)", () => {
  test("config-only profile resolves and streams against a local OpenAI-compatible server", async () => {
    const sse = openAiSseServer("hello from ollama");
    try {
      const config: MohConfig = {
        provider: "ollama/qwen3",
        endpoints: [
          { name: "ollama", type: "openai-compat", baseUrl: `http://localhost:${sse.port}/v1`, apiKey: "test-key", defaultModel: "qwen3" },
        ],
      };
      const provider = resolveProvider(config);
      const events: StreamEvent[] = [];
      for await (const event of provider.stream(sampleMessages(), new AbortController().signal)) {
        events.push(event);
      }
      const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("");
      expect(text).toBe("hello from ollama");
      expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    } finally {
      sse.stop();
    }
  });

  test("full session turn against the local endpoint, no code", async () => {
    const sse = openAiSseServer("local reply");
    try {
      const config: MohConfig = {
        provider: "ollama/qwen3",
        endpoints: [
          { name: "ollama", type: "openai-compat", baseUrl: `http://localhost:${sse.port}/v1`, apiKey: "test-key", defaultModel: "qwen3" },
        ],
      };
      const session = createSession({ provider: resolveProvider(config) });
      const result = await session.send("hi");
      expect(result.status).toBe("done");
      const text = session
        .history()
        .filter((e) => e.type === "assistant_delta")
        .map((e) => (e as { text: string }).text)
        .join("");
      expect(text).toBe("local reply");
      expect(session.history().at(-1)?.type).toBe("done");
    } finally {
      sse.stop();
    }
  });
});

function sampleMessages(): Message[] {
  return [{ role: "user", parts: [{ kind: "text", text: "hi" }] }];
}

/** Minimal OpenAI-compatible /chat/completions SSE server. */
function openAiSseServer(content: string): { port: number; stop: () => void } {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "qwen3",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body =
          chunk({ role: "assistant", content: "" }, null) +
          chunk({ content }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n";
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { port: server.port as number, stop: () => server.stop(true) };
}
