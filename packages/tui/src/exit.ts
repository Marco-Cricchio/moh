/** Exit-path work registry (#341).
 *
 * The TUI's exit is deliberate (double ctrl+c), but the process can outlive
 * the unmounted tree by seconds: Bun's HTTP client keeps provider keep-alive
 * sockets open, and the unmount cleanup fires `session.dispose()` without
 * awaiting it. The CLI therefore needs to (a) see the pending cleanup work
 * and (b) bound it — after a budget it exits explicitly instead of letting
 * lingering event-loop handles decide when the shell prompt comes back.
 *
 * This module is that seam: components register in-flight cleanup promises
 * with `trackExitWork`, and the entry point settles them through
 * `finishExit`, which always terminates the process. */

const pending = new Set<Promise<unknown>>();

/** Registers in-flight exit-path cleanup (e.g. session dispose) so the
 * entry point can await it before terminating. Safe on settled promises. */
export function trackExitWork(work: Promise<unknown>): void {
  const clear = () => pending.delete(work);
  pending.add(work);
  work.then(clear, clear);
}

/** Waits up to `timeoutMs` for all tracked exit work to settle. Returns
 * whether everything settled within the budget. Never rejects. */
export async function awaitExitWork(timeoutMs: number): Promise<boolean> {
  const timer = new Promise<false>((resolve) => {
    setTimeout(() => resolve(false), timeoutMs).unref?.();
  });
  const all = Promise.allSettled([...pending]).then(() => true as const);
  return Promise.race([all, timer]);
}

/** Bounded exit for the interactive path: gives tracked cleanup work up to
 * `timeoutMs` to settle, then terminates the process regardless — lingering
 * event-loop handles (Bun HTTP keep-alive sockets, background fetches) must
 * not turn a deliberate exit into a multi-second shutdown tail (#341). */
export async function finishExit(timeoutMs: number, code = 0): Promise<never> {
  await awaitExitWork(timeoutMs);
  process.exit(code);
}
