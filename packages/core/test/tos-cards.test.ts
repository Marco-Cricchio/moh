import { describe, expect, test } from "bun:test";
import { allTosCards, renderTosCard, tosCardFor, tosWizardLine, TOS_DISCLAIMER } from "../src/tos-cards";

/** The ADR-0010 provider list + the generic openai-compat card (#444). */
const COVERED = ["anthropic", "openai", "google", "github-copilot", "openrouter", "kimi-coding", "xai", "openai-compat"];

describe("tos cards (#444)", () => {
  test("one card per covered provider id, exactly", () => {
    expect(allTosCards().map((c) => c.provider)).toEqual([...COVERED].sort());
    for (const id of COVERED) expect(tosCardFor(id)?.provider).toBe(id);
  });

  test("unknown providers have no bundled card", () => {
    expect(tosCardFor("my-custom-provider")).toBeUndefined();
    expect(tosCardFor("mock")).toBeUndefined();
  });

  test("every card follows the fixed template and carries the disclaimer inputs", () => {
    for (const card of allTosCards()) {
      expect(card.verified).toMatch(/^\d{4}-\d{2}$/);
      expect(card.allowed.length).toBeGreaterThan(0);
      expect(card.forbidden.length).toBeGreaterThan(0);
      expect(card.retention.length).toBeGreaterThan(0);
      expect(card.training.length).toBeGreaterThan(0);
      for (const link of card.links) {
        expect(link.label.length).toBeGreaterThan(0);
        expect(link.url).toMatch(/^https:\/\//);
      }
    }
  });

  test("rendered cards are ~30 lines max and start with the disclaimer", () => {
    for (const card of allTosCards()) {
      const rendered = renderTosCard(card);
      expect(rendered.split("\n").length).toBeLessThanOrEqual(30);
      expect(rendered).toContain(TOS_DISCLAIMER);
      expect(rendered).toContain(`verified ${card.verified}`);
      expect(rendered).toContain("Data retention:");
      expect(rendered).toContain("Training on your inputs:");
      for (const link of card.links) expect(rendered).toContain(link.url);
    }
  });

  test("the wizard line is discreet and parseable: `ToS: <url> (verified YYYY-MM)`", () => {
    const line = tosWizardLine("anthropic")!;
    expect(line).toMatch(/^ToS: https:\S+ \(verified \d{4}-\d{2}\)$/);
    // openai-compat has no concrete ToS URL: the line defers instead.
    expect(tosWizardLine("openai-compat")).toMatch(/^ToS: .+ \(verified \d{4}-\d{2}\)$/);
    expect(tosWizardLine("custom-thing")).toBeUndefined();
  });
});
