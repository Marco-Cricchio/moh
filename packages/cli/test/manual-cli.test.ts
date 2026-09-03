import { describe, expect, test } from "bun:test";
import { manualCommand, MANUAL_USAGE } from "../src/manual";

/** #457: `moh manual [page]` — index and page printing over the bundled
 * assets. No network, no repo-relative reads at call time. */

function run(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = manualCommand({
    argv,
    stdout: { write: (s: string) => (stdout.push(s), true) } as unknown as NodeJS.WritableStream,
    stderr: { write: (s: string) => (stderr.push(s), true) } as unknown as NodeJS.WritableStream,
  });
  return { code, out: stdout.join(""), err: stderr.join("") };
}

describe("moh manual (#457)", () => {
  test("--help prints the usage", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain(MANUAL_USAGE);
  });

  test("no argument prints the index of all pages", () => {
    const { code, out } = run([]);
    expect(code).toBe(0);
    expect(out).toContain("sessions");
    expect(out).toContain("Sessions");
    expect(out).toContain("cli-reference");
    expect(out).toContain("Commands & keys");
    expect(out).toContain("moh manual <id>");
  });

  test("a page id prints the full page body", () => {
    const { code, out } = run(["sessions"]);
    expect(code).toBe(0);
    expect(out).toContain("# Sessions");
    expect(out).toContain("## Fork");
  });

  test("an unknown id exits 2 naming the known pages", () => {
    const { code, out, err } = run(["nope"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain('unknown page "nope"');
    expect(err).toContain("getting-started");
  });

  test("more than one page id is a usage error", () => {
    const { code, err } = run(["sessions", "mcp"]);
    expect(code).toBe(2);
    expect(err).toContain("at most one page id");
  });
});
