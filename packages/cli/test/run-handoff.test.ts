/**
 * Session Handoff T2 (#435): the `moh run` exit publish, e2e via a real
 * child process with an isolated HOME (same harness style as
 * run.e2e.test.ts — in-process runCommand runs proved flaky under bun
 * test's own lifecycle). With handoff.transport "gist" and gh absent
 * from PATH, the run still exits 0 (transport failures are warnings,
 * story 15) and the warning goes to stderr — stdout stays pure JSONL.
 * No network: gh never spawns.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const TMP = `/tmp/moh-cli-handoff-${process.pid}-${Date.now()}`;

function harness(mohJson?: unknown) {
  const dir = join(TMP, mohJson ? "gist" : "off");
  const cwd = join(dir, "project");
  const home = join(dir, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (mohJson) writeFileSync(join(cwd, "moh.json"), JSON.stringify(mohJson));
  return {
    run() {
      const proc = Bun.spawnSync(
        ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "run", "hello"],
        {
          cwd,
          // Isolated HOME and a PATH without gh: the publish reaches the
          // transport (the artifact exists after the turn) but gh cannot
          // spawn — classified as gh-missing, deterministic, no network.
          // bun must stay reachable, so it is resolved to its absolute path.
          env: {
            ...process.env,
            HOME: home,
            PATH: `${join(dirname(process.execPath))}:/usr/bin:/bin`,
            MOH_ENDPOINT_TEST_API_KEY: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return {
        code: proc.exitCode,
        stdout: new TextDecoder().decode(proc.stdout),
        stderr: new TextDecoder().decode(proc.stderr),
      };
    },
  };
}

describe("moh run handoff exit publish (#435)", () => {
  test("gist transport with gh unavailable warns on stderr and still exits 0", () => {
    const h = harness({ handoff: { transport: "gist" } });
    const r = h.run();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("handoff publish failed");
    // stdout stays pure JSONL events
    for (const line of r.stdout.split("\n").filter(Boolean)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("transport off never touches the publish path (no warning)", () => {
    const h = harness();
    const r = h.run();
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("handoff");
  });
});

process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
