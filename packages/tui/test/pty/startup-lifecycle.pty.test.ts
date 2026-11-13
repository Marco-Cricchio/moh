import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPOSER_READY } from "../helpers";
import { DEV_CONFIG, hasPython, runPtyRaw } from "./pty-runner";

const fixture = () => mkdtempSync(join(tmpdir(), "moh-pty-startup-test-"));

describe.skipIf(!hasPython)("PTY startup and child lifecycle (#1749)", () => {
  test("a cold child can start slowly before the first byte and still reach the real Home frame", async () => {
    const root = fixture();
    try {
      const preload = join(root, "cold-start.ts");
      // Controlled process-boundary latency, not a wait for a UI assertion.
      // This exceeds the old 2.5s boot pump + 8s Home condition deadline.
      writeFileSync(preload, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 11_000);\n");
      const result = await runPtyRaw({
        cols: 100, rows: 30, config: DEV_CONFIG,
        env: { BUN_OPTIONS: `--preload ${preload}`, MOH_SECRET_STORE: "file" },
        steps: [{ until: "New session", wait: 8, untilOnScreen: true }],
      });
      expect(result.lines.some((line) => line.text.includes("New session"))).toBe(true);
      expect(result.aliveAtEnd).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 45_000);

  test("the child uses its isolated file store even when the caller requests a native store", async () => {
    const root = fixture();
    try {
      const bin = join(root, "bin"); mkdirSync(bin);
      const marker = join(root, "native-store-called");
      const receipt = join(root, "store.json");
      const security = join(bin, "security");
      writeFileSync(security, '#!/bin/sh\nprintf called > "$MOH_NATIVE_STORE_MARKER"\nexit 1\n');
      chmodSync(security, 0o755);
      const preload = join(root, "store-probe.ts");
      writeFileSync(preload, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({store:process.env.MOH_SECRET_STORE, executable:process.execPath}));`);
      await runPtyRaw({
        cols: 100, rows: 30, config: DEV_CONFIG,
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`, MOH_SECRET_STORE: "native",
          MOH_NATIVE_STORE_MARKER: marker, BUN_OPTIONS: `--preload ${preload}`,
        },
        steps: [
          { until: "New session", wait: 8, untilOnScreen: true },
          { send: btoa("credential isolation") },
          { until: "start “credential isolation”", wait: 5, untilOnScreen: true },
          { send: btoa("\r") },
          { until: COMPOSER_READY, wait: 8, untilOnScreen: true },
        ],
      });
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual({ store: "file", executable: process.execPath });
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 60_000);

  test("a silent early exit reports the child state instead of spending a Home deadline", async () => {
    const root = fixture();
    try {
      const preload = join(root, "exit.ts");
      writeFileSync(preload, "process.exit(23);\n");
      let failure = "";
      try {
        await runPtyRaw({ cols: 100, rows: 30, env: { BUN_OPTIONS: `--preload ${preload}` }, steps: [{ until: "New session", wait: 8 }] });
      } catch (error) { failure = String(error); }
      expect(failure).toContain("before first PTY output");
      expect(failure).toContain("exit=23");
      expect(failure).toContain("bytes=0");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  test("the parent deadline lets the harness terminate and reap a quiet child", async () => {
    const root = fixture();
    try {
      const preload = join(root, "held.ts");
      writeFileSync(preload, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);\n");
      let failure = "";
      try {
        await runPtyRaw({ cols: 100, rows: 30, timeoutMs: 5000, env: { BUN_OPTIONS: `--preload ${preload}` }, steps: [{ until: "New session", wait: 8 }] });
      } catch (error) { failure = String(error); }
      expect(failure).toContain("pty harness timed out after 5000ms");
      const pid = Number(/child pid=(\d+)/.exec(failure)?.[1]);
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
});
