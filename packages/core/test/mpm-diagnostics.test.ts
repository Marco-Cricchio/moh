import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MpmService } from "../src/mpm/service";
import { extractWorkspace } from "../src/mpm/extractor";
import { mpmDiagnostics } from "../src/mpm/diagnostics";
import { resolveMpmConfig } from "../src/mpm/config";

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "moh-mpm-diag-"));
}

function loadedService(root: string, dir: string): MpmService {
  const service = new MpmService(dir);
  service.rebuild(extractWorkspace(root));
  return service;
}

describe("mpm diagnostics (#618)", () => {
  test("ready projection: coverage per language, budgets, capabilities — no content", () => {
    const root = workspace();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), 'import { b } from "./b";\nexport const a = 1;\n');
    writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");
    const dir = join(mkdtempSync(join(tmpdir(), "moh-mpm-diag-dir-")), "project-map");
    const service = loadedService(root, dir);
    const diag = mpmDiagnostics({ service, root, config: resolveMpmConfig({}) });
    expect(diag.status).toBe("ready");
    expect(diag.disabled).toBe(false);
    expect(diag.fileCount).toBe(2);
    expect(diag.symbolCount).toBeGreaterThanOrEqual(2);
    const ts = diag.coverage.find((c) => c.language === "typescript");
    expect(ts?.files).toBe(2);
    expect(diag.builtAt).not.toBeNull();
    expect(diag.capabilities.length).toBeGreaterThan(0);
    // Redaction: no field carries source content or full paths to source text.
    const serialized = JSON.stringify(diag);
    expect(serialized).not.toContain("export const a");
    expect(diag).not.toHaveProperty("prompt");
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("user disablement: unavailable, reason 'user', no coverage work", () => {
    const service = new MpmService(join(workspace(), "project-map"));
    const diag = mpmDiagnostics({
      service,
      root: workspace(),
      config: resolveMpmConfig({ enabled: false }),
    });
    expect(diag.status).toBe("unavailable");
    expect(diag.disabled).toBe(true);
    expect(diag.disabledReason).toBe("user");
    expect(diag.fileCount).toBe(0);
    expect(diag.fallbackReason).toBe("disabled");
  });

  test("stale projection: edited file counts as stale", () => {
    const root = workspace();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    const dir = join(mkdtempSync(join(tmpdir(), "moh-mpm-diag-dir2-")), "project-map");
    const service = loadedService(root, dir);
    writeFileSync(join(root, "src/a.ts"), "export const a = 42;\n");
    const diag = mpmDiagnostics({ service, root, config: resolveMpmConfig({}) });
    expect(diag.staleCount).toBe(1);
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("budget and exclusion values flow from the resolved config", () => {
    const service = new MpmService(join(workspace(), "project-map"));
    const diag = mpmDiagnostics({
      service,
      root: workspace(),
      config: resolveMpmConfig({ quota: { maxFiles: 100 }, exclude: ["legacy/**"] }),
    });
    expect(diag.budget.maxFiles).toBe(100);
    expect(diag.exclusions).toEqual(["legacy/**"]);
  });

  test("eviction and pending-work counters pass through", () => {
    const service = new MpmService(join(workspace(), "project-map"));
    const diag = mpmDiagnostics({
      service,
      root: workspace(),
      config: resolveMpmConfig({}),
      pendingWork: 3,
      evictions: 7,
      fallbackReason: "stale",
    });
    expect(diag.pendingWork).toBe(3);
    expect(diag.evictions).toBe(7);
    expect(diag.fallbackReason).toBe("stale");
  });
});
