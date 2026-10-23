import { describe, expect, test } from "bun:test";
import { scenarios, specFor } from "./tui";

// #1517: B5 baselines never touch the network. These tests exercise the spec
// that `tui.ts main()` hands to `runPtyRaw` (`specFor`) and assert literals,
// not the module's own constants.
const url = "http://127.0.0.1:1/v1";

/** Scenarios whose frames render the Settings "Update check" row (`on` in the
 * reference): proxy-only, they must NOT set the opt-out. */
const PROXY_ONLY = ["overlay-walk", "settings-submodal-return"];

describe("B5 scenarios are hermetic", () => {
  test("the scenario list is the expected one", () => {
    expect(scenarios.map((s) => s.name)).toEqual([
      "onboarding-fresh",
      "workflow-offer",
      "handoff-onboarding",
      "overlay-walk",
      "stranded",
      "settings-submodal-return",
      "permission-prompt",
      "bang-command",
      "mention-attach",
    ]);
  });

  test("every scenario runs with the dead proxy and a loopback bypass", () => {
    for (const s of scenarios) {
      const env = specFor(s, url).env ?? {};
      for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
        expect(env[k], `${s.name} ${k}`).toBe("http://127.0.0.1:9");
      }
      expect(env.NO_PROXY, s.name).toBe("127.0.0.1,localhost");
      expect(env.no_proxy, s.name).toBe("127.0.0.1,localhost");
    }
  });

  test("every scenario except the two that render the Settings row sets updateCheck: false", () => {
    for (const s of scenarios) {
      const updateCheck = specFor(s, url).config?.updateCheck;
      if (PROXY_ONLY.includes(s.name)) expect(updateCheck, s.name).toBeUndefined();
      else expect(updateCheck, s.name).toBe(false);
    }
  });

  test("specFor keeps a scenario's own env and asks for meta", () => {
    const spec = specFor({ name: "x", spec: () => ({ cols: 1, rows: 1, steps: [], env: { TERM_PROGRAM: "x" } }) }, url);
    expect(spec.env?.TERM_PROGRAM).toBe("x");
    expect(spec.meta).toBe(true);
  });
});
