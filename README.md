# 𝒕𝒈(𝒇x)

Run a local [𝒇x](https://github.com/vercel-labs/fx) agent through one Telegram
bot. `tgfx` lazily starts `fx acp` in the current folder, sends allowed Telegram
messages into a route-specific 𝒇x session, streams rich drafts in private chats,
and delivers a permanent rich response when the turn finishes.

𝒇x remains the agent. `tgfx` owns only Telegram transport, scoped Telegram MCP
actions, rendering, approvals, and the small recovery journal needed between
processes.

## Run from source

Requirements: macOS or Linux, [Bun](https://bun.sh), an authenticated `fx 0.0.6`
or newer, and a Telegram bot token from BotFather.

```bash
bun install
bun link

cd /path/to/your/project
tgfx
```

The first run validates the token, then either shows a scannable QR code and
private Telegram deep link for one-tap owner pairing or accepts one numeric
user/chat ID for an advanced setup. It verifies the approvals chat by sending a
setup message and writes non-secret settings to `.tgfx/config.json`. Allow more people later
with `tgfx allow`. The token goes to the operating-system credential store under
the bot's numeric ID. `TELEGRAM_BOT_TOKEN` may be used instead and is never
saved by `tgfx`.

One process owns one bot and one current folder. A machine-wide lock prevents the
same bot from polling in two workspaces at once. Messages outside the required
numeric allowlist are discarded without retaining their content.

## Commands

```text
tgfx                           run fx in this folder (sets up on first run)
tgfx access                    who can talk to fx, who approves, saved sessions
tgfx allow <id…>               add users or chats to the allowlist
tgfx deny <id…>                remove them
tgfx approvals <chat>[/topic]  route approval cards to a chat
tgfx auth [--remove]           add, rotate, or remove the bot token
tgfx doctor                    deep diagnostics: token, chats, rights, fx
```

`tgfx allow` infers users from positive IDs and chats from negative ones
(`--chat` overrides). Configuration edits are saved immediately and apply the
next time `tgfx` starts. Run flags: `--model <id>`, `--yolo`,
`--no-streaming`, `--no-collapse-tools`; global: `--json`, `--no-color`,
`--debug`.

FX starts in its automatic-review permission mode. `tgfx --yolo` disables FX's
permission checks for that process. It does not bypass tgfx's separate approval
cards for destructive Telegram administration.

Group administration needs no tgfx-side configuration: for an allowlisted group
the admin tools are exactly the bot's live Telegram admin rights. Promote the
bot in Telegram to enable them, demote it to revoke; destructive actions still
require a one-tap approval card in the approvals chat. `tgfx doctor` reports
the bot's current rights in every allowlisted group.

Telegram exposes `/compact`, `/model`, and `/cost`. `/compact` compacts the active 𝒇x
conversation and shows a purpose-built progress state. `/model` reads the live
model catalog from the route's FX session and switches that session through a
provider-first, paginated button picker. Provider and model buttons use the
public `tgfx icons` custom emoji pack by default and retry as
plain buttons when Telegram does not permit the bot to use custom emoji. Set
`modelPicker.customIcons` to `false` to disable the pack lookup and custom icons.
`/cost` renders FX's local usage and
spend for the last 24 hours, 7 days, or 30 days as a rich report with period
buttons. Other ACP-advertised commands are not projected into Telegram yet.

Private chats stream complete Rich Message snapshots through Telegram's draft
API. Each draft enables Telegram's Stop button, which cancels the matching active
𝒇x turn. Groups and `--no-streaming` receive one final message. `--no-collapse-tools`
shows full details for completed tools; otherwise each consecutive tool group is
compact. The current trailing tool group shows the thinking emoji and `Working…`;
earlier groups use their final activity labels. The current group stays collapsed
by default; set `renderer.expandStreamingTools` to `true` in `.tgfx/config.json`
to open it temporarily while it streams. Pending tools and private thought events stay hidden and do not trigger
draft requests. Visible frames stream optimistically, then adapt to Telegram's
per-chat limits and any `retry_after` response.

For `/compact`, streaming mode shows a draft-only Thinking block followed by
`✓ Conversation compacted`. Without streaming, tgfx sends one regular progress
message and edits it to that completed state.

The local `.tgfx/state.sqlite` file is an operational journal, not a chat archive:
accepted inbound and final-delivery bodies are scrubbed after success, drafts are
not stored, raw ACP transcripts are off, and opaque references prevent the model
from choosing raw Telegram IDs or Bot API file URLs.

For development and tests, `TGFX_INTERNAL_TELEGRAM_API_ROOT` points every
Telegram call (the poller and the MCP subprocess alike) at a local Bot API
simulator; `tests/fixtures/fake-telegram.ts` ships one that speaks the real
HTTP protocol, injects updates, and records outgoing calls.

Read the full [specification](./doc/SPEC.md). Local whiteboards and experiments
are intentionally excluded from the repository.
