import "./faketty/ci-mask";
/**
 * #1540: the /model picker fits the viewport — borders included — for any
 * list length, because the list window is what is left after the rows
 * actually drawn around it (header, filter, notices, footer), not a guessed
 * constant. In-process fake tty: the frame is the real screen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { renderOnFakeTty, type FakeTerminal } from "./faketty/render";
import { ModelPickerModal, type ModelPickerModalProps } from "../src/ModelPickerModal";
import type { EndpointPick } from "../src/model-picker";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import type { CatalogModel } from "@moh/core";

const BIG: CatalogModel[] = Array.from({ length: 200 }, (_, i) => ({
  id: `model-${String(i).padStart(3, "0")}`,
  name: `Model ${String(i).padStart(3, "0")}`,
  contextWindow: 128_000,
  reasoning: false,
}));

const open: FakeTerminal[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.unmount();
  for (const s of servers.splice(0)) s.stop(true);
});

function mount(rows: number, over: Partial<ModelPickerModalProps> = {}, endpoints?: EndpointPick[]) {
  const tty = renderOnFakeTty(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <ModelPickerModal
        activeModel="alpha/model-000"
        endpoints={endpoints ?? [{ name: "alpha", type: "openai-compat", catalog: BIG }]}
        onSwitch={() => ({ ok: true, model: "alpha/model-000" })}
        onSwitched={() => {}}
        liveCatalog={{}}
        onRefreshLive={() => {}}
        refreshingLive={false}
        onCompact={() => {}}
        onToast={() => {}}
        onClose={() => {}}
        {...over}
      />
    </ThemeProvider>,
    { cols: 80, rows },
  );
  open.push(tty);
  return tty;
}

function expectFits(tty: FakeTerminal, rows: number, footer = "esc close"): string {
  const lines = tty.screen.lines().map((l) => l.trimEnd());
  const frame = lines.join("\n");
  const top = lines.findIndex((l) => l.includes("╭"));
  const bottom = lines.findIndex((l) => l.includes("╰"));
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeGreaterThan(top);
  expect(bottom - top + 1).toBeLessThanOrEqual(rows);
  expect(tty.maxFrameRows()).toBeLessThanOrEqual(rows);
  expect(frame).toContain(footer);
  return frame;
}

describe("#1540 /model picker fits the viewport", () => {
  for (const rows of [24, 30, 50]) {
    test(`200 models at ${rows} rows: both borders visible, frame ≤ viewport`, async () => {
      const tty = mount(rows);
      await tty.settle();
      expectFits(tty, rows);
      // Scrolling to the end keeps the frame whole too.
      for (let i = 0; i < 199; i++) tty.write("\x1b[B");
      await tty.settle();
      const frame = expectFits(tty, rows);
      expect(frame).toContain("Model 199");
    });

    test(`every optional notice at ${rows} rows: still whole`, async () => {
      // A hanging endpoint ("fetching models: slow"), a refused one ("no list
      // from dead"), a live refresh, a long serving model, and the context-fit
      // refusal block — every optional row the modal can draw at once.
      const slow = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
      servers.push(slow);
      const tty = mount(
        rows,
        {
          servingModel: "fallback/a-very-long-model-identifier-that-wraps-in-the-header-row",
          refreshingLive: true,
          onSwitch: () => ({ ok: false, error: "needs 300k of context, this model holds 128k", reason: "context_length" }),
        },
        [
          { name: "alpha", type: "openai-compat", catalog: BIG },
          { name: "slow", type: "openai-compat", catalog: [], baseUrl: `http://localhost:${slow.port}/v1` },
          { name: "dead", type: "openai-compat", catalog: [], baseUrl: "http://127.0.0.1:1/v1" },
        ],
      );
      await tty.settle();
      tty.write("\r"); // pick → context_length refusal → the unfit block
      await tty.settle();
      const frame = expectFits(tty, rows, "keeps browsing");
      expect(frame).toContain("fetching models");
      expect(frame).toContain("no list from dead");
      expect(frame).toContain("cannot hold this session");
      expect(frame).toContain("keeps browsing");
    });
  }
});
