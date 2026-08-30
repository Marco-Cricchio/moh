import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../src/App";

/** #348 integration seam: App owns the shared opt-out and invokes the
 * core-owned skill discovery independently of both workflow gates. The
 * binary check is deliberately skipped in this repo (dev run), leaving
 * this fetch spy precise to skill-index traffic. */
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function homeWithConfig(config: unknown): string {
  const home = mkdtempSync(join(tmpdir(), "moh-update-poll-"));
  mkdirSync(join(home, ".moh"));
  writeFileSync(join(home, ".moh", "config"), JSON.stringify(config));
  return home;
}

function upstreamFetch(calls: string[]) {
  return (async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => JSON.stringify({ skills: [] }) };
  }) as typeof globalThis.fetch;
}

describe("App update polling (#348)", () => {
  test("discovers skills with workflow off and upstreamCheck false", async () => {
    const calls: string[] = [];
    globalThis.fetch = upstreamFetch(calls);
    const i = render(<App cwd={process.cwd()} home={homeWithConfig({
      updateCheck: true,
      workflow: { enabled: false, upstreamCheck: false },
    })} skipOnboarding env={{}} />);
    await Bun.sleep(30);
    expect(calls).toHaveLength(1);
    i.unmount();
  });

  test("the shared updateCheck opt-out suppresses skill-index traffic", async () => {
    const calls: string[] = [];
    globalThis.fetch = upstreamFetch(calls);
    const i = render(<App cwd={process.cwd()} home={homeWithConfig({
      updateCheck: false,
      workflow: { enabled: false, upstreamCheck: false },
    })} skipOnboarding env={{}} />);
    await Bun.sleep(30);
    expect(calls).toEqual([]);
    i.unmount();
  });
});
