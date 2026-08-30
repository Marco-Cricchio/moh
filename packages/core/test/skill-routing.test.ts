import { describe, expect, test } from "bun:test";
import { formatSkillCommand, skillRecommendations } from "../src/skill-routing";
import { loadMohConfig } from "../src/config";

describe("label-guided skill routing", () => {
  test("ranks a state label above a category label deterministically", () => {
    expect(skillRecommendations(["bug", "needs-triage"])).toEqual([
      { label: "needs-triage", command: "/triage" },
      { label: "bug", command: "/diagnosing-bugs" },
    ]);
  });

  test("maps every initial wayfinder label, including its domain companion", () => {
    expect(skillRecommendations(["wayfinder:task", "wayfinder:research", "wayfinder:prototype", "wayfinder:grilling"])).toEqual([
      { label: "wayfinder:grilling", command: "/grilling", suffix: "with /domain-modeling" },
      { label: "wayfinder:prototype", command: "/prototype" },
      { label: "wayfinder:research", command: "/research" },
      { label: "wayfinder:task", command: "/wizard" },
    ]);
  });

  test("augments built-ins, changes ranking, and can disable a built-in", () => {
    const routes = skillRecommendations(["bug", "customer-request", "enhancement"], {
      labels: {
        bug: { disabled: true },
        "customer-request": { command: "/implement", priority: 300, suffix: "review the request" },
        enhancement: { priority: 250 },
      },
    });

    expect(routes).toEqual([
      { label: "customer-request", command: "/implement", suffix: "review the request" },
      { label: "enhancement", command: "/implement" },
    ]);
  });

  test("loads project-level label route overrides from moh.json", () => {
    const config = loadMohConfig("moh.json", () => JSON.stringify({
      skillRouting: { labels: { "customer-request": { command: "/implement", priority: 300 } } },
    }));
    expect(skillRecommendations(["customer-request"], config.skillRouting)).toEqual([
      { label: "customer-request", command: "/implement" },
    ]);
  });

  test("formats only the command, issue reference, and necessary suffix", () => {
    expect(formatSkillCommand({ label: "enhancement", command: "/implement" }, "123")).toBe("/implement #123");
    expect(formatSkillCommand({ label: "custom", command: "/implement", suffix: "review the request" }, "123"))
      .toBe("/implement #123 review the request");
  });
});
