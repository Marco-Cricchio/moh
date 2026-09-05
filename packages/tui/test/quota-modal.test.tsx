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

const REPORT: QuotaReport = {
  source: "official",
  windows: [{ label: "limit", used: 45, limit: 120 }],
};

const LOCAL: LocalUsageRow[] = [{ model: "m-1", calls: 3, inputTokens: 1500, outputTokens: 300 }];

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
    await waitFor(instance, "limit:");
    await sleep(50); // let both probes settle
    const frame = stripAnsi(instance.lastFrame()!);
    expect(frame).toContain("usage quota");
    expect(frame).toContain("alpha");
    expect(frame).toContain("limit:");
    expect(frame).toContain("45");
    expect(frame).toContain("120");
    expect(frame).toContain("●"); // official badge
    expect(frame).toContain("provider quota unavailable"); // beta → null
    expect(frame).toContain("m-1: 1.5k in · 300 out (3 calls)");
    expect(frame).toContain("—"); // local badge
    expect(probeCalls).toEqual(["alpha", "beta"]);
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
