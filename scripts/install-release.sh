#!/bin/sh
set -eu
# Install a prebuilt release.
version=latest
prefix=${HOME:?}/.local
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || { echo 'Missing --version value' >&2; exit 1; }; version=$2; shift 2 ;;
    --prefix) [ "$#" -ge 2 ] || { echo 'Missing --prefix value' >&2; exit 1; }; prefix=$2; shift 2 ;;
    --help|-h) echo 'Usage: install-release.sh [--version v0.3.0] [--prefix ~/.local]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
case "$(uname -s):$(uname -m)" in
  Darwin:arm64|Darwin:aarch64) target=aarch64-apple-darwin ;;
  Darwin:x86_64) target=x86_64-apple-darwin ;;
  Linux:aarch64|Linux:arm64) target=aarch64-unknown-linux-gnu ;;
  Linux:x86_64|Linux:amd64) target=x86_64-unknown-linux-gnu ;;
  *) echo 'Supported systems: macOS and GNU/Linux on ARM64 or x86-64.' >&2; exit 1 ;;
esac
case "$version" in
  latest) release=https://github.com/molefrog/tgfx/releases/latest/download ;;
  v[0-9]*) release="https://github.com/molefrog/tgfx/releases/download/$version" ;;
  [0-9]*) release="https://github.com/molefrog/tgfx/releases/download/v$version" ;;
  *) echo 'Version must be latest or a release version such as v0.3.0.' >&2; exit 1 ;;
esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
asset="tgfx-$target.tar.gz"
curl --fail --silent --show-error --location "$release/$asset" -o "$work/$asset"
curl --fail --silent --show-error --location "$release/SHA256SUMS" -o "$work/SHA256SUMS"
expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$work/SHA256SUMS")
case "$expected" in ''|*[!a-fA-F0-9]*) echo 'Release checksum is missing or invalid.' >&2; exit 1 ;; esac
[ "${#expected}" -eq 64 ] || { echo 'Release checksum is invalid.' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$work/$asset" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$work/$asset" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || { echo 'Release checksum did not match.' >&2; exit 1; }
tar -xzf "$work/$asset" -C "$work" tgfx
mkdir -p "$prefix/bin"
install -m 755 "$work/tgfx" "$prefix/bin/tgfx"
"$prefix/bin/tgfx" --version
printf 'Installed %s/bin/tgfx\nAdd %s/bin to PATH if needed.\n' "$prefix" "$prefix"
