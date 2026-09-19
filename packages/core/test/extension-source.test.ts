/**
 * Client-loadable extensions (#834): the declared source and the trust
 * posture around it.
 *
 * The runtime (#34) already owns consent, the failure model and
 * hot-reload; this file pins the wiring a *client* adds — where files come
 * from, in which order, who is asked, and what happens when nobody can be
 * asked (headless fail-closed).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSession, ExtensionRuntime, MockProvider } from "../src/index";
import { extensionSourceFiles } from "../src/extension-source";
import { sessionFromConfig } from "../src/session/from-config";
import type { AgentEvent, ExtensionConsentRequest } from "../src/index";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(): { cwd: string; home: string; mohHome: string } {
  const dir = mkdtempSync(join(tmpdir(), "moh-ext-source-"));
  dirs.push(dir);
  const cwd = join(dir, "project");
  const home = join(dir, "home");
  const mohHome = join(home, ".moh");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(mohHome, { recursive: true });
  return { cwd, home, mohHome };
}

/** Writes a module; returns its path. */
function writeModule(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

/**
 * A minimal extension whose only visible effect is vetoing the `echo`
 * tool. Written as a plain object on purpose: the file lives in a temp
 * home, where `@moh/extension` (a workspace package) does not resolve —
 * the loader's contract is the *default export shape*, not where the
 * module's own imports point.
 */
const vetoExtension = (name: string, version = "1.0.0", extra = "") => `
export default {
  name: ${JSON.stringify(name)},
  version: ${JSON.stringify(version)},
  apiVersion: "1.0",
  ${extra}
  setup(ctx) {
    ctx.onToolCall(({ name }) => (name === "echo" ? { veto: true, reason: "from-${name}" } : undefined));
  },
};
`;

function turnOnEcho() {
  return MockProvider.scripted([
    { deltas: [], finish: "tool_calls", toolCalls: [{ name: "echo", args: { text: "hi" } }] },
    { deltas: ["ok"], finish: "stop" },
  ]);
}

const failedEvents = (events: readonly AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: "extension_failed" }> => e.type === "extension_failed");

describe("extensionSourceFiles (#834)", () => {
  test("the dotdir is sorted, filtered to loadable modules, and never walks directories", () => {
    const { cwd, mohHome } = tempProject();
    writeModule(join(mohHome, "extensions", "b-second.mjs"), "export default {};");
    writeModule(join(mohHome, "extensions", "a-first.ts"), "export default {};");
    writeModule(join(mohHome, "extensions", "notes.md"), "not a module");
    writeModule(join(mohHome, "extensions", "types.d.ts"), "export type X = 1;");
    writeModule(join(mohHome, "extensions", ".hidden.mjs"), "export default {};");
    writeModule(join(mohHome, "extensions", "nested", "c-nested.mjs"), "export default {};");

    expect(extensionSourceFiles({ mohHome, cwd })).toEqual([
      { file: join(mohHome, "extensions", "a-first.ts"), origin: "user" },
      { file: join(mohHome, "extensions", "b-second.mjs"), origin: "user" },
    ]);
  });

  test("project declarations resolve against the project and load after the dotdir, deduped", () => {
    const { cwd, mohHome } = tempProject();
    const user = writeModule(join(mohHome, "extensions", "shared.mjs"), "export default {};");
    const declared = writeModule(join(cwd, "extensions", "declared.mjs"), "export default {};");
    const sources = extensionSourceFiles({
      mohHome,
      cwd,
      // The dotdir file named again by the project loads once, and `/abs/path` stays as-is.
      declared: ["./extensions/declared.mjs", user, join(cwd, "extensions", "declared.mjs")],
    });
    expect(sources).toEqual([
      { file: user, origin: "user" },
      { file: declared, origin: "project" },
    ]);
  });

  test("no dotdir and no declaration is an empty list, never an error", () => {
    const { cwd, home } = tempProject();
    expect(extensionSourceFiles({ mohHome: join(home, "nope"), cwd })).toEqual([]);
  });
});


/** The one tool the extensions in this file veto; the registry override
 * keeps the session's other tools (built-ins) out of the way. */
const echoTool = {
  name: "echo",
  description: "echoes its text",
  inputSchema: undefined,
  execute: (args: { text: string }) => args.text,
};

/** Assembly helper: every call in this block runs a real client path —
 * `sessionFromConfig` with a temp home — over the echo tool. */
function assemble(
  options: Omit<Parameters<typeof sessionFromConfig>[0], "overrides">,
): ReturnType<typeof sessionFromConfig> {
  return sessionFromConfig({ ...options, overrides: { tools: { echo: echoTool } } });
}

async function withSession<T>(
  result: ReturnType<typeof sessionFromConfig>,
  body: (session: Extract<ReturnType<typeof sessionFromConfig>, { session: unknown }>["session"]) => Promise<T>,
): Promise<T> {
  if ("error" in result) throw new Error(result.error.message);
  try {
    return await body(result.session);
  } finally {
    await result.session.dispose();
  }
}

describe("sessionFromConfig loads the declared source (#834)", () => {
  test("files load in the resolved order: dotdir sorted, then the project's proposals", async () => {
    const { cwd, home, mohHome } = tempProject();
    writeModule(join(mohHome, "extensions", "b-second.mjs"), vetoExtension("second"));
    writeModule(join(mohHome, "extensions", "a-first.mjs"), vetoExtension("first"));
    writeModule(join(cwd, "extensions", "c-declared.mjs"), vetoExtension("declared"));
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ extensions: ["./extensions/c-declared.mjs"] }));
    await withSession(
      assemble({ cwd, home, provider: turnOnEcho(), consent: { onExtensionConsent: () => true } }),
      async (session) => {
        await session.send("go");
        // Hook precedence is registration order, so the order is the contract.
        const loaded = session
          .history()
          .filter((e) => e.type === "extension_loaded")
          .map((e) => (e as { name: string }).name);
        expect(loaded).toEqual(["first", "second", "declared"]);
        // The first veto wins on the tool call they all refuse.
        expect(session.history().find((e) => e.type === "permission_denied")).toMatchObject({ tool: "echo" });
      },
    );
  });

  test("a load that settled before the session existed still lands after session_start, in load order", async () => {
    const { mohHome } = tempProject();
    const first = writeModule(join(mohHome, "extensions", "a-first.mjs"), vetoExtension("first"));
    const second = writeModule(join(mohHome, "extensions", "b-second.mjs"), vetoExtension("second"));
    const declared = writeModule(join(mohHome, "extensions", "c-third.mjs"), vetoExtension("declared"));
    const runtime = new ExtensionRuntime({ mohHome, consent: () => true });
    // #834: the first file settles while no session exists yet — its load
    // event is buffered in the runtime, and the session picks it up at
    // construction. The log must still open with `session_start` and keep
    // the load order (the order the hooks decide in).
    void runtime.registerFile(first);
    await Bun.sleep(50);
    void runtime.registerFiles([second, declared]);
    const session = createSession({
      provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
      extensions: runtime,
    });
    await session.send("go");
    const history = session.history();
    expect(history[0]!.type).toBe("session_start");
    expect(
      history.filter((e) => e.type === "extension_loaded").map((e) => (e as { name: string }).name),
    ).toEqual(["first", "second", "declared"]);
    await session.dispose();
  });

  test("a consented file extension loads and its hooks run (end to end)", async () => {
    const { cwd, home, mohHome } = tempProject();
    const file = writeModule(join(mohHome, "extensions", "guard.mjs"), vetoExtension("guard"));
    const asked: ExtensionConsentRequest[] = [];
    await withSession(
      assemble({
        cwd,
        home,
        provider: turnOnEcho(),
        consent: {
          onExtensionConsent: (request) => {
            asked.push(request);
            return true;
          },
        },
      }),
      async (session) => {
        const turn = await session.send("go");
        // The prompt named the extension, its version and its source path.
        expect(asked).toEqual([{ name: "guard", version: "1.0.0", file }]);
        const history = session.history();
        expect(history.find((e) => e.type === "extension_loaded")).toMatchObject({ name: "guard", version: "1.0.0" });
        // The veto really came from the file — the tool call never ran.
        expect(history.find((e) => e.type === "permission_denied")).toMatchObject({ tool: "echo", reason: "extension" });
        expect(turn.status).toBe("done");
      },
    );
  });

  test("consent is remembered for the same bytes; editing the file asks again", async () => {
    const { cwd, home, mohHome } = tempProject();
    const file = writeModule(join(mohHome, "extensions", "guard.mjs"), vetoExtension("guard"));
    await withSession(assemble({ cwd, home, provider: turnOnEcho(), consent: { onExtensionConsent: () => true } }), async (session) => {
      await session.send("go");
    });

    // Same bytes, a seam that would refuse: nothing is asked.
    let asks = 0;
    await withSession(
      assemble({
        cwd,
        home,
        provider: turnOnEcho(),
        consent: {
          onExtensionConsent: () => {
            asks += 1;
            return false;
          },
        },
      }),
      async (session) => {
        await session.send("go");
        expect(session.history().find((e) => e.type === "extension_loaded")).toMatchObject({ name: "guard" });
        expect(asks).toBe(0);
      },
    );

    // Edited bytes: the content identity changed, so consent is asked again
    // — and a refusal means the extension does not run.
    writeModule(file, `${vetoExtension("guard", "1.1.0")}\n// edited\n`);
    let askedAgain = 0;
    await withSession(
      assemble({
        cwd,
        home,
        provider: turnOnEcho(),
        consent: {
          onExtensionConsent: () => {
            askedAgain += 1;
            return false;
          },
        },
      }),
      async (session) => {
        await session.send("go");
        expect(askedAgain).toBe(1);
        expect(failedEvents(session.history()).some((e) => e.reason === "consent")).toBe(true);
        expect(session.history().some((e) => e.type === "extension_loaded")).toBe(false);
      },
    );
  });

  test("headless (no consent seam) fails closed: the load is skipped, visibly, and the turn still runs", async () => {
    const { cwd, home, mohHome } = tempProject();
    writeModule(join(mohHome, "extensions", "guard.mjs"), vetoExtension("guard"));
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      // No consent seam: nothing can ask, so nothing is enabled — and the
      // session runs exactly as it would have without the file.
      await withSession(assemble({ cwd, home, provider: turnOnEcho() }), async (session) => {
        const turn = await session.send("go");
        expect(turn.status).toBe("done");
        expect(failedEvents(session.history()).find((e) => e.name === "guard")).toMatchObject({ reason: "consent" });
        // The call is denied by the ordinary headless fail-fast, never by
        // the extension that was not loaded.
        expect(session.history().find((e) => e.type === "permission_denied")).toMatchObject({ reason: "headless" });
        // One line on the human channel too (the headless client's only one).
        expect(lines.join("")).toContain("guard");
      });
    } finally {
      (process.stderr as unknown as { write: typeof write }).write = write;
    }
  });

  test("a moh.json declaration is only a proposal: refused without consent, loaded with it", async () => {
    const { cwd, home } = tempProject();
    const declared = writeModule(join(cwd, "extensions", "declared.mjs"), vetoExtension("declared"));
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ extensions: ["./extensions/declared.mjs"] }));

    await withSession(assemble({ cwd, home, provider: turnOnEcho() }), async (session) => {
      await session.send("go");
      expect(failedEvents(session.history()).some((e) => e.reason === "consent")).toBe(true);
      expect(session.history().find((e) => e.type === "permission_denied")).toMatchObject({ reason: "headless" });
    });

    const asked: ExtensionConsentRequest[] = [];
    await withSession(
      assemble({
        cwd,
        home,
        provider: turnOnEcho(),
        consent: {
          onExtensionConsent: (request) => {
            asked.push(request);
            return true;
          },
        },
      }),
      async (session) => {
        await session.send("go");
        expect(asked).toEqual([{ name: "declared", version: "1.0.0", file: declared }]);
        expect(session.history().find((e) => e.type === "permission_denied")).toMatchObject({ tool: "echo" });
      },
    );
  });

  test("a declared dependency is refused loudly: no host installs them (v1)", async () => {
    const { cwd, home, mohHome } = tempProject();
    writeModule(
      join(mohHome, "extensions", "needy.mjs"),
      vetoExtension("needy", "1.0.0", 'dependencies: ["left-pad@1.0.0"],'),
    );
    await withSession(
      assemble({ cwd, home, provider: turnOnEcho(), consent: { onExtensionConsent: () => true } }),
      async (session) => {
        await session.send("go");
        const failure = failedEvents(session.history()).find((e) => e.name === "needy");
        expect(failure).toMatchObject({ reason: "deps_unauthorized" });
        expect(failure!.message).toContain("left-pad@1.0.0");
        expect(session.history().some((e) => e.type === "extension_loaded")).toBe(false);
      },
    );
  });

  test("a broken file is one visible failure; the session continues", async () => {
    const { cwd, home, mohHome } = tempProject();
    writeModule(join(mohHome, "extensions", "a-broken.mjs"), "this is not javascript(");
    writeModule(join(mohHome, "extensions", "b-not-an-extension.mjs"), "export default { name: 'x' };");
    writeModule(join(mohHome, "extensions", "c-good.mjs"), vetoExtension("good"));
    await withSession(
      assemble({ cwd, home, provider: turnOnEcho(), consent: { onExtensionConsent: () => true } }),
      async (session) => {
        const turn = await session.send("go");
        expect(turn.status).toBe("done");
        const failures = failedEvents(session.history());
        expect(failures.some((e) => e.reason === "load_failed")).toBe(true);
        expect(failures.some((e) => e.reason === "invalid")).toBe(true);
        // The healthy extension in the same directory still loaded (and its
        // veto applied where it could).
        expect(session.history().find((e) => e.type === "extension_loaded")).toMatchObject({ name: "good" });
        expect(failures.filter((e) => e.reason === "consent")).toHaveLength(0);
      },
    );
  });

  test("a loaded file hot-reloads mid-session, state preserved", async () => {
    const { cwd, home, mohHome } = tempProject();
    const file = writeModule(join(mohHome, "extensions", "hot.mjs"), hotModule("1.0.0"));
    await withSession(
      assemble({
        cwd,
        home,
        provider: MockProvider.scripted([{ deltas: ["ok"], finish: "stop" }]),
        consent: { onExtensionConsent: () => true },
      }),
      async (session) => {
        await session.send("hi");
        writeModule(file, hotModule("2.0.0"));
        // The session's own watcher (startWatch at session start) picks the
        // change up; `loads` survives the swap.
        await Bun.sleep(500);
        const versions = session
          .history()
          .filter((e) => e.type === "extension_loaded")
          .map((e) => (e as { version: string }).version);
        expect(versions).toEqual(["1.0.0", "2.0.0"]);
        expect((await session.send("again")).status).toBe("done");
      },
    );
  });
});

/** A file extension that counts its own setups in `ctx.state` (the state a
 * hot-reload must carry over). */
const hotModule = (version: string) =>
  `export default { name: "hot", version: ${JSON.stringify(version)}, apiVersion: "1.0",
     setup(ctx) { ctx.state.loads = ((ctx.state.loads ?? 0) + 1); } };`;
