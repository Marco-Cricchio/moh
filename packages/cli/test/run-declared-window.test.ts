/**
 * ADR-0049 (door one, #986): the headless half of the declared window.
 * `moh run` shows the correction as exactly one stderr line, keeps stdout
 * pure JSONL, leaves the exit code exactly as it was and — when moh could
 * not read a window out of the refusal — leaves one trace line in the
 * user's own moh directory instead.
 *
 * e2e through the real CLI with an isolated HOME and the mock provider
 * (its scripted refusals are normalized exactly like a live provider's).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, readEvents } from "./run.e2e.test";

/** The #986 refusal, verbatim (openrouter, 2026-09-23). */
const REFUSAL = "This endpoint's maximum context length is 131072 tokens. However, you requested about 234666 tokens (232641 of text input, 2025 of tool input).";

/** A real refusal whose wording moh cannot read (it names the failure but
 * states no window): classified `context_length` today, taught nothing. */
const UNREADABLE = "This request exceeds the model's maximum context length";

function cassette(cwd: string, message: string): string {
  const file = join(cwd, "cassette.json");
  writeFileSync(
    file,
    JSON.stringify([{ deltas: [], finish: "stop", error: { kind: "context_length", message } }]),
  );
  return file;
}

describe("moh run declared window (#986)", () => {
  test("one stderr line, one chrome event on stdout, exit code unchanged", () => {
    const { cwd, home, spawn } = harness();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    const file = cassette(cwd, REFUSAL);

    const res = spawn(["run", "--cassette", file, "hello"]);

    // The turn failed because the provider refused — that is the exit code,
    // and the learning changes nothing about it.
    expect(res.code).toBe(1);
    const lines = res.stderr.split("\n").filter((line) => line.includes("declared a context window"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("131072 tokens");
    expect(lines[0]).toContain("mock");
    // stdout stays pure JSONL, and the event is in it.
    const events = readEvents(res.stdout);
    const declared = events.filter((e) => e.type === "declared_window");
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({ model: "mock", window: 131_072, catalog: 0 });
    // The refusal is logged first, the correction right after it.
    const types = events.map((e) => e.type);
    expect(types.indexOf("error")).toBeGreaterThan(-1);
    expect(types.indexOf("declared_window")).toBe(types.indexOf("error") + 1);
    // The refusal is still the same classified failure, with its own hint.
    expect(res.stderr).toContain("context_length");
    // A readable refusal is not a trace line: nothing to discover.
    expect(existsSync(join(home, ".moh", "context-refusals.log"))).toBe(false);
  });

  test("an unreadable refusal: same exit code, one trace line instead", () => {
    const { cwd, home, spawn } = harness();
    writeFileSync(join(cwd, "moh.json"), JSON.stringify({ provider: "mock" }));
    const file = cassette(cwd, UNREADABLE);

    const res = spawn(["run", "--cassette", file, "hello"]);

    expect(res.code).toBe(1);
    expect(res.stderr).not.toContain("declared a context window");
    expect(readEvents(res.stdout).some((e) => e.type === "declared_window")).toBe(false);
    const trace = join(home, ".moh", "context-refusals.log");
    expect(existsSync(trace)).toBe(true);
    const entry = JSON.parse(readFileSync(trace, "utf8").trim());
    expect(entry).toMatchObject({ model: "mock", count: 1 });
    expect(entry.message).toContain("exceeds the model's maximum context length");
  });
});
