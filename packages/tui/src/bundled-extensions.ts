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
import { jevBundledSource } from "@moh/jev-guard";
import type { BundledExtensionSource } from "@moh/core";

/** Every first-party bundled extension, in registration order (hook
 * precedence is registration order, so this list is a contract). */
export const BUNDLED_EXTENSION_SOURCES: readonly BundledExtensionSource[] = [jevBundledSource];
