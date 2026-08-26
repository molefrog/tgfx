# 𝒕𝒈(𝒇x) specification

> Status: implemented v0.1 specification, 23 August 2026. This document describes
> the current product contract and calls out remaining later work explicitly.

𝒕𝒈(𝒇x), typed as `tgfx`, is a small local program that lets a Telegram chat talk
to a [𝒇x](https://github.com/vercel-labs/fx) agent running in a project directory.
It lazily starts `fx acp`, gives the agent a carefully described Telegram message, and
mirrors the answer back to Telegram.

```text
Telegram message -> tgfx -> fx acp -> tgfx -> Telegram response
                          \-> scoped Telegram MCP tools
```

𝒇x is still the agent. tgfx does not replace its model loop, tools,
permissions, sessions, or project instructions. It is a transport adapter with a
small amount of reliable local state.

## Naming

| Surface | Name |
| --- | --- |
| Display name | **𝒕𝒈(𝒇x)** |
| GitHub repository | `telegram-fx` |
| npm package | `tgfx` |
| CLI executable | `tgfx` |

The Unicode wordmark is for headings, the bot display name, and visual identity.
Commands, package names, paths, configuration keys, logs, and accessibility text
use ASCII. The repository uses the longer `telegram-fx` slug for discoverability;
it does not change the independent product name.

This RFC uses **𝒇x** in product-facing introductions and `fx` for its executable.
Established technical compounds such as **FX ACP** and **FX session** remain
ASCII in code-adjacent sections and diagrams.

## Contents

- [What using it should feel like](#what-using-it-should-feel-like)
- [Start-to-finish user journey](#start-to-finish-user-journey)
- [Scope and architecture](#scope-of-the-first-release)
- [Telegram message contract](#the-telegram-message-contract)
- [Telegram MCP tools](#scoped-telegram-mcp-tools)
- [Rendering](#rendering-fx-in-telegram)
- [Storage and database](#storage-and-privacy)
- [Reliability contract](#reliability-contract)
- [Modules and stack](#module-boundaries)
- [Edge cases and open research](#important-edge-cases)

## Philosophy

tgfx follows the same direction as FX: minimal, fast, embeddable, and closer
to a Unix command than a terminal IDE.

1. **Run where the work is.** The directory in which `tgfx` starts is the FX
   workspace. There is no separate project picker or hosted control plane.
2. **Keep FX in charge of agent work.** tgfx does not duplicate FX tools,
   memory, models, or session storage.
3. **Make the safe path the obvious path.** A user/chat allowlist is mandatory.
   Secrets never go into project files. Telegram actions use opaque references
   and remain inside the authorized route. Group-administrator actions exist
   only where the group is allowlisted and Telegram itself grants the bot the
   matching admin right, with approval cards gating the destructive ones.
4. **Prefer one good default.** Private chats stream, groups receive one final
   answer, tool activity is collapsed, and long polling is used. Flags change
   only the few useful presentation choices.
5. **Persist only what recovery needs.** SQLite is an operational journal, not a
   chat archive. Raw ACP transcripts are off by default.
6. **Use typed boundaries.** Telegram updates, the context envelope, ACP events,
   MCP calls, and renderer state each have an explicit contract.
7. **Be honest.** Unsupported message types are reported plainly. tgfx never
   pretends that an argument, file, permission, or delivery was observed when it
   was not.

## What using it should feel like

### Start-to-finish user journey

The normal experience should require no knowledge of ACP, MCP, SQLite, or the
Telegram Bot API:

1. The user creates a Telegram bot, installs and authenticates `fx`, installs
   `tgfx`, enters a project directory, and runs `tgfx`.
2. On the first run, tgfx verifies the local FX installation, asks for the bot
   token in a hidden prompt, validates it with Telegram, and stores it in the
   operating system credential store under the bot's numeric ID.
3. The recommended setup displays a private `t.me` deep link containing a
   one-time nonce. Pressing **Start** proves the numeric user/chat pair without
   asking the user to look up IDs. Advanced setup can instead accept one numeric
   user or chat ID and a separate approvals chat; more principals can be added
   later with `tgfx allow`. No wildcard access exists in v1.
4. tgfx acquires the bot/workspace locks, writes non-secret settings to
   `.tgfx/config.json`, opens `.tgfx/state.sqlite`, and begins long polling. FX
   ACP processes are created lazily, one per active route. When the user supplied
   `tgfx --model <id>`, each process launches as `fx acp --model <id>` with the
   model ID as a separate argument.
5. The terminal becomes a small append-only status view and waits. The same bot
   cannot be active in another local workspace until this process stops.
6. An allowed person sends the bot a message. An ordinary private message starts
   a turn; a group message must use `/fx`, an advertised FX command, mention the
   bot, or reply to it. Everything outside the allowlist is silently discarded.
7. Before acknowledging the update locally, tgfx stores it and advances the
   Telegram polling cursor in one SQLite transaction. It then queues the message
   FIFO for its `{bot_id, chat_id, topic_id}` route.
8. tgfx creates or resumes that route's FX session. The prompt contains a
   host-generated `telegram_message` JSON block followed by the person's original
   text or caption unchanged.
9. Attachments and observed Telegram objects enter the prompt as scoped
   references. If the agent needs attachment bytes, it calls
   `download_attachment`; tgfx validates and downloads
   the file into `.tgfx/files/` without revealing the bot token or a reusable file
   URL.
10. 𝒇x works with its normal tools and may use the small scoped Telegram MCP
    action plane. It can reply explicitly, send a file, present choices or a
    poll, and react to the current or an earlier referenced message. In an
    allowlisted group it sees only the admin tools for which the bot currently
    holds the matching Telegram administrator right.
11. An FX permission request or a Telegram administration action that requires
    host approval appears as a single-use card in the approvals chat; the
    originating chat shows that work is waiting.
12. With default settings, a private chat sees a live rich draft containing
    structured prose and ordered groups of completed tools. A group, or any chat
    using `--no-streaming`, waits for one permanent rich response.
    `--collapse-tools` keeps each tool row compact instead of showing its full
    terminal details.
13. The next message in the same chat and topic continues the same FX route and
    session generation. Other chats and topics remain isolated.
14. On a clean Ctrl-C, tgfx stops polling, records accepted work, asks FX to
    cancel active work, finishes safe writes, and releases the bot lock. After a
    crash, accepted updates survive; uncertain FX work becomes `interrupted`
    instead of being silently replayed, and the user chooses `/retry` or
    `/discard`.

SQLite is invisible during normal use. It is a short-lived recovery journal, not
a copy of the Telegram conversation or an ACP transcript.

### Install

The current distribution is a Bun package run from source; npm publication and a
standalone executable are release operations, not different product designs:

```bash
# Install and authenticate FX first.
fx login

# From a checkout of the private repository:
bun install
bun link

cd my-project
tgfx

# Pin this run to one FX model without changing saved FX preferences.
tgfx --model openai/gpt-5.4
```

tgfx checks that Bun and FX are available, that FX is authenticated, and that
the current directory is usable. When an allowed route first needs the agent, it
launches that route's separate `fx acp` process in this workspace.

`tgfx --model <id>` is a thin startup pass-through. tgfx does not maintain its
own model catalog or save the value in workspace configuration; it spawns
`fx acp --model <id>` and lets FX validate the ID. The override applies only to
that process and takes precedence over the model stored in a loaded FX session.
Arguments are passed directly to the child process without a shell.

`tgfx` is always a workspace command. It does not start as a global daemon and
does not ask the user to choose a project after launch. The canonical current
directory is the workspace for the lifetime of the process.

### First run

If the selected bot has no token, tgfx asks for it in a hidden prompt:

```text
tgfx 0.1.0
◇  Telegram bot token
│  •••••••••••••••••••••••••••••••••••••••
◆  Who may use this workspace bot?
│  ● Connect my Telegram account (recommended)
│
◇  Connect your Telegram account
│  https://t.me/my_fx_bot?start=tgfx_<one-time-nonce>
│  Open this link and press Start.
◆  Connected Mole Frog (@molefrog)
@my_fx_bot · polling · /Users/me/code/my-project · streaming · collapsed tools
```

Setup asks nothing that a good default already answers: streaming and tool
collapsing keep their defaults and stay adjustable with flags or config.

The token is validated with Telegram's `getMe` before it is saved. The terminal
shows the bot identity and asks before replacing a different configured bot. The
confirmed bot ID is written to this workspace's `.tgfx/config.json`.

After resolving the bot ID, tgfx acquires a machine-wide process lock for that
bot before it begins polling. A lock is global to the user account, not stored in
the workspace, so another folder can see that the bot is already running.

Private pairing makes that user ID the initial allowlist and the paired private
chat the approvals chat. Manual onboarding cannot finish without one allowed user
ID or chat ID and a reachable approvals chat. In either mode, the approvals chat is
used for permission approvals and critical recovery notices.
The approvals target may be a private chat, group, or topic, and must be reachable
by the bot. Setup sends a harmless test message before saving it.

V1 has no owner, admin, or regular-user roles. Every allowed principal is equally
trusted. Allowing a user ID authorizes that sender in private chats and groups.
Allowing a group/supergroup chat ID authorizes every sender in that chat,
including anonymous chat-as-sender messages. Onboarding states that consequence
explicitly before accepting a chat-wide rule.

```text
authorized = sender.user_id in access.userIds
          OR chat.id        in access.chatIds
```

User IDs are used for people; chat IDs are used for groups and supergroups. Both
lists contain decimal strings, and no username or display name grants access.

In a non-interactive terminal, tgfx never waits for a hidden prompt. It uses
`TELEGRAM_BOT_TOKEN` if present or exits with a useful setup message.

### Normal run

Running `tgfx` again selects the known bot and workspace configuration:

```text
tgfx 0.1.0
✓ fx 0.0.6 · selected-model · authenticated provider
@my_fx_bot · polling · /Users/me/code/my-project · streaming · collapsed tools
12:04:11 Mole Frog · turn started
12:04:19 Mole Frog · delivered 1 message · 8.2s
```

Steady-state lines use stable numeric chat/topic route IDs. `tgfx doctor`
resolves live group names and rights when a human-readable diagnostic is
needed, without maintaining a second chat directory. The wordmark stays plain
ASCII in the terminal; the 𝒕𝒈(𝒇x) mark belongs to documentation.

If the same bot is active in another folder, startup stops before polling:

```text
✗ @my_fx_bot is already running
  workspace  /Users/me/code/other-project
  process    41822

Stop that tgfx process before using this bot here.
```

Steady-state output is append-only and readable in an ordinary terminal. Short
setup tasks may use a spinner, but tgfx does not use a full-screen TUI. A
`--json` mode provides machine-readable operational events.

### Workspace and bot execution model

V1 has three simple invariants:

```text
one process   = one canonical workspace
one process   = one Telegram bot
one bot       = at most one active tgfx process
```

The same bot may be initialized in several workspace folders. Those folders keep
separate configuration, routes, SQLite state, attachments, and FX sessions. Only
one can be active at a time. After a clean shutdown in workspace A, starting the
same bot in workspace B is allowed; all future Telegram updates are then handled
against workspace B.

The exclusive lock file is keyed by Telegram `getMe.id` and records diagnostic
metadata such as the canonical workspace path, PID, and start time. A normal
shutdown removes it. After a crash, the next process verifies that the recorded
PID is gone before reclaiming the stale file; metadata alone is never treated as
proof that a process is alive.

This lock coordinates processes on one machine. It cannot see a copy of tgfx
running on another computer. Telegram's competing-poller response remains the
cross-machine backstop: tgfx exits and explains that the bot is active elsewhere.

A workspace switch is a handoff of the bot's entire inbound stream, not routing
between two live projects. Shutdown therefore stops accepting new turns, resolves
or cancels queued work, and leaves the workspace journal consistent before the
lock is released. After an unclean exit with unfinished recovery rows, starting
the bot in a different workspace must warn and require the previous workspace to
be resumed or explicitly abandoned; it must not silently strand pending work.

### In Telegram

In a private chat, an ordinary allowed message starts a turn. With the default
streaming mode, the user first sees one temporary thinking placeholder. It
disappears as soon as structured prose or a completed tool is available, and the
rich draft then grows as FX responds. When the turn finishes, the draft becomes a
permanent rich message. With `--no-streaming`, the user sees only that final
message.

In a group, tgfx reacts only to an explicit `/fx` command, an advertised FX
command, a reply to the bot, or a configured mention. It does not read normal
group conversation as agent requests. Groups receive one final response in v1;
live group previews are left for later because their delivery and visibility
rules are different.

An allowed group where the bot is a Telegram administrator additionally has
**admin actions**. This does not make normal conversation autonomous: the same
`/fx`, mention, or reply trigger still starts a turn. It only gives that route
the administrator actions matching the bot's live Telegram rights, such as
maintaining one bot-owned pinned bulletin, managing forum topics, deleting
spam, moderating members, or reviewing join requests. Telegram's promote dialog
is the capability editor: promotion is the consent, demotion is the revocation,
and destructive actions still require a single-use approval card.

If a route already has an active turn, later messages wait in arrival order. The
user can send `/cancel` to cancel the active FX prompt. V1 runs one prompt at a
time for each bot/chat/topic route.

The tgfx-owned Telegram command surface is small:

| Command | Purpose |
| --- | --- |
| `/fx <prompt>` | Start a turn explicitly; required in groups unless the bot is mentioned or replied to. |
| `/cancel` | Cancel the active turn for this route. |
| `/new` | Start a fresh FX session generation for this route. |
| `/retry` | Explicitly start a new attempt for an interrupted turn after warning that earlier side effects may already exist. |
| `/discard` | Resolve an interrupted turn without running it again. |

Once an FX session exists for a route, tgfx also projects the commands advertised
by ACP `available_commands_update` into Telegram's slash-command menu for that
chat. With the currently checked FX build this includes commands such as
`/compact`, `/undo`, `/changes`, `/review`, `/status`, `/model`, `/permissions`,
`/mcp`, `/skills`, and `/fast`. This list is illustrative, not a product-level
hard-coded catalog.

### FX slash commands in Telegram

The ACP notification is the authoritative, replace-all snapshot for one FX
session. tgfx never assumes that the interactive FX command list and the ACP
command list are identical.

1. tgfx authorizes the Telegram sender and route before interpreting any
   command. Telegram's visible command menu is discoverability, not an access
   control boundary.
2. Built-in tgfx commands are resolved first. `/cancel`, `/new`, `/retry`,
   `/discard`, and `/fx` are never forwarded to FX. If a future FX catalog uses
   one of those names, the tgfx command wins and the colliding FX command is not
   exposed in v1.
3. A route without an FX session creates or resumes one before resolving a
   non-tgfx slash command. tgfx waits for its first
   `available_commands_update`, then either invokes an exact advertised command
   or reports that the command is unavailable. An unknown command is never
   downgraded into an ordinary model prompt.
4. Telegram input such as `/compact@my_fx_bot` or
   `/model@my_fx_bot openai/gpt-5.4` is normalized only by removing this bot's
   `@username` suffix. The command name and remaining argument text are otherwise
   preserved.
5. tgfx invokes the FX command with `session/prompt` as one text content block,
   for example `{ "type": "text", "text": "/compact" }`. It does not prepend
   the `telegram_message` envelope because doing so would stop the input from
   being an FX slash command.
6. FX owns the command's behavior and emits its normal ACP updates. tgfx renders
   those updates like any other turn. If the command succeeds without visible
   output, Telegram receives a small completion acknowledgement instead of
   appearing to ignore the command.
7. A later `available_commands_update` replaces the route's cached snapshot and
   triggers command-menu reconciliation. The last snapshot is stored with the
   route so the menu survives restart, then replaced when the resumed ACP session
   advertises a newer catalog.

tgfx uses Telegram `setMyCommands` with a chat-specific scope for each allowed
chat. It merges its reserved commands with the representable ACP commands,
without overwriting the bot's default or BotFather-managed command list. On a
clean handoff it removes the chat-scoped list it owned, revealing any broader
Telegram configuration underneath. Before a route has an FX session, its scoped
menu contains only the built-in tgfx commands; the first ACP command snapshot
expands it.

Only ACP names that already satisfy Telegram's command-name grammar—1 to 32
lowercase English letters, digits, or underscores—are placed in the menu.
Descriptions are safely truncated to Telegram's limit. Reserved-name collisions,
invalid names, and entries beyond Telegram's 100-command limit are omitted with
a local warning; current FX commands fit without translation. A command received
from Telegram is still checked against the live ACP snapshot because Telegram
can deliver commands that were never registered or whose menu entry is stale.

When `tgfx --model <id>` pins the FX process model, tgfx omits `/model` from its
Telegram projection and answers direct `/model` attempts with the effective
startup pin. This avoids offering a session-level selector that cannot override
the process-level model.

## Small command and configuration surface

The intended commands are deliberately limited. Each is one verb, one idea:

| Command | Purpose |
| --- | --- |
| `tgfx` | Start in the current directory; onboard if needed. Any other unknown first word is an error, never an implicit start. |
| `tgfx access` | The read-only map: numeric users and chats that can talk to fx, where approvals go, and saved sessions. |
| `tgfx allow <id…>` | Add users or chats to the allowlist. Positive IDs are users, negative IDs are chats; `--chat` overrides. |
| `tgfx deny <id…>` | Remove them. The allowlist can never become empty. |
| `tgfx approvals <chat>[/topic]` | Route approval cards and failure notices to a chat; with no argument, show the current target. |
| `tgfx auth [--remove]` | Add, rotate, or remove the Telegram bot token. |
| `tgfx doctor` | Check FX, Telegram, the approvals chat, live admin rights, SQLite, and workspace access. |

The run flags are `--model <id>`, `--yolo`, `--streaming`/`--no-streaming`, and
`--collapse-tools`/`--no-collapse-tools`; `--json`, `--no-color`, and `--debug`
are global. Human-readable output is the default and `--json` is the machine
mode everywhere. Conversational output — banners, prompts, errors, hints — goes
to stderr; primary command output goes to stdout, so `tgfx access --json | jq`
stays clean.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--model <id>` | FX default/session model | Pass `<id>` directly as `fx acp --model <id>` for this run. The value is not saved by tgfx. |
| `--yolo` | off (FX auto mode) | Disable FX permission checks for this process through `FX_PERMISSION_MODE=yolo`. tgfx's Telegram-admin approval layer remains active. |
| `--streaming` / `--no-streaming` | streaming | Stream a private draft, or wait for one final response. Groups remain final-only in v1. |
| `--collapse-tools` / `--no-collapse-tools` | collapse | Use compact rows or full terminal details inside ordered, completed-tool groups. In non-streaming mode tools are omitted from the final message. |
| `--json` | off | Emit terminal events as JSON Lines with a typed `event` field. |
| `--no-color` | off | Disable terminal color (NO_COLOR is also honored). |
| `--debug` | off | Show stack traces behind the one-line error output. |

Stable defaults may be written to `.tgfx/config.json`. Command-line flags win
for the current run. Environment variables are reserved for secrets and
automation, not for a second large configuration system.

```json
{
  "version": 1,
  "activeBotId": "123456789",
  "access": {
    "userIds": ["6143594"],
    "chatIds": ["-1002255001"]
  },
  "approvals": {
    "chatId": "6143594",
    "topicId": "0"
  },
  "renderer": {
    "mode": "streaming",
    "collapseTools": true,
    "updateEveryMs": 250
  }
}
```

The token does not belong in this file. Allowlist and approvals-target IDs do:
they are explicit workspace configuration, not model context or transient
delivery state. SQLite continues to own route sessions and recovery state.
### Configuration changes

Configuration commands validate and atomically replace `config.json`. A running
process keeps the configuration it started with, so `tgfx allow`, `tgfx deny`,
and `tgfx approvals` explicitly tell the operator to restart tgfx. This keeps
authorization, MCP capabilities, approval routing, and command menus on one
consistent startup snapshot.

## Scope of the first release

V1 includes:

- Bun and TypeScript, running as a local CLI;
- long polling of one selected Telegram bot;
- private chats, groups, supergroups, and their topics;
- mandatory fail-closed user/chat allowlisting and one approvals chat;
- one FX session per bot/chat/topic route;
- text, captions, replies, edits, and attachment references;
- a scoped Telegram MCP action plane for replies, files, reactions, choices,
  polls, and attachment downloads;
- group-admin actions derived from live Telegram rights for managed pins,
  topics, deletion, moderation, and join requests;
- rich-message drafts in private chats and final rich messages everywhere;
- SQLite recovery state and temporary attachment files;
- cancellation, queuing, retry, rate-limit handling, and graceful shutdown.

V1 intentionally does not include:

- broadcast channels, channel posts, business chats, communities, or guest bots;
- webhooks or a hosted service;
- multiple tgfx processes sharing one workspace database;
- a permanent Telegram message archive or raw ACP transcript;
- native image/audio blocks in ACP;
- arbitrary Telegram automation, a raw Bot API proxy, arbitrary destination chat
  IDs, or arbitrary filesystem paths in MCP calls;
- a full-screen terminal UI or a large config framework.

These are boundaries, not claims that Telegram or FX can never support them.

## Architecture

```text
┌──────────────┐   updates   ┌──────────────────────────────────────────┐
│   Telegram   │ ──────────> │ tgfx host                             │
│              │             │                                          │
│ private/group│ <──────────  │ ingress -> route/queue -> context        │
└──────────────┘ rich output │                    │                     │
                             │                    v                     │
                             │             FX ACP client/projector      │
                             │                │             │           │
                             │                v             v           │
                             │             fx acp     Telegram MCP      │
                             │                                          │
                             │ SQLite journal + temporary attachments   │
                             └──────────────────────────────────────────┘
```

The host owns inbound updates, Telegram identity, authorization, routing,
delivery, and recovery. ACP carries prompts into FX and streamed model/tool events
back out. MCP is the action plane: it lets the active FX session perform a small
set of Telegram operations without giving the model a general Bot API client.

### One message from end to end

1. The polling loop asks Telegram for updates from the saved cursor.
2. It compares the sender user ID and chat ID with the mandatory allowlist.
   Unauthorized updates are silently discarded and never become model input or
   stored message payloads.
3. In one SQLite transaction it records each authorized update and advances the
   cursor. Duplicate `(bot_id, update_id)` values are ignored.
4. The normalizer recognizes the sender, chat, topic, reply, edit, text/caption,
   and attachment metadata, then assigns route-scoped opaque refs to observed
   messages, members, attachments, and interactions.
5. The router creates or loads the route and queues the message behind any active
   turn for the same `{bot_id, chat_id, topic_id}`.
6. tgfx creates or resumes that route's FX session and sends the two-block
   context envelope through `session/prompt`. It also consumes the session's
   replace-all ACP command snapshot and reconciles the Telegram command menu for
   this chat.
7. FX streams assistant text, tool status, and permission requests over ACP. An
   explicit Telegram MCP action is validated against the context ref, the route
   allowlist, live bot admin rights, approval policy, and effect ledger
   before the host calls Telegram.
8. The projector reduces those events into a complete current timeline. It can
   add, update, collapse, or remove an earlier tool line.
9. The renderer coalesces fast changes and sends the whole current private draft
   with the same non-zero `draft_id`. It respects Telegram rate limits and keeps
   the 30-second draft alive.
10. On success it sends a permanent rich message and marks the inbox and outbox
   rows complete. On restart, each unfinished row follows the recovery rule for
   its recorded state. A turn or side effect that may already have started is
   never blindly replayed.

Button clicks and supported poll answers created by a prior action re-enter at
step 1 as new Telegram updates. Ambient administrator events do not automatically
wake FX in v1; bounded pending admin state is attached to the next explicit turn.

## Routes and FX sessions

A route is one Telegram conversation scope:

```text
route = bot_id + chat_id + topic_id
```

`topic_id` is `0` when the message is not inside a topic. It is part of the key
for both group topics and Telegram private-chat topics. Two topics in one group
do not share an FX conversation by default.

Each route has one FX session generation. tgfx may resume the saved FX session
after a restart. Changing the workspace or agent profile starts a new generation
instead of silently putting old context into a different environment.

Models, modes, permissions, built-in tools, skills, and project instructions stay
FX-owned. tgfx chooses the initial FX permission policy (`auto`, or `yolo` for an
explicit run) but does not implement that policy itself. It may display the
selected model, but it does not keep its own copy of FX's changing model or tool
catalogs.

Changing credentials is predictable:

- rotating a token for the same `getMe.id` keeps the route, polling, and FX
  session state;
- selecting a token for a different bot creates a new bot namespace and a fresh
  polling cursor; old routes remain dormant until that bot is selected again;
- an authorized message in a new chat or topic creates a new route and FX
  session;
- history is never copied between chats automatically.

Configuring the same bot in a second folder does not copy its allowlist, routes,
approvals chat, or FX history.
Whichever folder currently holds the bot lock is the only active workspace.

## The Telegram message contract

An FX prompt contains two text blocks:

1. host-generated JSON with one top-level key, `telegram_message`;
2. the user's original text or caption, unchanged.

Keeping them separate makes the source and routing facts easy for the agent to
recognize without wrapping or rewriting the user's words. Both blocks are still
untrusted model input. Authorization is always checked by the host.

This keeps the useful part of the Claude Channels pattern—a clearly named source
envelope—while using JSON and separating metadata from the person's message.

### Canonical text message

Block 1:

```json
{
  "telegram_message": {
    "version": 1,
    "source": "tgfx:telegram",
    "event": "message.created",
    "event_id": "tg:841234",
    "context_ref": "ctx_7qK2",
    "scope": {
      "chat_id": "6143594",
      "kind": "private",
      "topic_id": "0"
    },
    "sender": {
      "kind": "user",
      "ref": "member_Zp4c",
      "user_id": "6143594",
      "username": "molefrog",
      "display_name": "Mole Frog"
    },
    "message": {
      "ref": "msg_W1n8",
      "message_id": "1800",
      "ts": "2026-08-22T18:35:39Z"
    },
    "attachments": [],
    "response_target": {
      "kind": "automatic_reply"
    }
  }
}
```

Block 2:

```text
Can you review the failing tests?
```

IDs are decimal strings at the JSON and storage boundaries. This avoids accidental
32-bit truncation and makes compound keys stable across JavaScript, SQLite, and
Telegram.

### Photo-only message

A photo is represented by an opaque attachment reference. Its Telegram `file_id`
is not exposed as an authority the model can reuse elsewhere.

```json
{
  "telegram_message": {
    "version": 1,
    "source": "tgfx:telegram",
    "event": "message.created",
    "event_id": "tg:841240",
    "context_ref": "ctx_R9mA",
    "scope": {
      "chat_id": "6143594",
      "kind": "private",
      "topic_id": "0"
    },
    "sender": {
      "kind": "user",
      "ref": "member_Zp4c",
      "user_id": "6143594",
      "username": "molefrog"
    },
    "message": {
      "ref": "msg_A7qB",
      "message_id": "1804",
      "ts": "2026-08-22T18:42:11Z"
    },
    "attachments": [
      {
        "ref": "att_photo_1",
        "kind": "photo",
        "state": "remote",
        "mime": "image/jpeg",
        "size": 183421,
        "width": 1280,
        "height": 960
      }
    ],
    "response_target": {
      "kind": "automatic_reply"
    }
  }
}
```

There is no second block when a media-only message has no caption. The agent can
call `download_attachment` if the file is needed. Current FX ACP does
not accept image or audio prompt blocks, so tgfx does not claim that the model
has seen the pixels merely because Telegram supplied a photo.

### Voice message

```json
{
  "telegram_message": {
    "version": 1,
    "source": "tgfx:telegram",
    "event": "message.created",
    "event_id": "tg:841251",
    "context_ref": "ctx_x2Js",
    "scope": {
      "chat_id": "-1002255001",
      "kind": "supergroup",
      "topic_id": "77"
    },
    "sender": {
      "kind": "user",
      "ref": "member_M6tV",
      "user_id": "71262225",
      "username": "soaniel"
    },
    "message": {
      "ref": "msg_C2jR",
      "message_id": "402",
      "ts": "2026-08-22T19:02:00Z"
    },
    "attachments": [
      {
        "ref": "att_voice_1",
        "kind": "voice",
        "state": "remote",
        "mime": "audio/ogg",
        "size": 431386,
        "duration_seconds": 28
      }
    ],
    "response_target": {
      "kind": "automatic_reply"
    }
  }
}
```

Downloading does not imply transcription. A transcription tool can be added
later as a separate, explicit capability.

### Optional facets

The envelope adds fields only when Telegram supplied them:

- `reply`: opaque `message_ref`, optional quote, sender display name, bounded text
  excerpt, and attachment kinds; the raw replied-to message ID is not exposed;
- `edited_at` with `event: "message.edited"`;
- `media_group_id` and the attachment's position in a collected album;
- `forwarded_from` and `via_bot` provenance without trusting either as the actor;
- document `name`, MIME type, and size;
- photo, sticker, animation, video, video-note, document, audio, or voice
  attachment metadata that can be represented without copying a large payload;
- `admin_context`: the bot's current admin capabilities and bounded pending
  join-request refs when the allowlisted group has granted admin rights. Live
  Telegram rights are re-checked inside the MCP server immediately before an
  action. The context is
  attached only to an explicitly triggered group turn; an ambient join request
  does not wake FX by itself.

Contacts, locations, venues, native inbound polls, and unrelated service
messages are acknowledged without becoming agent prompts in v0.1.

`sender` is a union. A normal person is `{ "kind": "user", "ref":
"member_...", ... }`. An anonymous admin or a message sent as a chat is
`{ "kind": "chat", "ref": "member_...", "chat_id": "...",
"chat_kind": "supergroup", "title": "..." }`. When Telegram supplies
`sender_chat`, it wins over the compatibility `from` field; tgfx does not
invent a user identity.

`context_ref`, `message.ref`, `sender.ref`, and attachment `ref` values are
capabilities, not Telegram identifiers. A context reference expires with its
turn. Message and member references remain valid only inside the same bot,
route, and FX session generation, which lets the agent react to or moderate an
object from an earlier visible turn without accepting a raw target ID. tgfx can
resolve only messages and members it actually observed or sent; it does not
provide arbitrary history lookup in v1.

### Interaction result

A button click created by `request_choice` has metadata but no invented
user text. It starts a new turn because the earlier tool explicitly requested the
interaction:

```json
{
  "telegram_message": {
    "version": 1,
    "source": "tgfx:telegram",
    "event": "interaction.choice",
    "event_id": "tg:841310",
    "context_ref": "ctx_H3sN",
    "scope": {
      "chat_id": "6143594",
      "kind": "private",
      "topic_id": "0"
    },
    "sender": {
      "kind": "user",
      "ref": "member_Zp4c",
      "user_id": "6143594"
    },
    "interaction": {
      "ref": "interaction_Q8fK",
      "message_ref": "msg_B4yP",
      "choice_id": "approve_plan"
    },
    "response_target": {
      "kind": "automatic_reply"
    }
  }
}
```

Poll answers use `event: "poll.answer"` with `poll_ref`, selected option IDs,
and a sender ref when Telegram discloses the voter. Anonymous poll updates never
invent an identity. Callback tokens and raw poll IDs remain host-only.

## Teaching FX how Telegram works

tgfx supplies a small persistent instruction together with strongly described
MCP tools:

- the normal assistant response is automatically delivered to the current
  Telegram route; the agent should not call a tool just to answer;
- `telegram_message` describes where the turn came from, but it does not grant
  permission;
- `context_ref` selects the authorized route and current turn; a target reference
  can select only an object already observed or created inside that route;
- an attachment must be downloaded before the agent claims to have inspected it;
- a destructive administrator tool should be used only for an explicit user
  request, and may still pause for host approval;
- the agent must not ask for or invent a `chat_id`, Telegram `file_id`, raw
  message ID, member ID, or attachment destination path.

The important rule is enforced in code, not only in prose: every MCP call carries
an opaque, short-lived `context_ref`. The server resolves it to the authorized
bot/chat/topic/message and rejects expired, mismatched, or cross-route calls.
The tool catalog itself is capability-filtered, so the model does not see admin
tools that are disabled or impossible with the bot's current Telegram rights.

## Scoped Telegram MCP tools

MCP is the explicit Telegram action plane. It is not used for the ordinary
assistant response, streaming drafts, typing indicators, finalization, retries,
or delivery splitting; the tgfx host owns those automatically.

### Core action methods

The first server exposes this small core:

| Tool | Important input | Result and restrictions |
| --- | --- | --- |
| `set_reaction` | `emoji`, optional `message_ref` | Sets one bot reaction on the current message or a previously referenced message in the same route. Telegram validates whether that reaction is available. |
| `download_attachment` | `attachment_ref`, optional safe `filename` | Enforces Telegram's 20 MB cloud-download limit, saves into `.tgfx/files/<context_ref>/`, and returns the local path, exact byte count, and known MIME. |
| `send_file` | workspace-local `path`, optional `caption` and `filename` | Sends one regular file of at most 50 MB after canonical-path checks. It cannot target another chat. |
| `request_choice` | `question`, 2–8 bounded `options` | Sends inline buttons and returns `interaction_ref` and `message_ref`. A click is a later Telegram event and a new FX turn; the call does not wait. |
| `create_poll` | `question`, 2–12 `options`, `anonymous`, `multiple` | Sends a poll and returns opaque `poll_ref` and `message_ref`. Non-anonymous votes can arrive later as new turns. |

The reaction target deliberately supports prior turns. Each incoming and outgoing
message that may be referenced receives an opaque `message_ref`. The agent can
reuse a reference retained in its FX context, including one found in `reply`
metadata, but cannot supply an arbitrary Telegram message ID or cross into a
different chat or topic. V1 does not expose `list_recent_messages`; a future
bounded version may be added if FX context compaction makes retained references
insufficient.

Bot reactions are constrained by Telegram's available-reaction policy. tgfx
validates the requested emoji and treats setting the same reaction, or clearing
an absent reaction, as the same desired state rather than a second side effect.

`request_choice` and `create_poll` create permanent Telegram messages, so an
unknown network outcome is not automatically repeated. Callback and poll update
payloads are normalized into the same `telegram_message` envelope family with an
`interaction_ref` or `poll_ref`; authorization is checked again before they can
start a turn.

Editing or deleting a bot-sent ordinary action message and closing a poll are
useful follow-ups, but remain later additions: `telegram.edit_sent_message`,
`telegram.delete_sent_message`, and `telegram.close_poll`. They should accept
only refs returned by tgfx, never raw IDs.

### Group administrator actions from live Telegram rights

Administrator actions need no tgfx-side configuration. For an allowlisted group
chat, the available admin tools are exactly the bot's live Telegram admin
rights — Telegram's own promote dialog is the per-capability editor, operated
by exactly the people who own the consequences. Allowlisting the group remains
the operator's explicit act of trust, and the approval card remains the
per-action human gate. An admin tool executes only when all of these are true:

1. the group is allowlisted in the current workspace (and is a group: admin
   tools never exist for private chats);
2. Telegram currently reports the required bot administrator right, re-checked
   live at execution time;
3. the call's context and target refs resolve inside the same group and topic;
4. any required single-use approval succeeds.

The MCP tool catalog is published from live rights at session start. A
mid-session promotion is picked up by the next session, while a mid-session
demotion takes effect immediately through the execution-time re-check.
`tgfx doctor` queries Telegram directly when the operator wants a current rights
report.

The intended v1 admin methods are:

| Tool | Important input | Behavior |
| --- | --- | --- |
| `set_pinned_message` | `text` | Creates or updates one tgfx-owned bulletin for the current route and ensures it is pinned. It never unpins unrelated messages. |
| `pin_message` | `message_ref`, optional `silent` | Pins one observed message in the current route. |
| `unpin_message` | `message_ref` | Unpins exactly one referenced message; there is no `unpin_all` tool. |
| `manage_topic` | `action`, optional `topic_id` and `name` | Creates, renames, closes, or reopens a forum topic when `can_manage_topics` permits it. Creating a topic is non-idempotent. |
| `delete_messages` | 1–100 `message_refs` | Deletes only observed messages in the current group, subject to Telegram's rights and deletion rules. |
| `moderate_member` | `member_ref`, `action`, optional `until` | Restricts, restores, bans, or unbans an observed member. The bot and allowlisted users are protected. |
| `review_join_request` | `request_ref`, `decision` | Approves or declines one observed pending join request when the bot has `can_invite_users`. |

`set_pinned_message` is intentionally higher level than the Bot API. Telegram
allows several pinned messages, so tgfx stores one managed pin per route, edits
that bot-owned message in place, and reconciles the create/edit/pin sequence after
an interruption. It does not redefine “the pinned message” or disturb pins owned
by people and other bots.

Managed pins, explicit pin/unpin, deletion, moderation, declining a join request,
and topic creation require a single-use approval. Topic rename/close/reopen and
join approval still re-check the live Telegram right but do not add another tgfx
approval. Every MCP action also remains subject to 𝒇x's selected permission mode;
under `tgfx --yolo`, that FX layer is deliberately disabled while tgfx's
administrator-action approvals remain active.

Temporary invite links, chat title/description/photo changes, default member
permissions, reaction cleanup, sender-chat bans, and ownership-like operations
are deliberately deferred. If added, they belong to a stricter manager profile.
Invite URLs are secrets, and changing default permissions affects the entire
group; neither should arrive through a generic Bot API escape hatch.

### Protocol boundary

tgfx passes this local stdio MCP server in ACP `session/new`. FX treats the
ACP client's `mcpServers` list as authoritative, which means tgfx does not
silently inherit unrelated servers from the user's global FX profile.

The MCP server negotiates the latest modern stdio protocol shared by the installed
SDK and FX build. MCP catalog subscriptions are not a Telegram event inbox and do
not create ACP user turns. The tgfx host remains responsible for polling Telegram
and deciding when an allowed message, interaction result, poll vote, or bounded
admin context becomes a turn. The server publishes a rights-filtered catalog at
session startup and re-checks the required Telegram right at execution; a
promotion granted mid-session expands the catalog on the next session, while a
demotion takes effect immediately through the execution-time re-check.

## Rendering FX in Telegram

### Rich messages first

The primary renderer maps the ACP timeline to Telegram Rich Messages:

- accumulated Markdown is reparsed on every frame into headings, rich
  paragraphs, lists, block quotations, preformatted code, math, and tables;
- one draft-only `tg-thinking` block is shown only before any real output exists;
- only terminal tool calls are rendered, in their first-observed ACP order;
- consecutive tools form a details block. The trailing group is open while it is
  the last item in a streaming draft, then collapses when content follows;
- the final call uses `sendRichMessage`;
- private streaming uses `sendRichMessageDraft` with one stable `draft_id`.

Drafts cannot directly upload a new file. Generated or modified media is sent at
the final step, or as a separate validated `send_file` action. Streaming
continues with text and tool blocks while that media is being prepared.

The draft API receives the complete current frame, not an append-only token. This
is why tgfx can reparse an unfinished Markdown block, remove the initial thinking
placeholder, collapse an earlier tool group, and then add the next rich block.

Telegram is not updated for every model token. The projector acts like a reducer
and the scheduler like a React commit loop: it offers a new complete render only
when user-visible text, a paragraph boundary, or a terminal tool changes. Thought
chunks, pending tools, command catalogs, and equal rendered trees bail out before
they can cause a Telegram request.

The scheduler starts optimistically at a 250ms minimum gap, with only 40ms of
burst coalescing. The initial placeholder and first real output commit
immediately; paragraph boundaries and completed tools skip coalescing. After ten
opening attempts, each chat amortizes that burst across its remaining 30-second
budget, then settles near the sustainable 834ms cadence. This avoids exhausting
the limit early and freezing the draft until the rolling window resets.

One request may be in flight, and only the newest pending frame survives behind
it. Per chat, tgfx keeps Telegram's two draft limits as final safety rails with
headroom: at most 18 attempts in 5 seconds and 36 in 30 seconds. A `retry_after`
response blocks that chat for the requested duration and increases its spacing;
successful requests gradually remove the penalty. An unchanged frame is
refreshed after 20 seconds, before the 30-second draft expires. ACP continues to
be consumed while Telegram is throttled, so a slow network does not block FX.

If rich messages are unavailable or a block cannot be represented, the renderer
falls back to ordinary messages with explicit Telegram entities. It does not send
unfinished Markdown delimiters through a parse mode. Long output is split at
semantic block boundaries; it is never silently truncated.

### Renderer modes

| Streaming | Collapse tools | Private chat | Group/topic |
| --- | --- | --- | --- |
| on | on | Live structured prose plus compact, ordered groups of completed tools; the trailing draft group opens until later content arrives. | Wait, then one final answer without tool activity. |
| on | off | The same ordering and terminal-only visibility, with full details inside each tool row. | Wait, then one final answer without tool activity. |
| off | either | Wait, then one final answer without tool activity. | Same. |

Tool arguments are shown only when ACP supplies raw input or exact structured
metadata that can be recovered from a terminal update. FX 0.0.6 also places the
exact terminal command in a legacy `command_result`; tgfx preserves that field as
ACP raw output before schema validation. Ordinary result prose is never treated
as an argument, so the renderer does not reconstruct or hallucinate missing
input.

For the same reason, tgfx does not hard-code a list of FX built-in tools. The
projector consumes the generic ACP tool lifecycle, so a newer FX can add or remove
tools without requiring a new Telegram adapter release.

## Storage and privacy

tgfx uses a few small storage locations:

| Location | Contents | Lifetime |
| --- | --- | --- |
| OS credential store through `Bun.secrets` | Telegram bot token, keyed by actual bot ID | Until the user removes or rotates it. Bun uses macOS Keychain, Linux Secret Service/libsecret, or Windows Credential Manager. |
| `~/.config/tgfx/bots.json` | Non-secret mapping from bot ID to its last workspace | Until removed. Used to protect unfinished work when the bot moves between folders. |
| `<user-state>/tgfx/locks/<bot_id>.lock` | Machine-wide process lock plus diagnostic workspace/PID metadata | Held while that bot is active; safely reclaimable after process death. |
| `<workspace>/.tgfx/config.json` | Active bot ID and non-secret renderer/route defaults | Project-local. |
| `<workspace>/.tgfx/state.sqlite` | Poll cursor, used routes, FX session references, and temporary inbox/outbox/effect/approval recovery rows | Operational; completed payloads expire. |
| `<workspace>/.tgfx/files/` | Attachments explicitly downloaded for the agent | Temporary; cleaned by age. Scoped refs expire independently. |

`.tgfx/` is private runtime state and must be gitignored. FX authentication,
settings, project instructions, permissions, and saved agent sessions remain in
FX's own storage. tgfx does not copy them.

The token lookup order is:

1. `TELEGRAM_BOT_TOKEN` for the current process;
2. the OS credential store for the configured bot ID;
3. an interactive hidden prompt.

An environment token is validated with `getMe` and uses the state namespace for
that returned bot ID. tgfx never copies an environment-provided token into the
credential store.

If a configured secret is missing, tgfx asks for it again. If the OS credential
store is unavailable, an environment variable is accepted; the token is never
silently written as plaintext. Logs redact bot tokens, file URLs, context
capabilities, and message payloads by default.

The credential key is stable and inspectable in code: `service = "dev.tgfx"`
and `name = "telegram:<bot_id>"`. Token rotation for the same bot overwrites that
one secret. The global non-secret bot index maps that validated ID to its last
workspace so tgfx can require an explicit handoff when unfinished work exists.

### What SQLite is for

SQLite answers two questions after a crash:

1. Which Telegram update should be read next?
2. Which accepted work or outgoing delivery is not finished yet?

It is not the FX conversation history and not a permanent Telegram message log.
An accepted message is kept only until its turn and response are safely handled,
because advancing Telegram's polling cursor acknowledges that update. Without a
short-lived local copy, a crash between acknowledgement and processing could lose
the message forever.

The database uses WAL mode and transactions. Successful inbox content, the saved
retry prompt, and sent outbox bodies are scrubbed immediately; small completion
rows remain briefly for deduplication and crash reconciliation, then expire.
Failed or interrupted content remains only so `/retry` or `/discard` can resolve
it. Attachments stay outside SQLite. V1 does not write raw ACP JSONL. A future
explicit debug bundle may capture a bounded, redacted trace, but it is not part
of normal operation.

### Database schema

All Telegram identity values are stored as decimal text. `topic_id` is always
present and uses `"0"` outside a topic, avoiding SQLite's special `NULL` behavior
inside unique constraints.

```text
telegram_poll_state
  bot_id PK, next_offset, updated_at

routes
  route_key PK                     -- bot_id:chat_id:topic_id
  bot_id, chat_id, topic_id, chat_kind
  session_id, generation
  dynamic_commands_json, last_prompt_json, updated_at

telegram_principals
  ref PK, bot_id, route_key, principal_kind, telegram_id
  display_name, expires_at
  UNIQUE(bot_id, route_key, principal_kind, telegram_id)

telegram_messages
  ref PK, bot_id, route_key, chat_id, topic_id, message_id
  sender_ref, owned_by_bot, created_at, expires_at
  UNIQUE(bot_id, chat_id, message_id)

telegram_inbox
  id PK, bot_id, update_id, route_key
  status                         -- received/dispatching/running/done/
                                 -- interrupted/failed/discarded
  payload_json, attempts, error, created_at, updated_at
  UNIQUE(bot_id, update_id)

telegram_outbox
  id PK, effect_key UNIQUE, bot_id, route_key, inbox_id, kind
  payload_json, status           -- pending/sending/sent/failed
  attempts, telegram_message_id, error, created_at, updated_at

telegram_interactions
  interaction_id PK, bot_id, route_key, kind
  payload_json, state, result_json, expires_at, updated_at
  -- choices, polls, join requests, FX permissions, and admin approvals

managed_pins
  (bot_id, route_key) PK, message_ref, updated_at

effect_ledger
  effect_key PK, bot_id, route_key, tool_name
  state                          -- running/complete/unknown/failed
  result_json, error, created_at, updated_at

context_capabilities
  context_ref PK, bot_id, route_key, chat_id, topic_id
  message_ref, message_id, sender_ref, attachments_json
  active, expires_at, created_at
```

Relationships:

```text
routes       1 ── N inbox / outbox / interactions / effects
routes       1 ── N principals / messages / context_capabilities
routes       1 ── 0..1 managed_pins
principals   1 ── N messages
inbox        1 ── 0..N outbox
```

Inbox insertion and poll-cursor advancement happen in the same transaction.
If the transaction fails, tgfx does not advance the cursor and stops polling
rather than risk losing the update. Outbox and effect rows are written before
network delivery. Their retry classes determine whether recovery may resend an
operation; a stable local ID alone does not make a Telegram send idempotent.

`telegram_messages` and `telegram_principals` are reference indexes, not content
archives. They retain the minimum Telegram IDs needed to resolve opaque refs for
the active FX session generation and are pruned with that generation. Interaction
payloads retain only bounded button, poll, join-request, or approval validation
state until completion or expiry. Message bodies are still removed with
completed inbox and outbox recovery payloads.

Ephemeral draft frames are coalesced in memory and never written per token. The
permanent final delivery enters the outbox; explicit MCP side effects use the
effect ledger. If the process dies, the draft expires naturally. The managed-pin
row identifies the one bot-owned bulletin that may be edited and pinned again.

## Reliability contract

“Reliable” does not mean exactly once. Telegram sends and an FX turn that can
change workspace files do not offer a transaction that SQLite can join. tgfx
therefore gives each boundary an explicit delivery semantic:

| Boundary | V1 guarantee | Recovery behavior |
| --- | --- | --- |
| Telegram before local acceptance | Telegram-owned, with no tgfx durability guarantee. Telegram retains unconsumed updates for at most 24 hours. | Poll again while Telegram still retains the update. |
| Authorized inbound update after SQLite commit | Durable acceptance and deduplication by `(bot_id, update_id)`, assuming the local database remains readable. | The update remains queued until done, failed, interrupted, or explicitly discarded. |
| Unauthorized update | Intentional discard; its payload is not stored or sent to FX. | Advance the poll cursor and do not replay it. |
| Dispatching a prompt to FX | At-most-once **automatic** dispatch when acceptance is uncertain. This avoids silently repeating file or tool side effects. | A recovered `dispatching` or `running` row becomes `interrupted`; tgfx notifies the approvals chat and requires `/retry` or `/discard`. |
| Private rich draft | Best effort and ephemeral. Intermediate frames may be coalesced, skipped, overwritten, or disappear. | Do not persist draft frames. Reconstruct a new draft only from a safely resumed active turn. |
| Permanent final Telegram reply | At least once after an outbox row exists. | Retry `pending` or `sending` rows. A sent outbox reconciles its inbox to done after a crash; a crash after Telegram accepted but before SQLite committed can still rarely create a duplicate. |
| Telegram MCP effect | A stable hash of route, active context, tool, and arguments guards one attempt. A completed identical call returns its stored result. | Any thrown or disconnected attempt becomes `unknown` and is not repeated automatically, even when the operation would normally be idempotent. |
| Managed pinned bulletin | One known bot-owned message may be edited and pinned for this route. | The effect ledger prevents blind replay after an unknown create. Later successful calls edit only the recorded message and never unpin unrelated messages. |
| Approval decision | One accepted decision per approval ID in the local database. | Atomically change `pending` to `resolved`. Duplicate, late, expired, or wrong-route callbacks cannot execute the action. |
| FX workspace changes | Owned by FX and its tools; tgfx provides no rollback. | Never replay the whole turn merely to recover its Telegram response. |

### Inbound ordering and acceptance

- Inserting an authorized inbox row and advancing `next_update_id` are one SQLite
  transaction. A disk-full, lock, or corruption error leaves the cursor
  unadvanced and stops ingestion with a visible terminal error.
- Updates run FIFO within `{bot_id, chat_id, topic_id}`. Only one prompt may be
  active for a route. Different routes may run concurrently through the chosen
  FX process strategy; that does not weaken per-route ordering.
- `received` is safe to dispatch. Before calling `session/prompt`, tgfx commits
  `dispatching`; after FX accepts, it commits `running`. A crash in either latter
  state enters recovery instead of automatic resubmission.
- A recovered `dispatching` or `running` turn always becomes `interrupted`.
  `/retry` is a new, explicit attempt and clears the old interrupted row;
  `/discard` removes interrupted, failed, and still-queued payloads for the route.
- `/cancel` is best effort. A cancelled prompt is acknowledged and marked done;
  it does not promise to undo an FX command already in progress.

### Outgoing delivery and retries

- Every permanent send is inserted before the Bot API call. `pending` becomes
  `sending` before the request and `sent` only after Telegram returns a message
  ID. Draft refreshes are excluded from this journal.
- Network errors and Telegram 5xx responses retry with delays of 1, 2, 4, 8, 16,
  then 30 seconds, capped at eight attempts. A 429 waits for Telegram's
  `retry_after` before the next attempt. Permanent 4xx responses fail immediately.
  Exhaustion leaves a visible `failed` row for explicit retry or discard.
- Telegram provides no general idempotency key for a new message. If Telegram
  accepts a send and tgfx dies before saving the returned message ID, recovery
  cannot distinguish “sent” from “not sent.” Final responses choose delivery
  over deduplication and resend the `unknown` row, so a duplicate is possible.
- MCP effects choose the opposite tradeoff: an `unknown` effect is not resent
  automatically. The effect key includes route, active context, tool, and exact
  arguments; a successful identical call returns its stored result.
- Administrator rights are checked immediately before execution, not only at
  startup. Losing a right turns the call into an explained failure. Approval does
  not reserve a permission or make a later Telegram operation succeed.
- A managed-pin row records the exact bot-owned message reference after successful
  creation. Later calls may edit and pin that message again, but never search for
  a vaguely matching message or call Telegram's unpin-all operation.

### Approvals and shutdown

- Approval callbacks use an atomic compare-and-set from `pending` to `resolved`.
  Only an allowed user in the expected approvals chat/topic with an unexpired
  request can win that transition. Approval consumption is single-use.
- A graceful shutdown stops polling first, commits already accepted updates,
  asks FX to cancel the active prompt, finishes safe database writes, and releases
  the bot lock. A forced exit relies on the same recorded states at next startup.
- tgfx does not guarantee availability while the process, Telegram, FX, the
  network, or the local disk is unavailable. The contract begins only after the
  inbound acceptance transaction commits.

The recovery behavior above is part of the product contract, not a hidden
implementation choice. Tests must kill the process before and after every state
transition and verify the corresponding row and visible recovery result.

## Module boundaries

The implementation should be small enough to navigate without a framework:

| Module | Owns |
| --- | --- |
| `cli` | Commands, flags, cwd selection, safe FX argument pass-through, signals, and inline terminal output. |
| `config` | Workspace config, bot selection, OS secrets, first-run flow, and validation. |
| `state` | SQLite schema, transactions, inbox/outbox/effect/approval recovery, and retention. |
| `telegram` | grammY client, owned long-poll loop, normalization, allowlist gate, scoped command-menu reconciliation, live permission checks, and API errors. |
| `routing` | Route keys, per-route queue, cancellation, and FX session generations. |
| `attachments` | Opaque references, album collection, validated downloads, temporary files, and cleanup. |
| `fx` | `fx acp` process lifecycle, ACP client, session create/resume/prompt/cancel, available-command snapshots, slash-command forwarding, and permission events. |
| `telegram-mcp` | Scoped action methods, opaque-ref resolution, interaction callbacks, live admin-rights derivation, and capability validation. |
| `projector` | Reduction of ACP text/tool/permission events into a current semantic timeline. |
| `renderer` | Rich blocks, drafts, final messages, fallback entities, splitting, throttle, and retry. |

Composition belongs in one small entry point. Telegram-specific types should not
leak into the ACP client, and raw ACP event shapes should not leak into the Bot
API client. Zod validates workspace configuration, MCP environment and tool
arguments; the Telegram normalizer and SQLite state layer validate and bound the
specific shapes they consume.

## Stack

- **Bun + strict TypeScript** for the runtime, process spawning, SQLite, secrets,
  tests, and eventual standalone executable;
- **`@agentclientprotocol/sdk`** for ACP contracts;
- **grammY** for typed Telegram Bot API access and file helpers;
- an **owned `getUpdates` loop**, rather than a helper that advances an in-memory
  cursor before SQLite has accepted the work;
- **`bun:sqlite`** directly, with one small v0.1 schema and no ORM;
- **Citty** for CLI command parsing;
- **Clack** for the hidden token prompt, confirms, finite spinners, and readable
  inline status;
- **Zod** at untrusted JSON boundaries;
- **`bun:test`** plus protocol fixtures and fake Telegram/FX transports.

Dependencies are justified by removing protocol work, not by adding product
surface. Versions are pinned in the lockfile and upgraded deliberately.

## Permissions and security boundaries

- The configured user/chat allowlist decides who can spend model credits and
  expose the workspace. It is checked before route creation, persistence, or
  prompt construction. Telegram metadata sent to the model never decides
  authorization.
- If both allowlist arrays are absent or empty, startup fails. V1 has no wildcard
  or allow-all mode. Unauthorized messages and callback queries receive no
  Telegram response and their content is not stored; the poll cursor still
  advances so they are not replayed forever.
- Bot tokens are redacted everywhere, including errors. Telegram file URLs also
  contain the token and are never logged or placed in model context.
- The host strips `TELEGRAM_BOT_TOKEN` and internal tgfx variables from the FX
  process environment, so ordinary FX shell tools cannot read them. The token is
  supplied only to the scoped Telegram MCP subprocess in its ACP launch
  descriptor; it is not inherited by FX commands.
- MCP tools resolve an opaque capability to the current route and enforce paths,
  file size, MIME type, bot permissions, and expiry on the server side.
- Raw Telegram IDs may appear as descriptive envelope metadata, but MCP target
  schemas never accept them. `context_ref`, `message_ref`, `member_ref`,
  `attachment_ref`, `interaction_ref`, `poll_ref`, and `request_ref` resolve only
  inside the issuing bot, route, topic, and allowed lifetime.
- Telegram administrator status is necessary but insufficient for admin MCP
  tools. The exact group must be allowlisted by the operator, the live Bot API
  permission check must pass at execution time, and the target must resolve
  within that group. Rights revoked while tgfx is running take effect on the
  next call.
- Deletion, member restriction/ban, join-request decline, and non-idempotent topic
  creation require a single-use approvals-chat approval — with the capability
  profile gone, this card is the one deliberate operator gate for the
  destructive set and can never be configured away. Protected principals
  include the bot itself and every allowlisted user; they cannot be moderation
  targets.
- FX automatic review is the normal tgfx mode. tgfx explicitly selects ACP
  `code` after every new or loaded session so the displayed mode and effective
  permission policy cannot diverge. If FX is later switched to ACP `ask`, a
  normal message still cannot approve its permission request: tgfx sends a card
  to the configured approvals chat with the exact tool title and options FX
  supplied. `tgfx --yolo` instead starts FX with its process-scoped permission
  checks disabled. Administrator-action cards remain **Approve** and **Deny** in
  every FX mode.
- Approval callbacks are single-use, short-lived, attached to one bot and route,
  and accepted only in the exact configured approvals chat/topic from an
  allowlisted clicker. Expired, canceled, already resolved, wrong-route, or
  unknown callbacks cannot execute the action. Session-wide permission is owned
  by FX and disappears with that FX session; tgfx never writes a permanent allow
  rule.
- There are no approval roles. Every allowed user can approve from the approvals
  chat. If the approvals chat itself is chat-allowlisted, every member of that chat
  can approve; onboarding warns about this explicitly. Use an allowlisted private
  user as the approvals chat for the narrowest setup.
- While approval is pending, the originating rich draft keeps the tool in its
  running state. `/cancel` cancels the FX turn. Approval timeout is fail-closed.
- FX stdout is reserved for ACP JSON-RPC. Diagnostics go to stderr or an explicit
  log file.
- Downloaded and generated paths are canonicalized and must remain inside the
  workspace or the route's `.tgfx/files` directory.

## Important edge cases

### Telegram delivery

- Telegram keeps unconsumed updates for at most 24 hours. A bot stopped longer
  than that cannot recover older messages from Telegram.
- Update IDs are deduplication keys, not wall-clock sequence numbers; after long
  inactivity the next value can jump.
- HTTP 429 uses Telegram's `retry_after`. Transient 5xx/network errors retry with
  bounded backoff; permanent 4xx errors fail the delivery and are shown locally.
- The cloud Bot API limits downloads to 20 MB. Larger files remain described in
  the envelope but cannot be materialized unless the user configures a local Bot
  API server. A local server can remove the download limit and accept uploads up
  to 2 GB, but it is not a v1 default.
- A bot can disappear from a chat, lose permissions, be blocked, or be unable to
  react/send media. These are route errors, not reasons to crash the process.
- Pinning adds a message to Telegram's pinned-message set; it does not replace a
  single global pin. `set_pinned_message` therefore manages only the one bulletin
  owned by tgfx for that route. Pinning in groups needs `can_pin_messages`; in
  channels it needs `can_edit_messages`, although broadcast channels remain
  outside v1.
- Forum-topic changes require `can_manage_topics` unless Telegram permits the
  bot to manage a topic it created. A topic can disappear or be closed by another
  administrator between approval and execution.
- Message deletion remains subject to Telegram's age, message-type, and
  administrator-right rules. A missing message is treated as already absent, but
  tgfx does not infer a generic deletion event because standard bots do not
  receive one.
- Join-request updates are accepted only when that group enables the
  `join_requests` profile and the bot has `can_invite_users`. Pending requests
  expire locally; a late approval result cannot act on a different request.

### Telegram message shape

- `sender_chat` represents anonymous admins and chat-as-sender. It must not be
  mistaken for the compatibility `from` user.
- `message_thread_id` can occur in group topics and private topic mode. Routing
  always includes it.
- Albums arrive as separate updates with a shared `media_group_id`; Telegram does
  not send an explicit “album complete” event. tgfx uses a short bounded
  collection window and can still deliver a partial album if updates are delayed.
- An edit before processing replaces the queued recovery payload. An edit during
  or after a turn becomes a new `message.edited` turn; it does not rewrite FX
  history silently.
- Standard bots receive new and edited messages, but no generic deletion update
  for ordinary private/group messages. `deleted_business_messages` is a business
  exception and is outside v1.
- A group can migrate to a supergroup and receive a new chat ID. tgfx moves the
  route atomically, preserving its session generation and preventing two routes
  from processing the same conversation.
- Unsupported service messages are acknowledged and logged at a summary level,
  not injected into FX as if they were user prompts.
- Choice callbacks and poll changes are independent Telegram updates. They are
  deduplicated and authorized like messages, then carry their opaque interaction
  reference into a new FX turn. A tool call never blocks waiting for a person to
  click or vote.
- Reaction changes and member-status updates are excluded from Telegram's
  default update set and may require administrator rights plus explicit
  `allowed_updates`. V1 can set a reaction and perform moderation, but does not
  turn every ambient reaction/member change into an autonomous FX prompt.

### Command projection

- Telegram command menus persist remotely and can be stale while tgfx is
  offline. Every received command is re-authorized and checked against the
  route's live ACP snapshot before dispatch.
- Telegram command scopes do not include forum topics. All topics in one group
  therefore share the group-level discovery menu even though tgfx keeps their FX
  sessions separate. A command missing from a particular topic session is
  rejected when invoked there.
- Telegram clients can send `/name@bot_username`; tgfx accepts only its own bot
  suffix and ignores commands addressed to another bot.
- The Bot API caps a menu at 100 entries and restricts names to 32 lowercase
  English letters, digits, or underscores. tgfx never rewrites an ACP command
  into a different spelling because that could change what FX executes.
- A catalog update can arrive while a command is queued. The command is checked
  again immediately before `session/prompt`; removal wins and produces a visible
  “no longer available” result.
- Telegram `setMyCommands` failure does not stop agent messages. tgfx keeps
  accepting exact authorized commands from the current ACP snapshot, retries
  menu reconciliation, and reports the degraded discovery state locally.
- The process-level `tgfx --model` override pins FX. Session-level `/model`
  discovery is hidden for that run rather than promising an ineffective change.

### FX and concurrency

- A bot is never polled by two local tgfx processes. Another machine cannot share
  the local lock, so a Telegram competing-poller error is treated as a fatal,
  explained ownership conflict.
- One ACP connection has one active session and one active prompt. tgfx either
  switches sessions safely or uses separate FX processes when concurrent routes
  require it; it never multiplexes two prompts onto one active ACP session.
- A crash ends an in-flight process. The inbox row survives, but tgfx does not
  automatically repeat a turn whose FX acceptance is uncertain. Telegram MCP
  calls use the effect ledger and the retry class defined in the reliability
  contract; external services may still need their own idempotency support.
- Cancellation is best effort across Telegram, tgfx, ACP, FX tools, and MCP.
  The UI reports when work could not be stopped immediately.
- If an FX session cannot be resumed, tgfx creates a new generation and tells
  the user that conversational context was reset.
- ACP input is limited to 8 MiB. The envelope is bounded, reply excerpts are
  truncated safely, and large files are references rather than inline data.

## Findings that shape this design

The current official FX behavior matters in several places:

- The current installed and stable release checked for this RFC is `fx 0.0.6`.
  tgfx still probes ACP and MCP capabilities at startup instead of treating a
  version string as proof that every required feature is usable.
- `fx acp` is launched in the primary workspace and exposes ACP protocol version
  1, saved sessions, prompt cancellation, model/mode configuration, streamed tool
  status, and permission requests.
- FX exposes `ask` and `code` through ACP's dedicated `modes` state. tgfx always
  selects `code` with `session/set_mode` after creating or loading a session,
  making FX automatic review the deterministic default even when FX reports a
  stale display mode. ACP has no `yolo` mode, so `tgfx --yolo` uses FX's
  documented process override, `FX_PERMISSION_MODE=yolo`, and deliberately does
  not replace it with an ACP mode selection.
- `fx acp` accepts `--model <id>` and `--log-file <path>` after the `acp`
  subcommand. tgfx exposes only the model override in its normal product CLI and
  passes it as `fx acp --model <id>`; ACP diagnostics remain an implementation
  detail unless doctor/debugging needs an explicit log file.
- New and loaded FX ACP sessions advertise their slash-command surface through
  `available_commands_update`. tgfx treats each notification as a full dynamic
  snapshot, projects Telegram-compatible entries into a chat-scoped bot command
  menu, and invokes an advertised command as a single text block in
  `session/prompt`.
- ACP prompts accept text and embedded resources but not image or audio blocks.
- ACP-supplied MCP servers are authoritative for that session and can use stdio,
  HTTP, or legacy SSE transports.
- The shipped stdio server and protocol test negotiate modern MCP
  `2025-11-25`. MCP list-change notifications and subscriptions concern catalog
  or resource changes, not arbitrary external events such as new Telegram
  messages.
- Telegram Bot API 10.2 Rich Messages provide structured headings, lists, code,
  tables, details, media, formulas, and a draft-only thinking block. A rich draft
  is a private-chat, 30-second preview and must be finalized with
  `sendRichMessage`; Bot API 10.2 also allows an input rich message to identify
  media used by Markdown, HTML, or block formatting.
- Telegram group administration is granular. Pins, deletion, forum topics,
  restrictions, join requests, invite links, chat metadata, and default
  permissions each have separate methods and administrator rights. This supports
  capability-filtered tools better than one generic `telegram.request` method.
- Telegram pins are plural, callbacks and poll changes arrive as later updates,
  and standard bots receive no generic ordinary-message deletion event. Those
  facts require managed resources and event turns rather than a synchronous
  chat-RPC mental model.
- Hermes Agent demonstrates a useful separation between fail-closed numeric
  user/chat allowlists and a designated home channel for system delivery. tgfx
  adopts that small core as a mandatory allowlist plus one approvals chat, without
  adopting pairing codes, role tiers, guest access, or chat-driven permanent
  approval rules.

These are checked platform capabilities, but tgfx still needs fallbacks because
users can run older FX builds, older Telegram libraries, or clients with uneven
rendering support.

## Open research and later work

These are post-v0.1 hardening or expansion questions, not hidden dependencies of
the current private-chat bridge:

- resource bounds and eviction when many active routes each own an FX ACP
  process;
- FX session resume behavior after abrupt termination, including MCP capability
  restoration and permission state;
- behavior of every FX `available_commands_update` entry when invoked over ACP,
  especially terminal-oriented commands that may complete without renderable
  output, and whether any need a documented compatibility filter;
- approval-card usability, callback expiry, and concurrent permission requests
  across Telegram clients;
- Rich Message behavior across current Telegram mobile, desktop, and web clients,
  including long-message splitting and media blocks;
- whether Telegram's new group ephemeral messages are reliable enough for an
  opt-in group streaming preview;
- album collection timing under delayed and out-of-order updates;
- live Telegram permission drift edge cases, protected members, and approval
  policy;
- managed-pin recovery after each possible failure between create, edit, and pin,
  especially the irreducible unknown-create window;
- whether retained `message_ref` values survive realistic long FX sessions and
  context compaction, or justify a bounded `list_recent_messages` read tool;
- callback and poll event UX when the originating FX session is busy, reset, or
  no longer resumable;
- safe transcription as a separate MCP capability for voice/audio;
- native ACP image/audio support if FX adds it; a future policy could inline at
  most three resized images while preserving attachment references for download
  and editing;
- possible mitigations for the unavoidable final-send/SQLite-commit duplicate
  window, without changing v1's documented at-least-once behavior;
- local Bot API support for files larger than 20 MB;
- data-retention defaults, secure cleanup after crashes, and an explicit redacted
  debug bundle;
- ambient reaction/member events, locations, contacts, stickers, business chats,
  communities, guest mode, broadcast channels, invite links, and group-profile
  management as separate scoped features rather than accidental generic support.

## V0.1 acceptance checklist

The implementation and automated protocol tests cover this contract. The live
regression uses the configured private bot; group/topic/admin behavior is also
guarded by catalog, routing, state, and rights checks and should be repeated in a
real administrator group before a public release.

From a clean machine and a real repository, a user can:

1. install FX and tgfx, run `tgfx`, enter a bot token, configure at least one
   allowed user/chat ID and an approvals chat without editing a config file, and
   optionally start with `tgfx --model <id>` and observe that exact model in the
   spawned FX ACP process;
2. send text, a reply, an edit, a photo, a document, or a voice message and see an
   accurate context envelope reach the correct FX session;
3. receive a responsive private rich draft or one final group response, with
   correct markup and optional tool collapsing;
4. discover the route's live ACP command catalog in Telegram, invoke an
   advertised command such as `/compact`, and never forward an unknown,
   unauthorized, stale, or namespace-colliding slash command as a model prompt;
5. cancel a turn and queue another message without corrupting the route;
6. restart tgfx at every documented reliability boundary without losing a
   locally accepted update, silently replaying an uncertain FX turn, or violating
   the retry class of an outgoing effect; the final-send duplicate window remains
   visible and documented;
7. rotate the same bot token, switch bots, or allow a new group without mixing
   polling cursors or FX sessions;
8. use scoped attachment, file, choice, poll, reply, and reaction tools; react to
   a referenced message from an earlier turn without supplying a raw Telegram
   target ID or escaping the current route;
9. promote the bot with selected rights in one allowed group, verify those rights
   with `tgfx doctor`, maintain the group's tgfx-owned pinned bulletin, manage a
   topic, and complete an approved moderation action without exposing a generic
   Bot API proxy or disturbing unrelated pins;
10. understand failures from Telegram, FX, permissions, files, and recovery through
   concise terminal and chat messages;
11. verify that no bot token, Telegram file URL, permanent message archive, or raw
   ACP transcript was written to the project by default.

## References

- [FX repository and product direction](https://github.com/vercel-labs/fx)
- [FX contribution principles](https://github.com/vercel-labs/fx/blob/main/CONTRIBUTING.md)
- [FX embedding interfaces](https://fx.sh/docs/lib)
- [FX ACP server](https://fx.sh/docs/using-fx/acp)
- [FX v0.0.5 ACP command projection](https://github.com/vercel-labs/fx/blob/v0.0.5/src/acp/sessions.zig#L1005-L1054)
- [FX MCP protocol](https://fx.sh/docs/capabilities/mcp/protocol)
- [Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram bot commands and scopes](https://core.telegram.org/bots/api#setmycommands)
- [Telegram Rich Messages](https://core.telegram.org/bots/api#sendrichmessagedraft)
- [Telegram pinning](https://core.telegram.org/bots/api#pinchatmessage)
- [Telegram forum topics](https://core.telegram.org/bots/api#createforumtopic)
- [Telegram moderation and deletion](https://core.telegram.org/bots/api#deletemessage)
- [Telegram join requests](https://core.telegram.org/bots/api#approvechatjoinrequest)
- [Bun child processes](https://bun.sh/docs/runtime/child-process)
- [Bun secrets](https://bun.sh/docs/runtime/secrets)
- [grammY](https://grammy.dev/)
- [Clack](https://github.com/bombshell-dev/clack)
- [Citty](https://github.com/unjs/citty)
- [Hermes Agent Telegram gateway](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/messaging/telegram.md)
- [Hermes Agent security model](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/security.md)
