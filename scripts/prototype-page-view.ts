// PROTOTYPE — throwaway, answers wayfinder ticket #772 only.
// Question: is the a11y-refs-only view model enough for an agent to see and
// act on real pages, and at what token cost? Compare vs a11y+HTML.
// Run: bun scripts/prototype-page-view.ts <url> [...more urls]
import { chromium } from "playwright-core";

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("usage: bun scripts/prototype-page-view.ts <url> [...]");
  process.exit(1);
}

const fmt = (n: number) => `${(n / 1024).toFixed(1)} KiB (~${Math.round(n / 4)} tok)`;

const browser = await chromium.launch({
  headless: true,
  channel: "chromium", // real-Chrome new headless; falls back to bundled
}).catch(async () => chromium.launch({ headless: true }));

for (const url of urls) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});

    // --- View 1: a11y 'ai' snapshot with refs (the candidate default view)
    const t0 = Date.now();
    const snap = await page.locator("body").ariaSnapshot({ mode: "ai" });
    const snapMs = Date.now() - t0;
    const snapBytes = Buffer.byteLength(snap ?? "");

    // --- View 2: what HTML access would add
    const html = await page.content();
    const htmlBytes = Buffer.byteLength(html);
    const visibleText = await page.locator("body").innerText().catch(() => "");
    const textBytes = Buffer.byteLength(visibleText);

    // --- Ref stability probe: mutate the DOM (simulate SPA update), re-snapshot
    const probe = await page.evaluate(() => {
      const btn = document.querySelector("button, a[href]");
      if (btn) btn.textContent = (btn.textContent ?? "") + " !";
      const d = document.createElement("div");
      d.setAttribute("role", "status");
      d.textContent = "injected live region";
      document.body.appendChild(d);
    });
    void probe;
    const snap2 = await page.locator("body").ariaSnapshot({ mode: "ai" });
    const refs1 = new Set([...(snap ?? "").matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]));
    const refs2 = new Set([...(snap2 ?? "").matchAll(/\[ref=(e\d+)\]/g)].map((m) => m[1]));
    const kept = [...refs1].filter((r) => refs2.has(r)).length;

    // --- Action reliability probe: act purely from refs (click first link ref)
    let actResult = "no interactive ref found";
    const firstRef = [...(snap ?? "").matchAll(/\[ref=(e\d+)\]/g)][0]?.[1];
    if (firstRef) {
      try {
        await page.locator(`aria-ref=${firstRef}`).click({ timeout: 5_000, trial: true });
        actResult = `ref ${firstRef} resolves + clickable (trial)`;
      } catch (e) {
        actResult = `ref ${firstRef} FAILED: ${(e as Error).message.split("\n")[0]}`;
      }
    }

    // --- Where refs break: count roles with no a11y node
    const diag = await page.evaluate(() => ({
      canvases: document.querySelectorAll("canvas").length,
      iframes: document.querySelectorAll("iframe").length,
      shadowHosts: [...document.querySelectorAll("*")].filter((el) => (el as HTMLElement).shadowRoot).length,
    }));

    console.log(`\n=== ${url}`);
    console.log(`a11y snapshot ('ai', refs): ${fmt(snapBytes)} in ${snapMs}ms, ${refs1.size} refs`);
    console.log(`raw HTML:                   ${fmt(htmlBytes)} (${(snapBytes / htmlBytes * 100).toFixed(1)}% of HTML)`);
    console.log(`visible text only:          ${fmt(textBytes)}`);
    console.log(`ref stability after DOM mutation: ${kept}/${refs1.size} refs kept (${refs2.size - kept} new)`);
    console.log(`action-from-ref: ${actResult}`);
    console.log(`ref-breakers: canvas=${diag.canvases} iframe=${diag.iframes} shadowHosts=${diag.shadowHosts}`);

    // save artifacts for owner inspection
    const slug = url.replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync("prototype-artifacts", { recursive: true });
    writeFileSync(`prototype-artifacts/${slug}.a11y.txt`, snap ?? "");
    writeFileSync(`prototype-artifacts/${slug}.a11y-after-mutation.txt`, snap2 ?? "");
    const shot = await page.screenshot({ fullPage: false });
    writeFileSync(`prototype-artifacts/${slug}.png`, shot);
    console.log(`artifacts: prototype-artifacts/${slug}.{a11y.txt,png} (${fmt(shot.length)} screenshot)`);
  } catch (e) {
    console.log(`\n=== ${url}\nFAILED: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await ctx.close();
  }
}
await browser.close();
