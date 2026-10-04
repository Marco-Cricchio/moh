import { describe, expect, test } from "bun:test";
import { docsTool } from "../src/docs-tool";
import { allManualPages, manualPage } from "../src/manual";

const run = (args: unknown) => docsTool.execute(docsTool.inputSchema!.parse(args), {
  signal: new AbortController().signal,
  cwd: "/tmp",
  onProgress: () => {},
} as Parameters<typeof docsTool.execute>[1]);

describe("moh_docs tool (#1194, ADR-0072)", () => {
  test("index lists every page id with title and summary", async () => {
    const out = await run({ op: "index" });
    for (const page of allManualPages()) {
      expect(out).toContain(`${page.id}: ${page.title}`);
      expect(out).toContain(page.summary);
    }
  });

  test("read returns the full page with the citation head", async () => {
    const out = await run({ op: "read", id: "extensions" });
    expect(out).toStartWith("Manual → Extensions");
    const page = manualPage("extensions")!;
    expect(out).toContain(page.body.slice(0, 200));
  });

  test("read with an unknown id names the miss and lists known ids", async () => {
    let message = "";
    try {
      await run({ op: "read", id: "nope" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("nope");
    expect(message).toContain("extensions");
  });

  test("search finds excerpts with page ids, capped per page", async () => {
    const out = await run({ op: "search", query: "overlay" });
    expect(out).toContain(`Matches for "overlay"`);
    // every excerpt row is prefixed with its page id
    for (const line of out.split("\n")) {
      if (line.startsWith("[")) expect(line).toMatch(/^\[[a-z-]+\] /);
    }
    // no single page floods the result: at most 3 excerpts per page id
    const perPage = new Map<string, number>();
    for (const line of out.split("\n")) {
      const m = line.match(/^\[([a-z-]+)\]/);
      if (m) perPage.set(m[1]!, (perPage.get(m[1]!) ?? 0) + 1);
    }
    for (const n of perPage.values()) expect(n).toBeLessThanOrEqual(3);
  });

  test("search with no match tells the model to say so, never to guess", async () => {
    const out = await run({ op: "search", query: "xyzzyqwertyuiop" });
    expect(out).toContain("may not cover this");
  });

  test("read without id and search without query fail fast", async () => {
    const messages: string[] = [];
    for (const args of [{ op: "read" }, { op: "search" }]) {
      try {
        await run(args);
      } catch (e) {
        messages.push((e as Error).message);
      }
    }
    expect(messages[0]).toContain("needs a page id");
    expect(messages[1]).toContain("needs a query");
  });
});
