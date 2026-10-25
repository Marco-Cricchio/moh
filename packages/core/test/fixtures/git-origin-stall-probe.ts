/**
 * #1679 probe: run by `git-origin-timeout.test.ts` in a child `bun` whose
 * PATH starts with a fake `git` that never answers (changing
 * `process.env.PATH` in-process does not change where Bun finds git).
 * Prints one JSON object: each origin probe's result and how long it took.
 */
import { originUrl, originUrlSync } from "../../src/git";

const timed = <T>(f: () => T) => {
  const start = performance.now();
  const value = f();
  return { value, ms: performance.now() - start };
};

const sync = timed(() => originUrlSync(process.cwd(), "ignore", 300));
const asyncStart = performance.now();
const asyncValue = await originUrl(process.cwd(), 300);
console.log(JSON.stringify({ sync, async: { value: asyncValue, ms: performance.now() - asyncStart } }));
