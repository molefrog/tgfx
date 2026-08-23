# 𝒕𝒈(𝒇x) specification

> Status: draft RFC, 23 August 2026. This describes the intended first release.
> The existing proof of concept will be rewritten and is not the product contract.

𝒕𝒈(𝒇x), typed as `tgfx`, is a small local program that lets a Telegram chat talk
to a [𝒇x](https://github.com/vercel-labs/fx) agent running in a project directory.
It starts `fx acp`, gives the agent a carefully described Telegram message, and
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
| npm package | `tgfx` (private/local; the public unscoped name is already owned) |
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
   and remain inside the authorized route. Group-administrator actions require
   an additional, explicit capability profile.
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
2. On the first run, tgfx asks for the bot token in a hidden prompt, validates it
   with Telegram, and stores it in the operating system credential store under
   the bot's numeric ID.
3. The user chooses at least one allowed Telegram user or chat and one control
   chat for approvals. No wildcard access exists in v1. If the bot is an
   administrator of an allowed group, the user may separately enable a small set
   of group-administration capabilities for that group.
4. tgfx writes non-secret workspace settings to `.tgfx/config.json`, opens the
   operational journal at `.tgfx/state.sqlite`, acquires the machine-wide lock
   for that bot, and starts `fx acp` in the current directory.
5. The terminal becomes a small append-only status view and waits. The same bot
   cannot be active in another local workspace until this process stops.
6. An allowed person sends the bot a message. An ordinary private message starts
   a turn; a group message must use `/fx`, mention the bot, or reply to it.
   Everything outside the allowlist is silently discarded.
7. Before acknowledging the update locally, tgfx stores it and advances the
   Telegram polling cursor in one SQLite transaction. It then queues the message
   FIFO for its `{bot_id, chat_id, topic_id}` route.
8. tgfx creates or resumes that route's FX session. The prompt contains a
   host-generated `telegram_message` JSON block followed by the person's original
   text or caption unchanged.
9. Attachments and observed Telegram objects enter the prompt as scoped
   references. If the agent needs attachment bytes, it calls
   `telegram.download_attachment`; tgfx validates and downloads
   the file into `.tgfx/files/` without revealing the bot token or a reusable file
   URL.
10. 𝒇x works with its normal tools and may use the small scoped Telegram MCP
    action plane. It can reply explicitly, send a file, present choices or a
    poll, and react to the current or an earlier referenced message. In an
    admin-enabled group it sees only the configured admin tools for which the
    bot still has Telegram permission.
11. A sensitive FX permission request or destructive Telegram administration
    request appears as a single-use approval card in the control chat; the
    originating chat shows that work is waiting.
12. With default settings, a private chat sees a live rich draft containing prose
    and current tool progress. A group, or any chat using `--no-streaming`, waits
    for one permanent rich response. `--collapse-tools` replaces completed tool
    activity with a compact duration summary.
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

The intended distribution is a Bun package and, later, a standalone executable.
The exact package name is not published yet. The planned setup is:

```bash
# Install and authenticate FX first.
fx login

# Planned only after the existing npm name is secured or transferred.
# Do not use this command for the current unrelated package.
bun add --global tgfx

cd my-project
tgfx
```

tgfx checks that Bun and FX are available, that FX is authenticated, and that
the current directory is usable. It launches a separate `fx acp` process for this
workspace, as required by FX's ACP model.

`tgfx` is always a workspace command. It does not start as a global daemon and
does not ask the user to choose a project after launch. The canonical current
directory is the workspace for the lifetime of the process.

### First run

If the selected bot has no token, tgfx asks for it in a hidden prompt:

```text
tgfx  /Users/me/code/my-project

◇ Telegram bot token
│ •••••••••••••••••••••••••••••••••••••••
│
◆ Connected to @my_fx_bot (123456789)
◆ Saved token in the system credential store
◇ Allowed user IDs
│ 6143594
◇ Allowed group/chat IDs
│ -1002255001
◇ Control chat for approvals
│ 6143594
◆ Access configured · 1 user, 1 chat
◆ FX is ready
◆ State database is ready

Waiting for Telegram messages…
```

The token is validated with Telegram's `getMe` before it is saved. The terminal
shows the bot identity and asks before replacing a different configured bot. The
confirmed bot ID is written to this workspace's `.tgfx/config.json`.

After resolving the bot ID, tgfx acquires a machine-wide process lock for that
bot before it begins polling. A lock is global to the user account, not stored in
the workspace, so another folder can see that the bot is already running.

Onboarding cannot finish without at least one allowed user ID or chat ID. It also
requires one control chat for permission approvals and critical recovery notices.
The control target may be a private chat, group, or topic, and must be reachable
by the bot. Setup sends a harmless test message before saving it.

V1 has no owner, admin, or regular-user roles. Every allowed principal is equally
trusted. Allowing a user ID authorizes that sender in private chats and groups.
Allowing a group/supergroup chat ID authorizes every sender in that chat,
including anonymous chat-as-sender messages. Onboarding states that consequence
explicitly before accepting a chat-wide rule.

```text
authorized = sender.user_id in allowedUserIds
          OR chat.id        in allowedChatIds
```

User IDs are used for people; chat IDs are used for groups and supergroups. Both
lists contain decimal strings, and no username or display name grants access.

In a non-interactive terminal, tgfx never waits for a hidden prompt. It uses
`TELEGRAM_BOT_TOKEN` if present or exits with a useful setup message.

### Normal run

Running `tgfx` again selects the known bot and workspace configuration:

```text
tgfx  /Users/me/code/my-project

✓ FX ready
✓ Telegram @my_fx_bot
✓ Access · 1 user, 1 chat
✓ Control chat · private 6143594
● Listening

12:41:03  @maria · private           received 841234
12:41:03  @maria · private           FX turn started
12:41:11  @maria · private           delivered · 8.2s
```

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

The process-held lock is keyed by Telegram `getMe.id` and records diagnostic
metadata such as the canonical workspace path, PID, and start time. A normal
shutdown releases it. An OS-backed lock is released when the process dies; stale
diagnostic metadata is never treated by itself as proof that a process is alive.

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
streaming mode, the user first sees a rich draft that grows as FX responds. A
running tool appears as a temporary thinking/tool line. When the turn finishes,
the draft becomes a permanent rich message. With `--no-streaming`, the user sees
only that final message.

In a group, tgfx reacts only to an explicit `/fx` command, a reply to the bot,
or a configured mention. It does not read normal group conversation as agent
requests. Groups receive one final response in v1; live group previews are left
for later because their delivery and visibility rules are different.

An allowed group can additionally use **admin mode**. This does not make normal
conversation autonomous: the same `/fx`, mention, or reply trigger still starts
a turn. It only gives that route a configured set of administrator actions, such
as maintaining one bot-owned pinned bulletin, managing forum topics, deleting
spam, moderating members, or reviewing join requests. Merely promoting the bot
to administrator in Telegram does not enable these actions in tgfx.

If a route already has an active turn, later messages wait in arrival order. The
user can send `/cancel` to cancel the active FX prompt. V1 runs one prompt at a
time for each bot/chat/topic route.

The Telegram command surface is also small:

| Command | Purpose |
| --- | --- |
| `/fx <prompt>` | Start a turn explicitly; required in groups unless the bot is mentioned or replied to. |
| `/cancel` | Cancel the active turn for this route. |
| `/new` | Start a fresh FX session generation for this route. |
| `/retry` | Explicitly start a new attempt for an interrupted turn after warning that earlier side effects may already exist. |
| `/discard` | Resolve an interrupted turn without running it again. |

FX slash commands are not blindly forwarded in v1. tgfx commands, Telegram
commands, and FX session configuration are different namespaces and should not
accidentally invoke one another.

## Small command and configuration surface

The intended commands are deliberately limited:

| Command | Purpose |
| --- | --- |
| `tgfx` | Start in the current directory; onboard if needed. |
| `tgfx auth` | Add, rotate, or select a Telegram bot token. |
| `tgfx access` | Show, add, or remove allowed user/chat IDs and select the control chat. |
| `tgfx admin` | Configure the admin capability profile for one allowed group and verify the bot's current rights. |
| `tgfx routes` | Show Telegram scopes with active or saved FX sessions. |
| `tgfx doctor` | Check FX, Telegram, secrets, SQLite, and workspace access. |

The main renderer flags are:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--streaming` / `--no-streaming` | streaming | Stream a private draft, or wait for one final response. Groups remain final-only in v1. |
| `--collapse-tools` / `--show-tools` | collapse | Replace finished tool activity with `Worked for 1m`, or keep the visible tool timeline. In non-streaming mode tools are omitted from the final message. |
| `--json` | off | Emit terminal events as JSON Lines. |
| `--no-color` | off | Disable terminal color. |

Stable defaults may be written to `.tgfx/config.json`. Command-line flags win
for the current run. Environment variables are reserved for secrets and
automation, not for a second large configuration system.

```json
{
  "version": 1,
  "activeBotId": "123456789",
  "access": {
    "allowedUserIds": ["6143594"],
    "allowedChatIds": ["-1002255001"]
  },
  "controlChat": {
    "chatId": "6143594",
    "topicId": "0"
  },
  "renderer": {
    "streaming": true,
    "collapseTools": true
  },
  "admin": {
    "chats": [
      {
        "chatId": "-1002255001",
        "capabilities": [
          "pin",
          "topics",
          "delete",
          "moderation",
          "join_requests"
        ],
        "approvals": "destructive"
      }
    ]
  }
}
```

The token does not belong in this file. Allowlist and control-target IDs do: they
are explicit workspace configuration, not model context or transient delivery
state. SQLite continues to own route sessions and recovery state.

## Scope of the first release

V1 includes:

- Bun and TypeScript, running as a local CLI;
- long polling of one selected Telegram bot;
- private chats, groups, supergroups, and their topics;
- mandatory fail-closed user/chat allowlisting and one control chat;
- one FX session per bot/chat/topic route;
- text, captions, replies, edits, and attachment references;
- a scoped Telegram MCP action plane for replies, files, reactions, choices,
  polls, and attachment downloads;
- opt-in group-admin profiles for managed pins, topics, deletion, moderation,
  and join requests;
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
   context envelope through `session/prompt`.
7. FX streams assistant text, tool status, and permission requests over ACP. An
   explicit Telegram MCP action is validated against the context ref, route
   capability profile, live bot permissions, approval policy, and effect ledger
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
FX-owned. tgfx may display the selected model, but it does not keep its own
copy of FX's changing model or tool catalogs.

Changing credentials is predictable:

- rotating a token for the same `getMe.id` keeps the route, polling, and FX
  session state;
- selecting a token for a different bot creates a new bot namespace and a fresh
  polling cursor; old routes remain dormant until that bot is selected again;
- an authorized message in a new chat or topic creates a new route and FX
  session;
- history is never copied between chats automatically.

Configuring the same bot in a second folder does not copy its allowlist, routes,
control chat, or FX history.
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
      "kind": "reply_current"
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
      "kind": "reply_current"
    }
  }
}
```

There is no second block when a media-only message has no caption. The agent can
call `telegram.download_attachment` if the file is needed. Current FX ACP does
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
      "kind": "reply_current"
    }
  }
}
```

Downloading does not imply transcription. A transcription tool can be added
later as a separate, explicit capability.

### Optional facets

The envelope adds fields only when Telegram supplied them:

- `reply`: opaque `message_ref`, sender reference and summary, Telegram message
  ID, and a bounded text excerpt;
- `edited_at` with `event: "message.edited"`;
- `media_group_id` and the attachment's position in a collected album;
- `forwarded_from` and `via_bot` provenance without trusting either as the actor;
- document `name`, MIME type, and size;
- sticker, animation, video, video-note, contact, location, poll, or other typed
  metadata that can be represented without copying a large payload.
- `admin_context`: a bounded snapshot of enabled capabilities, currently granted
  bot rights, and pending join-request refs when admin mode is enabled. It is
  attached only to an explicitly triggered group turn; an ambient join request
  does not wake FX by itself.

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

A button click created by `telegram.request_choice` has metadata but no invented
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
      "kind": "reply_current"
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
| `telegram.reply_current` | `context_ref`, `content`, optional `quote` | Sends an additional explicit reply in the current route. `content` is sanitized Markdown or structured rich content. Ordinary agent output does not call this. |
| `telegram.set_reaction` | `context_ref`, `target`, `emoji`, optional `big` | Sets the bot's reaction on the current or a previously referenced message. `target` is `{kind:"current"}` or `{kind:"message", message_ref}`; `emoji: null` removes the bot's reaction. |
| `telegram.download_attachment` | `context_ref`, `attachment_ref` | Validates size and MIME, downloads into `.tgfx/files/<context_ref>/`, and returns a local path, size, MIME, and hash. The caller cannot choose a destination. |
| `telegram.send_file` | `context_ref`, workspace-local `path`, optional `caption` | Sends a generated or modified file to the current route after path, MIME, size, and permission checks. It cannot target another chat. |
| `telegram.request_choice` | `context_ref`, `prompt`, bounded `options`, optional expiry | Sends inline buttons and returns `interaction_ref` and `message_ref`. A click is a later Telegram event and a new FX turn; the tool call does not wait for the human. |
| `telegram.create_poll` | `context_ref`, `question`, bounded `options`, optional anonymity and multiple-choice settings | Sends a Telegram poll and returns `poll_ref` and `message_ref`. Votes and closure are later events, not a synchronous tool result. |

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

### Opt-in group administrator profile

Administrator mode is configured per allowed group. It is a capability profile,
not a user role and not an automatic consequence of making the bot a Telegram
administrator. An admin tool is published only when all of these are true:

1. the group is allowlisted in the current workspace;
2. that capability is enabled for that exact chat;
3. Telegram currently reports the required bot administrator right;
4. the call's context and target refs resolve inside the same group and topic;
5. any required single-use approval succeeds.

The intended v1 admin methods are:

| Tool | Important input | Behavior |
| --- | --- | --- |
| `telegram.admin.set_pinned_message` | `context_ref`, `scope`, `content`, optional `notify` | Creates or updates one tgfx-owned bulletin for the current chat/topic and ensures it is pinned. It never unpins unrelated messages. |
| `telegram.admin.pin_message` | `context_ref`, `message_ref`, optional `notify` | Adds an observed message to the chat's pinned messages. |
| `telegram.admin.unpin_message` | `context_ref`, `message_ref` | Unpins exactly one referenced message; there is no `unpin_all` tool. |
| `telegram.admin.manage_topic` | `context_ref`, `action`, optional `topic_ref`, `name`, or icon | Creates, renames, closes, or reopens a forum topic when `can_manage_topics` permits it. Creating a topic is non-idempotent. |
| `telegram.admin.delete_messages` | `context_ref`, bounded `message_refs` | Deletes only observed messages in the current group, subject to Telegram's rights and deletion rules. |
| `telegram.admin.moderate_member` | `context_ref`, `member_ref`, `action`, optional `until` | Mutes, restricts, unmutes, bans, or unbans an observed member. The bot, control operators, and configured protected members cannot be targeted. |
| `telegram.admin.review_join_request` | `context_ref`, `request_ref`, `decision` | Approves or declines one observed pending join request when the bot has `can_invite_users`. |

`set_pinned_message` is intentionally higher level than the Bot API. Telegram
allows several pinned messages, so tgfx stores one managed pin per route, edits
that bot-owned message in place, and reconciles the create/edit/pin sequence after
an interruption. It does not redefine “the pinned message” or disturb pins owned
by people and other bots.

Pins and reactions are normally allowed without another prompt after the admin
profile is enabled. Deletion, moderation, and declining a join request require a
single-use approval by default. Topic creation is also approved because a crash
after creation cannot be retried safely. The profile may require approval for
more actions but cannot disable approval for the destructive v1 set.

Temporary invite links, chat title/description/photo changes, default member
permissions, reaction cleanup, sender-chat bans, and ownership-like operations
are deliberately deferred. If added, they belong to a stricter manager profile.
Invite URLs are secrets, and changing default permissions affects the entire
group; neither should arrive through a generic Bot API escape hatch.

### Protocol boundary

tgfx passes this local stdio MCP server in ACP `session/new`. FX treats the
ACP client's `mcpServers` list as authoritative, which means tgfx does not
silently inherit unrelated servers from the user's global FX profile.

The MCP server negotiates the latest modern stdio protocol supported by the
installed FX build; the current tested pair uses MCP `2026-07-28`. Modern catalog
change delivery and `subscriptions/listen` carry tool, prompt, and resource
change notifications. They are not a Telegram event inbox and do not create an
ACP user turn. The tgfx host remains responsible for polling Telegram and
deciding when an allowed message, explicit interaction result, or bounded admin
context becomes an ACP turn.

This is nevertheless useful for admin mode: when the workspace profile changes
or tgfx observes that Telegram granted or revoked a bot right, the MCP server can
publish `notifications/tools/list_changed` through the modern subscription. FX
then refreshes the visible admin catalog. The execution-time permission check
remains authoritative in case rights change between refresh and tool call.

## Rendering FX in Telegram

### Rich messages first

The primary renderer maps the ACP timeline to Telegram Rich Messages:

- assistant prose becomes headings, paragraphs, lists, quotes, code, tables, and
  other structured blocks;
- a currently running tool can become a draft-only `tg-thinking` block;
- completed tool activity can become a collapsible details block;
- the final call uses `sendRichMessage`;
- private streaming uses `sendRichMessageDraft` with one stable `draft_id`.

Drafts cannot directly upload a new file. Generated or modified media is sent at
the final step, or as a separate validated `telegram.send_file` action. Streaming
continues with text and tool blocks while that media is being prepared.

The draft API receives the complete current frame, not an append-only token. This
is why tgfx can show two paragraphs, replace a line such as `λ Searching…`
several times, remove it, and then add the final marked-up paragraph.

Telegram is not updated for every model token. The scheduler keeps the newest
frame, coalesces bursts into responsive updates, refreshes before the 30-second
draft expires, and honors `retry_after` on HTTP 429. ACP continues to be consumed
while Telegram is throttled, so a slow network does not block FX.

If rich messages are unavailable or a block cannot be represented, the renderer
falls back to ordinary messages with explicit Telegram entities. It does not send
unfinished Markdown delimiters through a parse mode. Long output is split at
semantic block boundaries; it is never silently truncated.

### Renderer modes

| Streaming | Collapse tools | Private chat | Group/topic |
| --- | --- | --- | --- |
| on | on | Live prose and current tool; completed tools become `Worked for 1m`; the final keeps that compact summary. | Wait, then one final answer without tool activity. |
| on | off | Live prose plus the visible tool timeline; the final retains the timeline. | Wait, then one final answer without tool activity. |
| off | either | Wait, then one final answer without tool activity. | Same. |

Tool arguments are shown only when ACP actually supplies them. Our probes found
that many built-in FX read/search tool updates provide an ID, title, kind, state,
and sometimes a result preview, but not exact raw arguments. Permission requests
may contain structured input. The renderer must not reconstruct or hallucinate
missing arguments.

For the same reason, tgfx does not hard-code a list of FX built-in tools. The
projector consumes the generic ACP tool lifecycle, so a newer FX can add or remove
tools without requiring a new Telegram adapter release.

## Storage and privacy

tgfx uses a few small storage locations:

| Location | Contents | Lifetime |
| --- | --- | --- |
| OS credential store through `Bun.secrets` | Telegram bot token, keyed by actual bot ID | Until the user removes or rotates it. Bun uses macOS Keychain, Linux Secret Service/libsecret, or Windows Credential Manager. |
| `~/.config/tgfx/bots.json` | Non-secret index of known bot IDs and usernames | Until removed. Needed because credential stores do not provide a portable enumeration API. |
| `<user-state>/tgfx/locks/<bot_id>.lock` | Machine-wide process lock plus diagnostic workspace/PID metadata | Held while that bot is active; safely reclaimable after process death. |
| `<workspace>/.tgfx/config.json` | Active bot ID and non-secret renderer/route defaults | Project-local. |
| `<workspace>/.tgfx/state.sqlite` | Poll cursor, used routes, FX session references, and temporary inbox/outbox/effect/approval recovery rows | Operational; completed payloads expire. |
| `<workspace>/.tgfx/files/` | Attachments explicitly downloaded for the agent | Temporary; cleaned by age and route completion. |

`.tgfx/` is private runtime state and must be gitignored. FX authentication,
settings, project instructions, permissions, and saved agent sessions remain in
FX's own storage. tgfx does not copy them.

The token lookup order is:

1. `TELEGRAM_BOT_TOKEN` for the current process;
2. the OS credential store for the configured bot ID;
3. an interactive hidden prompt.

An environment token is validated with `getMe` and uses the state namespace for
that returned bot ID. It is not copied into the credential store without an
explicit interactive confirmation.

If a configured secret is missing, tgfx asks for it again. If the OS credential
store is unavailable, an environment variable is accepted; the token is never
silently written as plaintext. Logs redact bot tokens, file URLs, context
capabilities, and message payloads by default.

The credential key is stable and inspectable in code: `service = "dev.tgfx"`
and `name = "telegram:<bot_id>"`. Token rotation for the same bot overwrites that
one secret. The global non-secret bot index lets onboarding find the bot ID again
without requiring credential-store enumeration.

### What SQLite is for

SQLite answers two questions after a crash:

1. Which Telegram update should be read next?
2. Which accepted work or outgoing delivery is not finished yet?

It is not the FX conversation history and not a permanent Telegram message log.
An accepted message is kept only until its turn and response are safely handled,
because advancing Telegram's polling cursor acknowledges that update. Without a
short-lived local copy, a crash between acknowledgement and processing could lose
the message forever.

The database uses WAL mode and transactions. Completed recovery payloads have a
short retention period and are then deleted. Attachments stay outside SQLite.
V1 does not write raw ACP JSONL. A future explicit debug bundle may capture a
bounded, redacted trace, but it is not part of normal operation.

### Database schema

All Telegram identity values are stored as decimal text. `topic_id` is always
present and uses `"0"` outside a topic, avoiding SQLite's special `NULL` behavior
inside unique constraints.

```text
bot_accounts
  bot_id TEXT PRIMARY KEY                 -- Telegram getMe.id
  username TEXT
  display_name TEXT
  first_seen_at TEXT
  last_seen_at TEXT
  -- token is never stored here

telegram_poll_state
  bot_id TEXT PRIMARY KEY REFERENCES bot_accounts
  next_update_id INTEGER NOT NULL
  updated_at TEXT NOT NULL

routes
  route_id TEXT PRIMARY KEY
  bot_id TEXT NOT NULL REFERENCES bot_accounts
  chat_id TEXT NOT NULL
  topic_id TEXT NOT NULL DEFAULT '0'
  chat_kind TEXT NOT NULL
  enabled INTEGER NOT NULL
  workspace_path TEXT NOT NULL
  agent_profile TEXT
  session_generation INTEGER NOT NULL DEFAULT 1
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL
  UNIQUE (bot_id, chat_id, topic_id)

scope_state
  route_id TEXT PRIMARY KEY REFERENCES routes
  fx_session_id TEXT
  active_turn_id TEXT
  generation INTEGER NOT NULL
  updated_at TEXT NOT NULL

telegram_principals
  principal_ref TEXT PRIMARY KEY          -- member_... capability
  route_id TEXT NOT NULL REFERENCES routes
  kind TEXT NOT NULL                      -- user/sender_chat
  telegram_id TEXT NOT NULL
  first_seen_at TEXT NOT NULL
  last_seen_at TEXT NOT NULL
  UNIQUE (route_id, kind, telegram_id)

telegram_messages
  message_ref TEXT PRIMARY KEY            -- msg_... capability
  route_id TEXT NOT NULL REFERENCES routes
  telegram_message_id TEXT NOT NULL
  sender_ref TEXT REFERENCES telegram_principals
  direction TEXT NOT NULL                 -- incoming/outgoing
  owned_by_bot INTEGER NOT NULL
  first_seen_at TEXT NOT NULL
  last_seen_at TEXT NOT NULL
  UNIQUE (route_id, telegram_message_id)

telegram_inbox
  bot_id TEXT NOT NULL REFERENCES bot_accounts
  update_id INTEGER NOT NULL
  route_id TEXT REFERENCES routes
  event_kind TEXT NOT NULL              -- message.created/message.edited
  message_id TEXT
  message_ref TEXT REFERENCES telegram_messages
  supersedes_update_id INTEGER
  status TEXT NOT NULL                 -- received/dispatching/running/complete/
                                       -- interrupted/canceled/failed
  recovery_payload TEXT NOT NULL       -- normalized envelope + user content
  received_at TEXT NOT NULL
  completed_at TEXT
  PRIMARY KEY (bot_id, update_id)
  INDEX (route_id, message_id, status)

telegram_outbox
  delivery_id TEXT PRIMARY KEY
  bot_id TEXT NOT NULL REFERENCES bot_accounts
  route_id TEXT NOT NULL REFERENCES routes
  source_update_id INTEGER
  method TEXT NOT NULL
  payload TEXT NOT NULL
  retry_class TEXT NOT NULL            -- at_least_once/idempotent/manual_if_unknown
  status TEXT NOT NULL                 -- pending/sending/sent/unknown/failed
  attempts INTEGER NOT NULL DEFAULT 0
  next_attempt_at TEXT
  telegram_message_id TEXT
  message_ref TEXT REFERENCES telegram_messages
  created_at TEXT NOT NULL
  completed_at TEXT

telegram_interactions
  interaction_ref TEXT PRIMARY KEY        -- interaction_..., poll_..., request_...
  route_id TEXT NOT NULL REFERENCES routes
  kind TEXT NOT NULL                      -- choice/poll/join_request
  message_ref TEXT REFERENCES telegram_messages
  external_id TEXT
  status TEXT NOT NULL                    -- pending/answered/closed/expired
  recovery_payload TEXT NOT NULL          -- bounded options and validation state
  expires_at TEXT
  created_at TEXT NOT NULL
  completed_at TEXT

managed_pins
  route_id TEXT PRIMARY KEY REFERENCES routes
  message_ref TEXT NOT NULL REFERENCES telegram_messages
  desired_content_hash TEXT NOT NULL
  status TEXT NOT NULL                    -- creating/editing/pinning/ready/unknown
  updated_at TEXT NOT NULL

effect_ledger
  effect_id TEXT PRIMARY KEY
  bot_id TEXT NOT NULL REFERENCES bot_accounts
  route_id TEXT NOT NULL REFERENCES routes
  source_update_id INTEGER
  tool_call_id TEXT NOT NULL
  kind TEXT NOT NULL
  request_hash TEXT NOT NULL
  retry_class TEXT NOT NULL            -- idempotent/non_idempotent
  status TEXT NOT NULL                 -- pending/running/succeeded/unknown/failed
  result_payload TEXT
  created_at TEXT NOT NULL
  completed_at TEXT
  UNIQUE (route_id, tool_call_id, request_hash)

approval_requests
  approval_id TEXT PRIMARY KEY
  bot_id TEXT NOT NULL REFERENCES bot_accounts
  route_id TEXT NOT NULL REFERENCES routes
  source_update_id INTEGER
  tool_call_id TEXT NOT NULL
  input_hash TEXT NOT NULL
  control_chat_id TEXT NOT NULL
  control_topic_id TEXT NOT NULL DEFAULT '0'
  status TEXT NOT NULL                 -- pending/approved/denied/expired/canceled
  expires_at TEXT NOT NULL
  decided_by_user_id TEXT
  decided_at TEXT
```

Relationships:

```text
bot_accounts 1 ── 1 telegram_poll_state
bot_accounts 1 ── N routes
routes       1 ── 1 scope_state
routes       1 ── N telegram_principals
routes       1 ── N telegram_messages
routes       1 ── N telegram_inbox
routes       1 ── N telegram_outbox
routes       1 ── N telegram_interactions
routes       1 ── 0..1 managed_pins
routes       1 ── N effect_ledger
routes       1 ── N approval_requests
telegram_principals 1 ── N telegram_messages
telegram_messages 1 ── 0..N telegram_inbox
telegram_messages 1 ── 0..N telegram_outbox
telegram_messages 1 ── 0..N telegram_interactions
telegram_inbox 1 ── 0..N telegram_outbox
telegram_inbox 1 ── 0..N effect_ledger
telegram_inbox 1 ── 0..N approval_requests
```

Inbox insertion and poll-cursor advancement happen in the same transaction.
If the transaction fails, tgfx does not advance the cursor and stops polling
rather than risk losing the update. Outbox and effect rows are written before
network delivery. Their retry classes determine whether recovery may resend an
operation; a stable local ID alone does not make a Telegram send idempotent.

`telegram_messages` and `telegram_principals` are reference indexes, not content
archives. They retain the minimum Telegram IDs needed to resolve opaque refs for
the active FX session generation and are pruned with that generation. Interaction
payloads retain only bounded button, poll, or join-request validation state until
completion or expiry. Message bodies are still removed with completed inbox and
outbox recovery payloads.

Ephemeral draft frames are coalesced in memory and are not written for every
token. Only the permanent final delivery and explicit MCP side effects enter the
outbox. If the process dies, the draft expires naturally and recovery creates a
new one from the retained turn state. The managed-pin row lets startup reconcile
an interrupted create/edit/pin sequence without searching or replacing unrelated
pins.

## Reliability contract

“Reliable” does not mean exactly once. Telegram sends and an FX turn that can
change workspace files do not offer a transaction that SQLite can join. tgfx
therefore gives each boundary an explicit delivery semantic:

| Boundary | V1 guarantee | Recovery behavior |
| --- | --- | --- |
| Telegram before local acceptance | Telegram-owned, with no tgfx durability guarantee. Telegram retains unconsumed updates for at most 24 hours. | Poll again while Telegram still retains the update. |
| Authorized inbound update after SQLite commit | Durable acceptance and deduplication by `(bot_id, update_id)`, assuming the local database remains readable. | The update remains queued until complete, canceled, failed, or explicitly discarded. |
| Unauthorized update | Intentional discard; its payload is not stored or sent to FX. | Advance the poll cursor and do not replay it. |
| Dispatching a prompt to FX | At-most-once **automatic** dispatch when acceptance is uncertain. This avoids silently repeating file or tool side effects. | Resume the saved FX session when it proves the prompt is active or complete. If acceptance cannot be proved, mark the turn `interrupted` and require `/retry` or `/discard`. |
| Private rich draft | Best effort and ephemeral. Intermediate frames may be coalesced, skipped, overwritten, or disappear. | Do not persist draft frames. Reconstruct a new draft only from a safely resumed active turn. |
| Permanent final Telegram reply | At least once after an outbox row exists. | Retry `pending` rows. Treat a crash during `sending` as `unknown`, record the ambiguity, and retry; this can rarely create a duplicate. |
| State-setting Telegram MCP effect | Effectively once within one tgfx state database, using a stable `effect_id`, request hash, and stored result. Reactions, exact pin/unpin, deletion-to-absent, and some moderation state changes express a desired state. | Replay the stored result or reconcile/repeat only when the same desired state is safe. A Telegram “already absent” result can satisfy deletion. |
| Non-idempotent Telegram MCP effect | New replies, files, choices, polls, topic creation, and any future invite-link creation are never automatically repeated after an unknown outcome. | Mark it `unknown`; report that state to the recovered turn or operator. An explicit retry creates a new effect and warns that the first may have succeeded. |
| Managed pinned bulletin | A composite desired state: one tgfx-owned message with content hash X is pinned in this route. | Resume from the recorded create/edit/pin phase and reconcile only the known managed message. Never call `unpinAllChatMessages` or replace an unrelated pin. |
| Approval decision | One accepted decision per approval ID in the local database. | Atomically change `pending` to one terminal state. Duplicate, late, or mismatched callbacks cannot execute the action. |
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
- A recovered `dispatching` or `running` turn may continue automatically only
  when FX session evidence identifies that exact prompt as active or completed.
  Otherwise it becomes `interrupted`. `/retry` is a new, explicit attempt and
  tells the user that earlier side effects may already have happened.
- `/cancel` is best effort. `canceled` means tgfx will send no more automatic work
  for the turn; it does not promise to undo an FX command already in progress.

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
- Non-idempotent MCP sends choose the opposite tradeoff: an `unknown` effect is
  not resent automatically. The effect ledger rejects reuse of an `effect_id`
  with different arguments and returns the stored result for an already
  successful identical call.
- Administrator rights are checked immediately before execution, not only at
  startup. Losing a right turns the call into an explained failure. Approval does
  not reserve a permission or make a later Telegram operation succeed.
- A composite managed-pin update records its desired content hash and each phase
  before the Bot API call. Recovery may edit or pin the recorded bot-owned
  message again, but never searches for a vaguely matching message or creates a
  second bulletin after an unknown create result.

### Approvals and shutdown

- Approval callbacks use an atomic compare-and-set from `pending` to
  `approved`, `denied`, `expired`, or `canceled`. Only an allowed user, the
  expected control chat, the matching tool-input hash, and an unexpired request
  can win that transition. Approval delivery is retryable; approval consumption
  is single-use.
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
| `cli` | Commands, flags, cwd selection, signals, and inline terminal output. |
| `config` | Workspace config, bot selection, OS secrets, first-run flow, and validation. |
| `state` | SQLite schema, migrations, transactions, inbox/outbox/effect/approval recovery, and retention. |
| `telegram` | grammY client, owned long-poll loop, normalization, allowlist gate, live permission checks, and API errors. |
| `routing` | Route keys, per-route queue, cancellation, and FX session generations. |
| `attachments` | Opaque references, album collection, validated downloads, temporary files, and cleanup. |
| `fx` | `fx acp` process lifecycle, ACP client, session create/resume/prompt/cancel, and permission events. |
| `telegram-mcp` | Scoped action methods, opaque-ref resolution, interaction callbacks, admin profiles, and capability validation. |
| `projector` | Reduction of ACP text/tool/permission events into a current semantic timeline. |
| `renderer` | Rich blocks, drafts, final messages, fallback entities, splitting, throttle, and retry. |

Composition belongs in one small entry point. Telegram-specific types should not
leak into the ACP client, and raw ACP event shapes should not leak into the Bot
API client. Zod schemas validate data at the Telegram, config, database JSON, and
MCP boundaries.

## Stack

- **Bun + strict TypeScript** for the runtime, process spawning, SQLite, secrets,
  tests, and eventual standalone executable;
- **`@agentclientprotocol/sdk`** for ACP contracts;
- **grammY** for typed Telegram Bot API access and file helpers;
- an **owned `getUpdates` loop**, rather than a helper that advances an in-memory
  cursor before SQLite has accepted the work;
- **`bun:sqlite`** directly, with small migrations and no ORM;
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
  contain the token and are never logged or sent to FX.
- MCP tools resolve an opaque capability to the current route and enforce paths,
  file size, MIME type, bot permissions, and expiry on the server side.
- Raw Telegram IDs may appear as descriptive envelope metadata, but MCP target
  schemas never accept them. `context_ref`, `message_ref`, `member_ref`,
  `attachment_ref`, `interaction_ref`, `poll_ref`, and `request_ref` resolve only
  inside the issuing bot, route, topic, and allowed lifetime.
- Telegram administrator status is necessary but insufficient for admin MCP
  tools. The exact group must be allowlisted, its workspace admin profile must
  enable the capability, the live Bot API permission check must pass, and the
  target must resolve within that group. Rights revoked while tgfx is running
  take effect on the next call.
- Deletion, member restriction/ban, join-request decline, and non-idempotent topic
  creation require a single-use control-chat approval. Config may require more
  approvals, never fewer for this destructive set. Protected principals include
  the bot itself and explicitly configured control operators; they cannot be
  moderation targets.
- A normal message cannot approve an FX permission request. When FX requests
  permission, tgfx sends an approval card to the configured control chat. It
  shows the workspace label, originating route and sender, exact tool name and
  arguments supplied by ACP, and two buttons: **Allow once** and **Deny**.
- Approval callbacks are single-use, short-lived, and bound to the bot, workspace,
  FX session, turn, tool call, and an input hash. The callback sender must pass
  the same allowlist and the callback must come from the configured control chat.
  Expiry, cancellation, a mismatched hash, or an invalid callback denies the
  request. There is no “always allow” button in v1.
- There are no approval roles. Every allowed user can approve from the control
  chat. If the control chat itself is chat-allowlisted, every member of that chat
  can approve; onboarding warns about this explicitly. Use an allowlisted private
  user as the control chat for the narrowest setup.
- While approval is pending, the originating chat sees a compact “Waiting for
  approval in the control chat” state. `/cancel` cancels the pending request and
  the FX turn. Approval timeout is fail-closed and reported to both chats.
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

- The current installed and stable release checked for this RFC is `fx 0.0.5`.
  tgfx still probes ACP and MCP capabilities at startup instead of treating a
  version string as proof that every required feature is usable.
- `fx acp` is launched in the primary workspace and exposes ACP protocol version
  1, saved sessions, prompt cancellation, model/mode configuration, streamed tool
  status, and permission requests.
- ACP prompts accept text and embedded resources but not image or audio blocks.
- ACP-supplied MCP servers are authoritative for that session and can use stdio,
  HTTP, or legacy SSE transports.
- FX currently implements MCP `2026-07-28` over stdio and stateless Streamable
  HTTP with compatibility adapters for older servers. Its
  `subscriptions/listen` feature concerns MCP catalog/resource changes, not
  arbitrary external events such as new Telegram messages.
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
  adopts that small core as a mandatory allowlist plus one control chat, without
  adopting pairing codes, role tiers, guest access, or chat-driven permanent
  approval rules.

These are checked platform capabilities, but tgfx still needs fallbacks because
users can run older FX builds, older Telegram libraries, or clients with uneven
rendering support.

## Open research and later work

Before calling v1 stable, we should investigate or prove:

- the exact FX process strategy for several active routes: session switching
  versus a bounded pool of one-session processes;
- FX session resume behavior after abrupt termination, including MCP capability
  restoration and permission state;
- approval-card usability, callback expiry, and concurrent permission requests
  across Telegram clients;
- Rich Message behavior across current Telegram mobile, desktop, and web clients,
  including long-message splitting and media blocks;
- whether Telegram's new group ephemeral messages are reliable enough for an
  opt-in group streaming preview;
- album collection timing under delayed and out-of-order updates;
- the most legible onboarding for per-group admin capabilities, live Telegram
  permission drift, protected members, and approval policy;
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

## V1 is done when

From a clean machine and a real repository, a user can:

1. install FX and tgfx, run `tgfx`, enter a bot token, configure at least one
   allowed user/chat ID and a control chat without editing a config file;
2. send text, a reply, an edit, a photo, a document, or a voice message and see an
   accurate context envelope reach the correct FX session;
3. receive a responsive private rich draft or one final group response, with
   correct markup and optional tool collapsing;
4. cancel a turn and queue another message without corrupting the route;
5. restart tgfx at every documented reliability boundary without losing a
   locally accepted update, silently replaying an uncertain FX turn, or violating
   the retry class of an outgoing effect; the final-send duplicate window remains
   visible and documented;
6. rotate the same bot token, switch bots, or allow a new group without mixing
   polling cursors or FX sessions;
7. use scoped attachment, file, choice, poll, reply, and reaction tools; react to
   a referenced message from an earlier turn without supplying a raw Telegram
   target ID or escaping the current route;
8. opt one allowed group into selected admin capabilities, maintain its tgfx-owned
   pinned bulletin, manage a topic, and complete an approved moderation action
   without exposing a generic Bot API proxy or disturbing unrelated pins;
9. understand failures from Telegram, FX, permissions, files, and recovery through
   concise terminal and chat messages;
10. verify that no bot token, Telegram file URL, permanent message archive, or raw
   ACP transcript was written to the project by default.

## References

- [FX repository and product direction](https://github.com/vercel-labs/fx)
- [FX contribution principles](https://github.com/vercel-labs/fx/blob/main/CONTRIBUTING.md)
- [FX embedding interfaces](https://fx.sh/docs/lib)
- [FX ACP server](https://fx.sh/docs/using-fx/acp)
- [FX MCP protocol](https://fx.sh/docs/capabilities/mcp/protocol)
- [Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview)
- [Telegram Bot API](https://core.telegram.org/bots/api)
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
