import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { createSession, subscriptionModelCatalog, type CatalogModel } from "@moh/core";
import { ModelPickerModal } from "../src/ModelPickerModal";
import { filterCatalog } from "../src/model-picker";
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

describe("/model modal (#181)", () => {
  function mount(over: Partial<Parameters<typeof ModelPickerModal>[0]> = {}) {
    const switched: string[] = [];
    const toasts: string[] = [];
    let closed = 0;
    const i = render(
      <ThemeProvider value={THEMES[DEFAULT_THEME]}>
        <ModelPickerModal
          activeModel="alpha/claude-sonnet-4-5"
          providerType="anthropic"
          catalog={CATALOG}
          onSwitch={(ref) => {
            switched.push(ref);
            return { ok: true, model: `alpha/${ref}` };
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
    expect(frame).toContain("Claude Sonnet 4.5 (claude-sonnet-4-5)");
    expect(frame).toContain("ctx 200k");
    i.unmount();
  });

  test("enter on the selected row switches via the session seam and closes", async () => {
    const { i, switched, toasts, closed } = mount();
    await sleep(30);
    i.stdin.write("\x1b[B"); // opus
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(switched).toEqual(["claude-opus-4-1"]);
    expect(toasts[0]).toContain("claude-opus-4-1");
    expect(toasts[0]).toContain("next turn");
    expect(closed()).toBe(1);
    i.unmount();
  });

  test("typing filters; the free-text row commits endpoint/<typed>", async () => {
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
          providerType={session.activeEndpointType}
          catalog={[]}
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
