/**
 * #774 / ADR-0029: the `browser` tool — one action-dispatched tool over
 * the read tier: navigate / snapshot / read_text / close. Element
 * addressing is exclusively by ref from the latest snapshot; no HTML, no
 * CSS selectors. The tool owns nothing about the browser lifecycle beyond
 * dispatch — `BrowserSession` (one per session, disposed with the session)
 * holds the process.
 */
import { z } from "zod";
import type { Tool } from "./types";
import { BrowserSession, BrowserUnavailableError } from "./browser";

const readTierSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.string().min(1) }),
  z.object({
    action: z.literal("snapshot"),
    /** Subtree scope: an `eN` ref from the latest snapshot. */
    ref: z.string().min(1).optional(),
    /** Reserved for the depth-limited snapshot refinement. */
    depth: z.number().int().positive().optional(),
  }),
  z.object({ action: z.literal("read_text"), ref: z.string().min(1).optional() }),
  z.object({ action: z.literal("close") }),
]);

export interface BrowserToolOptions {
  session: BrowserSession;
  /** Exact-host SSRF escape hatch (spec: browser.allowedHosts). */
  allowedHosts?: readonly string[];
}

export function browserTool(options: BrowserToolOptions): Tool<z.infer<typeof readTierSchema>> {
  return {
    name: "browser",
    description:
      "Drive a headless browser (read tier). Actions: " +
      "`navigate` {url} — open a page and return its accessibility snapshot " +
      "with stable [ref=eN] element refs; `snapshot` {ref?, depth?} — re-snapshot " +
      "the page or one ref's subtree; `read_text` {ref?} — visible text of the " +
      "page or one element; `close` — close the browser. " +
      "Address elements only by their [ref=eN] from the latest snapshot; a " +
      "navigation invalidates all refs (navigate always returns fresh ones). " +
      "Loopback URLs (localhost dev servers) are allowed; other private " +
      "networks are blocked.",
    inputSchema: readTierSchema,
    timeoutMs: (args) => {
      const action = (args as { action?: string } | null | undefined)?.action;
      return action === "navigate" ? 30_000 : 10_000;
    },
    async execute(args) {
      const { session } = options;
      try {
        switch (args.action) {
          case "navigate":
            return await session.navigate(args.url, options.allowedHosts);
          case "snapshot":
            return await session.snapshot(args.ref, args.depth);
          case "read_text":
            return await session.readText(args.ref);
          case "close":
            await session.dispose();
            return "browser closed";
        }
      } catch (e) {
        if (e instanceof BrowserUnavailableError) return `browser unavailable: ${e.message}`;
        throw e;
      }
    },
  };
}
