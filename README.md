# 𝒕𝒈(𝒇x)

Chat with a Vercel [𝒇x](https://github.com/vercel-labs/fx) coding agent from
Telegram. Works with your locally installed 𝒇x and supports as many of the latest Telegram features as possible.

## Features

<img src="assets/tgfx-primary.webp" alt="tgfx in Telegram: rich replies, a model picker, stickers, and a transcribed voice message" width="240" align="right">

Most Telegram adapters for popular harnesses only scratch the surface of what Telegram can do.
Not 𝒕𝒈(𝒇x): the aim is chatting with your agent from Telegram the way you would from its TUI.

- [x] Rich replies: markdown, tables, code blocks, spoilers, TeX math
- [x] Live streaming while the agent works, renders tool calls nicely
- [x] Four reply styles (`/format`), from a quiet final answer to a live draft with tool activity
- [x] Can work in DMs and groups
- [x] Can send stickers and react to messages
- [x] Interactive model picker (`/model`)
- [x] Conversation compaction (`/compact`) and fresh starts (`/clear`), with inline confirmation buttons
- [x] Cost reports (`/cost`)
- [x] Approval cards for destructive actions
- [x] Bots can be group admins: pin messages, moderate, and more
- [x] Custom emoji icons for tool calls and popular MCPs ([see below](#custom-icons))
- [x] The agent can see and send files, images, location pins, polls, **voice messages** and even **video messages**
- [ ] `soon` Talking to [other bots](https://telegram.org/blog/ai-bot-revolution-11-new-features#bot-to-bot-communication)

## Install

TGFX is a native Rust executable for macOS and Linux. It needs an authenticated
[𝒇x](https://fx.sh) installation and a bot token from
[@BotFather](https://t.me/BotFather). FX 0.0.8+ is supported; use 0.0.15+ for
external-event steering.

Build and install this checkout with [Rust 1.99+](https://rustup.rs) and a C compiler:

```sh
./scripts/install.sh
```

Or use Cargo directly:

```sh
cargo install --locked --path . --force
```

Then sign in to FX and run TGFX in the folder where the agent should work:

```sh
fx login grok  # or fx login / fx login codex
cd /path/to/project
tgfx
```

The first run privately prompts for the bot token and pairs your Telegram
account. `TELEGRAM_BOT_TOKEN` overrides a saved token without saving the
environment token. Bun and Node.js are not needed to run the bot.

Versioned releases provide native archives and checksums for Apple Silicon and
Intel Macs, and ARM64/x86-64 Linux. After a Rust release is published, install
one with:

```sh
./scripts/install-release.sh --version v0.3.0
```

## How it works

That's it. `tgfx` starts an `fx acp` process in that folder, with your current
𝒇x provider and model, and bridges it to your Telegram bot. Pass `--yolo` to
skip 𝒇x's permission checks.

On the first run it asks for your bot token and pairs you as the owner: scan a
QR code or tap a link. To change or remove the token later, run `tgfx auth`.
Everything tgfx remembers about a folder lives under `~/.fx/telegram/`; nothing
is written into the project.

## Persistent memory

Keep shared facts, decisions, and conventions in `MEMORY.md` in the directory
where TGFX runs. No extra server or memory tools are required; the agent can
maintain the file using its normal file tools.

TGFX checks it before each new turn, independently for every chat/topic and
background session:

- First use sends the whole file in `<memory source="MEMORY.md">`.
- New top-level sections send only those sections in a
  `<memory-update action="append">` block.
- Editing, removing, renaming, or reordering existing sections sends a
  `<memory-update action="reread">` instruction to read the current file.
- Emptying or deleting it sends `<memory-update action="clear">`.
- Unchanged memory adds nothing. Steering an active turn does not refresh it.

Sections are Markdown H1 headings (`# Heading` or Setext `===`). Text before
the first heading is a section too. Code fences and quoted headings are not
sections. Duplicate headings use the conservative reread path. Blank space at
section boundaries does not turn an addition into an edit. `/compact` is sent
unchanged, and the next ordinary turn receives a fresh memory snapshot.

Memory is enabled by default, has no additional size limit, and does not create
a file until you or the agent writes one. Missing memory is silent. The existing
ACP transport limit still applies to the complete prompt. Optional project or
global-default settings:

```json
{ "memory": { "enabled": true, "file": "MEMORY.md" } }
```

`file` is relative to the working directory and must remain inside it, including
through symlinks. Set `enabled` to `false` to disable automatic loading. All
content in this file is shared across conversations; private conversation
details should not be copied into it unless the person asks to share them.

## External events

`tgfx emit` submits an event to the running TGFX instance for the current folder.
Use `--cwd /path/to/workspace` from another directory. The command does not
start a second bot or open the journal itself: a private Unix socket admits and
persists events in the running controller. A stopped instance returns an error.

```sh
tgfx emit email.received --id mail-123 --payload '{"inbox_id":"agent@example.com","message_id":"123"}'
tgfx emit email.received --cwd /path/to/workspace --chat -1001234567890 --topic 42 --payload-file event.json
tgfx emit check.completed --payload-file - --wait < event.json
tgfx emit feedback --steer --payload '{"note":"Prioritize the deadline"}'
tgfx emit --status mail-123
```

Without `--chat`, events use one persistent background conversation for the
workspace, with no Telegram MCP credentials and no Telegram delivery. Responses
are stored in the event journal and available through `--status` or `--wait`.
Explicit chat destinations must be allowed by the bot's access policy. They
reuse that chat/topic's session, Telegram tools, and reply format. Events have
no Telegram sender or current message; message-relative tools need an explicit
message reference. Queued events wait behind
existing chat work; `--steer` joins a running turn at FX's next input boundary,
or queues a new turn if none is active. Steering requires FX's ACP steering
extension (supported by FX 0.0.15).

The agent receives a distinct `external_event` envelope with the event name,
ID, destination, and arbitrary JSON payload. It is not fabricated as a Telegram
user message. Optional `--prompt` supplies the local integration's task guidance;
payload data cannot grant owner approval or change the access policy.

An explicit `--id` makes retries idempotent. The same ID with different contents
is rejected. Queued events survive restarts; interrupted running events are
marked `interrupted`, never automatically replayed because tools may already
have produced side effects. Outputs are local job results, not an exactly-once
guarantee for external side effects.

`/stop` and confirmed `/clear` cancel events already queued for that chat/topic.
Cancelled events stay cancelled across restarts and idempotent retries. Events
submitted after the command's cancellation boundary wait for it to finish.

The default socket is beside the bot journal and is owner-only. For a separate
trusted emitter user, set `TGFX_EVENTS_SOCKET` on the controller and emitter,
and create a private setgid parent directory accessible only to those two
users. The socket is then mode 0660. Do not share that directory or group with
the agent/tool user. FX's environment strips this variable; filesystem
permissions enforce the boundary even if the agent learns the socket path.

## Session controls

`/clear` and `/compact` first show a confirmation with buttons inside the message
text, using Telegram Bot API 10.3's `RichTextButton`. Nothing changes until the
person who sent the command presses the confirmation button. Cancel keeps the
conversation and running task unchanged. Confirmations expire after five
minutes; sending another session command replaces the pending confirmation.

Confirming `/clear` stops the current task, discards queued requests, and starts
a fresh conversation on the next message. It does not delete files or Telegram
messages. Confirming `/compact` queues compaction after existing work. `/stop`
still acts immediately and also discards queued compaction.

## Groups and reply settings

By default, bots only respond in groups when mentioned or replied to.
To reply to every message, allow the group using its chat ID:

```bash
tgfx allow -1001234567890 --reply all
```

To let it see the whole discussion, make it a group admin, or disable Group
Privacy in [@BotFather](https://t.me/BotFather) (`/setprivacy` → **Disable**),
then remove and re-add it to the group. Keep tgfx running to collect messages
as context for later requests; it cannot fetch messages from before it joined.

## Reply style

𝒕𝒈(𝒇x) has four reply styles, depending on whether you want the answer
streamed and whether you want to see the full history of tool calls.

By default, it streams the text using Telegram's new
[live message drafts](https://telegram.org/blog/ai-bot-revolution-11-new-features#streaming-text-for-bots).
Tool calls are rendered as collapsible groups, in the order they happen.

<table>
  <tr>
    <th align="center">Live with activity</th>
    <th align="center">Live answer</th>
    <th align="center">No streaming</th>
  </tr>
  <tr>
    <td width="240" align="center"><img src="assets/reply-live.webp" alt="Live with activity: the draft grows with prose and tool calls as they happen" width="240" height="300"></td>
    <td width="240" align="center"><img src="assets/reply-progress.webp" alt="Live answer: a status line while fx works, then the answer streams in" width="240" height="300"></td>
    <td width="240" align="center"><img src="assets/reply-answer.webp" alt="Final answer: one message with the answer once the turn finishes" width="240" height="300"></td>
  </tr>
  <tr>
    <td align="center"><code>live</code> (default)<br>Stream the answer and tool activity as they happen</td>
    <td align="center"><code>progress</code><br>Show live status drafts, then stream the final answer</td>
    <td align="center"><code>answer</code><br>Send the answer only when the full turn finishes</td>
  </tr>
</table>

There is also **Final with activity** (`report`): the final answer with the
tool activity collapsed underneath it. Groups always get one message.

How to pick a reply style:

- Start 𝒕𝒈(𝒇x) with `--output <mode>` for one run
- Press <kbd>f</kbd> in the running terminal, or send `/format` to the bot and tap a button
- Set a machine-wide default in `~/.fx/telegram/config.json`:

```json
{ "defaults": { "output": "progress" } }
```

## Custom icons

<img src="assets/custom-icons.png" alt="Tool calls rendered with custom emoji icons" width="340" align="right">

The bot renders tool calls nicely with the
[tgfx icons](https://t.me/addemoji/ai_provider_labs_by_fxharness_bot) premium custom
emoji pack: every 𝒇x tool gets its own icon, and so do 100+ popular MCP
servers (GitHub, Notion, Slack, Figma, and friends). The model picker uses
provider logos (OpenAI, Anthropic, etc.) from the same pack.

To turn it off, start with `tgfx --no-icons`.

## MCP

Each conversation receives TGFX's Telegram MCP server through a scoped Unix
broker. It supplies Telegram files, reactions, stickers, choices, polls, history,
and available group administration tools. Other MCP servers in your FX config
are not inherited automatically in ACP mode.

## Commands

```text
tgfx           run fx in this folder (sets up on first run)
tgfx --yolo    same, without fx permission checks
tgfx --output  answer · report · progress · live
tgfx allow     let more users or chats talk to the bot (no id: pair by QR code)
tgfx auth      add, rotate, or remove the bot token
tgfx doctor    diagnostics: token, chats, rights, fx
```

Run `tgfx --help` for all commands and options.

### Separate service and agent users

An optional Linux deployment can keep tgfx's Telegram credentials and journal
under a service user while running fx under a separate agent user. Set
`FX_BINARY` to an operator-owned wrapper that switches to the agent user,
clears the environment, drops privileges, and then execs fx. The wrapper is
also used for preflight and usage checks.

Set `TGFX_MCP_SOCKET_DIR` to a service-owned directory that the agent can
traverse. tgfx then runs credentialed Telegram MCP processes itself and gives
fx only a Unix-socket proxy and a revocable capability scoped to its session.
The agent cannot choose the bot token, route, or approval destination in the
proxy handshake. Session disposal revokes its capability and connections.
Without this option, TGFX creates a private temporary broker directory.

Set `TGFX_POLICY_FILE` to an operator-owned JSON file with `version`,
`activeBotId`, `access`, and `approvals` (the same shape as the project config).
It overrides those fields and rejects CLI access/approval changes; missing or
invalid policy fails closed. Presentation and reply preferences remain mutable.
Protect both the policy and tgfx's data directory from the agent at OS level.

For shared attachment reading, `TGFX_FILES_DIR` selects a separate download
root (with a bot-ID subdirectory), and `TGFX_SHARED_FILES=1` uses directories
`2750` and files `0640`. Give the service and agent a shared group, use a
service-owned setgid download root, and keep its parent protected from agent
writes. The agent can copy downloads into its writable workspace to edit them.
These options provide hooks for an OS boundary; they do not create a sandbox
or isolate agents that still run as the same user.

## Development

```sh
cargo build --locked
cargo test --locked --all-targets
```

For the full verification suite, install Bun 1.4+ for the retained TypeScript
behavior tests, then run:

```sh
bun install --frozen-lockfile
./scripts/check-rust.sh
```

The TypeScript sources remain a compatibility reference. The primary executable
is `src/main.rs`; `bin/tgfx` runs a locally built native binary.
