/**
 * #826: the Jev integration surface — the `typesafe` config block (moved
 * here from `@moh/core`, where it did not belong) and the bundled-extension
 * descriptor through which the core hosts this extension without knowing
 * anything about it.
 *
 * The core's side of the contract is covered in `packages/core/test/`; what
 * these tests pin is that the vendor's own resolution — activation, use-case
 * options, the two capabilities it contributes — is unchanged after the
 * move, and that the assembly really does end up with the extension
 * registered through the generic door.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFromConfig, userConfigFile } from "@moh/core";
import { jevBundledSource } from "../src/integration";
import { JEV_GUARD_NAME } from "../src/index";
import {
  maskApiKey,
  readTypesafeConfig,
  removeTypesafeApiKey,
  resolveTypesafeConfig,
  saveTypesafeApiKey,
} from "../src/typesafe";

function tmpDir(prefix = "moh-jev-int-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Writes `~/.moh/config` for a temp home. */
function writeUserConfig(home: string, body: Record<string, unknown>): void {
  const file = userConfigFile(home);
  mkdirSync(join(home, ".moh"), { recursive: true });
  writeFileSync(file, JSON.stringify(body));
}

describe("the typesafe config block (#784, #826)", () => {
  test("absent, present, stripped and malformed", () => {
    const dir = tmpDir();
    const file = join(dir, "config");
    expect(readTypesafeConfig(file)).toEqual({});

    writeFileSync(file, JSON.stringify({ typesafe: { apiKey: "sk-1", timeoutMs: 1000, routing: true, bogus: 2 } }));
    expect(readTypesafeConfig(file)).toEqual({ apiKey: "sk-1", timeoutMs: 1000, routing: true });

    writeFileSync(file, JSON.stringify({ typesafe: { timeoutMs: "soon" } }));
    expect(() => readTypesafeConfig(file)).toThrow(/typesafe section/);
  });

  test("resolve defaults and the masked hint", () => {
    expect(resolveTypesafeConfig(undefined)).toEqual({
      active: false,
      timeoutMs: 2500,
      routing: false,
      injection: false,
      classification: true,
      lint: false,
      rerank: false,
      skills: false,
      tiers: {},
    });
    expect(resolveTypesafeConfig({ apiKey: "   " })).toMatchObject({ active: false, timeoutMs: 2500 });
    expect(
      resolveTypesafeConfig({ apiKey: "sk-abcdef", timeoutMs: 900, routing: true, tiers: { "a/one": "potente" } }),
    ).toMatchObject({
      active: true,
      apiKey: "sk-abcdef",
      timeoutMs: 900,
      routing: true,
      tiers: { "a/one": "potente" },
    });
    expect(maskApiKey("sk-abcdef")).toBe("…cdef");
    expect(maskApiKey("ab")).toBe("…");
    expect(resolveTypesafeConfig({ skills: true })).toMatchObject({ skills: true });
  });

  test("save and remove go through the guardian and preserve other sections", () => {
    const dir = tmpDir();
    const file = join(dir, "config");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ provider: "mock", typesafe: { timeoutMs: 1200 } }));

    saveTypesafeApiKey(file, " sk-new ");
    expect(readTypesafeConfig(file)).toEqual({ apiKey: "sk-new", timeoutMs: 1200 });
    expect(JSON.parse(require("node:fs").readFileSync(file, "utf8")).provider).toBe("mock");

    removeTypesafeApiKey(file);
    expect(readTypesafeConfig(file)).toEqual({ timeoutMs: 1200 });
  });
});

describe("the bundled descriptor (#826)", () => {
  test("activation is the stored key, and nothing else", () => {
    const at = (body: unknown) => JSON.stringify(body);
    const file = "/nonexistent/config";

    // An empty config, a blank key and a broken block all mean "not active".
    expect(jevBundledSource.isActive(() => "", file)).toBe(false);
    expect(jevBundledSource.isActive(() => at({ typesafe: { apiKey: "   " } }), file)).toBe(false);
    expect(jevBundledSource.isActive(() => at({ typesafe: { timeoutMs: -1 } }), file)).toBe(false);

    expect(jevBundledSource.isActive(() => at({ typesafe: { apiKey: "sk-test" } }), file)).toBe(true);
  });

  test("activation reads through the injected reader, never the disk", () => {
    // The reader is the caller's by contract: a path that does not exist on
    // this machine still reports active if the injected read says so. If the
    // descriptor reached for the filesystem itself, this would be false.
    const file = join(tmpDir(), "config-that-does-not-exist");
    expect(existsSync(file)).toBe(false);
    expect(jevBundledSource.isActive(() => JSON.stringify({ typesafe: { apiKey: "sk-test" } }), file)).toBe(true);
    expect(jevBundledSource.isActive(() => JSON.stringify({ typesafe: {} }), file)).toBe(false);
  });

  test("a config file that cannot be read at all means inactive, not a crash", () => {
    const file = "/definitely/not/readable";
    expect(jevBundledSource.isActive(() => { throw new Error("EACCES"); }, file)).toBe(false);
  });

  test("the descriptor is named after the extension it registers", () => {
    // A literal in `integration.ts` (importing `index.ts` back would hit the
    // temporal dead zone through the cycle), so the two must be pinned equal.
    expect(jevBundledSource.name).toBe("jev-guard");
    expect(jevBundledSource.name).toBe(JEV_GUARD_NAME);
  });
});

describe("activation through the generic door (#826)", () => {
  test("with a key the extension loads; without one nothing is registered", async () => {
    const cwd = tmpDir("moh-jev-cwd-");
    const home = tmpDir("moh-jev-assembly-");
    const base = { cwd, home, config: { provider: "mock" }, bundledExtensions: [jevBundledSource] };

    // No key: the descriptor says no, so no extension is registered at all.
    const inactive = sessionFromConfig(base);
    expect("error" in inactive).toBe(false);
    if ("error" in inactive) return;
    expect(inactive.session.extensionStatuses()).toEqual([]);
    // The line the manual documents, produced by the extension itself (the
    // core has no words for it): pinned here so a refactor cannot drop it.
    expect(
      inactive.session.history().some((e) => e.type === "session_note" && e.text === "jev: inactive (no api key)"),
    ).toBe(true);
    await inactive.session.dispose();

    writeUserConfig(home, { typesafe: { apiKey: "sk-test", timeoutMs: 800 } });
    const active = sessionFromConfig(base);
    expect("error" in active).toBe(false);
    if ("error" in active) return;
    // Registration is async by design: the first turn waits for `ready()`.
    await active.session.send("hello");
    const loaded = active.session.history().find((e) => e.type === "extension_loaded") as { name?: string } | undefined;
    expect(loaded?.name).toBe("jev-guard");
    // Active: no "inactive" note.
    expect(active.session.history().some((e) => e.type === "session_note")).toBe(false);
    await active.session.dispose();
  });

  test("routing off registers no router; routing on with nothing to route reports it once", async () => {
    const cwd = tmpDir("moh-jev-cwd-");
    const home = tmpDir("moh-jev-assembly-");
    const base = { cwd, home, config: { provider: "mock" }, bundledExtensions: [jevBundledSource] };

    // Default (off): the extension is active but registers no beforeTurn
    // hook — routing is a choice, never a side effect of having a key.
    writeUserConfig(home, { typesafe: { apiKey: "sk-test" } });
    const off = sessionFromConfig(base);
    if ("error" in off) throw new Error(off.error.message);
    await off.session.send("hello");
    expect(off.session.history().some((e) => e.type === "extension_event" && e.name === "jev_routing")).toBe(false);
    await off.session.dispose();

    // On, but this session has no model pool at all (no endpoints): the
    // router is inert and says so exactly once.
    writeUserConfig(home, { typesafe: { apiKey: "sk-test", routing: true } });
    const on = sessionFromConfig(base);
    if ("error" in on) throw new Error(on.error.message);
    await on.session.send("hello");
    await Bun.sleep(5); // the pool resolution is asynchronous by design
    const notices = on.session.history().filter((e) => e.type === "extension_event" && e.name === "jev_routing");
    expect(notices).toHaveLength(1);
    expect((notices[0] as { payload?: { kind?: string } }).payload).toEqual({ kind: "inert" });
    await on.session.dispose();
  });

  test("routing off still registers the router, paused: /routing on enables the session", async () => {
    const cwd = tmpDir("moh-jev-cwd-");
    const home = tmpDir("moh-jev-assembly-");
    writeUserConfig(home, { typesafe: { apiKey: "sk-test" } });
    const assembled = sessionFromConfig({
      cwd,
      home,
      config: { provider: "mock" },
      bundledExtensions: [jevBundledSource],
    });
    if ("error" in assembled) throw new Error(assembled.error.message);
    const { session } = assembled;
    await session.send("hello");

    // The config did not opt in: the router exists (the session command can
    // enable it) but starts paused, and it costs nothing either way.
    const read = () => (session.extensionState("jev-guard", "routingState") as () => Record<string, unknown>)();
    expect(read()).toMatchObject({ paused: true });

    session.setExtensionState("jev-guard", { cmd: "on" });
    await Bun.sleep(5);
    expect(read()).toMatchObject({ paused: false });
    expect(session.history().some((e) => e.type === "extension_event" && e.name === "jev_routing")).toBe(true);
    await session.dispose();
  });

  test("a malformed typesafe section does not fail the session: the descriptor reports inactive", () => {
    const cwd = tmpDir("moh-jev-cwd-");
    const home = tmpDir("moh-jev-assembly-");
    writeUserConfig(home, { typesafe: { timeoutMs: -1 } });
    const result = sessionFromConfig({
      cwd,
      home,
      config: { provider: "mock" },
      bundledExtensions: [jevBundledSource],
    });
    // #826: an optional extension's broken config is the extension's
    // business. It never blocks a session that is otherwise usable — the
    // CLI (`moh jev status`) is where the user gets the loud error.
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.session.extensionStatuses()).toEqual([]);
  });
});
