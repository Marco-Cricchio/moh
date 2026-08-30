export async function waitForCondition(
  condition: () => boolean,
  describe: () => string,
  { timeoutMs = 2_000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(intervalMs);
  if (!condition()) throw new Error(`Timed out waiting: ${describe()}`);
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

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}
import type { AgentSession, SessionStore } from "@moh/core";

/** Test helper: makeSession returns a result union; tests with an explicit provider always succeed. */
export function unwrap(
  result: { session: AgentSession; store: SessionStore } | { error: { kind: string; message: string } },
): { session: AgentSession; store: SessionStore } {
  if ("error" in result) throw new Error(`assembly failed (${result.error.kind}): ${result.error.message}`);
  return result;
}
