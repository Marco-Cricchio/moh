/**
 * ADR-0062 (#1132): the `contribute-panels` / `contribute-overlays`
 * capability slots. A granted extension registers one panel (at most 4
 * across all extensions — the fifth is refused visibly at load, no
 * automatic eviction) and full-screen overlays opened by its own command.
 * Without the grant the registration APIs are absent from the context
 * (enforcement by absence). The core carries the render opaquely: a
 * headless client contributes nothing — visible absence, never a mock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRuntime, MAX_PANELS } from "../src/extensions";
import { defineExtension, parseApiVersion, MOH_EXTENSION_API_VERSION } from "@moh/extension";
import type { AgentEvent } from "../src/types";
import type { ExtensionDefinition, ExtensionSetupContext } from "@moh/extension";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moh-extpanel-"));
  dirs.push(dir);
  return dir;
}

function runtime(overrides: Partial<ConstructorParameters<typeof ExtensionRuntime>[0]> = {}) {
  return new ExtensionRuntime({ mohHome: tempDir(), consent: () => true, ...overrides });
}

async function load(rt: ExtensionRuntime, def: ExtensionDefinition) {
  await rt.register(def);
  await rt.ready();
}

/** Collects the extension_failed reasons recorded during loads. */
function failedReasons(rt: ExtensionRuntime): { name: string; reason: string; message: string }[] {
  const out: { name: string; reason: string; message: string }[] = [];
  rt.onLoadEvent((event) => {
    if (event.type === "extension_failed") {
      out.push({ name: event.name, reason: String((event as { reason?: string }).reason), message: String((event as { message?: string }).message) });
    }
  });
  return out;
}

describe("contribute-panels / contribute-overlays (#1132, ADR-0062)", () => {
  test("apiVersion is 1.12", () => {
    expect(parseApiVersion(MOH_EXTENSION_API_VERSION)).toEqual({ major: 1, minor: 16 });
  });

  test("with the grants, the extension registers a panel and an overlay; the runtime reports them", async () => {
    const rt = runtime();
    await load(
      rt,
      defineExtension({
        name: "ops",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-panels", "contribute-overlays"],
        setup(ctx) {
          ctx.registerPanel!({ name: "ops-status", description: "deployment status", maxHeight: 6, render: () => "panel" });
          const overlay = ctx.registerOverlay!({ name: "ops-console", description: "console", render: () => "overlay" });
          ctx.state.open = overlay;
        },
      }),
    );
    expect(rt.panels()).toMatchObject([{ extension: "ops", name: "ops-status", description: "deployment status", maxHeight: 6 }]);
    expect(rt.panels()[0]?.render()).toBe("panel");
    expect(rt.overlays()).toMatchObject([{ extension: "ops", name: "ops-console", description: "console" }]);
    expect(rt.overlays()[0]?.render()).toBe("overlay");
    expect(rt.uiRefusals()).toEqual([]);
  });

  test("without the grants, the registration APIs are absent from the context", async () => {
    let saw: { panel?: unknown; overlay?: unknown } = { panel: "unset", overlay: "unset" };
    const rt = runtime();
    await load(
      rt,
      defineExtension({
        name: "plain",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: [],
        setup(ctx: ExtensionSetupContext) {
          saw = { panel: (ctx as { registerPanel?: unknown }).registerPanel, overlay: (ctx as { registerOverlay?: unknown }).registerOverlay };
        },
      }),
    );
    expect(saw.panel).toBeUndefined();
    expect(saw.overlay).toBeUndefined();
    expect(rt.panels()).toEqual([]);
    expect(rt.overlays()).toEqual([]);
  });

  test("a second panel from the same extension is refused (one panel per extension)", async () => {
    const rt = runtime();
    const failures = failedReasons(rt);
    await load(
      rt,
      defineExtension({
        name: "greedy",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-panels"],
        setup(ctx) {
          ctx.registerPanel!({ name: "first", render: () => "one" });
          ctx.registerPanel!({ name: "second", render: () => "two" });
        },
      }),
    );
    expect(rt.panels().map((p) => p.name)).toEqual(["first"]);
    expect(rt.uiRefusals()).toEqual([{ extension: "greedy", kind: "panel", name: "second", reason: "taken" }]);
    expect(failures[0]?.reason).toBe("panel_refused");
    expect(failures[0]?.message).toContain("one panel per extension");
  });

  test("the fifth panel is refused visibly at load: panel slot exhausted (4/4)", async () => {
    const rt = runtime();
    const failures = failedReasons(rt);
    for (let i = 1; i <= MAX_PANELS + 1; i++) {
      await load(
        rt,
        defineExtension({
          name: `ext${i}`,
          version: "1.0.0",
          apiVersion: "1.0",
          capabilities: ["contribute-panels"],
          setup(ctx) {
            ctx.registerPanel!({ name: `panel-${i}`, render: () => "x" });
          },
        }),
      );
    }
    expect(rt.panels()).toHaveLength(MAX_PANELS);
    expect(rt.uiRefusals()).toEqual([{ extension: `ext${MAX_PANELS + 1}`, kind: "panel", name: `panel-${MAX_PANELS + 1}`, reason: "exhausted" }]);
    expect(failures[0]?.reason).toBe("panel_refused");
    expect(failures[0]?.message).toContain(`panel slot exhausted (${MAX_PANELS}/${MAX_PANELS}) — disable a panel in /extensions`);
  });

  test("a malformed panel registration is refused as invalid", async () => {
    const rt = runtime();
    await load(
      rt,
      defineExtension({
        name: "sloppy",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-panels"],
        setup(ctx) {
          (ctx.registerPanel! as (p: unknown) => void)({ name: "Bad Name" });
          ctx.registerPanel!({ name: "no-render" } as Parameters<NonNullable<ExtensionSetupContext["registerPanel"]>>[0]);
        },
      }),
    );
    expect(rt.panels()).toEqual([]);
    expect(rt.uiRefusals()).toEqual([
      { extension: "sloppy", kind: "panel", name: "Bad Name", reason: "invalid" },
      { extension: "sloppy", kind: "panel", name: "no-render", reason: "invalid" },
    ]);
  });

  test("an overlay cannot be opened by a retained callback outside its command", async () => {
    const rt = runtime();
    let open: (() => void) | undefined;
    await load(rt, defineExtension({
      name: "guarded-overlay",
      version: "1.0.0",
      apiVersion: "1.0",
      capabilities: ["contribute-overlays"],
      setup(ctx) {
        open = ctx.registerOverlay!({ name: "screen", render: () => "screen" }).open;
      },
    }));
    open!();
    expect(rt.activeOverlay()).toBeNull();
    const result = await rt.invokeCommand("missing", "");
    expect(result.ok).toBe(false);
  });

  test("overlay open/close is real state: listeners fire, close clears, no listener = nothing", async () => {
    const rt = runtime();
    let overlayHandle: { open(): void } | undefined;
    await load(
      rt,
      defineExtension({
        name: "console",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-overlays", "contribute-commands"],
        setup(ctx) {
          overlayHandle = ctx.registerOverlay!({ name: "console", render: () => "screen" });
          ctx.registerCommand!({ name: "open-console", run: () => { overlayHandle!.open(); return "opened"; } });
        },
      }),
    );
    expect(rt.activeOverlay()).toBeNull();
    const seen: { extension: string; name: string }[] = [];
    const unsubscribe = rt.onOverlayOpen((o) => seen.push(o));
    await rt.invokeCommand("open-console", "");
    expect(rt.activeOverlay()).toEqual({ extension: "console", name: "console" });
    expect(seen).toEqual([{ extension: "console", name: "console" }]);
    unsubscribe();
    overlayHandle!.open();
    expect(seen).toEqual([{ extension: "console", name: "console" }]);
    rt.closeOverlay();
    expect(rt.activeOverlay()).toBeNull();
    rt.closeOverlay(); // no-op when none
  });

  test("a duplicate overlay name from the same extension is refused; a malformed one is invalid", async () => {
    const rt = runtime();
    await load(
      rt,
      defineExtension({
        name: "dups",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-overlays"],
        setup(ctx) {
          ctx.registerOverlay!({ name: "board", render: () => "a" });
          ctx.registerOverlay!({ name: "board", render: () => "b" });
          ctx.registerOverlay!({ name: "no render" } as Parameters<NonNullable<ExtensionSetupContext["registerOverlay"]>>[0]);
        },
      }),
    );
    expect(rt.overlays().map((o) => o.name)).toEqual(["board"]);
    expect(rt.uiRefusals()).toEqual([
      { extension: "dups", kind: "overlay", name: "board", reason: "taken" },
      { extension: "dups", kind: "overlay", name: "no render", reason: "invalid" },
    ]);
  });

  test("the load event carries the registered panel/overlay names (headless visibility)", async () => {
    const rt = runtime();
    const loaded: AgentEvent[] = [];
    rt.onLoadEvent((event) => {
      if (event.type === "extension_loaded") loaded.push(event);
    });
    await load(
      rt,
      defineExtension({
        name: "full",
        version: "2.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-panels", "contribute-overlays"],
        setup(ctx) {
          ctx.registerPanel!({ name: "status", render: () => "x" });
          ctx.registerOverlay!({ name: "screen", render: () => "y" });
        },
      }),
    );
    const event = loaded[0] as { panels?: string[]; overlays?: string[] };
    expect(event.panels).toEqual(["status"]);
    expect(event.overlays).toEqual(["screen"]);
  });

  test("the panel slots add no action API: a callback reaches the session only through the existing gated seams", async () => {
    let contextKeys: string[] = [];
    const rt = runtime();
    await load(rt, defineExtension({
      name: "panel-button",
      version: "1.0.0",
      apiVersion: "1.0",
      capabilities: ["contribute-panels", "contribute-overlays", "contribute-commands"],
      setup(ctx) {
        contextKeys = Object.keys(ctx as object).sort();
        ctx.registerPanel!({ name: "actions", render: () => "render" });
        ctx.registerOverlay!({ name: "screen", render: () => "screen" });
      },
    }));

    // The UI grants widen the setup context by exactly two entry points —
    // both registration, neither an action. There is no tool runner, no
    // permission bypass, no send: a click can only ask for a turn
    // (`requestTurn`) or emit an event, which are the same doors every
    // other extension action uses (ADR-0031: a callback invokes, never
    // grants). This test is the pin: adding an action seam here fails it.
    const allowed = [
      "afterTurn",
      "appendEvent",
      "appendToPrompt",
      "beforeModelCall",
      "beforeTurn",
      "onCompaction",
      "onEvent",
      "onModelError",
      "onSessionEnd",
      "onSessionStart",
      "onToolCall",
      "onToolResult",
      "registerCommand",
      "registerOverlay",
      "registerPanel",
      "requestTurn",
      "setPromptNote",
      "setStatus",
      "state",
    ];
    expect(contextKeys).toEqual(allowed);
    // No action seam slipped in under a hook-shaped name: the two UI slots
    // added `registerPanel`/`registerOverlay` and nothing else.
    expect(contextKeys.filter((k) => /^register(Panel|Overlay|Command)$/.test(k)).sort()).toEqual([
      "registerCommand",
      "registerOverlay",
      "registerPanel",
    ]);
    expect(contextKeys.some((k) => /^(run|exec|send|grant|approve|permission)/i.test(k))).toBe(false);
  });

  test("a granted extension that registers no UI contributes nothing to panels()/overlays()", async () => {
    const rt = runtime();
    await load(
      rt,
      defineExtension({
        name: "quiet",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-panels", "contribute-overlays"],
        setup() {},
      }),
    );
    expect(rt.panels()).toEqual([]);
    expect(rt.overlays()).toEqual([]);
    expect(rt.uiRefusals()).toEqual([]);
  });
});

describe("panel capacity across a hot-reload (#1132)", () => {
  test("a full rail does not count the reloading instance out of its own slot", async () => {
    // Four extensions from files, one panel each: the rail is exactly full.
    const dir = tempDir();
    const files = [1, 2, 3, 4].map((n) => {
      const file = join(dir, `ext${n}.mjs`);
      writeFileSync(file, panelModule(`ext${n}`, "1.0.0", `panel-${n}`));
      return file;
    });
    writeFileSync(
      join(dir, "moh.extension.json"),
      JSON.stringify({ name: "rail", version: "1.0.0", entry: files.map((f) => f.split("/").pop()).sort(), capabilities: ["contribute-panels"] }, null, 2),
    );
    const rt = runtime();
    for (const file of files) expect(await rt.registerFile(file)).toBe(true);
    await rt.ready();
    expect(rt.panels().map((p) => p.name).sort()).toEqual(["panel-1", "panel-2", "panel-3", "panel-4"]);

    rt.startWatch();
    // An ordinary edit to one of them: the hot-reload must swap the
    // instance in place, not refuse its panel because the outgoing
    // instance still occupies the slot it is replacing.
    writeFileSync(files[3]!, panelModule("ext4", "1.1.0", "panel-4"));
    await Bun.sleep(900);

    expect(rt.panels().map((p) => p.name).sort()).toEqual(["panel-1", "panel-2", "panel-3", "panel-4"]);
    expect(rt.uiRefusals()).toEqual([]);
  });
});

function panelModule(name: string, version: string, panel: string): string {
  return `export default { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)}, apiVersion: "1.0",
    capabilities: ["contribute-panels"],
    setup(ctx) { ctx.registerPanel({ name: ${JSON.stringify(panel)}, render: () => "x" }); } };`;
}
