#!/bin/sh
# moh install script — curl -fsSL https://raw.githubusercontent.com/Marco-Cricchio/moh/develop/scripts/install.sh | sh
#
# Spec: docs/spec/cli-binary-distribution.md · ADR-0013 · Issue #269.
#
# Downloads the platform binary from the latest GitHub Release, verifies its
# sha256 against checksums.txt, smoke-tests it before touching anything, and
# installs it atomically (upgrading in place) to ~/.local/bin by default.
# Override with MOH_INSTALL_DIR.
#
# Environment overrides (mainly for tests):
#   MOH_DOWNLOAD_BASE      base URL for release assets
#                          (default: https://github.com/Marco-Cricchio/moh/releases/latest/download)
#   MOH_INSTALL_DIR        installation directory (default: ~/.local/bin)
#   MOH_PROC_VERSION_FILE  file read for the WSL fallback (default: /proc/version)
set -eu

REPO_DOWNLOAD_BASE="${MOH_DOWNLOAD_BASE:-https://github.com/Marco-Cricchio/moh/releases/latest/download}"
INSTALL_DIR="${MOH_INSTALL_DIR:-$HOME/.local/bin}"
PROC_VERSION_FILE="${MOH_PROC_VERSION_FILE:-/proc/version}"

err() {
  echo "moh install: $1" >&2
  exit 1
}

# --- platform detection (mirrors scripts/build.ts TARGETS) -----------------

os="$(uname -s)"
arch="$(uname -m)"
case "$os:$arch" in
  Darwin:arm64) platform="darwin-arm64" ;;
  Darwin:x86_64) platform="darwin-x64" ;;
  Linux:x86_64) platform="linux-x64" ;;
  Linux:aarch64|Linux:arm64) platform="linux-arm64" ;;
  *) err "unsupported platform: $os $arch. Supported: macOS arm64/x64, Linux x64/arm64." ;;
esac

echo "→ detected platform: $platform"

# --- prerequisites ----------------------------------------------------------

for cmd in curl uname mktemp grep; do
  command -v "$cmd" >/dev/null 2>&1 || err "required command not found: $cmd"
done

if command -v sha256sum >/dev/null 2>&1; then
  sha_cmd="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  sha_cmd="shasum -a 256"
else
  err "neither sha256sum nor shasum is available; cannot verify checksums."
fi

# --- environment advisories (#917) — informational, never blocking ----------

# WSL: env first, with the /proc/version "microsoft" fallback for the shells
# that do not export WSL_DISTRO_NAME/WSL_INTEROP. Same message as the TUI's
# /mnt footer hint (#913), different surface.
in_wsl=0
if [ -n "${WSL_DISTRO_NAME:-}" ] || [ -n "${WSL_INTEROP:-}" ]; then
  in_wsl=1
elif [ -r "$PROC_VERSION_FILE" ] && grep -qi microsoft "$PROC_VERSION_FILE"; then
  in_wsl=1
fi
if [ "$in_wsl" = "1" ]; then
  echo "ℹ running inside WSL: this Linux binary is the supported install — moh ships no native Windows build."
  echo "ℹ keep your projects in the Linux filesystem (e.g. ~/projects): /mnt/c works, but is dramatically slower."
fi

# Root: warn always, ask when a human is actually reachable, never refuse on
# the user's behalf. The prompt reads /dev/tty, never stdin — under
# `curl … | sh` stdin *is* the script.
#
# `[ -r /dev/tty ]` alone proves nothing: access(2) reports the device node's
# permissions, so it is "readable" even for a process with no controlling
# terminal (CI, `setsid`). Writing the prompt is what actually opens it — if
# that fails there is no one to ask, and the no-TTY path proceeds.
if [ "$(id -u 2>/dev/null || echo '')" = "0" ]; then
  echo "⚠ moh install: running as root." >&2
  echo "  This installs a binary downloaded from the network into root's home" >&2
  echo "  and puts it on root's PATH. A non-privileged user is recommended." >&2
  if [ -r /dev/tty ] && [ -w /dev/tty ] && printf 'Continue as root? [y/N] ' > /dev/tty 2>/dev/null; then
    # A reachable terminal: silence or EOF is a no, only y/yes continues.
    answer=""
    read -r answer < /dev/tty 2>/dev/null || answer=""
    case "$answer" in
      y|Y|yes|YES|Yes) echo "  continuing as root — your call." >&2 ;;
      *) err "aborted: you declined to install as root." ;;
    esac
  else
    echo "  no TTY to ask on — continuing with the warning above (the risk is" >&2
    echo "  yours to take; MOH_INSTALL_DIR can point at a user-owned directory)." >&2
  fi
fi

# --- download + verify ------------------------------------------------------

tmpdir="$(mktemp -d)"
staged=""
cleanup() {
  if [ -n "$staged" ]; then rm -f "$staged"; fi
  rm -rf "$tmpdir"
  return 0
}
trap cleanup EXIT

asset="moh-$platform"
echo "→ downloading $asset from the latest release"
curl -fsSL "$REPO_DOWNLOAD_BASE/$asset" -o "$tmpdir/$asset" \
  || err "download failed. No release asset for $platform? Try: $REPO_DOWNLOAD_BASE/$asset"

echo "→ downloading checksums.txt"
curl -fsSL "$REPO_DOWNLOAD_BASE/checksums.txt" -o "$tmpdir/checksums.txt" \
  || err "failed to download checksums.txt"

expected="$(grep " $asset\$" "$tmpdir/checksums.txt" | awk '{print $1}')"
[ -n "$expected" ] || err "no checksum found for $asset in checksums.txt."

actual="$($sha_cmd "$tmpdir/$asset" | awk '{print $1}')"
if [ "$expected" != "$actual" ]; then
  err "checksum mismatch for $asset!
  expected $expected
  actual   $actual
The download may be corrupted or tampered with — aborting."
fi
echo "✓ checksum verified"

# --- smoke test, before anything is replaced --------------------------------

chmod +x "$tmpdir/$asset"
smoke=""
smoke_status=0
smoke="$("$tmpdir/$asset" --version 2>&1)" || smoke_status=$?
if [ "$smoke_status" -ne 0 ]; then
  err "$asset cannot run on this system (exit $smoke_status):
  $smoke
  This usually means a libc mismatch: a musl-based distribution (Alpine,
  including Alpine WSL) cannot run a glibc binary, and moh ships no musl
  build yet. Nothing was installed — your existing moh is untouched."
fi
if [ -z "$smoke" ]; then
  err "$asset ran but printed nothing for --version; refusing to install it.
  Nothing was installed — your existing moh is untouched."
fi

# --- install (atomic: stage inside INSTALL_DIR, then rename within it) ------

mkdir -p "$INSTALL_DIR"
dest="$INSTALL_DIR/moh"
if [ -e "$dest" ] && [ ! -w "$dest" ]; then
  err "$dest exists but is not writable; cannot upgrade in place."
fi
# Staging inside INSTALL_DIR keeps the final rename on one filesystem, so a
# reader never sees a half-written moh (a /tmp on another filesystem could
# not offer that guarantee).
staged="$INSTALL_DIR/.moh.tmp.$$"
mv "$tmpdir/$asset" "$staged" || err "failed to stage the binary in $INSTALL_DIR."
mv "$staged" "$dest" || err "failed to install $dest."
staged=""
echo "✓ installed moh → $dest"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    # Name the file the user's shell actually reads: ~/.profile only applies
    # to login shells, so bash/zsh users get their rc file. `.` is the POSIX
    # spelling of `source`, so the hint works in any shell.
    case "${SHELL:-}" in
      */bash) rc_file="~/.bashrc" ;;
      */zsh) rc_file="~/.zshrc" ;;
      *) rc_file="~/.profile" ;;
    esac
    echo "⚠ $INSTALL_DIR is not on your PATH. Add it with:"
    echo "    echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> $rc_file && . $rc_file"
    ;;
esac

"$dest" --version
