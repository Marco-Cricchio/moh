import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { BROWSER_USAGE } from "../src/browser";
import { COMPACT_USAGE } from "../src/compact";
import { EXTENSION_USAGE } from "../src/extension";
import { HANDOFF_USAGE } from "../src/handoff";
import { JEV_USAGE } from "../src/jev";
import { LANES_USAGE } from "../src/lanes";
import { MANUAL_USAGE } from "../src/manual";
import { MCP_USAGE } from "../src/mcp";
import { MPM_USAGE } from "../src/mpm";
import { PROVIDER_USAGE } from "../src/provider";
import { RETRO_USAGE } from "../src/retro";
import { RUN_USAGE } from "../src/run";
import { SECRET_USAGE } from "../src/secret";
import { SERVE_USAGE } from "../src/serve";
import { SESSIONS_USAGE } from "../src/sessions";
import { TRASH_USAGE } from "../src/trash";
import { UPDATE_USAGE } from "../src/update";
import { USAGE_USAGE } from "../src/usage";
import { runCli, SPAWN_TEST_TIMEOUT_MS } from "./spawn-harness";

/**
 * Characterization of the top-level dispatcher (`main` in src/cli.ts)
 * before the dispatch blocks are replaced by a table (#1446). Every case
 * here either exits before any command runs (help, usage errors, the
 * `--yolo` / removed-flag / `--version` guards) or intercepts `-h`/`--help`
 * before the command body, so none of them touches the filesystem or the
 * network. The one case that writes files (`moh init`) runs in a child
 * process with its own working directory.
 */

/** Commands whose dispatch block answers `-h`/`--help` with their usage. */
const USAGE_COMMANDS: Array<[string, string]> = [
  ["run", RUN_USAGE],
  ["serve", SERVE_USAGE],
  ["mcp", MCP_USAGE],
  ["extension", EXTENSION_USAGE],
  ["provider", PROVIDER_USAGE],
  ["update", UPDATE_USAGE],
  ["compact", COMPACT_USAGE],
  ["mpm", MPM_USAGE],
  ["sessions", SESSIONS_USAGE],
  ["trash", TRASH_USAGE],
  ["lanes", LANES_USAGE],
  ["usage", USAGE_USAGE],
  ["jev", JEV_USAGE],
  ["secret", SECRET_USAGE],
  ["handoff", HANDOFF_USAGE],
  ["browser", BROWSER_USAGE],
  ["retro", RETRO_USAGE],
];

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `main` in-process and captures both streams. */
async function capture(argv: string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const writeOut = process.stdout.write;
  const writeErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, stdout: out.join(""), stderr: err.join("") };
  } finally {
    process.stdout.write = writeOut;
    process.stderr.write = writeErr;
  }
}

describe("moh dispatcher: -h / --help interception", () => {
  for (const [command, usage] of USAGE_COMMANDS) {
    test(`${command} prints its usage for -h and --help, wherever they sit`, async () => {
      for (const flag of ["-h", "--help"]) {
        const first = await capture([command, flag]);
        expect(first).toEqual({ code: 0, stdout: usage + "\n", stderr: "" });
        const last = await capture([command, "x", flag]);
        expect(last).toEqual({ code: 0, stdout: usage + "\n", stderr: "" });
      }
    });
  }

  test("manual answers --help and -h from inside its own command, not the dispatcher", async () => {
    for (const argv of [["manual", "-h"], ["manual", "--help"], ["manual", "x", "--help"]]) {
      expect(await capture(argv)).toEqual({ code: 0, stdout: MANUAL_USAGE + "\n", stderr: "" });
    }
  });

  test("lanes answers --help before its remove and delete sub-dispatch", async () => {
    for (const argv of [["lanes", "remove", "--help"], ["lanes", "delete", "-h"]]) {
      expect(await capture(argv)).toEqual({ code: 0, stdout: LANES_USAGE + "\n", stderr: "" });
    }
  });
});

describe("moh dispatcher: help and version", () => {
  test("--help and help ignore trailing arguments and print the root help", async () => {
    const root = await capture(["help"]);
    expect(root.code).toBe(0);
    expect(root.stdout.startsWith("moh — headless coding agent\n")).toBe(true);
    expect(await capture(["--help", "junk"])).toEqual(root);
    expect(await capture(["help", "junk"])).toEqual(root);
  });

  test("--version and -v reject arguments, including -h and the removed flag", async () => {
    const message = { stdout: "", stderr: "moh --version takes no arguments\n" };
    expect(await capture(["--version", "-h"])).toEqual({ code: 2, ...message });
    expect(await capture(["--version", "--dangerously-bypass-permissions"])).toEqual({ code: 2, ...message });
    expect(await capture(["-v", "x"])).toEqual({ code: 2, ...message });
  });
});

describe("moh dispatcher: tui and init", () => {
  test("tui takes no arguments: extra words, -h and --help are all usage errors", async () => {
    const message = { stdout: "", stderr: "moh tui takes no arguments\n" };
    expect(await capture(["tui", "extra"])).toEqual({ code: 2, ...message });
    expect(await capture(["tui", "--help"])).toEqual({ code: 2, ...message });
    expect(await capture(["tui", "--yolo", "extra"])).toEqual({ code: 2, ...message });
  });

  test("init does not intercept -h or --help: any argument is a usage error", async () => {
    const message = { stdout: "", stderr: "moh init takes no arguments\n" };
    expect(await capture(["init", "--help"])).toEqual({ code: 2, ...message });
    expect(await capture(["init", "-h"])).toEqual({ code: 2, ...message });
    expect(await capture(["init", "x"])).toEqual({ code: 2, ...message });
  });

  test("init with --yolo reports the --yolo placement error, not the argument error", async () => {
    expect(await capture(["init", "--yolo"])).toEqual({
      code: 2,
      stdout: "",
      stderr: `moh: --yolo applies to the TUI launch; use "moh --yolo" or "moh tui --yolo"\n`,
    });
  });

  test("init with no arguments scaffolds the project in the working directory", () => {
    const cwd = mkdtempSync(join(tmpdir(), "moh-dispatch-init-"));
    const home = mkdtempSync(join(tmpdir(), "moh-dispatch-home-"));
    const first = runCli(["init"], { cwd, home });
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/created\s+docs\/agents\/issue-tracker\.md/);
    expect(first.stdout).toMatch(/created\s+AGENTS\.md/);
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    const second = runCli(["init"], { cwd, home });
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/kept\s+docs\/agents\/domain\.md/);
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe("moh dispatcher: usage errors before any command runs", () => {
  test("the removed --dangerously-bypass-permissions flag fails in any position", async () => {
    const message = "moh: --dangerously-bypass-permissions was removed; use --yolo\n";
    expect(await capture(["run", "--dangerously-bypass-permissions"])).toEqual({ code: 2, stdout: "", stderr: message });
    expect(await capture(["init", "--dangerously-bypass-permissions"])).toEqual({ code: 2, stdout: "", stderr: message });
  });

  test("--yolo with a non-TUI word is a placement error", async () => {
    expect(await capture(["--yolo", "help"])).toEqual({
      code: 2,
      stdout: "",
      stderr: `moh: unexpected argument (bare moh opens the TUI; did you mean "moh run …"?)\n`,
    });
    expect(await capture(["extension", "--yolo"])).toEqual({
      code: 2,
      stdout: "",
      stderr: `moh: --yolo applies to the TUI launch; use "moh --yolo" or "moh tui --yolo"\n`,
    });
  });

  test("unknown words fail with exit 2 and the root help, even when they carry -h", async () => {
    const root = await capture(["help"]);
    for (const argv of [["-h"], ["junk", "--help"], ["junk"]]) {
      const got = await capture(argv);
      expect(got.code).toBe(2);
      expect(got.stdout).toBe("");
      expect(got.stderr.endsWith(root.stdout)).toBe(true);
      expect(got.stderr.startsWith(`moh: unknown command "${argv[0]}"\n\n`)).toBe(true);
    }
  });

  test("prototype property names are unknown commands, not dispatch targets", async () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      const got = await capture([name]);
      expect(got.code).toBe(2);
      expect(got.stderr.startsWith(`moh: unknown command "${name}"\n\n`)).toBe(true);
    }
  });
});
