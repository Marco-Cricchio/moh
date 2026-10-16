import { describe, expect, test } from "bun:test";
import { hermetic, isHermetic, NET_BLOCKED_ENV, SHOWS_UPDATE_CHECK } from "./tui-hermetic";
import { scenarios } from "./tui";

// #1517: B5 baselines never touch the network. Every scenario must carry the
// dead proxy and/or the `updateCheck: false` opt-out as the harness runs it.
describe("B5 scenarios are hermetic", () => {
  const url = "http://127.0.0.1:1/v1";

  test("every scenario is network-blocked or opted out", () => {
    for (const s of scenarios) {
      const { proxy, optOut } = isHermetic(hermetic(s.spec({ url })));
      expect(proxy || optOut, s.name).toBe(true);
    }
  });

  test("every scenario runs with the dead proxy", () => {
    for (const s of scenarios) {
      expect(isHermetic(hermetic(s.spec({ url }))).proxy, s.name).toBe(true);
    }
  });

  test("loopback bypasses the dead proxy so the fake provider servers stay reachable", () => {
    expect(NET_BLOCKED_ENV.NO_PROXY).toBe("127.0.0.1,localhost");
  });

  test("the scenarios that render the Settings row keep the default (the reference shows `on`)", () => {
    for (const name of SHOWS_UPDATE_CHECK) {
      const s = scenarios.find((x) => x.name === name)!;
      expect(s.spec({ url }).config?.updateCheck, name).toBeUndefined();
    }
  });

  test("the harness keeps a scenario's own env", () => {
    const spec = hermetic({ cols: 1, rows: 1, steps: [], env: { TERM_PROGRAM: "x" } });
    expect(spec.env?.TERM_PROGRAM).toBe("x");
    expect(spec.env?.HTTPS_PROXY).toBe("http://127.0.0.1:9");
  });
});
