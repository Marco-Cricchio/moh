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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  if (allowedHosts.includes(host)) return url;
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
  // Loopback is allowed before any resolution; numeric public literals
  // can't rebind; explicitly allowed hosts are the operator's own choice.
  const loopback = host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "127.0.0.1";
  const numeric = /^[0-9.]+$/.test(host) || host.includes(":");
  if (loopback || numeric || allowedHosts.includes(host)) return url;
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
    // Unresolvable here: let the browser surface the real navigation error.
    if (e instanceof Error && e.message.includes("private address")) throw e;
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
  locator(selector: string): {
    ariaSnapshot(options?: { mode?: string; depth?: number }): Promise<string>;
    textContent(options?: { timeout?: number }): Promise<string | null>;
  };
  route(pattern: string, handler: (route: BrowserRouteLike) => Promise<void>): Promise<void>;
  close(): Promise<void>;
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
  #browser: BrowserLike | null = null;
  #disposed = false;
  /** #775: ref → compact description, from the latest full snapshot. */
  #describe = new Map<string, string>();
  readonly #profileDir: string;
  readonly #headless: boolean;
  readonly #playwright: unknown;
  readonly #lookup: ((host: string) => Promise<{ address: string; family: number }[]>) | undefined;

  constructor(options: BrowserOptions = {}) {
    const home = options.home ?? homedir();
    const slug = projectSlug(options.cwd ?? process.cwd(), home);
    this.#profileDir = join(home, ".moh", "browser-profile", slug);
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
    return this.#page;
  }

  /**
   * Navigates and returns the fresh a11y snapshot (all refs die with the
   * document — the response always carries the new snapshot).
   */
  async navigate(url: string, allowedHosts: readonly string[] = []): Promise<string> {
    await this.#verify(url, allowedHosts);
    const page = await this.#ensurePage();
    await installRouteGuard(page, allowedHosts, (u) => this.#verify(u, allowedHosts));
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
    this.#describe = parseSnapshotDescriptions(text);
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

/** `e12` / `[ref=e12]` → the selector token `e12`. Throws on anything else.
 * Playwright's `aria-ref` engine is keyed by the full `eN` token. */
export function refNumber(ref: string): string {
  const m = /^\[?ref=(e\d+)\]?$/.exec(ref.trim()) ?? /^(e\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`browser: invalid ref "${ref}" (expected eN from the latest snapshot)`);
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
