# AGENTS.md

Small project, small rules. When in doubt, write less.

## Tests

`bun run check && bun test` (Bun ≥ 1.4). Whole suite stays fast; wait on
promises and conditions, never bare sleeps.

- Test behavior through real seams — the fake `fx` binary, the FakeTelegram
  HTTP server, real SQLite in a temp dir. No mock forests.
- Test the mechanism, not the data. Never mirror a production table (labels,
  catalogs, icon positions) into expected literals: a few representative
  cases, plus an invariant that iterates the real exported table.
- One behavior per test, named after the behavior. Share expensive setup with
  a helper, not by stuffing more behaviors into one test.
- Each behavior is asserted in one place. Parsers own exact output
  (deep-equal is fine there); layers above assert delegation only.
- Don't freeze copy — assert key substrings of user-facing strings, not
  whole sentences.
- Anything environment-sensitive gets its own test so a failure can't mask
  the rest.

## PR descriptions

- First line: what changed and why, fit for a changelog.
- Then only what the diff can't say: what broke or itched, the constraint
  that picked this design over the obvious one.
- How it was verified — command and result — and what was deliberately
  left out.
- No boilerplate, no checklists, no narrating the diff. An empty section
  doesn't exist.
