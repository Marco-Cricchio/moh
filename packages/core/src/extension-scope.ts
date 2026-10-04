import { AsyncLocalStorage } from "node:async_hooks";

/**
 * ADR-0053 absolute prohibitions — the dispatch-scope marker.
 *
 * Every extension hook invocation runs inside `runInExtensionScope`, so the
 * core's privileged operations can recognize "this call originates from
 * extension code" and refuse it with a typed error instead of trusting
 * module separation alone. The five prohibitions enforced this way (never
 * by configuration — no consent can authorize them):
 *
 * - grant or alter permissions or capabilities
 * - read or write `extensions.json` or consent files
 * - disable another extension
 * - bypass another extension's veto
 * - mask or alter log events
 */

/** A loud refusal of an extension spawn — the child is not created
 * (ADR-0053/#998). Lives in the leaf scope module: the extension runtime
 * imports it, and a value import from `subagents.ts` would close an
 * initialization cycle (subagents → session → extensions → subagents). */
export class ExtensionSpawnRefusedError extends Error {
  readonly reason: "spawn_cap" | "spawn_refused" | "spawn_unavailable" | "no_grandchildren";
  constructor(reason: ExtensionSpawnRefusedError["reason"], message: string) {
    super(message);
    this.name = "ExtensionSpawnRefusedError";
    this.reason = reason;
  }
}

/** Typed refusal for an attempted absolute prohibition (ADR-0053). */
export class ExtensionProhibitionError extends Error {
  /** Which prohibition was attempted (stable machine name). */
  readonly prohibition: string;
  /** The extension whose dispatch attempted it, when known. */
  readonly extension: string | null;

  constructor(prohibition: string, message: string, extension: string | null) {
    super(message);
    this.name = "ExtensionProhibitionError";
    this.prohibition = prohibition;
    this.extension = extension;
  }
}

const scope = new AsyncLocalStorage<{ extension: string }>();

/** Runs `fn` marked as extension code. Core code never enters this scope. */
export function runInExtensionScope<T>(extension: string, fn: () => T): T {
  return scope.run({ extension }, fn);
}

/** The extension whose dispatch is running, when the caller is extension code. */
export function currentExtensionScope(): string | null {
  return scope.getStore()?.extension ?? null;
}

/**
 * The one guard the privileged core seams call before doing their work:
 * entered from extension code, it throws the typed refusal and the
 * operation never happens. Core code (outside any extension dispatch)
 * passes untouched.
 */
export function assertNoExtensionScope(prohibition: string, action: string): void {
  const extension = currentExtensionScope();
  if (extension === null) return;
  throw new ExtensionProhibitionError(
    prohibition,
    `prohibition "${prohibition}": extension "${extension}" attempted to ${action}`,
    extension,
  );
}
