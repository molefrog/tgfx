#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
cargo build --locked --bin tgfx --example conformance
if command -v bun >/dev/null; then
  bun scripts/check-rust-parity.ts
  bun test tests/rust-e2e.test.ts
fi
