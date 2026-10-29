# Native TGFX

TGFX 0.3 runs as one Rust executable. FX remains a separate, locally installed
ACP agent. Telegram polling, route queues, recovery, output rendering, MCP
capabilities, external events, and the terminal interface run in the TGFX
process. Credentialed MCP children are launched by its broker.

## Build and install

Install Rust 1.99+ and a C compiler. SQLite and libwebp are built from the locked
crate dependencies; no system SQLite/WebP development package is required.

```sh
cargo build --release --locked
./target/release/tgfx --version
./scripts/install.sh
```

`scripts/install.sh` runs `cargo install --locked --path . --force`. Cargo puts
`tgfx` in `$CARGO_HOME/bin` (normally `~/.cargo/bin`); it does not edit shell
profiles. `cargo install --locked --git https://github.com/molefrog/tgfx.git`
also works after the Rust implementation is merged.

The development helper `bin/tgfx` runs a built release or debug executable. It
honors `CARGO_TARGET_DIR`, including a relative target directory. It does not
build on each launch. Installed binaries do not use this helper.

An authenticated FX installation and a Telegram bot token are runtime
requirements. Run `tgfx doctor` before switching an existing service. FX 0.0.8+
is supported, with FX 0.0.15+ required for steering external events.

## Checks

```sh
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
```

For the full compatibility suite, install Bun 1.4 and the development packages:

```sh
bun install --frozen-lockfile
./scripts/check-rust.sh
```

The full script adds two checks to native tests:

- `scripts/check-rust-parity.ts` copies original test sources into a temporary
  directory and changes their imports to a JSON bridge into the Rust example.
  Expected assertions stay unchanged. It exercises Markdown, ACP projection,
  tool labels, normalization and envelopes, model menus, icons, reply menus,
  session confirmations, and cost reports.
- `tests/rust-e2e.test.ts` runs the built Rust executable against a fake Telegram
  HTTP server and an actual ACP subprocess fixture, with real SQLite files.

Native tests additionally exercise official ACP/MCP transports, Unix broker
revocation, durable history and effects, file boundaries and restrictive
permissions, draft coalescing, cancellation, and terminal rendering.

The `.ts` implementation remains the compatibility reference. Runtime code is
Rust; Bun and Node.js are not deployment dependencies. `package.json` is private
and provides developer shortcuts only, so an npm publish cannot accidentally
ship a launcher without a native binary.

## Source map

| Area | Rust source |
| --- | --- |
| CLI, setup, credentials, settings | `src/main.rs`, `src/secrets.rs`, `src/config.rs` |
| Queues, controls, turn lifecycle | `src/runtime.rs` |
| Journal and observed history | `src/state.rs`, `src/history.rs`, `src/state_schema.sql` |
| ACP sessions and ordered presentation | `src/fx/` |
| Memory snapshots and updates | `src/memory.rs` |
| Telegram transport, normalization, drafts, controls | `src/telegram/` |
| Rich Markdown and static sticker conversion | `src/markdown.rs`, `src/sticker.rs` |
| MCP tools, resource server, capability broker | `src/mcp/` |
| External events and local sockets | `src/events.rs`, `src/event_socket.rs` |
| Safe local media and downloads | `src/files.rs` |
| Terminal interface | `src/tui.rs` |

Frankenstein handles Bot API requests, with raw JSON at update and sticker-set
boundaries for forward compatibility. Comrak parses Markdown. Ratatui and
Crossterm handle the terminal. The official `agent-client-protocol` and `rmcp`
crates implement ACP and MCP. MCP uses `rmcp` 3.8 with both the 2026-07-28
`server/discover` lifecycle used by current FX and legacy initialization. The
complete dependency graph is in `Cargo.lock`.

## Migrating an existing bot

The Rust version retains the existing settings, token lookup, environment
variables, SQLite schemas, route identities, and FX session IDs. It does not
require a new bot or a new workspace. The same configuration and database are
opened in place.

1. Stop the old process and wait for FX/MCP children to exit. Only one process
   can long-poll a given bot.
2. Make a private backup of `TGFX_HOME` (normally `~/.fx/telegram`) while it is
   stopped. Include all journal files, settings, and fallback token files. Keep
   the previous executable or Bun checkout available.
3. Install/build the native executable, run `tgfx doctor` from the same working
   directory, then start it with the existing environment and service user.
4. Verify a DM, a group/topic turn, Stop, format changes during work, and any
   integration that calls `tgfx emit`. Check logs before retiring the old image.

Recovery preserves the original guarantees: queued requests remain eligible;
interrupted agent work is not replayed automatically; pending final deliveries
can be retried without running FX again. Telegram sends can still be duplicated
at a process/network boundary. See [the failure specification](SPEC.md#failure-and-recovery).

To roll back, stop Rust first and start the previous executable with the same
working directory and settings. Keep state written since the switch when it is
readable by the old executable. Restore the stopped backup only when necessary:
restoring an old polling cursor or outbox can repeat deliveries and lose newly
collected history. The schema is intentionally shared so a normal rollback can
use the current journal.

## Containers and separate users

The Dockerfile builds TGFX from locked Rust dependencies and installs FX 0.0.15
in a Debian runtime image. It runs as the non-root `tgfx` user (UID 1000).

```sh
docker build -t tgfx:local .
docker volume create tgfx-home
docker run --rm -it --entrypoint fx \
  -v tgfx-home:/home/tgfx -v "$PWD":/workspace tgfx:local login grok
docker run --rm -it \
  -v tgfx-home:/home/tgfx -v "$PWD":/workspace tgfx:local
```

The workspace must be writable by the container user. The image contains TGFX
and FX; add the project's compilers and external tools to a derived image as
needed. Authentication/setup are manual. Persist the home volume for FX
credentials, Telegram settings, and journal recovery.

The base image runs TGFX and FX as the same user. For separate service/agent
users, keep the existing operator-owned `FX_BINARY` wrapper and policy:

- `TGFX_POLICY_FILE`: read-only access and approvals policy.
- `TGFX_MCP_SOCKET_DIR`: service-owned, agent-traversable broker directory.
- `TGFX_FILES_DIR` plus `TGFX_SHARED_FILES=1`: setgid download directories and
  group-readable files for the agent.
- `TGFX_EVENTS_SOCKET`: socket directory accessible to the trusted emitter and
  service, with the agent excluded.

The broker only accepts a session capability. The agent receives neither the
bot token nor permission to select a route, database, or approval destination.
Filesystem/user permissions enforce the service boundary. These hooks do not
create a sandbox by themselves.

For short MCP startup investigations, set `TGFX_MCP_TRACE_FILE` to a private
service-owned file. It records lifecycle stages and counters, never full RPC
messages, and stops at 1 MiB. Normal operation leaves this disabled.

## Native releases

`.github/workflows/ci.yml` runs native checks and the compatibility suite on
Linux and Apple Silicon macOS, plus a container build/smoke check.

Pushing a `v<version>` tag triggers `.github/workflows/release.yml`. Its version
must match `Cargo.toml`. The workflow tests and builds these archives:

| Archive | Platform |
| --- | --- |
| `tgfx-aarch64-apple-darwin.tar.gz` | Apple Silicon macOS 13+ |
| `tgfx-x86_64-apple-darwin.tar.gz` | Intel macOS 13+ |
| `tgfx-aarch64-unknown-linux-gnu.tar.gz` | ARM64 GNU/Linux, glibc 2.35+ |
| `tgfx-x86_64-unknown-linux-gnu.tar.gz` | x86-64 GNU/Linux, glibc 2.35+ |

Linux artifacts are built on Ubuntu 22.04 for compatibility with Debian 12 and
newer distributions. The release includes `SHA256SUMS`, README, and license.
GitHub runner labels follow the [hosted runner documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job).
Release automation is configured here; creating this checkout does not publish
a release or a tag.

After a release is published:

```sh
./scripts/install-release.sh --version v0.3.0
# Or select the latest release and a custom install prefix:
./scripts/install-release.sh --prefix "$HOME/.local"
```

The installer checks the archive's SHA-256 before extracting the executable and
installs without elevated privileges. Add the prefix's `bin` directory to PATH.
The macOS archives are not notarized by this workflow; local source/Cargo
installation remains available.
