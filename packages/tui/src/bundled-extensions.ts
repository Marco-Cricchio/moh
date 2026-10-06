/**
 * The first-party bundled extensions moh ships (#826).
 *
 * Why it exists: `@moh/core` hosts bundled extensions generically
 * (`bundledExtensions` on `sessionFromConfig`) but must not import any of
 * them — the vendor package is a *client* dependency, not the core's. This
 * is the single list both in-process clients mount (the TUI's factory and
 * the CLI's headless commands), so no assembly call site can drift and
 * there is one place to add the next bundled extension.
 *
 * It lives in the TUI because that is the lower of the two packages (the
 * CLI already depends on the TUI; the reverse edge would be a cycle) and
 * the CLI imports this module by path.
 *
 * A library user embedding `@moh/core` gets none of this: their assembly
 * hosts no bundled extension unless they mount one of their own, which is
 * the boundary #826 asked for.
 */
import { readFileSync } from "node:fs";
import { jevBundledSource } from "@moh/jev-guard";
import { teamBundledSource } from "@moh/team";
import { defaultCredentialStore, userConfigFile, type MountedBundledExtension } from "@moh/core";

/** Every first-party bundled extension, in registration order (hook
 * precedence is registration order, so this list is a contract).
 *
 * #826 residue removal: **here** is where activation is decided, because the
 * client owns the config surface of the code it ships. The core receives the
 * answer as a boolean and never runs an extension's predicate over the
 * user's config file. `home` is the resolved user home; a missing or
 * malformed config reads as "inactive" — a broken optional block must never
 * fail an assembly. */
export function bundledExtensionSources(home?: string): readonly MountedBundledExtension[] {
  const file = userConfigFile(home);
  const read = (f: string): string => readFileSync(f, "utf8");
  // #1162: the same credential store the assembly will host. The one-time
  // legacy-key migration (config plaintext -> store) runs here, before the
  // activation answer, so a pre-#1162 config converges without user action
  // and "active" keeps meaning what it always meant.
  const store = defaultCredentialStore(home ?? process.env.HOME ?? ".");
  jevBundledSource.migrate?.(store, file);
  let active = false;
  try {
    active = jevBundledSource.evaluateActive?.(read, file, store) ?? false;
  } catch {
    // A malformed `typesafe` block is the user's to fix (`moh jev status`
    // reports it loudly); at assembly time it means "not active" — a broken
    // optional block must never fail a session.
    active = false;
  }
  // ADR-0074: the team extension ships out of the box with the binary —
  // always active; the enable consent (which names the envelope) is the
  // switch, not a config block.
  return [
    { source: jevBundledSource, active },
    { source: teamBundledSource, active: true },
  ];
}
