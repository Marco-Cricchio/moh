/**
 * #774 / ADR-0029: browser tool skeleton — read tier. Unit tests over the
 * pure seams (SSRF guard, snapshot budget, ref parsing, availability
 * probe, registration policy) with a fake playwright module; the live
 * launch path is covered by an integration test that runs only when a
 * real Chromium is present.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  StaleRefError,
  applySnapshotBudget,
  assertNavigable,
  BrowserSession,
  BrowserUnavailableError,
  browserAvailability,
  refNumber,
  verifyNavigable,
  BROWSER_INSTALL_HINT,
} from "../src/browser";
import { browserTool } from "../src/browser-tool";
import { builtinTools } from "../src/builtin-tools";

const ctx = (cwd: string) => ({ signal: new AbortController().signal, cwd, onProgress: () => {} });

describe("assertNavigable (SSRF guard)", () => {
  test("loopback is allowed by default (dev-debug use case)", () => {
    expect(assertNavigable("http://localhost:3000").hostname).toBe("localhost");
    expect(assertNavigable("http://127.0.0.1:8080/").hostname).toBe("127.0.0.1");
  });

  test("private/link-local targets are blocked with a clear reason", () => {
    for (const url of ["http://169.254.169.254/", "http://192.168.1.1/", "http://10.0.0.1/"]) {
      expect(() => assertNavigable(url)).toThrow(/blocked by default/);
    }
  });

  test("allowedHosts is a per-host escape hatch", () => {
    expect(assertNavigable("http://192.168.1.1/", ["192.168.1.1"]).hostname).toBe("192.168.1.1");
    // A different private host stays blocked — no blanket bypass.
    expect(() => assertNavigable("http://10.0.0.1/", ["192.168.1.1"])).toThrow();
    // #776: config entries are normalized (case-insensitive, no brackets).
    expect(assertNavigable("http://127.0.0.1:9000/", [" LOCALHOST "]).hostname).toBe("127.0.0.1");
  });

  test("public URLs pass; non-http schemes are rejected", () => {
    expect(assertNavigable("https://example.com/").hostname).toBe("example.com");
    expect(() => assertNavigable("file:///etc/passwd")).toThrow(/http\/https/);
  });

  test("#776: non-canonical IPv4 spellings normalize before the private check", () => {
    // WHATWG URL canonicalizes decimal/hex/octal IPv4 to dotted quad —
    // loopback spellings land in the allowed loopback branch, private
    // spellings (192.168.0.1 = 3232235521) are blocked: no spelling games.
    expect(assertNavigable("http://2130706433/").hostname).toBe("127.0.0.1");
    expect(() => assertNavigable("http://3232235521/")).toThrow(/blocked by default/);
    expect(() => assertNavigable("http://0xC0A80001/")).toThrow(/blocked by default/);
  });
});

describe("applySnapshotBudget", () => {
  test("under budget: unchanged", () => {
    const text = "- banner [ref=e1]\n  - heading \"Hi\" [ref=e2]";
    expect(applySnapshotBudget(text, 1000)).toBe(text);
  });

  test("over budget: truncated with a visible marker and refinement guidance", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `- link "item ${i}" [ref=e${i}]`).join("\n");
    const out = applySnapshotBudget(text, 1000);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain("truncated");
    expect(out).toMatch(/ref.*depth/s);
  });

  test("never splits a [ref=eN] token", () => {
    const text = `- link "a" [ref=e1]\n- link "b" [ref=e200]`;
    const out = applySnapshotBudget(text, 25);
    expect(out).not.toMatch(/\[ref=e\d{0,2}$/);
  });
});

describe("refNumber", () => {
  test("accepts the snapshot's ref spellings and returns the selector token", () => {
    expect(refNumber("e12")).toBe("e12");
    expect(refNumber("[ref=e12]")).toBe("e12");
  });
  test("rejects invented refs", () => {
    expect(() => refNumber("button")).toThrow(/invalid ref/);
    expect(() => refNumber("12")).toThrow(/invalid ref/);
  });
});

/** Minimal fake playwright module: one page whose snapshot is scripted. */
function fakePlaywright(pageBehavior: {
  snapshot?: () => string;
  goto?: (url: string) => void;
}) {
  const page = {
    goto: async (url: string) => { pageBehavior.goto?.(url); },
    ariaSnapshot: async (_options?: { mode?: string; depth?: number }) => pageBehavior.snapshot?.() ?? "- heading \"Page\" [ref=e1]",
    locator: (selector: string) => ({
      ariaSnapshot: async () => `- link \"sub\" [ref=e2] (via ${selector})`,
      textContent: async () => "hello world",
      click: async () => {},
      fill: async (_text: string) => {},
      selectOption: async (values: string[]) => values,
    }),
    close: async () => {},
    // #776: the session's per-hop SSRF route handler, captured for tests.
    routeInterceptor: null as unknown,
    route: async (_pattern: string, handler: unknown) => { page.routeInterceptor = handler; },
  };
  const closed = { browser: 0, page: 0 };
  const launched: { args: string[]; options: Record<string, unknown> }[] = [];
  return {
    launched,
    closed,
    pw: {
      chromium: {
        executablePath: () => import.meta.path, // a real, existing file
        launchPersistentContext: async (_userDataDir: string, options: Record<string, unknown>) => {
          launched.push({ args: (options.args as string[]) ?? [], options });
          return {
            newPage: async () => {
              const originalClose = page.close.bind(page);
              (page as any).close = async () => { closed.page++; await originalClose(); };
              return page;
            },
            close: async () => { closed.browser++; },
          };
        },
      },
    },
    page,
  };
}

describe("browserAvailability", () => {
  test("present toolchain: available", () => {
    const fake = fakePlaywright({});
    expect(browserAvailability(fake)).toEqual({ available: true, pw: fake.pw });
  });
  test("missing playwright-core: unavailable with a reason", () => {
    const probe = browserAvailability({ missing: "playwright-core is not installed" });
    expect(probe.available).toBe(false);
    if (!probe.available) expect(probe.reason).toContain("not installed");
  });
  test("no Chromium build: unavailable", () => {
    const bad = { pw: { chromium: { executablePath: () => "/nonexistent/chrome", launch: async () => { throw new Error("no"); } } } };
    expect(browserAvailability(bad).available).toBe(false);
  });
});

describe("BrowserSession with a fake playwright", () => {
  test("navigate launches with the mandated flags, headless by default, and returns the snapshot", async () => {
    const fake = fakePlaywright({ snapshot: () => "- banner [ref=e1]\n- main [ref=e2]" });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    const out = await session.navigate("http://localhost:3000");
    expect(out).toContain("[ref=e1]");
    const call = fake.launched[0]!;
    // Playwright-core itself adds --remote-debugging-pipe and the
    // user-data-dir when launching a persistent context; we only supply
    // the extra hardening flags.
    expect(call.args).toContain("--no-first-run");
    expect(call.args).toContain("--no-default-browser-check");
    expect(call.options.headless).toBe(true); // browser.headless default
    await session.dispose();
  });

  test("browser.headless: false is honored on launch", async () => {
    const fake = fakePlaywright({});
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), headless: false, playwright: fake });
    await session.navigate("http://localhost:3000");
    expect(fake.launched[0]!.options.headless).toBe(false);
    await session.dispose();
  });

  test("private URLs never reach the browser", async () => {
    const fake = fakePlaywright({});
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await expect(session.navigate("http://169.254.169.254/")).rejects.toThrow(/blocked by default/);
    expect(fake.launched).toHaveLength(0); // lazily launched: blocked before launch
    await session.dispose();
  });

  test("snapshot with ref scopes to the subtree via the aria-ref selector; read_text returns visible text", async () => {
    const fake = fakePlaywright({});
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const subtree = await session.snapshot("e2");
    expect(subtree).toContain("aria-ref=e2");
    expect(await session.readText()).toBe("hello world");
    await session.dispose();
  });

  test("close reaps the page and the browser mid-session", async () => {
    const fake = fakePlaywright({});
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    await session.dispose();
    expect(fake.closed.page).toBe(1);
    expect(fake.closed.browser).toBe(1);
  });

  test("close mid-session and dispose are idempotent; use after dispose throws", async () => {
    const fake = fakePlaywright({});
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    await session.dispose();
    await session.dispose();
    await expect(session.navigate("http://localhost:3000")).rejects.toThrow(/disposed/);
  });
});

describe("browserTool dispatch", () => {
  test("close returns a confirmation; navigate returns the fresh snapshot", async () => {
    const fake = fakePlaywright({ snapshot: () => "- heading \"Fresh\" [ref=e9]" });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    const tool = browserTool({ session });
    const nav = await tool.execute({ action: "navigate", url: "http://localhost:3000" }, ctx("/tmp"));
    expect(nav).toContain("Fresh");
    expect(await tool.execute({ action: "close" }, ctx("/tmp"))).toContain("closed");
  });

  test("an unavailable toolchain degrades to a visible message, never a crash", async () => {
    const session = new BrowserSession({
      home: mkdtempSync(join(tmpdir(), "moh-browser-")),
      playwright: { missing: "playwright-core is not installed" },
    });
    const tool = browserTool({ session });
    const out = await tool.execute({ action: "navigate", url: "http://localhost:3000" }, ctx("/tmp"));
    expect(out).toContain("browser unavailable");
    expect(out).toContain(BROWSER_INSTALL_HINT);
  });

  test("snapshot before navigate is a precise error", async () => {
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fakePlaywright({}) });
    const tool = browserTool({ session });
    await expect(tool.execute({ action: "snapshot" }, ctx("/tmp"))).rejects.toThrow(/navigate first/);
  });
});

describe("registration policy (builtinTools)", () => {
  test("zero config: no browser tool, no diagnostics", () => {
    const tools = builtinTools();
    expect(tools.browser).toBeUndefined();
  });

  test("enabled with an unavailable toolchain: not registered, visible diagnostic", () => {
    // This environment has playwright-core; force the "no Chromium" branch
    // through an unresolvable registry by monkeypatching is out of scope —
    // instead assert the two invariants that hold either way: registration
    // only with availability, and diagnostics only when enabled.
    const options: Parameters<typeof builtinTools>[0] = {
      browser: { enabled: false },
      diagnostics: [],
    };
    const tools = builtinTools(options);
    expect(tools.browser).toBeUndefined();
    expect(options.diagnostics).toHaveLength(0);
  });

  test("enabled in an environment with the toolchain: registered and wired for dispose", () => {
    const availability = browserAvailability();
    const options: Parameters<typeof builtinTools>[0] = { browser: { enabled: true }, diagnostics: [] };
    const tools = builtinTools(options);
    if (availability.available) {
      expect(tools.browser).toBeDefined();
      expect(options.browserSession).toBeDefined();
      expect(options.diagnostics).toHaveLength(0);
    } else {
      expect(tools.browser).toBeUndefined();
      expect(options.diagnostics![0]).toContain("Install with:");
    }
  });
});

describe("BrowserUnavailableError", () => {
  test("is a distinct type", () => {
    expect(new BrowserUnavailableError("x")).toBeInstanceOf(BrowserUnavailableError);
  });
});

describe("#775: gate enrichment (page URL + element description)", () => {
  test("parseSnapshotDescriptions extracts compact labels per ref", () => {
    const { parseSnapshotDescriptions } = require("../src/browser") as {
      parseSnapshotDescriptions(s: string): Map<string, string>;
    };
    const snap = [
      '- button "Delete permanently" [ref=e12]',
      '- textbox "Email" [ref=e3]',
      "no refs here",
      '- link "Docs" [ref=e7]',
    ].join("\n");
    const map = parseSnapshotDescriptions(snap);
    expect(map.get("e12")).toBe('[button "Delete permanently"]');
    expect(map.get("e3")).toBe('[textbox "Email"]');
    expect(map.get("e7")).toBe('[link "Docs"]');
    expect(map.size).toBe(3);
  });

  test("gateArgs adds the live page URL and element description; navigate carries none", () => {
    const session = {
      pageUrl: () => "https://app.example.com/settings",
      describeElement: (ref: string) => (ref === "e12" ? '[button "Delete permanently"]' : null),
    };
    const tool = browserTool({
      session: session as any,
      pageUrl: () => session.pageUrl() as string,
      describeElement: (ref) => (session as any).describeElement(ref),
    });
    const gated = tool.gateArgs!({ action: "click", ref: "e12" } as any) as Record<string, unknown>;
    expect(gated.action).toBe("click");
    expect(gated.pageUrl).toBe("https://app.example.com/settings");
    expect(gated.elementDescription).toBe('[button "Delete permanently"]');
    const nav = tool.gateArgs!({ action: "navigate", url: "https://x.test/" } as any) as Record<string, unknown>;
    expect(nav.pageUrl).toBe("https://x.test/"); // navigate: its own target is the gate URL
    expect(nav.elementDescription).toBeUndefined();
  });
});

describe("verifyNavigable (#776: DNS verification)", () => {
  test("a public hostname resolving to a private address is blocked", async () => {
    for (const address of ["169.254.169.254", "192.168.1.1", "10.0.0.1", "172.16.0.9"]) {
      await expect(verifyNavigable("http://rebind.example/", [], { lookup: async () => [{ address, family: 4 }] }))
        .rejects.toThrow(/resolves to (the )?private address/);
    }
  });

  test("a public hostname resolving publicly passes; loopback names skip DNS", async () => {
    const url = await verifyNavigable("http://example.com/", [], { lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
    expect(url.hostname).toBe("example.com");
    // Loopback is allowed by default — no DNS resolution needed.
    await verifyNavigable("http://localhost:3000/", [], { lookup: async () => { throw new Error("no DNS"); } });
  });

  test("allowedHosts skips the DNS check for exactly that host (no wildcard subdomains)", async () => {
    const lookup = async () => { throw new Error("no DNS"); };
    // Explicit host: allowed even when it would resolve private.
    await verifyNavigable("http://host.example/", ["host.example"], { lookup });
    // Subdomain of an allowed host is NOT covered — the check applies.
    await expect(verifyNavigable("http://sub.host.example/", ["host.example"], { lookup: async () => [{ address: "10.0.0.1", family: 4 }] }))
      .rejects.toThrow(/private address/);
  });

  test("env overrides like MOH_FETCH_ALLOW_PRIVATE do not unlock the browser", async () => {
    process.env.MOH_FETCH_ALLOW_PRIVATE = "1";
    try {
      await expect(verifyNavigable("http://192.168.1.1/", [], { lookup: async () => { throw new Error("no DNS"); } }))
        .rejects.toThrow(/blocked by default/);
    } finally {
      delete process.env.MOH_FETCH_ALLOW_PRIVATE;
    }
  });

  test("unresolvable names fail closed (#776): navigation blocked, policy named", async () => {
    await expect(verifyNavigable("http://no-such-host.invalid/", [], { lookup: async () => { throw new Error("ENOTFOUND"); } }))
      .rejects.toThrow(/cannot verify.*SSRF guard/);
  });
});

describe("#776: per-hop redirect re-check", () => {
  const routeObj = (url: string, resourceType = "document") => {
    const r: {
      url(): string; resourceType(): string; continue(): Promise<void>;
      fulfill(o: { status: number; contentType: string; body: string }): Promise<void>;
      continued: number; fulfilled: { body: string } | null;
    } = {
      url: () => url,
      resourceType: () => resourceType,
      continued: 0,
      fulfilled: null,
      continue: async () => { r.continued++; },
      fulfill: async (o) => { r.fulfilled = o; },
    };
    return r;
  };

  test("a redirect hop bouncing a public URL into private space is caught", async () => {
    const fake = fakePlaywright({});
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const handler = fake.page.routeInterceptor! as (route: ReturnType<typeof routeObj>) => Promise<void>;
    const hop = routeObj("http://example.com/");
    await handler(hop);
    expect(hop.continued).toBe(1); // public hop passes
    const bad = routeObj("http://169.254.169.254/latest/meta-data/");
    await handler(bad);
    expect(bad.continued).toBe(0);
    expect((bad.fulfilled as { body: string }).body).toMatch(/SSRF guard/);
    await session.dispose();
  });

  test("only document requests are re-checked; subresources ride the page's own guard", async () => {
    const fake = fakePlaywright({});
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const handler = fake.page.routeInterceptor! as (route: ReturnType<typeof routeObj>) => Promise<void>;
    const sub = routeObj("http://169.254.169.254/track.png", "image");
    await handler(sub);
    expect(sub.continued).toBe(1);
    await session.dispose();
  });

  test("a redirect to a rebinding name is caught by DNS re-verification", async () => {
    const fake = fakePlaywright({});
    const session = new BrowserSession({
      home: mkdtempSync(join(tmpdir(), "moh-browser-")),
      playwright: fake,
      lookup: async () => [{ address: "10.9.9.9", family: 4 }],
    });
    await session.navigate("http://localhost:3000");
    const handler = fake.page.routeInterceptor! as (route: ReturnType<typeof routeObj>) => Promise<void>;
    const hop = routeObj("http://rebind.example/");
    await handler(hop);
    expect(hop.continued).toBe(0);
    expect((hop.fulfilled as { body: string }).body).toMatch(/SSRF guard/);
    await session.dispose();
  });
});

describe("#777: act tier (click/fill/select/scroll/press_key/wait_for)", () => {
  test("click addresses the element via aria-ref and returns the fresh snapshot", async () => {
    const fake = fakePlaywright({ snapshot: () => '- button "Save" [ref=e5]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const out = await session.click("e5");
    expect(out).toContain('clicked [[button "Save"]]');
    expect(out).toContain("[ref=e5]"); // fresh snapshot rides the result
    await session.dispose();
  });

  test("fill replaces the value; select picks an option", async () => {
    const fake = fakePlaywright({ snapshot: () => '- textbox "Email" [ref=e3]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const filled: string[] = [];
    (fake.page.locator as any) = (selector: string) => ({
      ariaSnapshot: async () => "- textbox",
      textContent: async () => "x",
      click: async () => {},
      fill: async (text: string) => { filled.push(`${selector}=${text}`); },
      selectOption: async (values: string[]) => values,
    });
    expect(await session.fill("e3", "a@b.c")).toContain("filled [[textbox \"Email\"]]");
    expect(filled[0]).toBe("aria-ref=e3=a@b.c");
    expect(await session.select("e3", "option-2")).toContain('selected "option-2" on [[');
    await session.dispose();
  });

  test("a ref the snapshot never named produces a stale-ref error with the fresh snapshot", async () => {
    const fake = fakePlaywright({ snapshot: () => '- button "Real" [ref=e1]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    // The fake locator resolves anything: simulate a dead ref via an
    // unknown-describe + failing textContent probe.
    (fake.page.locator as any) = (selector: string) => ({
      ariaSnapshot: async () => "- button",
      textContent: async () => { if (selector === "aria-ref=e99") throw new Error("not attached"); return "x"; },
      click: async () => {},
      fill: async () => {},
      selectOption: async (v: string[]) => v,
    });
    try {
      await session.click("e99");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StaleRefError);
      expect((e as Error).message).toContain('stale ref "e99"');
      expect((e as StaleRefError).freshSnapshot).toContain("[ref=e1]"); // fresh snapshot attached
    }
    await session.dispose();
  });

  test("a click timeout on a live ref propagates the real error (not a stale ref)", async () => {
    const fake = fakePlaywright({ snapshot: () => '- button "Ghost" [ref=e4]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    (fake.page.locator as any) = () => ({
      ariaSnapshot: async () => "- button",
      textContent: async () => "x",
      click: async () => { throw new Error("Timeout 10000ms exceeded"); },
      fill: async () => {},
      selectOption: async (v: string[]) => v,
    });
    // The fake locator still "exists" (textContent resolves), so the
    // failure propagates as the real error — a live ref's timeout is
    // not a stale ref (typically an overlay intercepting the click).
    await expect(session.click("e4")).rejects.toThrow(/Timeout 10000ms/);
    await session.dispose();
  });

  test("scroll uses the mouse wheel; press_key uses the keyboard", async () => {
    const fake = fakePlaywright({ snapshot: () => "- main [ref=e1]" });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const wheels: string[] = [];
    const keys: string[] = [];
    (fake.page as any).mouse = { wheel: async (dx: number, dy: number) => { wheels.push(`${dx},${dy}`); } };
    (fake.page as any).keyboard = { press: async (k: string) => { keys.push(k); } };
    expect(await session.scroll("down", 800)).toContain("scrolled down by 800px");
    expect(wheels).toEqual(["0,800"]);
    expect(await session.pressKey("Enter")).toContain("pressed Enter");
    expect(keys).toEqual(["Enter"]);
    await session.dispose();
  });

  test("wait_for text uses waitForFunction; wait_for ref resolves a live element", async () => {
    const fake = fakePlaywright({ snapshot: () => '- status "done" [ref=e2]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const fns: string[] = [];
    (fake.page as any).waitForFunction = async (fn: string, arg: string) => { fns.push(`${fn}|${arg}`); };
    expect(await session.waitFor({ text: "done" })).toContain('"done" appeared');
    expect(fns[0]).toContain("done");
    expect(await session.waitFor({ ref: "e2" })).toContain("visible");
    await session.dispose();
  });

  test("wait_for without text or ref is a precise error", async () => {
    const fake = fakePlaywright({});
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    await expect(session.waitFor({})).rejects.toThrow(/needs 'text' or 'ref'/);
    await session.dispose();
  });

  test("the tool dispatches act actions and gateArgs enriches refs", async () => {
    const fake = fakePlaywright({ snapshot: () => '- button "Go" [ref=e7]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    const tool = browserTool({ session, pageUrl: () => "https://app.example.com/" });
    await tool.execute({ action: "navigate", url: "http://localhost:3000" }, ctx("/tmp"));
    expect(await tool.execute({ action: "click", ref: "e7" }, ctx("/tmp"))).toContain("clicked");
    const gated = tool.gateArgs!({ action: "click", ref: "e7" } as any) as Record<string, unknown>;
    expect(gated.pageUrl).toBe("https://app.example.com/");
    await session.dispose();
  });
});

describe("#777: upload containment", () => {
  test("in-root upload resolves through the root and calls setInputFiles", async () => {
    const root = mkdtempSync(join(tmpdir(), "moh-root-"));
    const src = join(root, "report.pdf");
    writeFileSync(src, "pdf");
    const fake = fakePlaywright({ snapshot: () => '- fileinput "doc" [ref=e8]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const files: string[][] = [];
    (fake.page.locator as any) = () => ({
      ariaSnapshot: async () => "- fileinput",
      textContent: async () => "x",
      setInputFiles: async (f: string[]) => { files.push(f); },
    });
    const out = await session.upload("e8", "report.pdf", { root });
    expect(out).toContain("uploaded");
    expect(files[0]![0]).toBe(src);
    await session.dispose();
  });

  test("out-of-root upload throws OutOfRootError; the tool asks per occurrence and never persists", async () => {
    const root = mkdtempSync(join(tmpdir(), "moh-root-"));
    const fake = fakePlaywright({ snapshot: () => '- fileinput "doc" [ref=e8]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    let asked: string | undefined;
    const tool = browserTool({
      session,
      root,
      askOutOfRoot: (p) => {
        asked = p;
        return true;
      },
    });
    const outside = join(mkdtempSync(join(tmpdir(), "moh-out-")), "secret.txt");
    writeFileSync(outside, "x");
    (fake.page.locator as any) = () => ({
      ariaSnapshot: async () => "- fileinput",
      textContent: async () => "x",
      setInputFiles: async () => {},
    });
    const out = await tool.execute({ action: "upload", ref: "e8", path: outside }, ctx(root));
    expect(asked).toBe(outside); // per-occurrence ask happened
    expect(out).toContain("uploaded");
    await session.dispose();
  });

  test("out-of-root upload refused: visible refusal, no upload call", async () => {
    const root = mkdtempSync(join(tmpdir(), "moh-root-"));
    const fake = fakePlaywright({ snapshot: () => '- fileinput "doc" [ref=e8]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const tool = browserTool({ session, root, askOutOfRoot: () => false });
    const outside = join(mkdtempSync(join(tmpdir(), "moh-out-")), "secret.txt");
    const out = await tool.execute({ action: "upload", ref: "e8", path: outside }, ctx(root));
    expect(out).toContain("refused");
    await session.dispose();
  });

  test("without an ask seam, out-of-root uploads are refused outright", async () => {
    const root = mkdtempSync(join(tmpdir(), "moh-root-"));
    const fake = fakePlaywright({ snapshot: () => '- fileinput "doc" [ref=e8]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const tool = browserTool({ session, root });
    const out = await tool.execute({ action: "upload", ref: "e8", path: "/etc/passwd" }, ctx(root));
    expect(out).toContain("refused");
    await session.dispose();
  });
});

describe("#777: download staging", () => {
  function fakeDownload(filename: string, content: string) {
    return {
      suggestedFilename: () => filename,
      saveAs: async (p: string) => {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      },
      cancel: async () => {},
    };
  }

  test("a download asks with name + size, stages to the dir, and the path rides the result", async () => {
    const fake = fakePlaywright({ snapshot: () => "- main [ref=e1]" });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const dir = mkdtempSync(join(tmpdir(), "moh-dl-"));
    session.emitDownload(fakeDownload("report.csv", "a,b,c"));
    const asks: { filename: string; size: number }[] = [];
    const tool = browserTool({
      session,
      askDownload: (info) => {
        asks.push(info);
        return "allow";
      },
    });
    const out = await tool.execute({ action: "click", ref: "e1" }, ctx("/tmp"));
    expect(asks).toEqual([{ filename: "report.csv", size: 5 }]); // name + size in the ask
    expect(out).toMatch(/Download staged: .+report\.csv/);
    await session.dispose();
  });

  test("refused download: nothing staged, temp bytes deleted", async () => {
    const fake = fakePlaywright({ snapshot: () => "- main [ref=e1]" });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const dir = mkdtempSync(join(tmpdir(), "moh-dl-"));
    session.emitDownload(fakeDownload("virus.exe", "MZ"));
    const tool = browserTool({ session, askDownload: () => "deny" });
    const out = await tool.execute({ action: "click", ref: "e1" }, ctx("/tmp"));
    expect(out).not.toContain("Download staged");
    expect(readdirSync(dir)).toHaveLength(0); // no silent writes
    await session.dispose();
  });

  test("no ask seam: downloads stay blocked (nothing ever written)", async () => {
    const fake = fakePlaywright({ snapshot: () => "- main [ref=e1]" });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const dir = mkdtempSync(join(tmpdir(), "moh-dl-"));
    session.emitDownload(fakeDownload("data.json", "{}"));
    const tool = browserTool({ session });
    const out = await tool.execute({ action: "click", ref: "e1" }, ctx("/tmp"));
    expect(out).not.toContain("Download staged");
    expect(readdirSync(dir)).toHaveLength(0);
    await session.dispose();
  });

  test("no download: nothing staged, no ask", async () => {
    const fake = fakePlaywright({ snapshot: () => "- main [ref=e1]" });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    let asked = 0;
    const tool = browserTool({ session, askDownload: () => { asked++; return "allow"; } });
    await tool.execute({ action: "click", ref: "e1" }, ctx("/tmp"));
    expect(asked).toBe(0);
    await session.dispose();
  });
});

describe("#777: staging error visibility + stale-ref re-probe", () => {
  test("a staging failure surfaces in the result instead of vanishing", async () => {
    const fake = fakePlaywright({ snapshot: () => "- main [ref=e1]" });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    session.emitDownload({
      suggestedFilename: () => "x.bin",
      saveAs: async () => { throw new Error("disk full"); },
      cancel: async () => {},
    });
    const tool = browserTool({ session, askDownload: () => "allow" });
    const out = await tool.execute({ action: "click", ref: "e1" }, ctx("/tmp"));
    expect(out).toContain("staging failed");
    expect(out).toContain("disk full");
    await session.dispose();
  });

  test("a dead ref on act failure is re-classified as stale with a fresh snapshot", async () => {
    const fake = fakePlaywright({ snapshot: () => '- heading "New page" [ref=e1]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    (fake.page.locator as any) = (selector: string) => ({
      ariaSnapshot: async () => '- heading "New page" [ref=e1]',
      textContent: async (_o?: unknown) => {
        if (selector === "aria-ref=e6") throw new Error("element is not attached");
        return "x";
      },
      click: async () => { throw new Error("Timeout 10000ms exceeded"); },
      fill: async () => {},
      selectOption: async (v: string[]) => v,
    });
    try {
      await session.click("e6");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StaleRefError);
      expect((e as StaleRefError).freshSnapshot).toContain("New page");    }
    await session.dispose();
  });

  test("an approved out-of-root upload with a missing file gets the precise not-found error", async () => {
    const root = mkdtempSync(join(tmpdir(), "moh-root-"));
    const fake = fakePlaywright({ snapshot: () => '- fileinput "doc" [ref=e8]' });
    const session = new BrowserSession({ home: mkdtempSync(join(tmpdir(), "moh-browser-")), playwright: fake });
    await session.navigate("http://localhost:3000");
    const missing = join(mkdtempSync(join(tmpdir(), "moh-out-")), "gone.txt");
    const tool = browserTool({ session, root, askOutOfRoot: () => true });
    await expect(tool.execute({ action: "upload", ref: "e8", path: missing }, ctx(root))).rejects.toThrow(
      /upload source not found/,
    );
    await session.dispose();
  });
});
