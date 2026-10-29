#!/bin/sh
set -eu
# Build directly from the checked-out source, including local changes.
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
command -v cargo >/dev/null || { echo 'Install Rust from https://rustup.rs, then rerun this script.' >&2; exit 1; }
cargo install --locked --path . --force
