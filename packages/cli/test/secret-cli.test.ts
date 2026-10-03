/**
 * `moh secret set/rm/list` (#1161, ADR-0069): the user-mint surface,
 * in-process through main(argv) with a pinned home. The 0600-file
 * fallback backs the store in tests (no keychain calls); values arrive
 * on stdin and are never echoed back.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";

const homes: string[] = [];

function pinnedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "moh-secret-cli-"));
  homes.push(home);
  process.env.HOME = home;
  return home;
}

function secretFile(home: string): string {
  return join(home, ".moh", "secrets.json");
}

/** Runs one command with `value` as the whole of stdin. */
async function run(argv: string[], value = ""): Promise<number> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
  // The dispatch passes Bun.stdin by default; main() has no stdin param,
  // so drive secretCommand's stdin through a global swap the way the
  // CLI's own test fixtures do — here, via direct module call instead.
  const { secretCommand } = await import("../src/secret");
  return secretCommand({
    argv,
    home: process.env.HOME,
    stdin: stream,
    stdout: { write: (s) => (out += s) },
    stderr: { write: (s) => (err += s) },
  });
}

let out = "";
let err = "";

describe("moh secret", () => {
  test("set stores via stdin, list shows the name only, rm deletes; the value never echoes", async () => {
    const home = pinnedHome();
    expect(await run(["set", "deploy-key"], "s3cret\n")).toBe(0);
    expect(out).toContain("`deploy-key` stored");
    expect(out).not.toContain("s3cret");

    const file = secretFile(home);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("s3cret");
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600");

    out = "";
    expect(await run(["list"])).toBe(0);
    expect(out).toBe("deploy-key\n");

    out = "";
    expect(await run(["rm", "deploy-key"])).toBe(0);
    expect(out).toContain("deleted");
    expect(await run(["rm", "deploy-key"])).toBe(1);
  });

  test("set over an existing ref replaces silently; empty stdin is refused", async () => {
    pinnedHome();
    expect(await run(["set", "k"], "one\n")).toBe(0);
    expect(await run(["set", "k"], "two\n")).toBe(0);
    out = "";
    expect(await run(["list"])).toBe(0);
    expect(out).toBe("k\n");
    expect(await run(["set", "k"], "")).toBe(2);
    expect(err).toContain("empty value");
  });

  test("usage errors exit 2 with the usage text; unknown subcommand refused", async () => {
    pinnedHome();
    err = "";
    expect(await run([])).toBe(2);
    expect(out + err).toContain("usage: moh secret");
    expect(await run(["frobnicate"])).toBe(2);
    expect(await run(["set"])).toBe(2);
  });
});

describe("moh secret: main() routing", () => {
  test("the dispatch reaches the command through main(argv)", async () => {
    const home = pinnedHome();
    // `moh secret list` with no store: exit 0, empty report.
    const originalStdout = process.stdout.write.bind(process.stdout);
    let routed = "";
    process.stdout.write = (s: string) => ((routed += s), true);
    try {
      const code = await main(["secret", "list"]);
      expect(code).toBe(0);
      expect(routed).toContain("no secrets stored");
    } finally {
      process.stdout.write = originalStdout;
    }
    expect(existsSync(secretFile(home))).toBe(false);
  });

  test("a set through main() lands the secret at the real path (the store owns the .moh join)", async () => {
    const home = pinnedHome();
    const originalStdin = Bun.stdin.stream;
    Bun.stdin.stream = (() =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("s3cret\n"));
          controller.close();
        },
      })) as typeof Bun.stdin.stream;
    const originalStdout = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try {
      expect(await main(["secret", "set", "deploy-key"])).toBe(0);
    } finally {
      Bun.stdin.stream = originalStdin;
      process.stdout.write = originalStdout;
    }
    const file = join(home, ".moh", "secrets.json");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("s3cret");
    // No doubled namespace: the moh dotdir holds the file directly.
    expect(existsSync(join(home, ".moh", ".moh"))).toBe(false);
  });
});

for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
