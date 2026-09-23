/**
 * `/mnt` I/O awareness (#918, ADR-0044).
 *
 * A project root that resolves under `/mnt/` lives on a Windows drive
 * mounted into WSL: every file operation crosses the 9P boundary into the
 * Windows filesystem, and grep/glob over a large tree is dramatically
 * slower there. moh says so instead of hiding it — the TUI keeps a hint in
 * its footer, `moh run` prints one line on stderr — and nothing here can
 * fail a session or block a turn: this is environment information, never an
 * error.
 *
 * Two deliberate narrowings, both decided in #913:
 *
 * - **Any mount under `/mnt/`**, not just `/mnt/c`: `/mnt/d` and friends are
 *   the same 9P story.
 * - **Realpath-anchored, no filesystem sniffing**: the root is resolved the
 *   way the permission spine anchors paths, so a symlink into `/mnt` is
 *   caught and one out of it is not. Sniffing the filesystem type (9p,
 *   DrvFs) is more precise but risks false negatives and buys nothing a
 *   resolved prefix does not already say.
 */
import { realpathSync } from "node:fs";

/** WSL's automount root in its default configuration: `/etc/wsl.conf`
 * `automount.root` is customizable, and a distro that moved it is not
 * detected — #913 fixed the prefix at `/mnt/`, the case that covers every
 * Windows drive a user reaches by default. */
const WINDOWS_MOUNT_ROOT = "/mnt/";

/**
 * Does `root` resolve under a Windows drive mounted into WSL? The realpath
 * resolver is injectable so the anchoring is unit-testable where `/mnt`
 * cannot exist (macOS dev machines, CI runners).
 *
 * The predicate is the resolved prefix, so it also accepts WSL's own
 * internal mounts under `/mnt` (`/mnt/wsl`, `/mnt/wslg`): over-inclusive by
 * a path no project lives at, and the accepted cost of not sniffing the
 * filesystem type.
 */
export function isOnWindowsMount(
  root: string,
  realpath: (path: string) => string = realpathSync,
): boolean {
  let resolved: string;
  try {
    resolved = realpath(root);
  } catch {
    // A root that does not resolve (a path judged before it exists, or a
    // permission error) is taken as given — the same fallback the
    // permission spine's `realpathOf` uses.
    resolved = root;
  }
  return resolved.startsWith(WINDOWS_MOUNT_ROOT);
}
