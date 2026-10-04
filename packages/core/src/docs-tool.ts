/**
 * The `moh_docs` built-in tool (#1194, ADR-0072): the model's door to the
 * bundled user manual (ADR-0013). Read-only over content compiled into the
 * binary — no filesystem, no network — so a binary-only install answers
 * questions about moh itself from the shipped documentation instead of
 * trained memory.
 */
import { z } from "zod";
import type { Tool } from "./types";
import { allManualPages, manualIndex, manualPage } from "./manual";

/** Excerpt context: characters of a match line kept either side. */
const EXCERPT_CONTEXT = 120;
/** Maximum excerpts returned by one search. */
const MAX_EXCERPTS = 40;

const docsSchema = z.object({
  op: z.enum(["index", "read", "search"]).describe("index = page list, read = one page by id, search = keyword query"),
  id: z.string().optional().describe("page id (read): see index"),
  query: z.string().optional().describe("plain keywords (search)"),
});
type DocsArgs = z.infer<typeof docsSchema>;

/** One case-insensitive line match, rendered as a bounded excerpt. */
function excerpt(line: string, query: string): string | null {
  const at = line.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return null;
  const start = Math.max(0, at - EXCERPT_CONTEXT);
  const end = Math.min(line.length, at + query.length + EXCERPT_CONTEXT);
  return `${start > 0 ? "…" : ""}${line.slice(start, end).trim()}${end < line.length ? "…" : ""}`;
}

export const docsTool: Tool<DocsArgs> = {
  name: "moh_docs",
  description:
    "Search moh's own user manual (bundled, version-matched to this binary). " +
    "Use for ANY question about moh itself — capabilities, commands, panels, " +
    "overlays, config keys, permissions, providers, extensions — before " +
    "answering from memory. op=index lists pages, op=read gives one full page, " +
    "op=search finds excerpts by keyword. Cite answers as `Manual → <Title>`; " +
    "if no page covers the question, say the manual doesn't cover it.",
  inputSchema: docsSchema,
  execute(args) {
    if (args.op === "index") {
      const lines = manualIndex().map((p) => `- ${p.id}: ${p.title} — ${p.summary}`);
      return [`moh manual pages:`, ...lines, ``, `Use op="read" with a page id for the full page.`].join("\n");
    }
    if (args.op === "read") {
      if (!args.id) throw new Error(`op="read" needs a page id (see the index)`);
      const page = manualPage(args.id);
      if (!page) {
        const ids = manualIndex().map((p) => p.id).join(", ");
        throw new Error(`unknown page id: ${args.id} (known: ${ids})`);
      }
      return `Manual → ${page.title}\n\n${page.body}`;
    }
    // search
    const query = (args.query ?? "").trim();
    if (!query) throw new Error(`op="search" needs a query`);
    const out: string[] = [];
    for (const page of allManualPages()) {
      let shown = 0;
      for (const line of page.body.split("\n")) {
        const ex = excerpt(line, query);
        if (ex === null) continue;
        out.push(`[${page.id}] ${page.title}: ${ex}`);
        if (++shown >= 3) break; // per page, keeps one page from flooding
        if (out.length >= MAX_EXCERPTS) break;
      }
      if (out.length >= MAX_EXCERPTS) break;
    }
    if (out.length === 0) {
      return `No manual page matches "${query}". The manual may not cover this — say so rather than guessing, or try other keywords (op="search") or op="index".`;
    }
    return [
      `Matches for "${query}" (op="read" with a page id for the full page):`,
      "",
      ...out,
    ].join("\n");
  },
};
