# 𝒕𝒈(𝒇x)

Tiny, local Telegram bridge for [fx](https://github.com/vercel-labs/fx).

`tgfx` runs in the current directory, starts `fx acp`, turns approved Telegram
messages into FX turns, and renders the result back into Telegram. FX remains the
agent; tgfx only owns transport, routing, rendering, and delivery reliability.

Display name: **𝒕𝒈(𝒇x)** · repository: `telegram-fx` · package/CLI: `tgfx`

> Status: design RFC. The current proof-of-concept code is experimental evidence
> and will be replaced. The behavior described below is not shipped yet.

Read the [project specification](./doc/SPEC.md) or open the surviving architecture
board in [`Tele-FX Architecture Exploration.tldraw`](./Tele-FX%20Architecture%20Exploration.tldraw).
