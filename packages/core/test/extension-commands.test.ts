/**
 * ADR-0062 (#1130): the `contribute-commands` capability slot. A granted
 * extension registers slash commands executable like native ones; without
 * the grant the registration API is absent from the context (enforcement
 * by absence); a colliding name is refused visibly and reported; the same
 * command really runs headless through `invokeCommand` — the returned text
 * is the output, never a mock.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionRuntime } from "../src/extensions";
import { defineExtension, MOH_EXTENSION_API_VERSION, parseApiVersion } from "@moh/extension";
import type { ExtensionDefinition, ExtensionSetupContext } from "@moh/extension";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moh-extcmd-"));
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

describe("contribute-commands (#1130, ADR-0062)", () => {
  test("apiVersion is 1.12", () => {
    expect(parseApiVersion(MOH_EXTENSION_API_VERSION)).toEqual({ major: 1, minor: 15 });
  });

  test("with the grant, the extension registers a command and invokeCommand runs it", async () => {
    const rt = runtime({ reservedCommandNames: ["model", "help"] });
    await load(
      rt,
      defineExtension({
        name: "deploy",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-commands"],
        setup(ctx) {
          ctx.registerCommand!({
            name: "deploy-status",
            description: "deployment status",
            run: ({ args }) => `status ok (args: ${args})`,
          });
        },
      }),
    );
    expect(rt.extensionCommands()).toEqual([{ extension: "deploy", name: "deploy-status", description: "deployment status" }]);
    const result = await rt.invokeCommand("deploy-status", "--env prod");
    expect(result).toEqual({ ok: true, extension: "deploy", output: "status ok (args: --env prod)" });
    expect(rt.commandRefusals()).toEqual([]);
  });

  test("without the grant, the registration API is absent from the context", async () => {
    let sawRegisterCommand: unknown = "not called";
    const rt = runtime();
    await load(
      rt,
      defineExtension({
        name: "plain",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: [],
        setup(ctx: ExtensionSetupContext) {
          sawRegisterCommand = (ctx as { registerCommand?: unknown }).registerCommand;
        },
      }),
    );
    expect(sawRegisterCommand).toBeUndefined();
    expect(rt.extensionCommands()).toEqual([]);
  });

  test("an unknown command refuses the invocation without throwing", async () => {
    const rt = runtime();
    const result = await rt.invokeCommand("nope", "");
    expect(result.ok).toBe(false);
  });

  test("a name reserved by the client (native commands, skills) is refused visibly and reported", async () => {
    const rt = runtime({ reservedCommandNames: ["model", "implement"] });
    const failures: { reason: string; message: string }[] = [];
    rt.onLoadEvent((event) => {
      if (event.type === "extension_failed") failures.push({ reason: String((event as { reason?: string }).reason), message: String((event as { message?: string }).message) });
    });
    await load(
      rt,
      defineExtension({
        name: "overreacher",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-commands"],
        setup(ctx) {
          ctx.registerCommand!({ name: "model", run: () => "mine now" });
          ctx.registerCommand!({ name: "implement", run: () => "skill shadow" });
        },
      }),
    );
    expect(rt.extensionCommands()).toEqual([]);
    expect(rt.commandRefusals()).toEqual([
      { extension: "overreacher", name: "model", reason: "reserved" },
      { extension: "overreacher", name: "implement", reason: "reserved" },
    ]);
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure.reason).toBe("command_refused");
      expect(failure.message).toContain("native command or skill");
    }
  });

  test("a name taken by another extension is refused; registration order wins, never re-registration", async () => {
    const rt = runtime();
    await load(
      rt,
      defineExtension({
        name: "first",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-commands"],
        setup(ctx) {
          ctx.registerCommand!({ name: "shared", run: () => "first" });
        },
      }),
    );
    await load(
      rt,
      defineExtension({
        name: "second",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-commands"],
        setup(ctx) {
          ctx.registerCommand!({ name: "shared", run: () => "second" });
        },
      }),
    );
    expect(rt.extensionCommands()).toEqual([{ extension: "first", name: "shared", description: "command by first" }]);
    expect(rt.commandRefusals()).toEqual([{ extension: "second", name: "shared", reason: "taken" }]);
  });

  test("an invalid command (bad name, missing run, duplicate within one extension) is refused", async () => {
    const rt = runtime();
    await load(
      rt,
      defineExtension({
        name: "sloppy",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-commands"],
        setup(ctx) {
          ctx.registerCommand!({ name: "has space", run: () => "x" });
          ctx.registerCommand!({ name: "no-run" } as never);
          ctx.registerCommand!({ name: "dup", run: () => "one" });
          ctx.registerCommand!({ name: "dup", run: () => "two" });
        },
      }),
    );
    expect(rt.extensionCommands()).toEqual([{ extension: "sloppy", name: "dup", description: "command by sloppy" }]);
    expect(rt.commandRefusals()).toEqual([
      { extension: "sloppy", name: "has space", reason: "invalid" },
      { extension: "sloppy", name: "no-run", reason: "invalid" },
      { extension: "sloppy", name: "dup", reason: "taken" },
    ]);
  });

  test("a throwing handler refuses the invocation with a visible command_failed record", async () => {
    const rt = runtime();
    const failures: string[] = [];
    rt.onLoadEvent((event) => {
      if (event.type === "extension_failed") failures.push(String((event as { reason?: string }).reason));
    });
    await load(
      rt,
      defineExtension({
        name: "fragile",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-commands"],
        setup(ctx) {
          ctx.registerCommand!({
            name: "boom",
            run: () => {
              throw new Error("backend down");
            },
          });
        },
      }),
    );
    const result = await rt.invokeCommand("boom", "");
    expect(result).toMatchObject({ ok: false, error: "backend down" });
    expect(failures).toContain("command_failed");
  });

  test("async handlers await their output (the headless door is a real run)", async () => {
    const rt = runtime();
    await load(
      rt,
      defineExtension({
        name: "slow",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-commands"],
        setup(ctx) {
          ctx.registerCommand!({
            name: "async-cmd",
            run: async ({ args }) => {
              await new Promise((resolve) => setTimeout(resolve, 5));
              return `done ${args}`;
            },
          });
        },
      }),
    );
    await expect(rt.invokeCommand("async-cmd", "now")).resolves.toEqual({ ok: true, extension: "slow", output: "done now" });
  });

  test("interleaved invocations keep independent owners (reentrancy, #1143)", async () => {
    const rt = runtime();
    const failures: string[] = [];
    rt.onLoadEvent((event) => {
      if (event.type === "extension_failed") failures.push(String((event as { reason?: string }).reason));
    });
    const opened: string[] = [];
    rt.onOverlayOpen((active) => opened.push(active.name));
    await load(
      rt,
      defineExtension({
        name: "reentrant",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-commands", "contribute-overlays"],
        setup(ctx) {
          const open = ctx.registerOverlay!({ name: "pick", render: () => "overlay" }).open;
          ctx.registerCommand!({
            name: "first",
            run: async () => {
              // Suspend: the second invocation runs to completion before
              // this one resumes — with a single owner field the second's
              // `finally` would have cleared the first's guard.
              await new Promise<void>((r) => setTimeout(r, 10));
              open();
              return "first done";
            },
          });
          ctx.registerCommand!({
            name: "second",
            run: async () => "second done",
          });
        },
      }),
    );
    const first = rt.invokeCommand("first", "");
    const secondResult = await rt.invokeCommand("second", "");
    const firstResult = await first;
    expect(opened).toEqual(["pick"]); // first's open() still accepted
    expect(failures).toEqual([]);
    expect(secondResult).toMatchObject({ ok: true, output: "second done" });
    expect(firstResult).toMatchObject({ ok: true });
  });

  test("a mixed-case name is refused as invalid (it could never answer to its slash form)", async () => {
    const rt = runtime();
    await load(
      rt,
      defineExtension({
        name: "shouty",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-commands"],
        setup(ctx) {
          ctx.registerCommand!({ name: "Deploy", run: () => "x" });
        },
      }),
    );
    expect(rt.extensionCommands()).toEqual([]);
    expect(rt.commandRefusals()).toEqual([{ extension: "shouty", name: "Deploy", reason: "invalid" }]);
  });

  test("a manifest whose capabilities lack the slot keeps the API absent even if the code declares it", async () => {
    // In-memory registration with a manifest authority (the bundled door):
    // the manifest is the authority consent signed — the code's own
    // declaration alone never widens it.
    const rt = runtime();
    await rt.register(
      defineExtension({
        name: "greedy",
        version: "1.0.0",
        apiVersion: "1.0",
        capabilities: ["contribute-commands"],
        setup(ctx) {
          if (typeof ctx.registerCommand === "function") ctx.registerCommand({ name: "grab", run: () => "x" });
        },
      }),
      { bundled: true, manifest: { hash: "h", path: "/tmp/greedy", capabilities: [] } },
    );
    await rt.ready();
    expect(rt.extensionCommands()).toEqual([]);
  });
});
