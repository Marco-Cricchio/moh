import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { createSession, listOpenAiCompatModels, subscriptionModelCatalog, type CatalogModel } from "@moh/core";
import { ModelPickerModal, type ModelPickerModalProps } from "../src/ModelPickerModal";
import { contextWindowForLabel, filterCatalog, type EndpointPick } from "../src/model-picker";
import { contextFraction } from "../src/sidebar";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CATALOG: CatalogModel[] = [
  { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextWindow: 200_000, reasoning: true },
  { id: "claude-opus-4-1", name: "Claude Opus 4.1", contextWindow: 200_000, reasoning: true },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, reasoning: false },
];

describe("filterCatalog (#181 shared source)", () => {
  test("empty query returns the full catalog in order", () => {
    expect(filterCatalog(CATALOG, "")).toEqual(CATALOG);
    expect(filterCatalog(CATALOG, "  ")).toEqual(CATALOG);
  });

  test("substring matches on name and id, case-insensitive", () => {
    expect(filterCatalog(CATALOG, "opus").map((m) => m.id)).toEqual(["claude-opus-4-1"]);
    expect(filterCatalog(CATALOG, "Sonnet").map((m) => m.id)).toEqual(["claude-sonnet-4-5"]);
  });

  test("falls back to fuzzy subsequence on id", () => {
    // no substring match ("opus4"), but the subsequence o-p-u-s-4 matches the id
    expect(filterCatalog(CATALOG, "opus4").map((m) => m.id)).toEqual(["claude-opus-4-1"]);
  });

  test("no match returns empty (the free-text row takes over)", () => {
    expect(filterCatalog(CATALOG, "zzz")).toEqual([]);
  });

  test("openrouter-scale catalogs filter incrementally", () => {
    const big = subscriptionModelCatalog("openrouter");
    expect(big.length).toBeGreaterThan(100);
    expect(filterCatalog(big, "deepseek").length).toBeLessThan(big.length);
  });
});

describe("listOpenAiCompatModels (#181 follow-up)", () => {
  test("fetches GET <baseUrl>/models with bearer auth and maps ids", async () => {
    let sawAuth = "";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        sawAuth = req.headers.get("authorization") ?? "";
        return Response.json({ data: [{ id: "glm-5.3" }, { id: "glm-5.3-air" }, { nope: true }] });
      },
    });
    try {
      const ids = await listOpenAiCompatModels(`http://localhost:${server.port}/v1`, "key-1");
      expect(ids).toEqual(["glm-5.3", "glm-5.3-air"]);
      expect(sawAuth).toBe("Bearer key-1");
    } finally {
      server.stop(true);
    }
  });

  test("non-2xx and empty lists throw (callers fall back to free text)", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("nope", { status: 401 });
      },
    });
    try {
      await expect(listOpenAiCompatModels(`http://localhost:${server.port}/v1`)).rejects.toThrow("401");
    } finally {
      server.stop(true);
    }
  });
});

describe("/model modal (#181)", () => {
  function mount(over: Partial<ModelPickerModalProps> = {}) {
    const switched: string[] = [];
    const toasts: string[] = [];
    let closed = 0;
    const endpoints: EndpointPick[] = [{ name: "alpha", type: "anthropic", catalog: CATALOG }];
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <ModelPickerModal
          activeModel="alpha/claude-sonnet-4-5"
          endpoints={endpoints}
          onSwitch={(ref) => {
            switched.push(ref);
            return { ok: true, model: ref.includes("/") ? ref : `alpha/${ref}` };
          }}
          onSwitched={() => {}}
          onToast={(m) => toasts.push(m)}
          onClose={() => (closed += 1)}
          {...over}
        />
      </ThemeProvider>,
    );
    return { i, switched, toasts, closed: () => closed };
  }

  test("shows the active model and the catalog with context windows", async () => {
    const { i } = mount();
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("active: alpha/claude-sonnet-4-5");
    expect(frame).toContain("alpha · Claude Sonnet 4.5 · 200k");
    i.unmount();
  });

  test("every configured endpoint's models are listed, not just the active one", async () => {
    const { i, switched, toasts } = mount({
      endpoints: [
        { name: "alpha", type: "anthropic", catalog: CATALOG },
        { name: "zai", type: "openai-compat", catalog: [{ id: "glm-5.3", name: "glm-5.3", contextWindow: 0, reasoning: false }] },
      ],
    });
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("alpha · Claude");
    expect(frame).toContain("zai · glm-5.3");
    // selecting another endpoint's model switches across endpoints
    i.stdin.write("glm");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(switched).toEqual(["zai/glm-5.3"]);
    expect(toasts[0]).toContain("zai/glm-5.3");
    i.unmount();
  });

  test("a slash query narrows by endpoint name", async () => {
    const { i, switched, toasts } = mount({
      endpoints: [
        { name: "alpha", type: "anthropic", catalog: CATALOG },
        { name: "zai", type: "openai-compat", catalog: [{ id: "glm-5.3", name: "glm-5.3", contextWindow: 0, reasoning: false }] },
      ],
    });
    await sleep(30);
    i.stdin.write("zai/");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("zai · glm-5.3");
    expect(frame).not.toContain("Claude");
    i.unmount();
  });

  test("openai-compat endpoints fetch their model list live", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ data: [{ id: "glm-5.3" }, { id: "glm-5.3-air" }] });
      },
    });
    try {
      const { i } = mount({
        endpoints: [{ name: "zai", type: "openai-compat", baseUrl: `http://localhost:${server.port}/v1`, apiKey: "k", catalog: [] }],
      });
      await sleep(80);
      const frame = stripAnsi(i.lastFrame() ?? "");
      expect(frame).toContain("zai · glm-5.3");
      expect(frame).toContain("zai · glm-5.3-air");
      i.unmount();
    } finally {
      server.stop(true);
    }
  });

  test("a failed fetch degrades to free text, never blocks", async () => {
    const { i, switched } = mount({
      endpoints: [{ name: "zai", type: "openai-compat", baseUrl: "http://localhost:9/v1", catalog: [] }],
    });
    await sleep(120);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("no list from zai");
    i.stdin.write("glm-5.3");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(switched).toEqual(["alpha/glm-5.3"]);
    i.unmount();
  });

  test("enter on the selected row switches via the session seam and closes", async () => {
    const { i, switched, toasts, closed } = mount();
    await sleep(30);
    i.stdin.write("\x1b[B"); // opus
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(switched).toEqual(["alpha/claude-opus-4-1"]);
    expect(toasts[0]).toContain("claude-opus-4-1");
    expect(toasts[0]).toContain("next turn");
    expect(closed()).toBe(1);
    i.unmount();
  });

  test("typing filters; the free-text row commits the typed id", async () => {
    const { i, switched } = mount();
    await sleep(30);
    i.stdin.write("zzz-not-in-catalog");
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain('+ use "zzz-not-in-catalog" (free text)');
    expect(frame).not.toContain("Claude Sonnet");
    i.stdin.write("\r");
    await sleep(30);
    expect(switched).toEqual(["alpha/zzz-not-in-catalog"]);
    i.unmount();
  });

  test("a failed switch surfaces the error and keeps the modal open", async () => {
    const { i, switched, toasts, closed } = mount({
      onSwitch: () => ({ ok: false, error: "unknown endpoint" }),
    });
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(switched).toEqual([]);
    expect(toasts[0]).toContain("✗ unknown endpoint");
    expect(closed()).toBe(0);
    i.unmount();
  });

  test("esc closes without switching", async () => {
    const { i, switched, closed } = mount();
    await sleep(30);
    i.stdin.write("\x1b");
    await sleep(30);
    expect(switched).toEqual([]);
    expect(closed()).toBe(1);
    i.unmount();
  });
});

describe("/model modal against a live session (#181 shared semantics)", () => {
  test("switch routes through AgentSession.switchModel (model_switched event, next turn)", async () => {
    const session = createSession({
      provider: "alpha/one",
      endpoints: [{ name: "alpha", type: "openai-compat", baseUrl: "http://localhost:1/v1", defaultModel: "one" }],
    });
    const events: string[] = [];
    void (async () => {
      for await (const e of session.events) events.push(e.type);
    })();
    const inst = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <ModelPickerModal
          activeModel={session.activeModel}
          endpoints={session.endpointProfiles.map((e) => ({
            name: e.name,
            type: e.type,
            defaultModel: e.defaultModel,
            baseUrl: e.baseUrl,
            apiKey: e.apiKey,
            catalog: [],
          }))}
          onSwitch={(ref) => session.switchModel(ref)}
          onSwitched={() => {}}
          onToast={() => {}}
          onClose={() => {}}
        />
      </ThemeProvider>,
    );
    const i = inst;
    await sleep(30);
    i.stdin.write("custom-model");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(session.activeModel).toBe("alpha/custom-model");
    expect(events).toContain("model_switched");
    i.unmount();
  });
});

describe("contextWindowForLabel (note 11: catalog-derived context bar)", () => {
  const picks: EndpointPick[] = [
    { name: "alpha", type: "anthropic", catalog: [{ id: "opus-5", name: "Opus 5", contextWindow: 1_000_000, reasoning: true }] },
    { name: "compat", type: "openai-compat", catalog: [] },
  ];

  test("resolves the active model's declared window (endpoint/modelId label)", () => {
    expect(contextWindowForLabel(picks, "alpha/opus-5")).toBe(1_000_000);
  });

  test("openai-compat backends without a catalog return 0 (caller keeps the default)", () => {
    expect(contextWindowForLabel(picks, "compat/glm-5.3")).toBe(0);
  });

  test("unknown endpoint or bare labels return 0", () => {
    expect(contextWindowForLabel(picks, "nope/opus-5")).toBe(0);
    expect(contextWindowForLabel(picks, "opus-5")).toBe(0);
  });

  test("fraction of a 1M-window model no longer reads as near-full at 200k", () => {
    expect(contextFraction(180_000, contextWindowForLabel(picks, "alpha/opus-5"))).toBeLessThan(0.25);
  });
});
