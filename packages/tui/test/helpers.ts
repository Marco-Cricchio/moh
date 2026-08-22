/** ANSI escape stripper for frame assertions. */
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
