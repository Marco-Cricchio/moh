/**
 * #774: from-config wiring — the browser tool rides the builtin assembly
 * when `browser.enabled` is set; a missing toolchain becomes the visible
 * `browser_unavailable` chrome event (never a session error); the live
 * browser is reaped at session dispose.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFromConfig } from "../src/session/from-config";
import type { AgentEvent } from "../src/types";
import { browserAvailability } from "../src/browser";

function tempProject(): { cwd: string; home: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "moh-browser-config-"));
  return { cwd: dir, home: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("from-config browser wiring", () => {
  test("zero config: no browser tool, no diagnostic events", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const events: AgentEvent[] = [];
      const result = sessionFromConfig({ cwd, home, overrides: { sink: (e) => events.push(e) } });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      expect(result.session.tools.browser).toBeUndefined();
      expect(events.filter((e) => e.type === "browser_unavailable")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("enabled: registered only with a toolchain, else the visible diagnostic fires", () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const events: AgentEvent[] = [];
      const result = sessionFromConfig({
        cwd,
        home,
        config: { provider: "mock", browser: { enabled: true } },
        overrides: { sink: (e) => events.push(e) },
      });
      expect("error" in result).toBe(false);
      if ("error" in result) return;
      // #935: availability is scoped to the session's project + home (the
      // project's own node_modules, then the moh-owned toolchain root), so
      // the probe must ask the same question the assembly did.
      const available = browserAvailability({ cwd, home }).available;
      if (available) {
        expect(result.session.tools.browser).toBeDefined();
        expect(events.filter((e) => e.type === "browser_unavailable")).toHaveLength(0);
      } else {
        expect(result.session.tools.browser).toBeUndefined();
        const diags = events.filter((e) => e.type === "browser_unavailable");
        expect(diags).toHaveLength(1);
        expect((diags[0] as { reason: string }).reason).toContain("moh browser install");
      }
    } finally {
      cleanup();
    }
  });

  test("dispose never throws with the browser seam wired", async () => {
    const { cwd, home, cleanup } = tempProject();
    try {
      const result = sessionFromConfig({
        cwd,
        home,
        config: { provider: "mock", browser: { enabled: true } },
      });
      if ("error" in result) throw new Error(result.error.message);
      await result.session.dispose();
    } finally {
      cleanup();
    }
  });
});
