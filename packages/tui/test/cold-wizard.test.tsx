import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ColdWizard, type ColdWizardSeams } from "../src/ColdWizard";
import { ThemeProvider, THEMES, DEFAULT_THEME } from "../src/themes";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeOffer(overrides: Record<string, unknown> = {}) {
  return {
    projectSlug: "project-a",
    updatedAt: "2026-09-03T00:00:00.000Z",
    git: { branch: "develop", head: "abc", dirty: false },
    lastUserMessage: "Continue the migration",
    repoUrl: "https://github.com/acme/project-a.git",
    url: "https://gist.github.com/one",
    ...overrides,
  };
}

const payload = {
  version: 2 as const, kind: "raw" as const, sessionId: "session", updatedAt: "2026-09-03T00:00:00.000Z",
  git: { branch: "develop", head: "abc", dirty: false }, turns: 2,
  lastUserMessage: "Continue the migration", lastAssistantMessage: "Done",
  files: [], tests: [], counts: { toolCalls: 0, errors: 0, cancelled: 0 },
};

function mount(props: Parameters<typeof ColdWizard>[0]) {
  return render(
    <ThemeProvider value={THEMES[DEFAULT_THEME]}>
      <ColdWizard {...props} />
    </ThemeProvider>,
  );
}

const seams = (): ColdWizardSeams & { cloned: { repoUrl: string; dest: string } | null } => {
  let cloned: { repoUrl: string; dest: string } | null = null;
  return {
    cloned: null,
    get state() { return cloned; },
    clone: async (opts: { repoUrl: string; dest: string }) => {
      cloned = { repoUrl: opts.repoUrl, dest: opts.dest };
      // surface to the test via the returned object's property bag
      (seams as unknown as { lastClone?: unknown }).lastClone = cloned;
      return { ok: true, path: join(opts.dest, "project-a") };
    },
    pull: async () => ({ ok: true, payload }),
    ghUser: async () => ({ ok: true, user: "octo" }),
  } as unknown as ColdWizardSeams & { cloned: { repoUrl: string; dest: string } | null };
};

describe("cold-directory wizard (#595)", () => {
  test("offer picker → location prompt (cwd proposed) → clone → pull → proceeds with the seeded payload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-cold-"));
    const s = seams();
    let proceeded: { path: string; stale: boolean } | null = null;
    const i = mount({
      offers: [makeOffer()],
      cwd: dir,
      seams: s,
      onProceed: (args) => { proceeded = { path: args.path, stale: args.stale }; },
      onClose: () => {},
    });
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("project-a");
    i.stdin.write("\r"); // choose the offer
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("clone where?");
    // The dialog wraps long paths; compare whitespace-free.
    const flat = (s: string) => stripAnsi(s).replace(/\s+/g, "");
    expect(flat(i.lastFrame() ?? "")).toContain(dir.slice(0, 30));
    i.stdin.write("\r"); // confirm the proposed location
    await sleep(50);
    expect(proceeded).not.toBeNull();
    expect(proceeded!.path).toBe(join(dir, "project-a"));
    expect(proceeded!.stale).toBe(true); // the temp clone has no .git: the anchor can never match
    i.unmount();
  });

  test("a legacy gist without repoUrl asks for the path and skips the clone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-cold-"));
    const existing = mkdtempSync(join(tmpdir(), "moh-existing-"));
    let cloned = false;
    let proceeded: { path: string } | null = null;
    let pulledCwd: string | null = null;
    const i = mount({
      offers: [makeOffer({ repoUrl: undefined })],
      cwd: dir,
      seams: {
        clone: async () => { cloned = true; return { ok: true as const, path: "/never" }; },
        pull: async (opts: { cwd: string }) => { pulledCwd = opts.cwd; return { ok: true as const, payload }; },
        ghUser: async () => ({ ok: true as const, user: "octo" }),
      },
      onProceed: (args: { path: string }) => { proceeded = args; },
      onClose: () => {},
    });
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "").replace(/\s+/g, " ");
    expect(frame).toContain("repoUrl");
    i.stdin.write("\r");
    await sleep(30);
    i.stdin.write(existing);
    await sleep(30);
    i.stdin.write("\r");
    await sleep(50);
    expect(cloned).toBe(false);
    expect(pulledCwd as unknown as string).toBe(existing);
    expect((proceeded as { path: string } | null)?.path).toBe(existing);
    i.unmount();
  });

  test("esc on the picker closes; cancel leaves nothing half-done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-cold-"));
    let closed = false;
    const i = mount({
      offers: [makeOffer()],
      cwd: dir,
      seams: { pull: async () => ({ ok: true, payload }), clone: async () => ({ ok: true, path: "/x" }), ghUser: async () => ({ ok: true, user: "u" }) },
      onProceed: () => {},
      onClose: () => { closed = true; },
    });
    await sleep(30);
    i.stdin.write("\x1b");
    await sleep(30);
    expect(closed).toBe(true);
    i.unmount();
  });

  test("a failed clone shows the error and nothing proceeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moh-cold-"));
    let proceeded = 0;
    const i = mount({
      offers: [makeOffer()],
      cwd: dir,
      seams: {
        clone: async () => ({ ok: false, reason: "failed", message: "fatal: repository not found" }),
        pull: async () => ({ ok: true, payload }),
        ghUser: async () => ({ ok: true, user: "u" }),
      },
      onProceed: () => { proceeded += 1; },
      onClose: () => {},
    });
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("repository not found");
    expect(proceeded).toBe(0);
    i.unmount();
  });
});
