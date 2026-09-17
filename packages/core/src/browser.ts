/**
 * #774 / ADR-0029: the headless-browser seam behind the `browser` tool's
 * read tier. One browser per session, lazily launched on first use:
 * playwright-core (optional peer) drives a user-installed Chromium through
 * `--remote-debugging-pipe` (never a TCP debug port) with a dedicated
 * per-project profile dir. The model's only textual view is the ref-
 * annotated a11y snapshot (`[ref=eN]`), hard-budgeted; the element
 * addressing for later act-tier work is the `aria-ref=eN` selector.
 *
 * Failure model: every absence (no playwright-core, no Chromium) is an
 * explicit `BrowserUnavailableError` carrying the install command — the
 * session turns it into a visible diagnostic and never registers the
 * tool; runtime failures are turn errors, never process errors.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, dirname, join, relative, resolve } from "node:path";
import { projectSlug } from "./session-store";
import { isPrivateHost } from "./builtin-tools";

/** Hard snapshot budget: ~20k tokens ≈ 80 KiB of text. */
const SNAPSHOT_BUDGET_BYTES = 80 * 1024;

export const BROWSER_INSTALL_HINT =
  "npm i -g playwright-core && npx playwright-core install chromium";

/** Thrown when the toolchain (playwright-core or a Chromium build) is missing. */
export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

export interface BrowserOptions {
  /** Working root: picks the per-project profile dir slug. Default process.cwd(). */
  cwd?: string;
  /** moh home dir (default `~`). Profile lives at `<home>/.moh/browser-profile/<slug>/`. */
  home?: string;
  /** Headful when false (spec: `browser.headless` config key, default true). */
  headless?: boolean;
  /** Test seam: inject a pre-built playwright-core module. */
  playwright?: unknown;
  /** #776 test seam: DNS lookup used by the navigation guard. */
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
}

/** SSRF posture (SEC-05 philosophy at the navigation layer): loopback
 * allowed by default (dev-debug use case), all other private/link-local
 * ranges blocked; `allowedHosts` is the only escape hatch, per-host. */
export function assertNavigable(rawUrl: string, allowedHosts: readonly string[] = []): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`browser: invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`browser: only http/https URLs are supported (got "${url.protocol}")`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = allowedHosts.map((h) => h.trim().replace(/^\[|\]$/g, "").toLowerCase());
  if (allowed.includes(host)) return url;
  // Loopback is the feature (localhost dev debugging); everything else
  // private must be explicitly allowed.
  const loopback =
    host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "127.0.0.1" || host === "[::1]";
  if (loopback) return url;
  if (isPrivateHost(host)) {
    throw new Error(
      `browser: "${host}" is a private/link-local address, blocked by default (prompt-injection SSRF guard); allow it with browser.allowedHosts: ["${host}"]`,
    );
  }
  return url;
}

/**
 * #776: full navigation guard — the `assertNavigable` URL-level checks plus
 * DNS verification (#697/SEC-05 philosophy): a public hostname that
 * resolves to a private/link-local address is blocked (the DNS-rebinding
 * TOCTOU). Same resolution philosophy as fetch, one DNS lookup, no pinning
 * (Chromium resolves and dials itself; the check closes the check/connect
 * gap that matters — a short-TTL name can no longer answer public for the
 * check and private for the dial within one navigation, and every
 * redirect hop is re-checked by the route handler). Env-var overrides
 * (`MOH_FETCH_ALLOW_PRIVATE`) deliberately do not apply here.
 */
export async function verifyNavigable(
  rawUrl: string,
  allowedHosts: readonly string[] = [],
  deps: { lookup?: (host: string) => Promise<{ address: string; family: number }[]> } = {},
): Promise<URL> {
  const url = assertNavigable(rawUrl, allowedHosts);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // Loopback is allowed before any resolution; numeric literals are
  // already canonical (WHATWG URL normalizes decimal/hex IPv4 spellings
  // to dotted quad, which assertNavigable classified above) and can't
  // rebind; explicitly allowed hosts are the operator's own choice.
  const loopback = host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "127.0.0.1";
  const numeric = /^[0-9.]+$/.test(host) || host.includes(":");
  if (loopback || numeric || allowedHosts.some((h) => h.trim().toLowerCase() === host)) return url;
  try {
    const lookup = deps.lookup ?? (async (h: string) => (await import("node:dns/promises")).lookup(h, { all: true }));
    const addresses = await lookup(host);
    const bad = addresses.find((a) => isPrivateHost(a.address));
    if (bad) {
      throw new Error(
        `browser: "${host}" resolves to private address ${bad.address}; blocked by default (prompt-injection SSRF guard); allow it with browser.allowedHosts: ["${host}"]`,
      );
    }
  } catch (e) {
    // Fail closed: a name moh cannot verify could resolve private for
    // Chromium. Never let a resolver failure become a bypass — the
    // navigation error names the policy either way.
    if (e instanceof Error && e.message.includes("SSRF guard")) throw e;
    throw new Error(`browser: cannot verify "${host}" via DNS (prompt-injection SSRF guard); navigation blocked`);
  }
  return url;
}

/** #776: the response a blocked navigation hop gets — visible, model-readable. */
function blockedRouteResponse(reason: string): { status: number; contentType: string; body: string } {
  return {
    status: 403,
    contentType: "text/plain",
    body: `Blocked by moh's browser SSRF guard: ${reason} The page refused to load.`,
  };
}

/**
 * #776: per-hop redirect re-check. Installed once per page; every
 * document request (the initial navigation and each redirect hop —
 * redirects surface as fresh document requests) is re-verified against
 * the same posture. A blocked hop is fulfilled with a 403 naming the
 * policy, so the failure is model-readable in the navigation response
 * instead of a stack trace. Subresource requests ride the page's own
 * network stack — the guard is document-navigation scoped by design.
 */
async function installRouteGuard(
  page: BrowserPageLike,
  allowedHosts: readonly string[],
  verify: (url: string) => Promise<URL>,
): Promise<void> {
  if (typeof page.route !== "function") return;
  await page.route("**/*", async (route: BrowserRouteLike) => {
    if (route.resourceType() !== "document") return route.continue();
    try {
      await verify(route.url());
    } catch (e) {
      return route.fulfill(blockedRouteResponse(e instanceof Error ? e.message : String(e)));
    }
    return route.continue();
  });
}

/**
 * Truncates a snapshot to the hard budget with a visible marker and
 * refinement guidance. Pure function — unit-tested in isolation.
 */
export function applySnapshotBudget(text: string, budget = SNAPSHOT_BUDGET_BYTES): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  // Never split a `[ref=eN]` token across the boundary — an actor must
  // never see a half ref and guess the rest.
  const lastComplete = Math.max(cut.lastIndexOf("\n"), 0);
  const head = cut.slice(0, lastComplete > 0 ? lastComplete : cut.length);
  const hiddenLines = text.slice(head.length).split("\n").filter((l) => l.trim()).length;
  return `${head}\n…[snapshot truncated, ${hiddenLines} more nodes — re-call snapshot with a 'ref' (subtree) or a smaller 'depth' to target one region]`;
}

/**
 * #778: captures the viewport (or one `ref` element) as a PNG. Returns
 * the raw bytes; the tool layer owns the image-part decision (#490
 * pipeline) and the chip + warning for non-multimodal models.
 */
export interface ScreenshotResult {
  mime: "image/png";
  base64: string;
  /** What was captured, for the text chip (`viewport` or the element description). */
  target: string;
}

/** #778: large-output cap for `eval_js` results (≈5k tokens of text). */
export const EVAL_OUTPUT_BUDGET_BYTES = 20 * 1024;

/**
 * #778: truncates an eval_js result over budget with a visible marker.
 * Pure function — unit-tested in isolation.
 */
export function applyEvalBudget(text: string, budget = EVAL_OUTPUT_BUDGET_BYTES): string {
  if (text.length <= budget) return text;
  return `${text.slice(0, budget)}\n…[eval_js result truncated at ${budget} bytes — narrow the expression (e.g. return only the fields you need)]`;
}

/**
 * #778: serializes one evaluated value the way the devtools console
 * would accept back into a conversation: strings as-is (quoted only at
 * the budget layer's discretion — no, strings stay raw for readability),
 * everything else JSON with a stable key order; `undefined` becomes the
 * visible string "undefined". Throws nothing: a non-serializable value
 * (circular structure, BigInt) degrades to its String() form.
 */
export function serializeEvalValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v)) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable value]";
    }
  }
}

/** Default per-action timeouts (#777): act 10s, wait_for arg-capped. */
export const ACT_TIMEOUT_MS = 10_000;

/** A stale ref: the element the snapshot named is gone from the live DOM.
 * Carries the fresh snapshot so the model can re-target — never a silent
 * mis-click, never a bare error. */
export class StaleRefError extends Error {
  constructor(
    ref: string,
    /** The fresh post-failure snapshot text. */
    readonly freshSnapshot: string,
  ) {
    super(
      `browser: stale ref "${ref}" — the element is no longer in the live DOM ` +
        `(a navigation or a mutation killed it). Fresh snapshot:\n${freshSnapshot}`,
    );
    this.name = "StaleRefError";
  }
}

/** Options for `upload`: the in-root containment contract. */
export interface UploadOptions {
  /** Project root the source path must resolve inside (realpath-anchored, like write). */
  root: string;
}

/** Downloads staging options (#777). */
export interface DownloadStagingOptions {
  /** Staging root (default `<home>/.moh/browser-downloads/<slug>/`). */
  dir?: string;
  /** Ask seam for a required download (name + size, known post-save).
   * Return "allow" to stage, "deny" (or omit) to cancel and delete.
   * Absent → downloads stay blocked (never a silent write). */
  ask?: (info: { filename: string; size: number }) => Promise<"allow" | "deny"> | "allow" | "deny";
}
/** The playwright surface this module needs — structural, so tests can fake it. */
export interface BrowserRouteLike {
  url(): string;
  resourceType(): string;
  continue(): Promise<void>;
  fulfill(options: { status: number; contentType: string; body: string }): Promise<void>;
}

export interface BrowserPageLike {
  goto(url: string, options?: { waitUntil?: string; timeoutMs?: number }): Promise<unknown>;
  ariaSnapshot(options?: { mode?: string; depth?: number }): Promise<string>;
  waitForLoadState?(state: string, options?: { timeout?: number }): Promise<void>;
  mouse?: {
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  keyboard?: {
    press(key: string): Promise<void>;
  };
  /** #777: download seam — accepted only when a download flow is armed. */
  on?(event: "download", handler: (download: BrowserDownloadLike) => void): void;
  waitForEvent?(event: "download", options?: { timeout?: number }): Promise<BrowserDownloadLike>;
  /** #778: screenshot seam — accepted only on fakes/real pages that have it. */
  screenshot?(options?: { fullPage?: boolean }): Promise<Buffer>;
  /** #778: page-context JS evaluation (devtools-console semantics). */
  evaluate?<R>(fn: string, arg?: unknown): Promise<R>;
  /** #778: headful diagnostics (real window) — never used for behavior. */
  locator(selector: string): {
    ariaSnapshot(options?: { mode?: string; depth?: number }): Promise<string>;
    textContent(options?: { timeout?: number }): Promise<string | null>;
    click(options?: { timeout?: number }): Promise<void>;
    fill(text: string, options?: { timeout?: number }): Promise<void>;
    selectOption(values: string[], options?: { timeout?: number }): Promise<string[]>;
    /** #778: element-scoped screenshot (viewport-clipped to the element). */
    screenshot?(options?: { timeout?: number }): Promise<Buffer>;
  };
  route(pattern: string, handler: (route: BrowserRouteLike) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

/** #777: playwright download handle (structural, faked in tests). */
export interface BrowserDownloadLike {
  suggestedFilename(): string;
  /** Downloads to a directory; resolves to the saved file path. */
  saveAs(path: string): Promise<void>;
  /** When present: cancelled downloads fail this promise. */
  cancel?(): Promise<void>;
}

export interface BrowserLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<BrowserLike>;
  executablePath(): string;
}

interface PlaywrightModule {
  chromium: PlaywrightChromium;
}

/** Probes for the optional peer: null (with a reason) when absent. */
export function loadPlaywrightSync(): { pw: PlaywrightModule } | { missing: string } {
  try {
    // Synchronous on purpose: the registration decision (register the
    // tool or emit the diagnostic) happens inside the sync session
    // assembly. createRequire dodges Bun's eager-async import graph.
    const { createRequire } = require("node:module") as typeof import("node:module");
    const req = createRequire(import.meta.url);
    const pw = req("playwright-core") as PlaywrightModule;
    if (typeof pw?.chromium?.launchPersistentContext !== "function") return { missing: "playwright-core is installed but unusable" };
    return { pw };
  } catch {
    return { missing: "playwright-core is not installed" };
  }
}

/** True when a Chromium build exists in playwright's registry. */
export function chromiumInstalled(pw: PlaywrightModule): boolean {
  try {
    const p = pw.chromium.executablePath();
    return typeof p === "string" && p.length > 0 && existsSync(p);
  } catch {
    return false;
  }
}

/** Availability probe for the registration diagnostic: never throws. */
export function browserAvailability(
  injected?: unknown,
): { available: true; pw: PlaywrightModule } | { available: false; reason: string } {
  const loaded = injected !== undefined ? injected : loadPlaywrightSync();
  if (typeof loaded === "object" && loaded !== null && "missing" in (loaded as object)) {
    return { available: false, reason: (loaded as { missing: string }).missing };
  }
  const mod = (loaded as { pw: PlaywrightModule }).pw;
  if (!chromiumInstalled(mod)) {
    return { available: false, reason: "no Chromium build found" };
  }
  return { available: true, pw: mod };
}

/**
 * One browser per session. Lazily launches on first `navigate`; `dispose`
 * reaps the process (idempotent). Blocks until the first page exists.
 */
export class BrowserSession {
  #page: BrowserPageLike | null = null;
  /** #777: the SSRF route handler installs once per page, not per navigate. */
  #routeGuardInstalled = false;
  #browser: BrowserLike | null = null;
  #disposed = false;
  /** #777: downloads observed by the page listener, awaiting the ask. */
  #pendingDownloads: BrowserDownloadLike[] = [];
  /** #775: ref → compact description, from the latest full snapshot. */
  #describe = new Map<string, string>();
  readonly #profileDir: string;
  readonly #headless: boolean;
  readonly #playwright: unknown;
  readonly #lookup: ((host: string) => Promise<{ address: string; family: number }[]>) | undefined;
  /** #777: download staging dir for this project. */
  readonly #downloadDir: string;

  constructor(options: BrowserOptions = {}) {
    const home = options.home ?? homedir();
    const slug = projectSlug(options.cwd ?? process.cwd(), home);
    this.#profileDir = join(home, ".moh", "browser-profile", slug);
    this.#downloadDir = join(home, ".moh", "browser-downloads", slug);
    this.#headless = options.headless ?? true;
    this.#playwright = options.playwright;
    this.#lookup = options.lookup;
  }

  /** #776: the navigation guard, bound to this session's DNS seam. */
  #verify(url: string, allowedHosts: readonly string[]): Promise<URL> {
    return verifyNavigable(url, allowedHosts, this.#lookup ? { lookup: this.#lookup } : {});
  }

  /** Launches (once) and returns the single page. Never launches after dispose. */
  async #ensurePage(): Promise<BrowserPageLike> {
    if (this.#disposed) throw new Error("browser: session disposed");
    if (this.#page) return this.#page;
    const probe = browserAvailability(this.#playwright);
    if (!probe.available) {
      throw new BrowserUnavailableError(`${probe.reason}. Install with: ${BROWSER_INSTALL_HINT}`);
    }
    const pw = probe.pw;
    mkdirSync(this.#profileDir, { recursive: true, mode: 0o700 });
    chmodSync(this.#profileDir, 0o700);
    // The profile dir rides launchPersistentContext, which makes
    // playwright-core spawn Chromium with `--user-data-dir=<dedicated
    // profile>` and `--remote-debugging-pipe` itself (driven over fds
    // 3/4 — never a TCP debug port, never the user's real profile;
    // passing either flag by hand makes playwright refuse to launch).
    this.#browser = await pw.chromium.launchPersistentContext(this.#profileDir, {
      headless: this.#headless,
      args: [
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    this.#page = await this.#browser!.newPage();
    // #777: collect download events; staging happens only through
    // stageDownload (ask-gated). Without it, the download is simply
    // never saved — blocked by default.
    const page = this.#page as BrowserPageLike & {
      on?: (event: "download", handler: (download: BrowserDownloadLike) => void) => void;
    };
    page.on?.("download", (download) => {
      this.#pendingDownloads.push(download);
    });    return this.#page;
  }

  /**
   * Navigates and returns the fresh a11y snapshot (all refs die with the
   * document — the response always carries the new snapshot).
   */
  async navigate(url: string, allowedHosts: readonly string[] = []): Promise<string> {
    await this.#verify(url, allowedHosts);
    const page = await this.#ensurePage();
    if (!this.#routeGuardInstalled) {
      await installRouteGuard(page, allowedHosts, (u) => this.#verify(u, allowedHosts));
      this.#routeGuardInstalled = true;
    }
    await page.goto(url, { waitUntil: "load", timeoutMs: 30_000 });
    return this.snapshot();
  }

  /** a11y snapshot of the page, or of one `ref` subtree. */
  async snapshot(ref?: string, depth?: number): Promise<string> {
    const page = await this.#page;
    if (!page) throw new Error("browser: no page open — navigate first");
    const options = { mode: "ai", ...(depth ? { depth } : {}) } as const;
    // Older playwright builds lack Page.ariaSnapshot: snapshot via the
    // body locator, which is present across all versions that have the
    // a11y snapshot API at all.
    let text: string;
    if (ref !== undefined) {
      const locator = page.locator(`aria-ref=${refNumber(ref)}`);
      text = applySnapshotBudget(await locator.ariaSnapshot(options));
    } else {
      const snapshottable = page as BrowserPageLike & { ariaSnapshot?: (o: typeof options) => Promise<string> };
      text = snapshottable.ariaSnapshot
        ? await snapshottable.ariaSnapshot(options)
        : await page.locator("body").ariaSnapshot(options);
      text = applySnapshotBudget(text);
    }
    // #775: refresh the element descriptions the permission asks render.
    // A subtree snapshot merges into the full-page map (a subtree re-call
    // must not wipe descriptions for refs outside the subtree, #777).
    this.#describe = ref !== undefined
      ? new Map([...this.#describe, ...parseSnapshotDescriptions(text)])
      : parseSnapshotDescriptions(text);
    return text;
  }

  /**
   * #775: compact description of one `ref` element from the latest
   * snapshot (`[button "Delete permanently"]`), for the permission ask.
   * Null when the ref is unknown or stale.
   */
  describeElement(ref: string): string | null {
    try {
      return this.#describe.get(refNumber(ref)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * #777: act-tier element addressing — resolves `ref` against the live
   * DOM via the `aria-ref=eN` selector (Playwright actionability:
   * scroll-into-view, hit-target verification). A ref that no longer
   * resolves throws `StaleRefError` carrying the fresh snapshot; a ref
   * the snapshot never named is an immediate invalid-ref error.
   */
  async #resolveRef(ref: string): Promise<ReturnType<BrowserPageLike["locator"]>> {
    const page = await this.#page;
    if (!page) throw new Error("browser: no page open — navigate first");
    const token = refNumber(ref);
    if (!this.#describe.has(token)) {
      // Unknown to the latest snapshot: try the DOM anyway — the snapshot
      // may have been truncated — but a miss is final (no invented refs).
      const locator = page.locator(`aria-ref=${token}`);
      if (!(await refExists(locator))) {
        const fresh = await this.snapshot();
        throw new StaleRefError(ref, fresh);
      }
      return locator;
    }
    return page.locator(`aria-ref=${token}`);
  }

  /** #777: click with Playwright actionability (hit-target, not coordinates). */
  async click(ref: string): Promise<string> {
    const locator = await this.#resolveRef(ref);
    try {
      await locator.click({ timeout: ACT_TIMEOUT_MS });
    } catch (e) {
      return await this.#actFailure(ref, e);
    }
    return this.#actResult(`clicked [${this.describeElement(ref) ?? ref}]`);
  }

  /** #777: fill (replaces the value) with actionability. */
  async fill(ref: string, text: string): Promise<string> {
    const locator = await this.#resolveRef(ref);
    try {
      await locator.fill(text, { timeout: ACT_TIMEOUT_MS });
    } catch (e) {
      return await this.#actFailure(ref, e);
    }
    return this.#actResult(`filled [${this.describeElement(ref) ?? ref}]`);
  }

  /** #777: select an option (by value or visible label) on a `<select>`. */
  async select(ref: string, option: string): Promise<string> {
    const locator = await this.#resolveRef(ref);
    try {
      const picked = await locator.selectOption([option], { timeout: ACT_TIMEOUT_MS });
      return this.#actResult(
        `selected ${picked.length > 0 ? `"${picked[0]}"` : "nothing"} on [${this.describeElement(ref) ?? ref}]`,
      );
    } catch (e) {
      return await this.#actFailure(ref, e);
    }
  }

  /** #777: scroll the viewport (mouse wheel — no element targeting). */
  async scroll(direction: "up" | "down" | "left" | "right", amount = 600): Promise<string> {
    const page = await this.#page;
    if (!page) throw new Error("browser: no page open — navigate first");
    const mouse = page.mouse;
    if (!mouse) throw new Error("browser: scroll unavailable (no mouse seam)");
    const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
    const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
    await mouse.wheel(dx, dy);
    return this.#actResult(`scrolled ${direction} by ${amount}px`);
  }

  /** #777: press a key combo on the page (devtools-console semantics). */
  async pressKey(key: string): Promise<string> {
    const page = await this.#page;
    if (!page) throw new Error("browser: no page open — navigate first");
    const keyboard = page.keyboard;
    if (!keyboard) throw new Error("browser: press_key unavailable (no keyboard seam)");
    await keyboard.press(key);
    return this.#actResult(`pressed ${key}`);
  }

  /** #777: wait until a text appears in the page or a ref becomes visible. */
  async waitFor(target: { text?: string; ref?: string }, timeoutMs = ACT_TIMEOUT_MS): Promise<string> {
    const page = await this.#page;
    if (!page) throw new Error("browser: no page open — navigate first");
    if (target.ref !== undefined) {
      const locator = await this.#resolveRef(target.ref); // stale refs fail fast, with the fresh snapshot
      await waitForLocatorVisible(locator, timeoutMs);
      return this.#actResult(`ref ${target.ref} is visible`);
    }
    if (typeof target.text === "string") {
      const fn = (page as { waitForFunction?: (fn: string, arg: string, o: { timeout?: number }) => Promise<void> })
        .waitForFunction;
      if (!fn) throw new Error("browser: wait_for text unavailable (no waitForFunction seam)");
      await fn.call(page, "(text) => document.body?.innerText?.includes(text)", target.text, { timeout: timeoutMs });
      return this.#actResult(`text "${target.text}" appeared`);
    }
    throw new Error("browser: wait_for needs 'text' or 'ref'");
  }

  /**
   * #778: captures a PNG of the viewport, or of one `ref` element
   * (element-scoped). Returns raw bytes + a target description for the
   * text chip; the tool layer decides image part vs chip + warning.
   */
  async screenshot(ref?: string): Promise<ScreenshotResult> {
    const page = await this.#page;
    if (!page) throw new Error("browser: no page open — navigate first");
    const toResult = (bytes: Buffer, target: string): ScreenshotResult => ({
      mime: "image/png",
      base64: bytes.toString("base64"),
      target,
    });
    if (ref !== undefined) {
      const locator = (await this.#resolveRef(ref)) as ReturnType<BrowserPageLike["locator"]>;
      const shot = locator.screenshot;
      if (typeof shot !== "function") throw new Error("browser: screenshot unavailable (no element screenshot seam)");
      try {
        return toResult(await shot.call(locator, { timeout: ACT_TIMEOUT_MS }), this.describeElement(ref) ?? `element ${ref}`);
      } catch (e) {
        throw await this.#actFailure2(ref, e);
      }
    }
    const pageShot = (page as { screenshot?: (o?: { fullPage?: boolean }) => Promise<Buffer> }).screenshot;
    if (typeof pageShot !== "function") throw new Error("browser: screenshot unavailable (no page screenshot seam)");
    return toResult(await pageShot.call(page, { fullPage: false }), "viewport");
  }

  /**
   * #778: evaluates one expression in the full page context
   * (devtools-console semantics — no read-only sandbox is promised; the
   * control is the act-tier ask, not a wrapper). The result is
   * serialized with a hard output cap and a visible truncation marker.
   */
  async evalJs(expression: string): Promise<string> {
    const page = await this.#page;
    if (!page) throw new Error("browser: no page open — navigate first");
    const evaluate = (page as { evaluate?: (fn: string, arg?: unknown) => Promise<unknown> }).evaluate;
    if (typeof evaluate !== "function") throw new Error("browser: eval_js unavailable (no evaluate seam)");
    let value: unknown;
    try {
      value = await evaluate.call(page, `(() => { "use strict"; return (${expression}); })()`);
    } catch (e) {
      throw new Error(`browser: eval_js failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return applyEvalBudget(serializeEvalValue(value));
  }

  /** #778: screenshot-flavored act-failure — same re-probe contract as
   * #actFailure, kept separate only because screenshots do not append a
   * fresh snapshot to a binary result. */
  async #actFailure2(ref: string, e: unknown): Promise<never> {
    if (e instanceof StaleRefError) throw e;
    let known = false;
    try {
      known = this.#describe.has(refNumber(ref));
    } catch {
      known = false;
    }
    if (!known) throw new StaleRefError(ref, await this.snapshot());
    const page = await this.#page;
    const stillThere = page ? await refExists(page.locator(`aria-ref=${refNumber(ref)}`)).catch(() => false) : false;
    if (!stillThere) throw new StaleRefError(ref, await this.snapshot());
    throw e;
  }

  /**
   * #777: upload a local file into a file input. The source path must
   * resolve inside the project root (realpath-anchored, like write);
   * outside root throws — the tool layer turns it into the
   * per-occurrence out-of-root ask, never a persistable rule.
   */
  async upload(ref: string, path: string, options: UploadOptions & { allowOutOfRoot?: boolean }): Promise<string> {
    const inside = inRootPath(options.root, path);
    const source = inside ?? path;
    if (!inside) {
      if (!options.allowOutOfRoot) throw new OutOfRootError(path, options.root);
    }
    // Existence checks apply to both branches — an approved out-of-root
    // path gets the same precise errors as an in-root one.
    if (!existsSync(source)) throw new Error(`browser: upload source not found: ${source}`);
    if (!statSync(source).isFile()) throw new Error(`browser: upload source is not a file: ${source}`);
    const locator = await this.#resolveRef(ref);
    const setInputFiles = (
      locator as { setInputFiles?: (files: string[], o?: { timeout?: number }) => Promise<void> }
    ).setInputFiles;
    if (typeof setInputFiles !== "function") throw new Error("browser: upload unavailable (no setInputFiles seam)");
    try {
      await setInputFiles.call(locator, [source], { timeout: ACT_TIMEOUT_MS });
    } catch (e) {
      return await this.#actFailure(ref, e);
    }
    return this.#actResult(`uploaded ${source} into [${this.describeElement(ref) ?? ref}]`);
  }

  /**
   * #777: consume one pending download, if any, and stage it after the
   * ask. Downloads are blocked by default: with no ask seam nothing is
   * ever written and the download is cancelled. The ask carries name +
   * size (the file is saved to a temp location first — the only way to
   * know the size — and deleted on refusal). Returns the staged path, or
   * null when no download materialized (nothing staged, no silent
   * writes). Never auto-opens the file.
   */
  async stageDownload(options: DownloadStagingOptions = {}, timeoutMs = 5000): Promise<string | null> {
    const pending = this.#pendingDownloads.shift();
    if (!pending) return null;
    const filename = pending.suggestedFilename().replace(/[/\\]/g, "_") || "download";
    const staging = options.dir ?? this.#downloadDir;
    // Save first (size is only known after the transfer), then ask.
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    const tmp = join(mkdtempSync(join(staging, ".dl-")), filename);
    await pending.saveAs(tmp);
    const size = statSync(tmp).size;
    let decision: "allow" | "deny" = "deny";
    if (options.ask) decision = await options.ask({ filename, size });
    if (decision !== "allow") {
      rmSync(dirname(tmp), { recursive: true, force: true });
      return null;
    }
    const target = join(staging, filename);
    copyFileSync(tmp, target);
    rmSync(dirname(tmp), { recursive: true, force: true });
    return target;
  }

  /** Shared act-failure path: re-probe the ref against the live DOM. A
   * dead ref (or a Playwright timeout, whose usual cause is the element
   * being gone or covered after a mutation) surfaces as a stale-ref
   * error with the fresh snapshot so the model can re-target; a live
   * ref propagates the real error (e.g. a missing select option). */
  async #actFailure(ref: string, e: unknown): Promise<string> {
    if (e instanceof StaleRefError) throw e;
    let known = false;
    try {
      known = this.#describe.has(refNumber(ref));
    } catch {
      known = false;
    }
    if (!known) throw new StaleRefError(ref, await this.snapshot());
    const page = await this.#page;
    const stillThere = page ? await refExists(page.locator(`aria-ref=${refNumber(ref)}`)).catch(() => false) : false;
    if (!stillThere) throw new StaleRefError(ref, await this.snapshot());
    throw e;
  }

  /** Act results end with the fresh snapshot: actions mutate the DOM, so
   * the model always sees current refs for the next step. */
  async #actResult(message: string): Promise<string> {
    return `${message}\n\n${await this.snapshot()}`;
  }

  /** Visible text of the page or of one `ref` element. */
  async readText(ref?: string): Promise<string> {
    const page = await this.#page;
    if (!page) throw new Error("browser: no page open — navigate first");
    if (ref !== undefined) {
      const locator = page.locator(`aria-ref=${refNumber(ref)}`);
      return applySnapshotBudget((await locator.textContent({ timeout: 10_000 })) ?? "");
    }
    // Whole-page text: the DOM body's textContent is the honest read view.
    const text = await page.locator("body").textContent({ timeout: 10_000 });
    return applySnapshotBudget(text ?? "");
  }

  /** The live page URL (permission-gate seam, #775): null before the first
   * navigate or after dispose. Never throws. */
  pageUrl(): string | null {
    try {
      const page = this.#page as (BrowserPageLike & { url?: () => string }) | null;
      const url = page?.url?.();
      return typeof url === "string" && url ? url : null;
    } catch {
      return null;
    }
  }

  /**
   * #777: records a download event (the page listener calls this; tests
   * inject fakes through it). Staging itself only happens via
   * `stageDownload`, which is ask-gated.
   */
  emitDownload(download: BrowserDownloadLike): void {
    this.#pendingDownloads.push(download);
  }

  /** Reaps browser and page. Idempotent; safe mid-session and at dispose. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    try {
      await this.#page?.close();
    } catch { /* already gone */ }
    try {
      await this.#browser?.close();
    } catch { /* already gone */ }
    this.#page = null;
    this.#browser = null;
  }
}

/** #777: an upload source outside the project root — the per-occurrence
 * out-of-root ask (never persistable), same class as the write tool's. */
export class OutOfRootError extends Error {
  constructor(path: string, root: string) {
    super(
      `browser: upload source "${path}" is outside the project root (${root}) — ` +
        `out-of-root paths require per-occurrence approval and never persist as a rule`,
    );
    this.name = "OutOfRootError";
  }
}

/**
 * #777: resolves `path` inside `root` (realpath-anchored when it exists,
 * like the write tool). Returns the absolute path, or null when it
 * escapes the root.
 */
export function inRootPath(root: string, path: string): string | null {
  const abs = isAbsolute(path) ? path : resolve(root, path);
  let base = root;
  try {
    // macOS tmpdirs are /var/... symlinks of /private/var/... — compare
    // both sides through realpath, or every tmpdir file reads out-of-root.
    base = realpathSync(root);
  } catch { /* keep lexical root */ }
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch { /* nonexistent: lexical check only */ }
  const rel = relative(base, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

/** #777: existence probe on a fake locator (no real DOM in tests). */
async function refExists(locator: { textContent(o?: { timeout?: number }): Promise<string | null> }): Promise<boolean> {
  try {
    await locator.textContent({ timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

/** #777: waits for a locator's element to be visible. */
async function waitForLocatorVisible(
  locator: { ariaSnapshot(o?: { mode?: string }): Promise<string> },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snap = await locator.ariaSnapshot({ mode: "ai" });
    if (snap.trim().length > 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("browser: element never became visible");
}

/** `e12` / `[ref=e12]` → the selector token `e12`. Throws on anything else.
 * Playwright's `aria-ref` engine is keyed by the full `eN` token. */
export function refNumber(ref: string): string {
  const m = /^\[?ref=(e\d+)\]?$/.exec(ref.trim()) ?? /^(e\d+)$/.exec(ref.trim());  if (!m) throw new Error(`browser: invalid ref "${ref}" (expected eN from the latest snapshot)`);
  return m[1]!;
}

/**
 * #775: extracts per-ref compact element descriptions from a ref-annotated
 * snapshot line (`- button "Delete permanently" [ref=e12]`). Best-effort:
 * refs without a recognizable label simply have no description.
 */
export function parseSnapshotDescriptions(snapshot: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of snapshot.split("\n")) {
    const m = /^(.*)\[ref=(e\d+)\]\s*$/.exec(line.trim());
    if (!m) continue;
    const label = m[1]!.replace(/^[-\s]+/, "").replace(/\s+/g, " ").trim();
    if (label) out.set(m[2]!, `[${label}]`);
  }
  return out;
}
