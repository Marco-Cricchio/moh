import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTrashedSessions, projectSlug } from "@moh/core";

// Characterization of the ordering the B3 `trash list` transcript relies on:
// newest mtime first, and an exact mtime tie falls back to file name
// descending (#1486).

const GAMMA = "20260103T000000000Z-44444444";
const TRASHED = "20251231T000000000Z-33333333";

function seed(mtimes: { gamma: number; trashed: number }): string[] {
  const home = mkdtempSync(join(tmpdir(), "moh-trash-order-"));
  try {
    const cwd = join(home, "cwd");
    mkdirSync(cwd, { recursive: true });
    const dir = join(home, ".moh", "trash", "projects", projectSlug(cwd, home));
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ type: "session_start", schemaVersion: 2, promptVersion: "seed", id: "01M4V7J7QVD9KRMGCBTQH01F8H", prevHash: "" });
    for (const [id, mtime] of [[GAMMA, mtimes.gamma], [TRASHED, mtimes.trashed]] as const) {
      const file = join(dir, `${id}.jsonl`);
      writeFileSync(file, line + "\n");
      utimesSync(file, mtime, mtime);
    }
    return listTrashedSessions(cwd, home).map((t) => t.id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const now = Math.floor(Date.now() / 1000);

test("trash listing is newest mtime first", () => {
  expect(seed({ gamma: now - 10, trashed: now - 20 })).toEqual([GAMMA, TRASHED]);
  expect(seed({ gamma: now - 20, trashed: now - 10 })).toEqual([TRASHED, GAMMA]);
});

test("trash listing breaks an mtime tie by file name descending", () => {
  expect(seed({ gamma: now - 10, trashed: now - 10 })).toEqual([GAMMA, TRASHED]);
});
