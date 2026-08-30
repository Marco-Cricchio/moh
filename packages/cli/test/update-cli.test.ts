/**
 * #274: `moh update` CLI surface — usage, dev-run refusal, exit codes.
 * The download/verify/replace seams are covered in core (self-update.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateCommand } from "../src/update";
import { formatBytes } from "../src/update-progress";

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

/** #351: phase milestone lines in piped (non-TTY) runs — plain ✓/✗ lines,
 * one per phase, final message after them; no ANSI, no spinner. */
describe("moh update progress lines (non-TTY)", () => {
  const PAYLOAD = new TextEncoder().encode("#!/bin/sh\necho new\n");

  function checksum(data: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(data).digest("hex");
  }

  function happyFetch(): NonNullable<Parameters<typeof updateCommand>[0]["fetch"]> {
    const sums = `${checksum(PAYLOAD)}  moh-darwin-arm64\n`;
    return async (url: string) => {
      if (url.includes("checksums.txt")) {
        return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), text: async () => sums };
      }
      if (url.includes("moh-darwin-arm64")) {
        const buf = PAYLOAD.buffer.slice(PAYLOAD.byteOffset, PAYLOAD.byteOffset + PAYLOAD.byteLength) as ArrayBuffer;
        return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => buf, text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: "v0.2.0",
          assets: [
            { name: "moh-darwin-arm64", browser_download_url: "http://x/dl/moh-darwin-arm64" },
            { name: "checksums.txt", browser_download_url: "http://x/dl/checksums.txt" },
          ],
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
        text: async () => "",
      };
    };
  }

  function fakeExec(): string {
    const dir = mkdtempSync(join(tmpdir(), "moh-update-cli-"));
    const path = join(dir, "moh");
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    return path;
  }

  test("successful update prints all four milestone lines then the final message", async () => {
    const { stdout, out } = io();
    const code = await updateCommand({
      argv: [],
      stdout,
      stderr: io().stderr,
      devRun: false,
      execPath: fakeExec(),
      platform: "darwin-arm64",
      currentVersion: "0.1.0",
      fetch: happyFetch(),
    });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("✓ Checking for the latest release");
    expect(text).toContain(`✓ Downloading the update — ${formatBytes(PAYLOAD.byteLength)}`);
    expect(text).toContain("✓ Verifying checksum");
    expect(text).toContain("✓ Installing the new binary");
    expect(text).toContain("updated moh 0.1.0 → 0.2.0");
    // Milestone ordering: checking < downloading < verifying < installing < final.
    const order = ["Checking", "Downloading", "Verifying", "Installing", "updated moh"].map((s) => text.indexOf(s));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
    expect(text.includes("\x1b")).toBe(false); // no ANSI in piped mode
  });

  test("up-to-date prints only the checking line", async () => {
    const { stdout, out } = io();
    const errIo = io();
    const code = await updateCommand({
      argv: [],
      stdout,
      stderr: errIo.stderr,
      devRun: false,
      execPath: fakeExec(),
      platform: "darwin-arm64",
      currentVersion: "0.2.0",
      fetch: happyFetch(),
    });
    expect(code).toBe(0);
    // up-to-date keeps the existing contract: result message on stderr.
    expect(out.join("")).toBe("✓ Checking for the latest release\n");
    expect(errIo.err.join("")).toContain("already the latest stable release");
  });

  test("checksum mismatch commits the verifying line with ✗, final error on stderr", async () => {
    const { stdout, out } = io();
    const errStream = io();
    const code = await updateCommand({
      argv: [],
      stdout,
      stderr: errStream.stderr,
      devRun: false,
      execPath: fakeExec(),
      platform: "darwin-arm64",
      currentVersion: "0.1.0",
      fetch: async (url: string) => {
        if (url.includes("checksums.txt")) {
          return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), text: async () => `${"0".repeat(64)}  moh-darwin-arm64\n` };
        }
        return happyFetch()(url);
      },
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("✗ Verifying checksum");
    expect(errStream.err.join("")).toContain("checksum mismatch");
  });

  test("download failure commits the downloading line with ✗", async () => {
    const { stdout, out } = io();
    const errStream = io();
    const code = await updateCommand({
      argv: [],
      stdout,
      stderr: errStream.stderr,
      devRun: false,
      execPath: fakeExec(),
      platform: "darwin-arm64",
      currentVersion: "0.1.0",
      fetch: async (url: string) => {
        if (url.includes("moh-darwin-arm64") && !url.includes("checksums.txt") && !url.includes("releases")) {
          return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0), text: async () => "" };
        }
        return happyFetch()(url);
      },
    });
    expect(code).toBe(1);
    expect(out.join("")).toContain("✗ Downloading the update");
    expect(errStream.err.join("")).toContain("could not download");
  });
});
