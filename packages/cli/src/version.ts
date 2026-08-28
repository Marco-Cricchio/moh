/**
 * Version reported by `moh --version`.
 *
 * Compiled binaries are stamped by `scripts/build.ts` via
 * `--define __MOH_BUILD_VERSION__` (git tag, falling back to the package
 * version). In dev runs (`bun packages/cli/src/cli.ts`) no define is present,
 * so we fall back to `MOH_VERSION` from @moh/core.
 */
declare const __MOH_BUILD_VERSION__: string | undefined;

import { MOH_VERSION } from "@moh/core";

export const CLI_VERSION: string =
  typeof __MOH_BUILD_VERSION__ !== "undefined" ? __MOH_BUILD_VERSION__ : MOH_VERSION;
