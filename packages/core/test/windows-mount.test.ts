/**
 * `/mnt` I/O awareness (#918, ADR-0044): a project root that resolves under
 * `/mnt/` — a Windows drive mounted into WSL — is detected once, at session
 * assembly, and never again. The fact is environment information, so the
 * tests below pin the predicate itself (both directions, the anchoring, the
 * unresolvable-root fallback) and the session-level fact clients read.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOnWindowsMount } from "../src/windows-mount";
import { sessionFromConfig } from "../src/session/from-config";

/** A home + a distro-side project directory, both disposable. */
function tempPair(): { home: string; cwd: string; cleanup: () => void } {
  const dir = join(tmpdir(), `moh-mnt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const home = join(dir, "home");
  // The distro side of the pair is a temp project, never `process.cwd()`:
  // a test must not read the repository's own moh.json (which names a real
  // provider) or any developer's checkout.
  const cwd = join(dir, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return { home, cwd, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("isOnWindowsMount (#918)", () => {
  test("any mount under /mnt counts, not just /mnt/c", () => {
    expect(isOnWindowsMount("/mnt/c/project")).toBe(true);
    expect(isOnWindowsMount("/mnt/d/work/repo")).toBe(true);
    // WSL's own internal mounts are accepted too: the predicate is a
    // resolved prefix, deliberately (no filesystem-type sniffing), and no
    // project lives under these — the accepted cost of #913's rule.
    expect(isOnWindowsMount("/mnt/wsl/shared")).toBe(true);
    // The drive root itself is a project root too.
    expect(isOnWindowsMount("/mnt/c")).toBe(true);
  });

  test("the distro filesystem and lookalike paths do not", () => {
    expect(isOnWindowsMount("/home/me/project")).toBe(false);
    expect(isOnWindowsMount("/Users/me/project")).toBe(false);
    // The automount root is not a Windows drive...
    expect(isOnWindowsMount("/mnt")).toBe(false);
    // ...and neither is a path that merely shares the prefix letters.
    expect(isOnWindowsMount("/mntish/project")).toBe(false);
  });

  test("the resolved root decides: detection is realpath-anchored", () => {
    // A project reached through a symlink into a Windows drive is caught...
    expect(isOnWindowsMount("/home/me/project", () => "/mnt/c/project")).toBe(true);
    // ...and a /mnt-looking path resolving into the distro is not.
    expect(isOnWindowsMount("/mnt/c/project", () => "/home/me/project")).toBe(false);
  });

  test("a root that cannot be resolved is judged as given", () => {
    const boom = () => {
      throw new Error("ENOENT");
    };
    expect(isOnWindowsMount("/mnt/c/project", boom)).toBe(true);
    expect(isOnWindowsMount("/home/me/project", boom)).toBe(false);
  });
});

describe("session.rootOnWindowsMount (#918)", () => {
  test("assembly resolves the fact from the project root, both ways", () => {
    const onMount = tempPair();
    const onDistro = tempPair();
    try {
      const windows = sessionFromConfig({ cwd: "/mnt/c/project", home: onMount.home });
      expect("error" in windows).toBe(false);
      if ("error" in windows) return;
      expect(windows.session.rootOnWindowsMount).toBe(true);

      const distro = sessionFromConfig({ cwd: onDistro.cwd, home: onDistro.home });
      expect("error" in distro).toBe(false);
      if ("error" in distro) return;
      expect(distro.session.rootOnWindowsMount).toBe(false);
    } finally {
      onMount.cleanup();
      onDistro.cleanup();
    }
  });
});
