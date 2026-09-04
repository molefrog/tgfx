# tgfx specification

`tgfx` connects a Telegram bot to an fx agent running in a local project folder.
People send requests in Telegram; fx works in that folder; tgfx sends the answer
back. fx owns the model, tools, project instructions, and conversation history.
tgfx owns access, routing, Telegram presentation, and delivery recovery.

This document describes the current implementation. Installation instructions and
screenshots are in the [README](../README.md).

## Running it

One tgfx process serves one bot in one workspace. Run it from the folder where
fx should work. Sessions start lazily when a conversation needs the agent.

The runtime requires Bun 1.4 or newer and an authenticated fx installation.
Startup checks fx's version and diagnostic report, validates the Telegram bot,
and acquires a local lock before polling. See the README for the recommended
fx version.

On first run, setup asks for a bot token and who may use it. Private pairing uses
a one-time Telegram link or QR code: pressing Start adds that user and selects
their private chat for approvals. Manual setup accepts numeric IDs and an
approvals destination. Setup tests the approvals chat before saving it.

A bot can be configured in several folders, but only one local process may run
it at a time. The lock identifies the active folder and is released when its
process exits or crashes. It cannot coordinate other computers; a competing
Telegram poller causes tgfx to stop with an ownership error.

### Terminal commands

| Command | Behavior |
| --- | --- |
| `tgfx` | Run in the current folder, setting it up if necessary. |
| `tgfx access` | Show allowed users and chats, the approvals target, and saved routes. |
| `tgfx allow [id…]` | Add access. Without IDs, offer interactive pairing or manual entry. Positive IDs mean users; negative IDs mean chats. `--chat` selects a chat explicitly. |
| `tgfx deny <id…>` | Remove access. The allowlist must retain at least one entry. |
| `tgfx approvals [chat[/topic]]` | Show or change where approval cards and recovery notices go. |
| `tgfx auth [--remove]` | Add, replace, or remove the bot token. |
| `tgfx doctor` | Check fx, credentials, Telegram access, group rights, storage, and the workspace. |
| `tgfx help`, `tgfx version` | Show command help or the installed version. |

Access and approvals changes require a restart. Interactive pairing also polls
the bot, so stop the running process before pairing another account.

| Run option | Behavior |
| --- | --- |
| `--model <id>` | Pass the model to fx for this run; do not save a tgfx model preference. |
| `--yolo` | Disable fx permission checks for this run. Telegram admin approvals still apply. |
| `--output <mode>` | Select `live`, `progress`, `report`, or `answer`. |
| `--no-icons` | Disable custom emoji icons. |
| `--no-tui` | Use an append-only log instead of the live terminal view. |
| `--json` | Use machine-readable terminal output. |
| `--no-color` | Disable terminal color; `NO_COLOR` also works. |
| `--debug` | Include diagnostic stack traces in terminal errors. |

The live terminal shows polling health, active conversations, elapsed time, tool
activity, and approval waits. `f` opens the format menu, `p` pauses polling, `l`
toggles logs, and `q` quits. Pausing leaves updates unacknowledged and does not
cancel work already accepted. Non-interactive runs never wait for setup input.

## Who can use the bot

Access is granted when either the sender's numeric user ID is allowed or the
conversation's numeric chat ID is allowed. Usernames and display names grant
nothing. An empty allowlist is invalid.

Allowing a user lets that person address the bot in private chats and groups.
Allowing a group lets its members address the bot, including anonymous
administrators sending as the group. Incoming messages from bots and broadcast
channels are excluded.

Allowed people can ask fx to work in the local workspace and spend model
credits. There are no separate owner, administrator, or guest roles in tgfx.
The same access rules govern approval clicks: if the approvals chat is allowed
as a whole, its members can approve actions.

Unauthorized updates are silently discarded. Their message payloads are neither
stored nor sent to fx; the polling cursor still advances past them.

## Conversations

A conversation, called a *route* in the code, is identified by:

```text
bot ID + chat ID + topic ID
```

The topic ID is `0` outside a topic. Each route has its own fx process and saved
session. Requests run in arrival order, one prompt at a time per route. Different
routes can work concurrently.

In a private chat, a supported message starts a turn. In a group, it must mention
the bot, reply to the bot, or use a slash command addressed to it. Ordinary group
conversation does not wake fx. These rules also apply to edited messages; an
edit is a new event, not a rewind of earlier work.

A restart attempts to resume the saved fx session. If resume fails, tgfx starts
a new session and tells the chat that its conversation was reset. A crashed fx
process is replaced when the next request arrives. Neither case automatically
repeats a request that may already have run.

Starting the same bot in another workspace resets its fx sessions and expires
old references. Queued requests for the previous workspace are discarded.
Polling state and unfinished Telegram deliveries remain in the bot's shared
journal. Changing a token for the same bot preserves that journal; selecting a
different bot uses a separate one.

### Telegram commands

| Command | Behavior |
| --- | --- |
| `/stop` | Cancel the current task and discard requests already queued for this route. |
| `/clear` | Stop and discard queued work, then create a fresh conversation for this route. |
| `/compact` | Ask fx to compact the current conversation, with visible progress and completion. |
| `/model` | Open fx's live model picker. A selection made during a task applies to the next ordinary turn. |
| `/format` | Choose a reply style and save it for this project. |
| `/cost` | Show local fx usage for 24 hours, 7 days, or 30 days. Totals include fx activity outside this Telegram conversation. |

Commands take no arguments. A suffix such as `/stop@my_bot` is accepted only
for this bot. Unknown commands receive an error; commands addressed to another
bot are ignored. Additional commands advertised by fx do not become Telegram
commands automatically.

Control menus, their buttons, and approval clicks respond while a task is
running. They do not replace its active message context. `/compact` uses the
ordinary task queue.

Requests received after `/stop` or `/clear` wait for that command to finish.
If fx ignores prompt cancellation for two seconds, tgfx starts terminating its
process. Cancellation cannot undo files changed, commands run, or messages sent.
Telegram's draft Stop button cancels only the task with the matching active
draft ID; it does not clear the queue.

The bot installs chat-scoped command menus and removes them on clean shutdown.
It leaves the default BotFather menu alone. All topics in a chat share its menu.

## Replies

| Style | During the task in a private chat | Final response |
| --- | --- | --- |
| `live` — default | Stream prose and tool activity in a rich draft. | Answer and collapsed tool groups. |
| `progress` | Show a brief activity status, then stream the answer. | Answer only. |
| `report` | Show typing status. | Answer and collapsed tool groups. |
| `answer` | Show typing status. | Answer only. |

Groups receive final responses without drafts. Their selected style still
determines whether tool activity is included. Normally the result is one
message; long fallback text may need several. Explicit agent actions such as
sending a file, poll, or sticker create separate messages.

Rich responses support headings, lists, quotes, code, tables, emphasis,
spoilers, highlights, and TeX math. Images written in Markdown become links;
file delivery uses the Telegram tools. Raw HTML is unsupported.

Tool rows preserve execution order and group consecutive calls. Repeated rows
can fold into a count. Rows show available input summaries, never tool result
bodies. Answer-only styles leave out narration before tools and trailing tool
activity. Missing arguments are not reconstructed from result prose.

Draft updates are coalesced and rate-limited per chat. Only the newest waiting
frame is kept, and unchanged drafts are refreshed before expiry. Telegram rate
limits delay frames without blocking fx. Repeated draft failures stop streaming
for that turn; final delivery is still attempted.

The final response is sent as a permanent rich message. If that fails, tgfx
tries plain text, splitting long text at paragraph, line, or word boundaries
where possible. It does not silently truncate the answer.

## What fx receives

A normal request contains a host-generated JSON block under `telegram_message`,
followed by the user's original text or caption unchanged. Media-only requests
omit the second block.

The envelope describes the event, route, sender, message, and attachments. It
includes an opaque `context_ref`; message, member, and attachment references
identify objects tgfx has observed. Telegram IDs are decimal strings. Reply
metadata contains a reference, optional quote, and bounded excerpt. Forwarding
and via-bot metadata describe provenance, not the authorized sender.

The first ordinary prompt in a new session includes instructions to read
`telegram://guidelines`. Session creation or replacement finishes before tgfx
activates that prompt's context. The context is deactivated when the turn ends.

Supported attachments are photos, documents, audio, voice messages, video,
video notes, animations, and stickers. Albums arriving close together are
combined. Stickers are downloaded automatically and include a local path plus
metadata such as emoji, pack name, and sendable file ID. Other attachments remain
references until fx downloads them.

A reference to audio or an image does not mean it has been transcribed or
visually inspected. tgfx sends text and file metadata through ACP; interpretation
of downloaded media depends on fx and its available tools.

Location pins include coordinates, accuracy and live-location details when
available. Venue pins also include the place name and address. Replies to pins
retain the location too.

Consecutive forwards from the same sender in the same chat/topic are collected
until one second passes without another forward, or a different message arrives.
Telegram provides no forwarding-batch ID, so this quiet period is a heuristic.
One FX prompt contains the ordered messages, each marked as forwarded with its
own source, text, and attachments. Forwarded albums participate in the same
batch. Forwarded slash commands are quoted content, not bot controls. Queued
batches survive restart and are discarded by `/stop` or `/clear`.

Contacts, unrelated service messages, and arbitrary inbound
polls do not become prompts. Choice clicks and supported poll votes created by
tgfx tools arrive as later, authorized events and can start new turns. Join
requests are retained for a later explicit group task; they do not wake fx.

For exact fields, see [normalization](../src/telegram/normalize.ts) and
[message types](../src/types.ts).

## Telegram tools available to fx

Each fx session receives a local Telegram MCP server. Ordinary assistant answers
are delivered automatically; these tools are for explicit Telegram actions.
The session does not automatically inherit other MCP servers from the user's
fx configuration.

The server obtains the active context from its assigned route. Tool calls do
not need a `context_ref` argument. Calls requiring an active turn fail after
that context expires. Message and member targets use opaque references checked
against the same route, with their own expiry. A reset invalidates old refs.

| Tool | Purpose |
| --- | --- |
| `set_reaction` | Set one emoji reaction on the current message or an earlier referenced message. |
| `download_attachment` | Download an attachment from the active context and return its local path. Maximum: 20 MiB. |
| `send_file` | Send a regular file from the workspace or this bot's download directory. Maximum: 50 MiB. |
| `send_photo` | Display a JPEG or PNG as a photo in the chat, with an optional caption. Maximum: 10 MiB. |
| `send_voice` | Send OGG/Opus, MP3 or M4A as a voice message, with an optional caption. Maximum: 50 MiB. |
| `send_video_note` | Send a square MPEG4 video up to 60 seconds as a circular video message, without a caption. Maximum: 50 MiB. |
| `get_sticker_pack` | Read pack metadata and sendable file IDs, optionally downloading previews. Results are paginated. |
| `send_sticker_by_id` | Send an existing sticker by its Telegram file ID. |
| `send_sticker_file` | Upload a local sticker; raster images are converted to a bounded WebP. |
| `request_choice` | Send 2–8 buttons and return immediately. A click becomes a later event. |
| `create_poll` | Send a poll with 2–12 options. Identifiable votes can become later events. |

Upload paths are resolved before use. They must stay inside the workspace or
the bot's downloads; private tgfx settings and state cannot be sent through
these tools. Downloads use private directories, bounded writes, and safe
filenames. Bot tokens and download URLs are not returned to the model.
Photo, voice and video-note tools upload prepared media; they do not generate
speech or transcode video. All sends stay in the active chat/topic and return a
message reference.

Two read-only MCP resources support the conversation:

- `telegram://guidelines` explains reply formatting and the available tools.
- `telegram://chat/recent` lists up to 25 observed or sent messages from this
  route, oldest first, with refs and excerpts of at most 200 characters. It
  helps recover references after compaction and works without an active turn.
  It cannot fetch arbitrary Telegram history.

### Group administration

Admin tools require the group itself to be allowlisted and the bot to hold the
corresponding Telegram administrator right. An allowed user alone does not
unlock them. Available tools are selected when the MCP server starts; execution
also checks live rights. Start a new session to pick up newly granted tools.

| Tool | Action | Requires a tgfx approval card |
| --- | --- | --- |
| `set_pinned_message` | Create or update one bot-owned bulletin for the route and pin it. | Yes |
| `pin_message`, `unpin_message` | Change the pin state of one referenced message. | Yes |
| `manage_topic` | Create, rename, close, or reopen a topic in the current group. | Creation only |
| `delete_messages` | Delete 1–100 referenced messages. | Yes |
| `moderate_member` | Restrict, restore, ban, or unban an observed user. | Yes |
| `review_join_request` | Approve or decline an observed pending request. | Decline only |

The managed bulletin does not replace or unpin other people's messages. Topic
management can take a numeric topic ID within the current group. Other message
and member targets require observed refs. The bot and allowlisted users cannot
be moderation targets.

There is no generic Bot API tool, arbitrary destination chat, unpin-all action,
or invite-link management. Exact tool schemas live in the
[MCP server](../src/mcp/server.ts).

## Approvals

fx permission requests and tgfx admin actions use cards in the configured
approvals chat and topic. The originating conversation shows that work is
waiting. fx cards use the options supplied by fx; admin cards use Approve and
Deny.

A click must come from an allowed person in the expected approvals destination.
Each card accepts one decision. Unknown, expired, canceled, and already resolved
cards cannot authorize work. Timeout denies the request. Startup expires cards
left open by the previous process.

The default fx policy uses its automatic review mode. `--yolo` disables that fx
layer for the process, while tgfx admin approvals remain required. Approvals do
not provide rollback or guarantee that Telegram will accept the action.

## Settings and storage

All tgfx state lives under `~/.fx/telegram/`, or `TGFX_HOME` when set. tgfx does
not put its runtime files in the project. fx may still edit the project as part
of a task and keeps its own session history separately.

| Location | Contents |
| --- | --- |
| OS credential store | Bot token, keyed by the numeric bot ID. |
| `config.json` | Machine-wide defaults for `output` and `customIcons`. |
| `projects/<folder>-<hash>.json` | Workspace path, bot ID, access list, approvals target, and project setting overrides. |
| `state/<bot_id>.db` | Poll cursor, routes, references, accepted requests, deliveries, interactions, and action results. |
| `state/<bot_id>.lock` and `.info.json` | Local process lock and diagnostic owner information. |
| `files/<bot_id>/` | Downloaded attachments, pruned by age. Sticker previews also use system temporary directories. |

The token lookup order is `TELEGRAM_BOT_TOKEN`, the OS credential store, then an
interactive hidden prompt. Environment tokens are validated but not copied into
the credential store. If secure storage is unavailable, use the environment;
tgfx does not fall back to a plaintext token file. Token-bearing URLs and tokens
are redacted from diagnostics. The fx child does not inherit the Telegram token
as a shell environment variable; the scoped MCP server receives it separately.

Settings precedence is built-in defaults, machine defaults, project overrides,
then run flags. A project file can omit presentation settings to inherit them.
For example, this machine default selects a live answer without tool history:

```json
{ "defaults": { "output": "progress" } }
```

Changing the reply style in Telegram or the terminal saves a project override
for subsequent turns. Terminal icon changes are saved too. Writes within the
process are serialized and atomically replace the settings file. Shutdown waits
for pending saves; failures are shown instead of silently claiming persistence.

SQLite is a recovery journal. Successful request and response bodies are
scrubbed after completion; bounded excerpts remain with message refs. Expired
refs and old completion records are pruned. Failed or interrupted work can
retain payloads for diagnosis, so the database must be treated as private data.
Raw ACP transcripts are not recorded by default.

## Failure and recovery

Telegram, fx, and SQLite do not share a transaction. The guarantees depend on
which boundary the work has crossed:

| State at failure | What happens next |
| --- | --- |
| Update not yet accepted locally | Poll again if Telegram still has it. |
| Authorized update committed as `received` | It survives restart and stays eligible for dispatch. Duplicate update IDs are ignored. |
| Request claimed as `dispatching` or `running` | Recovery marks it interrupted and reports it to the approvals chat, unless a recorded delivery already proves completion. It is not automatically rerun. |
| Draft on screen | It expires. Draft frames are not journaled. |
| Final reply recorded as `pending` or `sending` | Startup retries delivery from the stored response without rerunning fx. |
| Final reply recorded as `sent` | Recovery can finish the corresponding request's bookkeeping. |
| Final reply recorded as `failed` | It remains in storage. Normal startup does not retry it, and there is currently no user-facing retry command. |
| MCP action completed | An identical call in the same context returns its stored result. |
| MCP action threw or disconnected | Its outcome is treated as unknown; an identical call is blocked rather than blindly repeated. |

Accepting an update and advancing the poll cursor happen in one SQLite
transaction. Failure to commit stops ingestion. Different routes may progress
independently, but each route preserves prompt order.

Final delivery retries transient failures and respects Telegram's `retry_after`.
Retries are bounded. A send can reach Telegram before tgfx saves the returned
message ID; recovery may then send a duplicate. Partial plain-text delivery can
also duplicate earlier parts. tgfx does not promise exactly-once delivery.

The action ledger is scoped to the route, active context, tool, and arguments.
It prevents repeating the same uncertain tool call within that context. It does
not make a new user request safe to repeat: fx or Telegram may already have
performed part of the earlier work.

Clean shutdown stops polling, cancels active work, waits for control operations
and settings saves, terminates remaining fx processes, and releases the bot
lock. After an abrupt exit, recovery uses the recorded states above.

## Boundaries and maintenance

The current product covers private chats, groups, supergroups, and topics using
long polling. It has no hosted daemon, webhook mode, broadcast-channel support,
business-chat integration, bot-to-bot conversation, general history browser,
or built-in media transcription. There is no limit or idle eviction policy yet
for the number of route processes.

Keep product behavior here and implementation detail beside the code:

| Area | Source |
| --- | --- |
| Commands and setup | [index](../src/index.ts) |
| Routing, turns, controls, approvals | [app](../src/app.ts) |
| Persistence and recovery states | [state](../src/state.ts) |
| fx session lifecycle | [ACP client](../src/fx/acp.ts) |
| Telegram presentation and delivery | [renderer](../src/telegram/renderer.ts) |
| Settings | [config](../src/config.ts) |

Regression tests use a fake fx executable, a fake Telegram server, and real
SQLite in temporary directories. They cover authorization, routing, controls,
session recovery, rendering, file boundaries, and action deduplication. They do
not establish how every Telegram client renders a message or how every real
fx tool behaves under cancellation.

Run `bun run check && bun test` for code changes, and `bun run build` before
using the linked executable.
