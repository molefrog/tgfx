# 𝒕𝒈(𝒇x) specification

> Status: draft RFC, 23 August 2026. This describes the intended first release.
> The existing proof of concept will be rewritten and is not the product contract.

𝒕𝒈(𝒇x), typed as `tgfx`, is a small local program that lets a Telegram chat talk to an
[FX](https://github.com/vercel-labs/fx) agent running in a project directory. It
starts FX through ACP, gives it a carefully described Telegram message, and
mirrors FX's answer back to Telegram.

```text
Telegram message -> tgfx -> fx acp -> tgfx -> Telegram response
                          \-> scoped Telegram MCP tools
```

FX is still the agent. tgfx does not replace its model loop, tools,
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

## Contents

- [What using it should feel like](#what-using-it-should-feel-like)
- [Scope and architecture](#scope-of-the-first-release)
- [Telegram message contract](#the-telegram-message-contract)
- [Telegram MCP tools](#scoped-telegram-mcp-tools)
- [Rendering](#rendering-fx-in-telegram)
- [Storage and database](#storage-and-privacy)
- [Modules and stack](#module-boundaries)
- [Edge cases and open research](#important-edge-cases)

## Philosophy

tgfx follows the same direction as FX: minimal, fast, embeddable, and closer
to a Unix command than a terminal IDE.

1. **Run where the work is.** The directory in which `tgfx` starts is the FX
   workspace. There is no separate project picker or hosted control plane.
2. **Keep FX in charge of agent work.** tgfx does not duplicate FX tools,
   memory, models, or session storage.
3. **Make the safe path the obvious path.** Chats must be paired. Secrets never
   go into project files. Telegram actions are restricted to the current message
   and chat.
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

### First run

If the selected bot has no token, tgfx asks for it in a hidden prompt:

```text
tgfx  /Users/me/code/my-project

◇ Telegram bot token
│ •••••••••••••••••••••••••••••••••••••••
│
◆ Connected to @my_fx_bot (123456789)
◆ Saved token in the system credential store
◆ FX is ready
◆ State database is ready

Pair the bot by sending: /pair violet-river-42
Waiting for Telegram messages…
```

The token is validated with Telegram's `getMe` before it is saved. The terminal
shows the bot identity and asks before replacing a different active bot.

The pairing code is short-lived. The first matching private user becomes the
owner of this workspace route. A group or topic must be explicitly paired by an
owner, for example by sending the active `/pair <code>` command inside that
group. Group routes default to `owner_only`; adding or pairing the bot does not
grant every member access to the workspace. Access can later be changed through
the interactive `tgfx routes` command.

In a non-interactive terminal, tgfx never waits for a hidden prompt. It uses
`TELEGRAM_BOT_TOKEN` if present or exits with a useful setup message.

### Normal run

Running `tgfx` again selects the known bot and workspace configuration:

```text
tgfx  /Users/me/code/my-project

✓ FX ready
✓ Telegram @my_fx_bot
✓ 2 paired routes
● Listening

12:41:03  @maria · private           received 841234
12:41:03  @maria · private           FX turn started
12:41:11  @maria · private           delivered · 8.2s
```

Steady-state output is append-only and readable in an ordinary terminal. Short
setup tasks may use a spinner, but tgfx does not use a full-screen TUI. A
`--json` mode provides machine-readable operational events.

### In Telegram

In a private chat, an ordinary paired message starts a turn. The user first sees
a rich draft that grows as FX responds. A running tool appears as a temporary
thinking/tool line. When the turn finishes, the draft becomes a permanent rich
message.

In a group, tgfx reacts only to an explicit `/fx` command, a reply to the bot,
or a configured mention. It does not read normal group conversation as agent
requests. Groups receive one final response in v1; live group previews are left
for later because their delivery and visibility rules are different.

If a route already has an active turn, later messages wait in arrival order. The
user can send `/cancel` to cancel the active FX prompt. V1 runs one prompt at a
time for each bot/chat/topic route.

The Telegram command surface is also small:

| Command | Purpose |
| --- | --- |
| `/pair <code>` | Pair the current private chat, group, or topic. |
| `/fx <prompt>` | Start a turn explicitly; required in groups unless the bot is mentioned or replied to. |
| `/cancel` | Cancel the active turn for this route. |
| `/new` | Start a fresh FX session generation for this route. |

FX slash commands are not blindly forwarded in v1. tgfx commands, Telegram
commands, and FX session configuration are different namespaces and should not
accidentally invoke one another.

## Small command and configuration surface

The intended commands are deliberately limited:

| Command | Purpose |
| --- | --- |
| `tgfx` | Start in the current directory; onboard if needed. |
| `tgfx auth` | Add, rotate, or select a Telegram bot token. |
| `tgfx routes` | Show paired private chats, groups, and topics. |
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
  "renderer": {
    "streaming": true,
    "collapseTools": true
  }
}
```

Tokens and paired chat IDs do not belong in this file. Pairing and delivery state
live in SQLite so they can be changed transactionally.

## Scope of the first release

V1 includes:

- Bun and TypeScript, running as a local CLI;
- long polling of one selected Telegram bot;
- private chats, groups, supergroups, and their topics;
- safe pairing and route allowlisting;
- one FX session per bot/chat/topic route;
- text, captions, replies, edits, and attachment references;
- a scoped Telegram MCP server for a few current-message actions;
- rich-message drafts in private chats and final rich messages everywhere;
- SQLite recovery state and temporary attachment files;
- cancellation, queuing, retry, rate-limit handling, and graceful shutdown.

V1 intentionally does not include:

- broadcast channels, channel posts, business chats, communities, or guest bots;
- webhooks or a hosted service;
- multiple tgfx processes sharing one workspace database;
- a permanent Telegram message archive or raw ACP transcript;
- native image/audio blocks in ACP;
- arbitrary Telegram automation, arbitrary destination chat IDs, or arbitrary
  filesystem paths in MCP calls;
- remote permission approval without a separately designed secure flow;
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
2. In one SQLite transaction it records each accepted update and advances the
   cursor. Duplicate `(bot_id, update_id)` values are ignored.
3. The normalizer recognizes the sender, chat, topic, reply, edit, text/caption,
   and attachment metadata.
4. The router checks the paired route and queues the message behind any active
   turn for the same `{bot_id, chat_id, topic_id}`.
5. tgfx creates or resumes that route's FX session and sends the two-block
   context envelope through `session/prompt`.
6. FX streams assistant text, tool status, and permission requests over ACP.
7. The projector reduces those events into a complete current timeline. It can
   add, update, collapse, or remove an earlier tool line.
8. The renderer coalesces fast changes and sends the whole current private draft
   with the same non-zero `draft_id`. It respects Telegram rate limits and keeps
   the 30-second draft alive.
9. On success it sends a permanent rich message and marks the inbox and outbox
   rows complete. On restart, unfinished rows are retried.

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
- pairing a different user, group, or topic creates a new route and FX session;
- history is never copied between chats automatically.

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
      "user_id": "6143594",
      "username": "molefrog",
      "display_name": "Mole Frog"
    },
    "message": {
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
      "user_id": "6143594",
      "username": "molefrog"
    },
    "message": {
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
      "user_id": "71262225",
      "username": "soaniel"
    },
    "message": {
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

- `reply`: referenced message ID, sender summary, and a bounded text excerpt;
- `edited_at` with `event: "message.edited"`;
- `media_group_id` and the attachment's position in a collected album;
- `forwarded_from` and `via_bot` provenance without trusting either as the actor;
- document `name`, MIME type, and size;
- sticker, animation, video, video-note, contact, location, poll, or other typed
  metadata that can be represented without copying a large payload.

`sender` is a union. A normal person is `{ "kind": "user", ... }`. An anonymous
admin or a message sent as a chat is `{ "kind": "chat", "chat_id": "...",
"chat_kind": "supergroup", "title": "..." }`. When Telegram supplies
`sender_chat`, it wins over the compatibility `from` field; tgfx does not
invent a user identity.

## Teaching FX how Telegram works

tgfx supplies a small persistent instruction together with strongly described
MCP tools:

- the normal assistant response is automatically delivered to the current
  Telegram route; the agent should not call a tool just to answer;
- `telegram_message` describes where the turn came from, but it does not grant
  permission;
- tools named `*_current` act only on the current scoped message;
- an attachment must be downloaded before the agent claims to have inspected it;
- the agent must not ask for or invent `chat_id`, Telegram `file_id`, or a target
  path.

The important rule is enforced in code, not only in prose: every MCP call carries
an opaque, short-lived `context_ref`. The server resolves it to the authorized
bot/chat/topic/message and rejects expired, mismatched, or cross-route calls.

## Scoped Telegram MCP tools

The first MCP server is intentionally small:

| Tool | Input | Result and restrictions |
| --- | --- | --- |
| `telegram.reply_current` | `context_ref`, `text`, optional `quote` | Sends an extra explicit reply in the current route. Ordinary agent output does not need this tool. |
| `telegram.react_current` | `context_ref`, `emoji` | Reacts to the current message if the chat and bot permissions allow it. |
| `telegram.download_attachment` | `context_ref`, `attachment_ref` | Validates size and MIME, downloads into `.tgfx/files/<context_ref>/`, and returns a local path, size, MIME, and hash. The caller cannot choose a destination. |
| `telegram.send_media` | `context_ref`, workspace-local `path`, optional `caption` | Sends a generated or modified file to the current route after path, MIME, size, and permission checks. It cannot target another chat. |

tgfx passes this local stdio MCP server in ACP `session/new`. FX treats the
ACP client's `mcpServers` list as authoritative, which means tgfx does not
silently inherit unrelated servers from the user's global FX profile.

The MCP server uses the latest stateless stdio protocol supported by FX. Features
such as catalog change delivery and `subscriptions/listen` are useful for MCP
tool/resource catalog updates; they are not a Telegram event inbox and cannot
wake an idle FX session. The tgfx host remains responsible for polling and
injecting new user turns.

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
the final step, or as a separate validated `telegram.send_media` action. Streaming
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
| `<workspace>/.tgfx/config.json` | Active bot ID and non-secret renderer/route defaults | Project-local. |
| `<workspace>/.tgfx/state.sqlite` | Poll cursor, paired routes, FX session references, and temporary inbox/outbox recovery rows | Operational; completed payloads expire. |
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
  access_mode TEXT NOT NULL             -- owner_only/all_members
  workspace_path TEXT NOT NULL
  agent_profile TEXT
  session_generation INTEGER NOT NULL DEFAULT 1
  created_at TEXT NOT NULL
  updated_at TEXT NOT NULL
  UNIQUE (bot_id, chat_id, topic_id)

route_principals
  route_id TEXT NOT NULL REFERENCES routes
  principal_kind TEXT NOT NULL          -- user/chat
  principal_id TEXT NOT NULL
  role TEXT NOT NULL                    -- owner/member
  enabled INTEGER NOT NULL
  created_at TEXT NOT NULL
  PRIMARY KEY (route_id, principal_kind, principal_id)

scope_state
  route_id TEXT PRIMARY KEY REFERENCES routes
  fx_session_id TEXT
  active_turn_id TEXT
  generation INTEGER NOT NULL
  updated_at TEXT NOT NULL

telegram_inbox
  bot_id TEXT NOT NULL REFERENCES bot_accounts
  update_id INTEGER NOT NULL
  route_id TEXT REFERENCES routes
  event_kind TEXT NOT NULL              -- message.created/message.edited
  message_id TEXT
  supersedes_update_id INTEGER
  status TEXT NOT NULL                 -- received/processing/complete/failed
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
  status TEXT NOT NULL                 -- pending/sending/sent/failed
  attempts INTEGER NOT NULL DEFAULT 0
  next_attempt_at TEXT
  telegram_message_id TEXT
  created_at TEXT NOT NULL
  completed_at TEXT
```

Relationships:

```text
bot_accounts 1 ── 1 telegram_poll_state
bot_accounts 1 ── N routes
routes       1 ── N route_principals
routes       1 ── 1 scope_state
routes       1 ── N telegram_inbox
routes       1 ── N telegram_outbox
telegram_inbox 1 ── 0..N telegram_outbox
```

Inbox insertion and poll-cursor advancement happen in the same transaction.
Outbox rows are written before network delivery. Stable delivery IDs prevent
most local duplicates. Telegram has no general idempotency key, so a process
crash after Telegram accepts a final message but before SQLite records the result
can still produce a duplicate on retry; v1 should mark or reconcile this window
where possible and document it honestly.

Ephemeral draft frames are coalesced in memory and are not written for every
token. Only the permanent final delivery and explicit MCP side effects enter the
outbox. If the process dies, the draft expires naturally and recovery creates a
new one from the retained turn state.

## Module boundaries

The implementation should be small enough to navigate without a framework:

| Module | Owns |
| --- | --- |
| `cli` | Commands, flags, cwd selection, signals, and inline terminal output. |
| `config` | Workspace config, bot selection, OS secrets, first-run flow, and validation. |
| `state` | SQLite schema, migrations, transactions, inbox/outbox recovery, and retention. |
| `telegram` | grammY client, owned long-poll loop, normalization, pairing, and API errors. |
| `routing` | Route keys, allowlist, per-route queue, cancellation, and FX session generations. |
| `attachments` | Opaque references, album collection, validated downloads, temporary files, and cleanup. |
| `fx` | `fx acp` process lifecycle, ACP client, session create/resume/prompt/cancel, and permission events. |
| `telegram-mcp` | Scoped current-message actions and capability validation. |
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

- Pairing and route status decide who can spend model credits and expose the
  workspace. Telegram metadata sent to the model never decides authorization.
- Bot tokens are redacted everywhere, including errors. Telegram file URLs also
  contain the token and are never logged or sent to FX.
- MCP tools resolve an opaque capability to the current route and enforce paths,
  file size, MIME type, bot permissions, and expiry on the server side.
- A normal message cannot approve an FX permission request. V1 never
  auto-approves sensitive work. If the process has an interactive TTY it may show
  FX's exact approval request there; otherwise the request is rejected and the
  Telegram user gets a clear explanation.
- Remote approval buttons need a separate design with owner identity, exact tool
  input, expiry, single use, and route/turn binding before they can ship.
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

### FX and concurrency

- One ACP connection has one active session and one active prompt. tgfx either
  switches sessions safely or uses separate FX processes when concurrent routes
  require it; it never multiplexes two prompts onto one active ACP session.
- A crash ends an in-flight process. The inbox row survives, but repeating the
  turn may repeat side effects. Telegram MCP calls therefore need stable effect
  IDs and server-side deduplication.
- Cancellation is best effort across Telegram, tgfx, ACP, FX tools, and MCP.
  The UI reports when work could not be stopped immediately.
- If an FX session cannot be resumed, tgfx creates a new generation and tells
  the user that conversational context was reset.
- ACP input is limited to 8 MiB. The envelope is bounded, reply excerpts are
  truncated safely, and large files are references rather than inline data.

## Findings that shape this design

The current official FX behavior matters in several places:

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
- Telegram Rich Messages provide structured headings, lists, code, tables,
  details, media, formulas, and a draft-only thinking block. A rich draft is a
  private-chat, 30-second preview and must be finalized with `sendRichMessage`.

These are checked platform capabilities, but tgfx still needs fallbacks because
users can run older FX builds, older Telegram libraries, or clients with uneven
rendering support.

## Open research and later work

Before calling v1 stable, we should investigate or prove:

- the exact FX process strategy for several active routes: session switching
  versus a bounded pool of one-session processes;
- FX session resume behavior after abrupt termination, including MCP capability
  restoration and permission state;
- the smallest useful terminal-only permission flow and the security design for
  later Telegram approval buttons;
- Rich Message behavior across current Telegram mobile, desktop, and web clients,
  including long-message splitting and media blocks;
- whether Telegram's new group ephemeral messages are reliable enough for an
  opt-in group streaming preview;
- album collection timing under delayed and out-of-order updates;
- safe transcription as a separate MCP capability for voice/audio;
- native ACP image/audio support if FX adds it; a future policy could inline at
  most three resized images while preserving attachment references for download
  and editing;
- recovery from the final-send/SQLite-commit duplicate window;
- local Bot API support for files larger than 20 MB;
- data-retention defaults, secure cleanup after crashes, and an explicit redacted
  debug bundle;
- callback queries, reactions, locations, contacts, polls, stickers, business
  chats, communities, and broadcast channels as separate scoped features rather
  than accidental generic support.

## V1 is done when

From a clean machine and a real repository, a user can:

1. install FX and tgfx, run `tgfx`, enter a bot token once, and pair a private
   chat without editing a config file;
2. send text, a reply, an edit, a photo, a document, or a voice message and see an
   accurate context envelope reach the correct FX session;
3. receive a responsive private rich draft or one final group response, with
   correct markup and optional tool collapsing;
4. cancel a turn and queue another message without corrupting the route;
5. restart tgfx during ingestion or delivery without losing an acknowledged
   update;
6. rotate the same bot token, switch bots, or pair a new group without mixing
   polling cursors or FX sessions;
7. use the scoped attachment and Telegram MCP tools without being able to escape
   the current route or workspace;
8. understand failures from Telegram, FX, permissions, files, and recovery through
   concise terminal and chat messages;
9. verify that no bot token, Telegram file URL, permanent message archive, or raw
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
- [Bun child processes](https://bun.sh/docs/runtime/child-process)
- [Bun secrets](https://bun.sh/docs/runtime/secrets)
- [grammY](https://grammy.dev/)
- [Clack](https://github.com/bombshell-dev/clack)
- [Citty](https://github.com/unjs/citty)
