# AGENTS.md

Small project, small rules. When in doubt, write less.

## Tests

`bun run check && bun test` (Bun ≥ 1.4). Keep the suite fast. Wait on
promises, never sleep and hope.

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
