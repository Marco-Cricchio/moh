#!/bin/sh
# moh install script — curl -fsSL https://raw.githubusercontent.com/Marco-Cricchio/moh/develop/scripts/install.sh | sh
#
# Spec: docs/spec/cli-binary-distribution.md · ADR-0013 · Issue #269.
#
# Downloads the platform binary from the latest GitHub Release, verifies its
# sha256 against checksums.txt, and installs it (upgrading in place) to
# ~/.local/bin by default. Override with MOH_INSTALL_DIR.
#
# Environment overrides (mainly for tests):
#   MOH_DOWNLOAD_BASE  base URL for release assets
#                     (default: https://github.com/Marco-Cricchio/moh/releases/latest/download)
#   MOH_INSTALL_DIR   installation directory (default: ~/.local/bin)
set -eu

REPO_DOWNLOAD_BASE="${MOH_DOWNLOAD_BASE:-https://github.com/Marco-Cricchio/moh/releases/latest/download}"
INSTALL_DIR="${MOH_INSTALL_DIR:-$HOME/.local/bin}"

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
  *) err "unsupported platform: $os $arch. Supported: macOS arm64/x64, Linux x64." ;;
esac

echo "→ detected platform: $platform"

# --- prerequisites ----------------------------------------------------------

for cmd in curl uname mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || err "required command not found: $cmd"
done

if command -v sha256sum >/dev/null 2>&1; then
  sha_cmd="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  sha_cmd="shasum -a 256"
else
  err "neither sha256sum nor shasum is available; cannot verify checksums."
fi

# --- download + verify ------------------------------------------------------

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

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

# --- install (atomic-ish: write next to the target, then rename) -----------

chmod +x "$tmpdir/$asset"
mkdir -p "$INSTALL_DIR"
dest="$INSTALL_DIR/moh"
if [ -e "$dest" ] && [ ! -w "$dest" ]; then
  err "$dest exists but is not writable; cannot upgrade in place."
fi
mv "$tmpdir/$asset" "$dest"
echo "✓ installed moh → $dest"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "⚠ $INSTALL_DIR is not on your PATH. Add it with:"
    echo "    echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile && source ~/.profile"
    ;;
esac

"$dest" --version
