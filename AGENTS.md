# AGENTS.md

Small project, small rules. When in doubt, write less.

## Project scope

TGFX is a reusable Rust CLI/package that connects Telegram to a locally
installed Vercel `fx` coding agent through ACP. Other people install it and run
it in their own project folders.

Keep reusable Telegram features and fixes here. A Docker bot used to dogfood
TGFX is a separate, task-specific playground: its prompts, integrations,
credentials, and deployment configuration belong outside this package. Use
that playground to discover gaps and test new features, then bring generally
useful behavior into TGFX. Updating the package and updating a running bot are
separate steps.

## Toolkit

Rust is the runtime and test harness. Prefer standard-library and existing
crate APIs. Keep `Cargo.lock` committed.

## README

Keep [README.md](README.md) minimal and written for users. Cover what TGFX
does, how to start, and the few details needed to use it. New features do not
automatically need documentation; prefer a short edit to an existing section.
Explain internals only when they help users make a choice or use a feature.
Keep architecture, implementation details, and exhaustive behavior elsewhere.
When asking the user to review a README change, explain what you added, show
the focused diff, and give your judgment on whether it fits this scope.

## Link locally

`./scripts/install.sh` installs the native binary with Cargo. For development,
`cargo build --locked` followed by `bin/tgfx` runs the local build. Rebuild after
changes.

## Tests

Run `./scripts/check-rust.sh`: formatting, Clippy, and all tests, including
subprocess end-to-end tests. The ACP test fixture uses Python 3.

- Test through real seams: the fake `fx` binary, the fake Telegram server,
  real SQLite in a temp dir. No mock forests.
- Test the mechanism, not the data. Don't copy a production table into
  expected values — a few representative cases plus a loop over the real
  table.
- One behavior per test, named after the behavior. Share setup with a
  helper, don't pile behaviors into one test.
- Each behavior is asserted in one place. Parsers own exact output; layers
  above only check they delegate.
- Don't pin copy. Check a key word, not the whole sentence.
- Anything environment-specific gets its own test so it can't hide other
  failures.

## PR descriptions

Write like you'd explain it to a friend. Short sentences, plain words,
no corporate voice.

- First line: what changed and why.
- Then only what the diff can't say: what broke, what you tried, why this
  way.
- How you checked it works.
- No section headers, no checklists, no narrating the diff.
