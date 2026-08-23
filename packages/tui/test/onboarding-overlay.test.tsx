import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { existsSync, readFileSync } from "node:fs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMohConfig } from "@moh/core";
import { Onboarding } from "../src/OnboardingOverlay";
import { stripAnsi } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempHome = () => mkdtempSync(join(tmpdir(), "moh-obt-home-"));
const tempCwd = () => mkdtempSync(join(tmpdir(), "moh-obt-"));
const okTester = async () => ({ ok: true as const, modelId: "tested" });
const failTester = async () => ({ ok: false as const, error: "HTTP 401 unauthorized" });

function typeInto(i: ReturnType<typeof render>, text: string) {
  i.stdin.write(text);
}

describe("onboarding overlay (issue #33)", () => {
  test("detected env key is confirmed in one step and saved without an inline key", async () => {
    const cwd = tempCwd();
    const home = tempHome();
    const done: (string | null)[] = [];
    const i = render(
      <Onboarding
        cwd={cwd}
        home={home}
        env={{ ANTHROPIC_API_KEY: "sk-test" }}
        tester={okTester}
        onDone={(ref) => done.push(ref)}
      />,
    );
    await sleep(30);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("ANTHROPIC_API_KEY");
    expect(frame).toContain("claude-sonnet-4-5");
    i.stdin.write("\r"); // one confirm
    await sleep(100);
    expect(done).toEqual(["anthropic/claude-sonnet-4-5"]);
    const config = loadMohConfig(join(cwd, "moh.json"));
    expect(config.provider).toBe("anthropic/claude-sonnet-4-5");
    expect(config.endpoints![0]!.apiKey).toBeUndefined();
    i.unmount();
  });

  test("nothing detected → wizard collects type/model/base URL and passes the connection test", async () => {
    const cwd = tempCwd();
    const home = tempHome();
    const done: (string | null)[] = [];
    const i = render(<Onboarding cwd={cwd} home={home} env={{}} tester={okTester} onDone={(ref) => done.push(ref)} />);
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Pick a provider type");

    i.stdin.write("\x1b[B"); // down x3 → openai-compat
    await sleep(10);
    i.stdin.write("\x1b[B");
    await sleep(10);
    i.stdin.write("\x1b[B");
    await sleep(30);
    i.stdin.write("\r");
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Default model");
    typeInto(i, "qwen3");
    await sleep(10);
    i.stdin.write("\r");
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("API key");
    i.stdin.write("\r"); // empty key → env/local
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Base URL");
    typeInto(i, "http://localhost:11434/v1");
    await sleep(10);
    i.stdin.write("\r");
    await sleep(100);

    // Save-scope chooser (#129): brand-new endpoint, no moh.json → cursor
    // defaults to user; choose project for this test.
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Where should");
    i.stdin.write("\x1b[B");
    await sleep(10);
    i.stdin.write("\r");
    await sleep(100);

    expect(done).toEqual(["openai-compat/qwen3"]);
    const config = loadMohConfig(join(cwd, "moh.json"));
    expect(config.provider).toBe("openai-compat/qwen3");
    expect(config.endpoints![0]).toMatchObject({
      name: "openai-compat",
      type: "openai-compat",
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "qwen3",
    });
    i.unmount();
  });

  test("failed connection test offers retry / wizard / skip, retry can succeed", async () => {
    const cwd = tempCwd();
    const home = tempHome();
    const done: (string | null)[] = [];
    let fails = 1;
    const flaky = async () => (fails-- > 0 ? { ok: false as const, error: "HTTP 503 overloaded" } : { ok: true as const, modelId: "x" });
    const i = render(<Onboarding cwd={cwd} home={home} env={{ OPENAI_API_KEY: "k" }} tester={flaky} onDone={(ref) => done.push(ref)} />);
    await sleep(30);
    i.stdin.write("\r"); // confirm detection → test runs and fails
    await sleep(100);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Connection test failed: HTTP 503 overloaded");
    expect(frame).toContain("r retry · w wizard · s skip");
    i.stdin.write("r");
    await sleep(100);
    expect(done).toEqual(["openai/gpt-5"]);
    i.unmount();
  });

  test("skip completes without writing moh.json", async () => {
    const cwd = tempCwd();
    const home = tempHome();
    const done: (string | null)[] = [];
    const i = render(<Onboarding cwd={cwd} home={home} env={{ ANTHROPIC_API_KEY: "k" }} tester={okTester} onDone={(ref) => done.push(ref)} />);
    await sleep(30);
    i.stdin.write("s");
    await sleep(30);
    expect(done).toEqual([null]);
    expect(existsSync(join(cwd, "moh.json"))).toBe(false);
    i.unmount();
  });

  test("wizard requires a model before moving on", async () => {
    const cwd = tempCwd();
    const home = tempHome();
    const i = render(<Onboarding cwd={cwd} home={home} env={{}} tester={okTester} onDone={() => {}} />);
    await sleep(30);
    i.stdin.write("\r"); // select anthropic
    await sleep(30);
    i.stdin.write("\r"); // api-key (default) → model prompt
    await sleep(30);
    i.stdin.write("\r"); // empty model → stays
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Default model");
    i.unmount();
  });

  test("openai-compat wizard refuses an empty base URL", async () => {
    const cwd = tempCwd();
    const home = tempHome();
    const i = render(<Onboarding cwd={cwd} home={home} env={{}} tester={okTester} onDone={() => {}} />);
    await sleep(30);
    i.stdin.write("\x1b[B"); // openai-compat
    await sleep(10);
    i.stdin.write("\x1b[B");
    await sleep(10);
    i.stdin.write("\x1b[B");
    await sleep(10);
    i.stdin.write("\r");
    await sleep(30);
    typeInto(i, "qwen3");
    i.stdin.write("\r");
    await sleep(30);
    i.stdin.write("\r"); // empty key
    await sleep(30);
    i.stdin.write("\r"); // empty base URL → stays
    await sleep(30);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("Base URL");
    expect(existsSync(join(cwd, "moh.json"))).toBe(false);
    i.unmount();
  });
});

// keep writeFileSync referenced for potential fixtures
void writeFileSync;
void readFileSync;

describe("onboarding overlay — user-level wizard semantics (#129)", () => {
  const profile0 = { name: "openai-compat", type: "openai-compat", baseUrl: "http://localhost:11434/v1", defaultModel: "qwen3" };

  async function runWizard(home: string, cwd: string) {
    const done: (string | null)[] = [];
    const i = render(<Onboarding cwd={cwd} home={home} env={{}} tester={okTester} onDone={(ref) => done.push(ref)} />);
    await sleep(30);
    for (let d = 0; d < 3; d++) {
      i.stdin.write("\x1b[B"); // down x3 → openai-compat
      await sleep(10);
    }
    await sleep(20);
    i.stdin.write("\r");
    await sleep(20);
    typeInto(i, "qwen3");
    await sleep(10);
    i.stdin.write("\r");
    await sleep(20);
    i.stdin.write("\r"); // empty key
    await sleep(20);
    typeInto(i, "http://localhost:11434/v1");
    await sleep(10);
    i.stdin.write("\r");
    await sleep(100);
    return { i, done };
  }

  test("brand-new endpoint defaults to user scope on absolute first run", async () => {
    const home = tempHome();
    const cwd = tempCwd();
    const { i, done } = await runWizard(home, cwd);
    const frame = stripAnsi(i.lastFrame() ?? "");
    expect(frame).toContain("Where should");
    expect(frame).toContain("›"); // cursor on user
    i.stdin.write("\r"); // user
    await sleep(100);
    expect(done).toEqual(["openai-compat/qwen3"]);
    const raw = JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8"));
    expect(raw.provider).toBe("openai-compat/qwen3");
    expect(raw.endpoints).toEqual([profile0]);
    expect(existsSync(join(cwd, "moh.json"))).toBe(false); // no project file created
    i.unmount();
  });

  test("same name + same config in user config: silent reuse, ref set, nothing rewritten", async () => {
    const home = tempHome();
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ theme: "dark", endpoints: [profile0] }));
    const cwd = tempCwd();
    const { i, done } = await runWizard(home, cwd);
    await sleep(100);
    expect(done).toEqual(["openai-compat/qwen3"]);
    const raw = JSON.parse(readFileSync(join(home, ".moh", "config"), "utf8"));
    expect(raw.theme).toBe("dark");
    expect(raw.endpoints).toEqual([profile0]); // untouched
    expect(raw.provider).toBe("openai-compat/qwen3"); // ref set user-level
    i.unmount();
  });

  test("same name + different key: conflict warning, user picks project-level anyway", async () => {
    const home = tempHome();
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(
      join(home, ".moh", "config"),
      JSON.stringify({ endpoints: [{ ...profile0, apiKey: "sk-existing" }] }),
    );
    const cwd = tempCwd();
    const { i, done } = await runWizard(home, cwd);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("(apiKey)");
    i.stdin.write("p");
    await sleep(100);
    expect(done).toEqual(["openai-compat/qwen3"]);
    const config = loadMohConfig(join(cwd, "moh.json"));
    expect(config.endpoints).toHaveLength(1);
    expect(config.provider).toBe("openai-compat/qwen3");
    i.unmount();
  });

  test("different name but content match: duplicate warning, user uses the existing one", async () => {
    const home = tempHome();
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(join(home, ".moh", "config"), JSON.stringify({ endpoints: [{ ...profile0, name: "ollama" }] }));
    const cwd = tempCwd();
    const { i, done } = await runWizard(home, cwd);
    expect(stripAnsi(i.lastFrame() ?? "")).toContain("same type, base");
    i.stdin.write("u");
    await sleep(100);
    expect(done).toEqual(["ollama/qwen3"]);
    i.unmount();
  });
});
