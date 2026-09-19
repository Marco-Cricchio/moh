/**
 * #826: the bundled-extension seam. The core hosts first-party code that
 * ships inside the binary without knowing which extension that is; the
 * vendor's own resolution is covered in `packages/jev-guard/test/`.
 *
 * What these tests pin is the *generic* contract, using a synthetic
 * descriptor so the property under test is never accidentally a Jev one:
 * activation comes from the extension (through the injected reader), the
 * wiring slots are filled by the extension, and a core with no mounted
 * source hosts nothing at all.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineExtension, type ExtensionSetupContext } from "@moh/extension";
import {
  ExtensionRuntime,
  resolveBundledExtensions,
  sessionFromConfig,
  userConfigFile,
  type BundledExtensionSource,
} from "../src/index";

function tmpDir(prefix = "moh-bundled-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeUserConfig(home: string, body: Record<string, unknown>): void {
  const file = userConfigFile(home);
  mkdirSync(join(home, ".moh"), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
}

/** A synthetic first-party extension: activates on a key of its own block
 * and contributes a gate, so nothing here depends on Jev's shapes. */
const SYNTHETIC = "opus-test";
function syntheticSource(options: { wire?: boolean; note?: boolean } = {}): BundledExtensionSource {
  return {
    name: SYNTHETIC,
    ...(options.note ? { inactiveNote: () => `${SYNTHETIC}: inactive (no key)` } : {}),
    isActive(_readConfig, configFile) {
      const raw = _readConfig(configFile);
      if (!raw.trim()) return false;
      try {
        const data = JSON.parse(raw) as { opusTest?: { enabled?: boolean } };
        return data.opusTest?.enabled === true;
      } catch {
        return false;
      }
    },
    activate(context) {
      return defineExtension({
        name: SYNTHETIC,
        version: "1.0.0",
        apiVersion: "1.1",
        setup(ctx: ExtensionSetupContext) {
          ctx.state.activationCwd = context.cwd;
          ctx.state.sawEndpoints = context.endpoints.length;
        },
      });
    },
    ...(options.wire
      ? {
          wire(readInstances, wiring) {
            wiring.turnGate = () => {
              const state = readInstances().find((i) => i.def.name === SYNTHETIC)?.state;
              return state === undefined ? undefined : true;
            };
          },
        }
      : {}),
  };
}

describe("resolveBundledExtensions (#826)", () => {
  test("an inactive descriptor contributes the extension's own note", async () => {
    const home = tmpDir();
    const runtime = new ExtensionRuntime({ mohHome: home });
    const result = resolveBundledExtensions({
      descriptors: [syntheticSource({ note: true })],
      runtime,
      configFile: userConfigFile(home),
      readConfig: () => "",
      context: { mohHome: home, cwd: home, endpoints: [], modelPool: () => Promise.resolve({ models: [], warnings: [] }), skillRoster: () => Promise.resolve([]) },
    });
    // The core has no words for another extension's precondition: it logs
    // exactly what the extension said, in source order.
    expect(result.notes).toEqual([`${SYNTHETIC}: inactive (no key)`]);
  });

  test("an inactive descriptor with nothing to say stays silent", async () => {
    const home = tmpDir();
    const runtime = new ExtensionRuntime({ mohHome: home });
    const result = resolveBundledExtensions({
      descriptors: [syntheticSource()],
      runtime,
      configFile: userConfigFile(home),
      readConfig: () => "",
      context: { mohHome: home, cwd: home, endpoints: [], modelPool: () => Promise.resolve({ models: [], warnings: [] }), skillRoster: () => Promise.resolve([]) },
    });
    expect(result.notes).toEqual([]);
  });

  test("an inactive descriptor registers nothing and reports no activation", async () => {
    const home = tmpDir();
    const runtime = new ExtensionRuntime({ mohHome: home });
    const result = resolveBundledExtensions({
      descriptors: [syntheticSource()],
      runtime,
      configFile: userConfigFile(home),
      readConfig: () => "",
      context: { mohHome: home, cwd: home, endpoints: [], modelPool: () => Promise.resolve({ models: [], warnings: [] }), skillRoster: () => Promise.resolve([]) },
    });
    expect(result.anyActive).toBe(false);
    expect(Object.keys(result.wiring)).toEqual([]);
    await runtime.ready();
    expect(runtime.instances).toHaveLength(0);
  });

  test("an active descriptor registers its definition as bundled code", async () => {
    const home = tmpDir();
    writeUserConfig(home, { opusTest: { enabled: true } });
    const runtime = new ExtensionRuntime({ mohHome: home });
    const result = resolveBundledExtensions({
      descriptors: [syntheticSource()],
      runtime,
      configFile: userConfigFile(home),
      readConfig: (f) => (f === userConfigFile(home) ? JSON.stringify({ opusTest: { enabled: true } }) : ""),
      context: { mohHome: home, cwd: home, endpoints: [], modelPool: () => Promise.resolve({ models: [], warnings: [] }), skillRoster: () => Promise.resolve([]) },
    });
    expect(result.anyActive).toBe(true);
    await runtime.ready();
    // Bundled code needs no consent: the host shipped the bytes.
    expect(runtime.instances.map((i) => i.def.name)).toEqual([SYNTHETIC]);
  });

  test("a wiring step fills a core slot with the extension's own reader", async () => {
    const home = tmpDir();
    const runtime = new ExtensionRuntime({ mohHome: home });
    const result = resolveBundledExtensions({
      descriptors: [syntheticSource({ wire: true })],
      runtime,
      configFile: userConfigFile(home),
      readConfig: () => JSON.stringify({ opusTest: { enabled: true } }),
      context: { mohHome: home, cwd: home, endpoints: [], modelPool: () => Promise.resolve({ models: [], warnings: [] }), skillRoster: () => Promise.resolve([]) },
    });
    // The slot is present and callable, and it is the extension's closure.
    expect(typeof result.wiring.turnGate).toBe("function");
    expect(result.wiring.rerank).toBeUndefined();
    await runtime.ready();
  });

  test("a throwing predicate is a descriptor bug, not a session failure", async () => {
    const home = tmpDir();
    const runtime = new ExtensionRuntime({ mohHome: home });
    const result = resolveBundledExtensions({
      descriptors: [{ ...syntheticSource(), isActive: () => { throw new Error("boom"); } }],
      runtime,
      configFile: userConfigFile(home),
      readConfig: () => "{}",
      context: { mohHome: home, cwd: home, endpoints: [], modelPool: () => Promise.resolve({ models: [], warnings: [] }), skillRoster: () => Promise.resolve([]) },
    });
    expect(result.anyActive).toBe(false);
  });
});

describe("sessionFromConfig — no mounted source means no bundled extension (#826)", () => {
  test("a plain library assembly registers nothing and stays silent", async () => {
    const cwd = tmpDir("moh-bundled-cwd-");
    const home = tmpDir("moh-bundled-home-");
    const result = sessionFromConfig({ cwd, home, config: { provider: "mock" } });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    await result.session.send("hello");
    expect(result.session.extensionStatuses()).toEqual([]);
    expect(result.session.history().some((e) => e.type === "extension_loaded")).toBe(false);
    await result.session.dispose();
  });

  test("a mounted source that is inactive notes its own line, and only its own", async () => {
    const cwd = tmpDir("moh-bundled-cwd-");
    const home = tmpDir("moh-bundled-home-");
    const result = sessionFromConfig({
      cwd,
      home,
      config: { provider: "mock" },
      bundledExtensions: [syntheticSource({ note: true })],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    await result.session.send("hello");
    const texts = result.session
      .history()
      .filter((e) => e.type === "session_note")
      .map((e) => (e as { text?: string }).text);
    expect(texts).toContain(`${SYNTHETIC}: inactive (no key)`);
    // No generic fallback line: the core never invents another extension's
    // precondition.
    expect(texts.some((t) => t?.startsWith("extensions:"))).toBe(false);
    await result.session.dispose();
  });

  test("a mounted source that is inactive in silence adds no note at all", async () => {
    const cwd = tmpDir("moh-bundled-cwd-");
    const home = tmpDir("moh-bundled-home-");
    const result = sessionFromConfig({
      cwd,
      home,
      config: { provider: "mock" },
      bundledExtensions: [syntheticSource()],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    await result.session.send("hello");
    expect(result.session.history().some((e) => e.type === "session_note")).toBe(false);
    await result.session.dispose();
  });

  test("a mounted source that is active loads and sees the generic context", async () => {
    const cwd = tmpDir("moh-bundled-cwd-");
    const home = tmpDir("moh-bundled-home-");
    writeUserConfig(home, { opusTest: { enabled: true } });
    const result = sessionFromConfig({
      cwd,
      home,
      config: { provider: "mock" },
      bundledExtensions: [syntheticSource()],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    await result.session.send("hello");
    const loaded = result.session.history().find((e) => e.type === "extension_loaded") as { name?: string } | undefined;
    expect(loaded?.name).toBe(SYNTHETIC);
    await result.session.dispose();
  });
});
