import { afterAll, beforeAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { teamManifestAuthority } from "@moh/team";

/**
 * Pre-grants the team extension's enable consent (ADR-0074) in a test
 * home: tests that exercise an unrelated consent flow must not see the
 * team question riding their modal queue. Same store the core maintains.
 */
export function grantTeamExtension(home: string): void {
  const mohHome = join(home, ".moh");
  mkdirSync(mohHome, { recursive: true });
  const authority = teamManifestAuthority();
  const file = join(mohHome, "extensions.json");
  const store = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : { consents: {}, dependencies: {}, manifests: {} };
  store.consents["memory:team"] = true;
  store.manifests[authority.path] = { hash: authority.hash, capabilities: [...authority.capabilities] };
  writeFileSync(file, JSON.stringify(store));
}

/**
 * #1504: pins the 0600-file credential store for the calling file and
 * restores `MOH_SECRET_STORE` after it. On darwin the default store is the
 * login keychain: every App mount would read it through a synchronous
 * `security` spawn (the bundled-extension activation check), which stalls
 * frame waits and writes into the developer's keychain. Call at module top
 * level, once per file.
 */
export function useFileCredentialStore(): void {
  const original = process.env.MOH_SECRET_STORE;
  beforeAll(() => {
    process.env.MOH_SECRET_STORE = "file";
  });
  afterAll(() => {
    if (original === undefined) delete process.env.MOH_SECRET_STORE;
    else process.env.MOH_SECRET_STORE = original;
  });
}

/**
 * #1504: an empty project directory. A test that mounts App on
 * `process.cwd()` reads the checkout's own (gitignored) `moh.json`, so a
 * developer's local settings — a provider, `browser.enabled` — leak into
 * the frame.
 */
export const tempProjectDir = (prefix = "moh-test-cwd-"): string => mkdtempSync(join(tmpdir(), prefix));

export async function waitForCondition(

  condition: () => boolean,
  describe: () => string,
  { timeoutMs = 2_000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(intervalMs);
  if (!condition()) throw new Error(`Timed out waiting: ${describe()}`);
}

export async function actUntilFrame(
  action: () => void,
  frame: () => string,
  expected: string,
  options: { timeoutMs?: number; intervalMs?: number; absent?: boolean } = {},
): Promise<void> {
  const { timeoutMs = 2_000, intervalMs = 10, absent = false } = options;
  const matches = () => frame().includes(expected) !== absent;
  const deadline = Date.now() + timeoutMs;
  while (!matches() && Date.now() < deadline) {
    action();
    await Bun.sleep(intervalMs);
  }
  await waitForFrame(frame, expected, { timeoutMs: 0, intervalMs, absent });
}

export async function waitForFrame(
  frame: () => string,
  expected: string,
  { timeoutMs = 2_000, intervalMs = 10, absent = false }: { timeoutMs?: number; intervalMs?: number; absent?: boolean } = {},
): Promise<void> {
  await waitForCondition(
    () => frame().includes(expected) !== absent,
    () => `for frame ${absent ? "without" : "containing"} ${JSON.stringify(expected)}. Last frame:\n${frame()}`,
    { timeoutMs, intervalMs },
  );
  return;
}

/**
 * The empty composer's placeholder copy is the sentinel every surface test
 * probes for "the chat input is mounted" (`Chat.tsx` owns the real string,
 * `COMPOSER_HINT`; `compact-toasts.test.tsx` asserts the copy verbatim).
 * Keeping the two substrings here means a copy change is one edit, not 50.
 * The composer shows the compact form instead when the long hint would not
 * fit its column (`cols < COMPOSER_HINT_MIN_COLS`, and the compact width
 * class) — those tests say `COMPOSER_COMPACT`.
 */
export const COMPOSER_READY = "for everything you need";
export const COMPOSER_COMPACT = "type…";

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

/**
 * Ink's `useInput` re-subscribes its handler in a `useEffect`, so for a
 * moment after a surface paints, a key still reaches the previous surface's
 * handler (#1466). React's scheduler flushes passive effects on the
 * `setImmediate` queue, which already holds that flush once a frame is
 * observed: two turns of it leave the new handler attached.
 */
export const effectsFlushed = (): Promise<void> =>
  new Promise<void>((r) => setImmediate(() => setImmediate(r)));

/** The minimal surface of an `ink-testing-library` render the waits read. */
type Rendered = { lastFrame: () => string | undefined; stdin: { write: (data: string) => void } };

/**
 * Waits for `condition` within a deadline, then for passive effects, so the
 * next key reaches the surface the condition describes. A step that never
 * happens fails as `stuck at step "<step>"` with the last frame, instead of a
 * fixed sleep letting a later assertion read a stale frame (#1473). The
 * default deadline stays under bun's 5 s test timeout, so a stuck step is
 * reported by name rather than as a bare timeout.
 */
export async function waitStep(
  view: Pick<Rendered, "lastFrame">,
  condition: () => boolean,
  step: string,
  { timeoutMs = 3_000 }: { timeoutMs?: number } = {},
): Promise<void> {
  try {
    await waitForCondition(condition, () => `for ${step}. Last frame:\n${stripAnsi(view.lastFrame() ?? "")}`, { timeoutMs });
  } catch (e) {
    throw new Error(`stuck at step "${step}": ${e instanceof Error ? e.message : String(e)}`);
  }
  await effectsFlushed();
}

/** `waitStep` on the stripped frame containing (or, with `absent`, losing) `expected`. */
export function waitText(
  view: Pick<Rendered, "lastFrame">,
  expected: string,
  step: string,
  { absent = false, timeoutMs }: { absent?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  return waitStep(
    view,
    () => stripAnsi(view.lastFrame() ?? "").includes(expected) !== absent,
    `${step} (frame ${absent ? "without" : "containing"} ${JSON.stringify(expected)})`,
    timeoutMs === undefined ? {} : { timeoutMs },
  );
}

/**
 * Writes a key and waits for the commit that carries it, then for passive
 * effects — for keys whose effect leaves no text to wait on (a focus move
 * under the tests' colorless output). `ink-testing-library` renders in debug
 * mode, where Ink writes a frame on every commit even when its text is
 * unchanged, and the key's state update lands in the first commit after the
 * write: a new entry in `frames` is that commit (#1473). React's `act()` does
 * not cover Ink's renderer, and one fixed-turn flush is not always enough.
 */
export async function pressCommitted(view: Rendered & { frames: readonly string[] }, key: string, step: string): Promise<void> {
  const before = view.frames.length;
  view.stdin.write(key);
  await waitStep(view, () => view.frames.length > before, `${step} (a commit after the key)`);
}

/**
 * Writes a key inside React's `act()`. Ink renders on a LegacyRoot, so the
 * key's render is synchronous inside the write and its passive effects land
 * in `act`'s queue, which runs them before this resolves. Use it where the
 * NEXT key reads state an effect republishes — e.g. the composer's
 * `canClear` handle (#1009), re-published in a `useEffect` after every
 * render: a ctrl+c written before that effect ran saw an empty draft and
 * armed the exit instead of clearing (3/6 under CPU load; 0/6 with this).
 */
export function pressSettled(view: Pick<Rendered, "stdin">, key: string): Promise<void> {
  return inAct(() => view.stdin.write(key));
}

/**
 * Unmounts inside React's `act()` and then lets the scheduler drain, so no
 * work from this tree is still flushing when the next test mounts (#1495:
 * `Should not already be working.` from react-reconciler inside a later
 * `render()`). Idempotent: Ink ignores a second unmount.
 */
export async function unmountSettled(view: { unmount: () => void }): Promise<void> {
  await inAct(() => view.unmount());
  await effectsFlushed();
}

async function inAct(work: () => void): Promise<void> {
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => { work(); });
  } finally {
    if (previous === undefined) delete env.IS_REACT_ACT_ENVIRONMENT;
    else env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

/**
 * Sends one prompt through the chat composer (#1471): type only once the
 * composer has mounted, press Enter only once the prompt has echoed. The
 * composer mounts after the App's first async render, which can take well
 * over 100 ms on a busy machine.
 */
export async function sendPrompt(view: Rendered, text: string): Promise<void> {
  const frame = () => stripAnsi(view.lastFrame() ?? "");
  await waitStep(view, () => frame().includes(COMPOSER_READY), "the composer mounted");
  view.stdin.write(text);
  // The composer wraps a long prompt: its first word is enough to see the echo.
  const head = text.split(" ")[0]!;
  await waitStep(view, () => frame().includes(head) && !frame().includes(COMPOSER_READY), "the prompt echoed in the composer");
  view.stdin.write("\r");
}
import type { AgentSession, SessionStore } from "@moh/core";

/** Test helper: makeSession returns a result union; tests with an explicit provider always succeed. */
export function unwrap(
  result: { session: AgentSession; store: SessionStore } | { error: { kind: string; message: string } },
): { session: AgentSession; store: SessionStore } {
  if ("error" in result) throw new Error(`assembly failed (${result.error.kind}): ${result.error.message}`);
  return result;
}
