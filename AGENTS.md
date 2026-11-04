# AGENTS.md

Guidance for coding agents that work in this repository.

## Project

A Buzz desktop plugin (plugin API version 1). It adds **View tables** to the
message menu and shows the Markdown tables of that message in a full-screen
dialog. The README describes the behavior, the supported Markdown and the
mobile behavior. Keep the README true when you change behavior.

| Path | Purpose |
| --- | --- |
| `plugin/manifest.json` | Plugin manifest. Buzz installs the `plugin/` folder. |
| `plugin/plugin.js` | The plugin: one self-contained ES module, no build step. |
| `scripts/smoke.mjs` | Smoke scenarios: runs `plugin.js` with a fake Buzz context. |
| `scripts/check` | All repository checks. The Git hooks call it. |
| `scripts/setup-hooks` | Turns on the Git hooks for a clone. Copied from a template. |
| `.githooks/` | Generic hooks and helpers, copied from a template. |
| `.githooks/<hook>.d/` | This repository's own hook checks. |

## Setup and checks

1. Run `scripts/setup-hooks` once after you clone.
2. Run `scripts/check --quick` while you work, and `scripts/check` before
   you push.
3. Run one file of scenarios with `node scripts/smoke.mjs [path/to/plugin.js]`.

Never use `--no-verify`, and never change `core.hooksPath` or other Git
settings. Do not edit the files that come from the hook template:
`.githooks/*` (outside the `*.d/` folders), `.githooks/lib/` and
`scripts/setup-hooks`.

## Plugin rules

- `plugin/plugin.js` must stay one file with no runtime imports. Buzz loads
  it as is. Use `ctx.react` for React. API v1 has no CSS files: use inline
  styles and the host theme variables.
- Keep the module top level pure. Do all work in `apply(ctx)`.
- Message text is untrusted. Give it to React as text only. Never use a
  raw-HTML sink, never make a link or an image from cell text. `scripts/check`
  rejects the common sinks.
- Ask for the minimum: keep `inject` short, and add no `host` grants.
  `scripts/check` rejects a `host` block.
- Do not change the manifest `id` (`sagmans.table-view`) or the action id
  (`view-tables`). Installs match on them.
- Put each fixed value in a named constant at the top of the file.
- Comments explain why the code exists, not what it does.
- Each failure is visible: log it with its context. Do not drop errors.

## Tests

Do not add a unit test framework. Add or update a scenario in
`scripts/smoke.mjs` for each behavior change, and make sure that the
scenario fails without the change.

## Private data

This repository is public. Never commit names of people, private host or
network names, real public keys, local home paths, issue tracker links or
secrets. Use neutral words, such as "the user" or `example.com`.
`scripts/check` blocks the common shapes of such data.

## Commits

- Follow `.githooks/GIT_CONVENTION.md` (Conventional Commits with a body).
- Sign and sign off each commit: `git commit -s -S`.
- Make each commit one logical change, and make sure that `scripts/check`
  passes on it.
