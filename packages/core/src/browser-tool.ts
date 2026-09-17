/**
 * #774 / #777 / ADR-0029: the `browser` tool — one action-dispatched
 * tool over the read and act tiers (navigate / snapshot / read_text /
 * close; click / fill / select / scroll / press_key / wait_for /
 * upload). Element
 * addressing is exclusively by ref from the latest snapshot; no HTML, no
 * CSS selectors. The tool owns nothing about the browser lifecycle beyond
 * dispatch — `BrowserSession` (one per session, disposed with the session)
 * holds the process.
 */
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "./types";
import { BrowserSession, BrowserUnavailableError, OutOfRootError, inRootPath } from "./browser";

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
  // #777: the act tier — element addressing exclusively by snapshot ref.
  z.object({ action: z.literal("click"), ref: z.string().min(1) }),
  z.object({ action: z.literal("fill"), ref: z.string().min(1), text: z.string() }),
  z.object({ action: z.literal("select"), ref: z.string().min(1), option: z.string().min(1) }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]),
    amount: z.number().positive().max(10_000).optional(),
  }),
  z.object({ action: z.literal("press_key"), key: z.string().min(1) }),
  z.object({
    action: z.literal("wait_for"),
    text: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
  }),
  z.object({ action: z.literal("upload"), ref: z.string().min(1), path: z.string().min(1) }),
  // #778: visual + power actions.
  z.object({
    action: z.literal("screenshot"),
    /** Element-scoped capture: an `eN` ref from the latest snapshot. */
    ref: z.string().min(1).optional(),
  }),
  z.object({ action: z.literal("eval_js"), expression: z.string().min(1) }),
]);

export interface BrowserToolOptions {
  session: BrowserSession;
  /** Exact-host SSRF escape hatch (spec: browser.allowedHosts). */
  allowedHosts?: readonly string[];
  /**
   * #775: element description for the permission ask, resolved from the
   * latest snapshot (`click [button "Delete permanently"] on host`).
   * Returns a compact single-line description or null.
   */
  describeElement?: (ref: string) => string | null;
  /** #775: gate-seam override for the live page URL (tests); defaults to the session's page. */
  pageUrl?: () => string | null;
  /** #777: project root for `upload` containment (realpath-anchored, like write). */
  root?: string;
  /**
   * #777: ask seam for a required download (name + suggested filename).
   * Returns "allow" to stage into the project's download dir, "deny" to
   * cancel. Absent → downloads stay blocked (never a silent write).
   */
  askDownload?: (info: { filename: string; size: number }) => Promise<"allow" | "deny"> | "allow" | "deny";
  /** #777: out-of-root upload consent — per-occurrence, never persistable. */
  askOutOfRoot?: (path: string) => Promise<boolean> | boolean;
}

/**
 * #778: the structured result a `screenshot` execute() resolves to. The
 * tool contract stays `Promise<string>` for every other action; the
 * runner recognizes this shape (branded) and promotes it to a typed
 * image part on the tool_result when the serving model declares image
 * input (#490 pipeline), else renders the visible chip + warning text.
 */
export interface ScreenshotToolResult {
  __screenshot: true;
  mime: string;
  base64: string;
  target: string;
}

/** Structural recognition — never a blind cast of arbitrary tool output. */
export function isScreenshotToolResult(value: unknown): value is ScreenshotToolResult {
  return (
    typeof value === "object" && value !== null &&
    (value as { __screenshot?: unknown }).__screenshot === true &&
    typeof (value as { mime?: unknown }).mime === "string" &&
    typeof (value as { base64?: unknown }).base64 === "string" &&
    typeof (value as { target?: unknown }).target === "string"
  );
}

/** #778: the visible chip when the model cannot receive images. */
export function renderScreenshotChip(result: ScreenshotToolResult): string {
  return `[screenshot: ${result.target}] image captured (${result.mime}, ${Math.round((result.base64.length * 3) / 4 / 1024)} KB) — the serving model does not support image input, so the pixels are not visible to it`;
}

export function browserTool(options: BrowserToolOptions): Tool<z.infer<typeof readTierSchema>> {
  // #775: the permission gate matches `browser:<action> <url-glob>` rules
  // against the page URL at action time; the args the gate sees are
  // enriched with it (and a compact element description for the ask).
  const gateArgs = (raw: { action: string; ref?: string; url?: string; path?: string }): Record<string, unknown> => {
    const enriched: Record<string, unknown> = { ...raw };
    if (raw.action === "navigate") {
      // navigate carries its own target: URL rules match it directly.
      if (typeof raw.url === "string") enriched.pageUrl = raw.url;
    } else {
      const pageUrl = (options.pageUrl ?? (() => options.session.pageUrl()))();
      if (pageUrl) enriched.pageUrl = pageUrl;
    }
    // #777: upload resolves its source against the project root before
    // the gate sees it (absolute, so the containment check is exact).
    if (raw.action === "upload" && typeof raw.path === "string" && options.root) {
      enriched.path = isAbsolute(raw.path) ? raw.path : resolve(options.root, raw.path);
    }
    const ref = raw.ref;
    if (ref) {
      const desc = options.describeElement?.(ref);
      if (desc) enriched.elementDescription = desc;
    }
    return enriched;
  };
  return {
    name: "browser",
    description:
      "Drive a headless browser. Read tier: " +
      "`navigate` {url} — open a page and return its accessibility snapshot " +
      "with stable [ref=eN] element refs; `snapshot` {ref?, depth?} — re-snapshot " +
      "the page or one ref's subtree; `read_text` {ref?} — visible text of the " +
      "page or one element; `close` — close the browser. " +
      "Act tier (asks for permission): `click` {ref}; `fill` {ref, text}; " +
      "`select` {ref, option}; `scroll` {direction: up|down|left|right, amount?}; " +
      "`press_key` {key}; `wait_for` {text | ref}; `upload` {ref, path} — path " +
      "must be inside the project root; `eval_js` {expression} — run JS in " +
      "the full page context (asks). " +
      "`screenshot` {ref?} — capture the viewport or one element as an " +
      "image; the model receives it as an image when the serving model " +
      "declares image input, otherwise a reference chip is returned. " +
      "Address elements only by their [ref=eN] from the latest snapshot; a " +
      "navigation invalidates all refs (navigate always returns fresh ones, and " +
      "acting on a stale ref returns the fresh snapshot so you can re-target). " +
      "Loopback URLs (localhost dev servers) are allowed; other private " +
      "networks are blocked.",
    inputSchema: readTierSchema,
    gateArgs: (raw) => gateArgs(raw as { action: string; ref?: string; url?: string }),
    timeoutMs: (args) => {
      const action = (args as { action?: string } | null | undefined)?.action;
      if (action === "navigate") return 30_000;
      if (action === "wait_for") return 30_000; // arg-capped by the session's wait budget
      if (action === "screenshot") return 15_000;
      if (action === "eval_js") return 15_000;
      return 10_000;
    },
    async execute(args) {
      const { session } = options;
      const root = options.root ?? process.cwd();
      const run = async (): Promise<string> => {
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
          // #777: act tier.
          case "click":
            return await session.click(args.ref);
          case "fill":
            return await session.fill(args.ref, args.text);
          case "select":
            return await session.select(args.ref, args.option);
          case "scroll":
            return await session.scroll(args.direction, args.amount);
          case "press_key":
            return await session.pressKey(args.key);
          case "wait_for":
            return await session.waitFor({ text: args.text, ref: args.ref });
          case "upload": {
            const inside = inRootPath(root, args.path);
            if (!inside) {
              // Out-of-root: per-occurrence consent, never persistable —
              // nothing is stored even on approval; the path rides this
              // call only.
              if (!options.askOutOfRoot) return `upload refused: "${args.path}" is outside the project root`;
              const ok = await options.askOutOfRoot(args.path);
              if (!ok) return `upload refused: "${args.path}" is outside the project root`;
              return await session.upload(args.ref, args.path, { root, allowOutOfRoot: true });
            }
            return await session.upload(args.ref, inside, { root });
          }
          // #778: screenshot returns a structured result the runner
          // promotes to a typed image part (or the chip fallback).
          case "screenshot": {
            const shot = await session.screenshot(args.ref);
            return { __screenshot: true, mime: shot.mime, base64: shot.base64, target: shot.target } as unknown as string;
          }          case "eval_js":
            return await session.evalJs(args.expression);
        }
      };
      let result: string;
      try {
        result = await run();
      } catch (e) {
        if (e instanceof BrowserUnavailableError) return `browser unavailable: ${e.message}`;
        if (e instanceof OutOfRootError) {
          return `${e.message}${options.askOutOfRoot ? "" : " (upload refused)"}`;
        }
        throw e;
      }
      // #777: stage any downloads this action produced (ask-gated;
      // without an ask seam nothing is ever written to disk). Staging
      // failures are visible in the result, never swallowed.
      const staged: string[] = [];
      const failed: string[] = [];
      for (;;) {
        try {
          const path = await session.stageDownload({ ask: options.askDownload });
          if (!path) break;
          staged.push(path);
        } catch (e) {
          failed.push(e instanceof Error ? e.message : String(e));
          break; // a broken staging must not loop; report and stop
        }
      }
      let out = result;
      if (staged.length) out += `\n\n${staged.map((p) => `Download staged: ${p} (read it with the read tool)`).join("\n")}`;
      if (failed.length) out += `\n\nDownload staging failed: ${failed.join("; ")}`;
      return out;
    },
  };
}
