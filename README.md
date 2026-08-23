# 𝒕𝒈(𝒇x)

Tiny, local Telegram bridge for [fx](https://github.com/vercel-labs/fx).

`tgfx` runs in the current directory, starts `fx acp`, turns approved Telegram
messages into FX turns, and renders the result back into Telegram. FX remains the
agent; tgfx only owns transport, routing, rendering, and delivery reliability.

One process owns exactly one bot and the current workspace. The same bot cannot
run in another workspace until the first `tgfx` process stops.

Startup requires an explicit Telegram user/chat allowlist and a control chat for
approvals. Messages outside that allowlist are silently dropped.

Reliability is explicit: durable inbound acceptance, ordered turns, best-effort
drafts, at-least-once final replies, and no blind replay of uncertain FX or MCP
side effects.

Display name: **𝒕𝒈(𝒇x)** · repository: `telegram-fx` · package/CLI: `tgfx`

> Status: design RFC. The current proof-of-concept code is experimental evidence
> and will be replaced. The behavior described below is not shipped yet.

Read the [project specification](./doc/SPEC.md). Architecture canvases remain
local design artifacts and are not stored in the repository.
