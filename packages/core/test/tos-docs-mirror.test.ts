import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { allTosCards, renderTosCard } from "../src/tos-cards";

/** #444 anti-drift: docs/providers/tos/ is generated from the bundled
 * assets (`bun packages/core/scripts/gen-tos-docs.ts`); this test fails
 * whenever the mirror is stale or hand-edited. */
const ROOT = join(import.meta.dir, "..", "..", "..");
const DOCS = join(ROOT, "docs", "providers", "tos");

describe("tos docs mirror (#444)", () => {
  test("one docs page per card plus the index, no extras", () => {
    const expected = [...allTosCards().map((c) => `${c.provider}.md`), "README.md"].sort();
    const actual = readdirSync(DOCS).filter((f) => f.endsWith(".md")).sort();
    expect(actual).toEqual(expected);
  });

  test("every page matches what the generator renders from the asset", () => {
    for (const card of allTosCards()) {
      const page = readFileSync(join(DOCS, `${card.provider}.md`), "utf8");
      // Anchors of the generated markdown, straight from the asset data.
      expect(page).toContain(`# Terms of Service — ${card.provider}`);
      expect(page).toContain(`**${card.verified}**`);
      for (const item of card.allowed) expect(page).toContain(item);
      for (const item of card.forbidden) expect(page).toContain(item);
      expect(page).toContain(card.retention);
      expect(page).toContain(card.training);
      for (const link of card.links) expect(page).toContain(`](${link.url})`);
      // The rendered plain-text card (what the TUI shows) carries the same facts.
      const plain = renderTosCard(card);
      expect(plain).toContain(card.retention);
    }
  });

  test("the index links every card with its verification date", () => {
    const index = readFileSync(join(DOCS, "README.md"), "utf8");
    for (const card of allTosCards()) {
      expect(index).toContain(`](./${card.provider}.md) (verified ${card.verified})`);
    }
  });
});
