/**
 * #499: usage quota modal — component-level fixture tests (probe seam
 * injected, no live providers) plus the App-level ctrl+q open / esc
 * close wiring.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import type { QuotaReport, LocalUsageRow, EndpointProfile } from "@moh/core";
import { QuotaModal, clearQuotaCache, type QuotaModalProps } from "../src/QuotaModal";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi, waitForFrame } from "./helpers";

const waitFor = (instance: { lastFrame: () => string | undefined }, text: string) =>
  waitForFrame(() => stripAnsi(instance.lastFrame() ?? ""), text);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENDPOINTS: EndpointProfile[] = [
  { name: "alpha", type: "anthropic", auth: { kind: "subscription" } },
  { name: "beta", type: "openai-compat", apiKey: "k", baseUrl: "https://example.com/v1" },
];

const OPENCODE: EndpointProfile = {
  name: "opencode-go",
  type: "opencode",
  apiKey: "key",
  baseUrl: "https://opencode.ai/zen/go/v1",
};

const REPORT: QuotaReport = {
  source: "official",
  windows: [{ label: "limit", used: 45, limit: 120 }],
};

const LOCAL: LocalUsageRow[] = [{ model: "m-1", calls: 3, inputTokens: 1500, outputTokens: 300, estimatedCostUsd: 0.006 }];

function mount(over: Partial<QuotaModalProps> = {}) {
  let closed = 0;
  const props: QuotaModalProps = {
    endpoints: ENDPOINTS,
    localUsage: LOCAL,
    probe: async () => null,
    onClose: () => {
      closed += 1;
    },
    ...over,
  };
  const i = render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <QuotaModal {...props} />
    </ThemeProvider>,
  );
  return { instance: i, closed: () => closed };
}

describe("QuotaModal (#499)", () => {
  test("renders window rows with progress bar, badge, and local section", async () => {
    clearQuotaCache();
    const probeCalls: string[] = [];
    const { instance } = mount({
      probe: async (e) => {
        probeCalls.push(e.name);
        return e.name === "alpha" ? REPORT : null;
      },
    });
    await waitFor(instance, "limit");
    await sleep(50); // let both probes settle
    const frame = stripAnsi(instance.lastFrame()!);
    expect(frame).toContain("usage quota");
    expect(frame).toContain("alpha");
    expect(frame).toContain("limit");
    expect(frame).toContain("45");
    expect(frame).toContain("120");
    expect(frame).toContain("●"); // official badge
    expect(frame).toContain("provider quota unavailable"); // beta → null
    expect(frame).toContain("m-1");
    expect(frame).toContain("1.5k");
    expect(frame).toContain("300");
    expect(frame).toContain("$0.0060");
    expect(frame).toContain("total");
    expect(frame).toContain("estimated USD · pricing snapshot 0.85.0");
    expect(frame).toContain("—"); // local badge
    expect(probeCalls).toEqual(["alpha", "beta"]);
  });

  test("links OpenCode Console and retains local usage without a remote probe", async () => {
    clearQuotaCache();
    const probeCalls: string[] = [];
    const { instance } = mount({
      endpoints: [OPENCODE],
      probe: async (e) => {
        probeCalls.push(e.name);
        return REPORT;
      },
    });
    await waitFor(instance, "OpenCode usage:");
    const frame = stripAnsi(instance.lastFrame()!);
    expect(frame).toContain("https://opencode.ai/console");
    expect(frame).toContain("measurement below");
    expect(frame).toContain("m-1");
    expect(frame).not.toContain("provider quota unavailable");
    expect(probeCalls).toEqual([]);
  });

  test("shows spinner while probing, then rows (undocumented badge ○)", async () => {
    clearQuotaCache();
    let resolve!: (r: QuotaReport | null) => void;
    const gate = new Promise<QuotaReport | null>((r) => (resolve = r));
    const { instance } = mount({
      endpoints: [ENDPOINTS[0]!],
      probe: () => gate,
    });
    await sleep(50);
    expect(stripAnsi(instance.lastFrame()!)).toContain("probing");
    resolve({ source: "undocumented", windows: [{ label: "5h window", percent: 42 }] });
    await waitFor(instance, "5h window");
    const frame = stripAnsi(instance.lastFrame()!);
    expect(frame).toContain("42%");
    expect(frame).toContain("○");
    expect(frame).not.toContain("provider quota unavailable");
  });

  test("esc closes", async () => {
    clearQuotaCache();
    const { instance, closed } = mount();
    await waitFor(instance, "local measured");
    instance.stdin.write("\x1b");
    await sleep(50);
    expect(closed()).toBe(1);
  });

  test("r forces a re-probe (cache bypass, second round of calls)", async () => {
    clearQuotaCache();
    let calls = 0;
    const { instance } = mount({
      endpoints: [ENDPOINTS[0]!],
      probe: async () => {
        calls += 1;
        return REPORT;
      },
    });
    await waitFor(instance, "local measured");
    expect(calls).toBe(1);
    instance.stdin.write("r");
    await sleep(80);
    expect(calls).toBe(2);
  });

  test("60s cache: a second mount with the same endpoint name does not re-probe", async () => {
    clearQuotaCache();
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return REPORT;
    };
    const a = mount({ endpoints: [ENDPOINTS[0]!], probe });
    await waitFor(a.instance, "local measured");
    expect(calls).toBe(1);
    const b = mount({ endpoints: [ENDPOINTS[0]!], probe });
    await waitFor(b.instance, "local measured");
    await sleep(60);
    expect(calls).toBe(1);
    clearQuotaCache();
  });
});

describe("QuotaModal recent sessions (#718)", () => {
  test("renders the last-N rollup under its own heading, hiding an empty one", async () => {
    clearQuotaCache();
    const { instance } = mount({
      recentUsage: { window: 10, models: [{ model: "m-2", calls: 9, inputTokens: 20_000, outputTokens: 1_500 }] },
    });
    await waitFor(instance, "last 10 sessions");
    const frame = stripAnsi(instance.lastFrame()!);
    expect(frame).toContain("local measured (this session)");
    expect(frame).toContain("m-2");
    expect(frame).toContain("20.0k");
    expect(frame).toContain("9");
    instance.unmount();

    // Empty rollup: the section is hidden cleanly.
    const empty = mount({ recentUsage: { window: 10, models: [] } });
    await waitFor(empty.instance, "local measured");
    expect(stripAnsi(empty.instance.lastFrame()!)).not.toContain("last 10 sessions");
    empty.instance.unmount();

    // Absent rollup (aggregator failure): session-only view, no error.
    const degraded = mount({ recentUsage: null });
    await waitFor(degraded.instance, "local measured");
    const dframe = stripAnsi(degraded.instance.lastFrame()!);
    expect(dframe).toContain("m-1");
    expect(dframe).not.toContain("last 10 sessions");
  });
});
