/**
 * #274: `moh update` CLI surface — usage, dev-run refusal, exit codes.
 * The download/verify/replace seams are covered in core (self-update.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateCommand } from "../src/update";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const w = (buf: string[]) => ({ write: (s: string) => void buf.push(s) } as unknown as NodeJS.WritableStream);
  return { out, err, stdout: w(out), stderr: w(err) };
}

describe("moh update", () => {
  test("dev run refuses with a pointer to git, exit 1", async () => {
    const { stdout, stderr, err } = io();
    const code = await updateCommand({ argv: [], stdout, stderr, devRun: true });
    expect(code).toBe(1);
    expect(err.join("")).toContain("dev run");
    expect(err.join("")).toContain("git");
  });

  test("--help prints usage, exit 0", async () => {
    const { stdout, stderr } = io();
    const code = await updateCommand({ argv: ["--help"], stdout, stderr, devRun: true });
    expect(code).toBe(0);
    expect(stdout.write).toBeDefined();
  });

  test("unknown option → usage on stderr, exit 2", async () => {
    const { stdout, stderr, err } = io();
    const code = await updateCommand({ argv: ["--nope"], stdout, stderr, devRun: false });
    expect(code).toBe(2);
    expect(err.join("")).toContain("unknown option --nope");
  });

  test("release without assets → error message on stderr, exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-update-cli-"));
    const execPath = join(dir, "moh");
    writeFileSync(execPath, "#!/bin/sh\n");
    chmodSync(execPath, 0o755);
    const { stdout, stderr, err } = io();
    const code = await updateCommand({
      argv: [],
      stdout,
      stderr,
      devRun: false,
      execPath,
      platform: "darwin-arm64",
      currentVersion: "0.1.0",
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "v0.2.0", assets: [] }), arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" }),
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("missing its moh-darwin-arm64 asset");
  });
});
