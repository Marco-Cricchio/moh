/**
 * #1622: characterization of `removeTypesafeApiKey` on a malformed
 * `typesafe` section. The function is reached in production only through
 * `migrateTypesafeKey` / `saveTypesafeApiKey`, which return or throw before
 * it on a malformed block, so these assertions pin what it does when called
 * directly. Real temp file, no injected I/O.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTypesafeApiKey } from "../src/typesafe";

function configWith(typesafe: unknown): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "moh-jev-remove-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ provider: "mock", typesafe, theme: "nord" }));
  return { file, dir };
}

const readConfig = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

describe("removeTypesafeApiKey on a malformed typesafe section (#1622)", () => {
  test("an array section is kept as-is: nothing to delete, no throw", () => {
    const { file } = configWith([1, 2]);
    expect(() => removeTypesafeApiKey(file)).not.toThrow();
    expect(readConfig(file)).toEqual({ provider: "mock", typesafe: [1, 2], theme: "nord" });
  });

  test("a null section is replaced by an empty object; the other keys survive", () => {
    const { file } = configWith(null);
    expect(() => removeTypesafeApiKey(file)).not.toThrow();
    expect(readConfig(file)).toEqual({ provider: "mock", typesafe: {}, theme: "nord" });
  });

  test("a string section is kept as-is: nothing to delete, no throw", () => {
    const { file } = configWith("oops");
    expect(() => removeTypesafeApiKey(file)).not.toThrow();
    expect(readConfig(file)).toEqual({ provider: "mock", typesafe: "oops", theme: "nord" });
  });

  test("a numeric section is kept as-is: nothing to delete, no throw", () => {
    const { file } = configWith(42);
    expect(() => removeTypesafeApiKey(file)).not.toThrow();
    expect(readConfig(file)).toEqual({ provider: "mock", typesafe: 42, theme: "nord" });
  });
});
