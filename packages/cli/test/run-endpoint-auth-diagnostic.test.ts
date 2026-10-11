/**
 * #1317: the headless half of the withdrawn-subscription diagnostic. An
 * endpoint still authenticated with a subscription login moh's onboarding
 * no longer offers (anthropic) cannot serve inference, so `moh run` says
 * so — exactly one stderr line naming the remedy — without ever becoming a
 * failure: stdout stays pure JSONL, the turn runs, the exit code is
 * unchanged, and the stored tokens are neither converted nor deleted.
 *
 * e2e through the real CLI with an isolated HOME: the point is the
 * assembled session's behaviour, not a unit seam.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness, readEvents } from "./run.e2e.test";
import { SPAWN_TEST_TIMEOUT_MS } from "./spawn-harness";

describe("moh run endpoint diagnostic (#1317)", () => {
  test("an anthropic subscription endpoint: one actionable stderr line, stdout pure JSONL, exit 0", () => {
    const { cwd, home, spawn } = harness();
    writeFileSync(
      join(cwd, "moh.json"),
      JSON.stringify({
        provider: "mock",
        endpoints: [{ name: "anthropic", type: "anthropic", defaultModel: "claude-sonnet-4-5", auth: { kind: "subscription" } }],
      }),
    );
    const authFile = join(home, ".moh", "config");
    mkdirSync(join(home, ".moh"), { recursive: true });
    writeFileSync(authFile, JSON.stringify({ auth: { tokens: { anthropic: { accessToken: "acc-x", refreshToken: "ref-x", updatedAt: 1 } } } }));

    const { code, stdout, stderr } = spawn(["run", "hello"]);

    expect(code).toBe(0);
    const lines = stderr.split("\n").filter((line) => line.includes("subscription login"));
    expect(lines).toHaveLength(1);
    // Both halves of the remedy, and the endpoint's own name in the logout.
    expect(lines[0]).toContain("moh provider add");
    expect(lines[0]).toContain("moh provider logout anthropic");
    // stdout stays pure JSONL: the warning is chrome, never a turn error.
    const events = readEvents(stdout);
    expect(events.filter((e) => e.type === "endpoint_auth_withdrawn")).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)!.type).toBe("done");
    // Nothing converted, nothing deleted.
    expect(JSON.parse(readFileSync(authFile, "utf8")).auth.tokens.anthropic.accessToken).toBe("acc-x");
  }, SPAWN_TEST_TIMEOUT_MS);
});
