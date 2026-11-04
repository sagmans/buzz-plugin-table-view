# buzz-plugin-table-view

A Buzz desktop plugin. It shows the Markdown tables of a message in a
full-screen dialog, so a wide table is easy to read.

## What it does

Buzz draws a Markdown table inside the message column. A wide table then
needs horizontal scrolling. The plugin adds the entry **View tables** to the
message **⋯** menu:

- The entry shows only on a message that holds at least one GitHub Flavored
  Markdown (GFM) table.
- The entry opens a dialog that fills the window and shows all tables of the
  message, in order. A message with more than one table gets a caption for
  each table, for example "Table 2 of 3".
- Each table scrolls in its own frame. Its header row stays visible while
  you scroll down.
- The column alignment of the table (`:---`, `:---:`, `---:`) is kept.
- Select **Close** or push **Escape** to close the dialog.

The dialog uses the colors of the app theme, in light and dark mode.

## What it reads

The plugin reads GFM tables: a header row, a delimiter row with the same
number of cells, and the body rows that follow. A table inside a fenced code
block is code, not a table, and gets no entry. Diff messages get no entry.

Cells show this inline Markdown:

| Markdown | Shown as |
| --- | --- |
| `` `code` `` | Code |
| `**strong**`, `__strong__` | Strong text |
| `*emphasis*` | Emphasized text |
| `~~old~~` | Struck-out text |
| `[label](address)` | The label only, not a link |
| `<https://example.com>` | The address as text |
| `\|` and other backslash escapes | The escaped character |
| `<br>` | A line break |

All other text, HTML included, shows as plain text.

## Install

The plugin needs the Buzz desktop app (plugin API version 1). The plugin is
in the `plugin/` folder: `manifest.json` and `plugin.js`. There is no build
step.

From Git:

1. Open **Settings > Plugins > Manage plugins**.
2. Add the repository `sagmans/buzz-plugin-table-view` with branch `main`.
3. Select the `plugin` folder in the list, then select **Install**.

On macOS, this link opens the same preview. It does not install anything
until you select **Install**:

```sh
open 'buzz://plugin-install?repository=sagmans%2Fbuzz-plugin-table-view&ref=main'
```

From a folder:

1. Clone this repository.
2. Open **Settings > Plugins > Manage plugins** and load a folder.
3. Select the `plugin/` folder of the clone, then select **Install**.

New plugins are enabled by default. To update, use **Update** on the plugin
in **Manage plugins**.

## Mobile behavior

The Buzz mobile app runs no plugins. On mobile, the message menu has no
**View tables** entry.

## Limitations

- Buzz plugins cannot add a button to each table in a message. The entry is
  in the message menu and opens all tables of the message.
- The parser follows the GFM table rules for common text. A table inside a
  block quote or a list item gets no entry.

## Security

- Message text comes from any member of a channel, so the plugin treats it
  as untrusted. It gives each cell to React as text. It never sets raw HTML
  and never makes a link from cell text. `scripts/check` blocks the raw-HTML
  sinks of the DOM and React in `plugin/plugin.js`.
- The plugin asks for no native host access, no network origins and no
  processes: the manifest has no `host` block. It uses two app services:
  React and conversation.
- It stores no data and sends no messages.
- Buzz plugins are not sandboxed. They run inside the app with its full
  access. Install only code that you trust, and read `plugin/plugin.js`
  first. It is one file with no dependencies.

## Contributing

1. After you clone, run `scripts/setup-hooks` once. It turns on the Git
   hooks of this repository.
2. Install the tools that the hooks use: `gitleaks`, `node`, `shellcheck`,
   `shfmt`, `markdownlint-cli2`, `lizard`, `semgrep` and `trivy`.
3. Run `scripts/check` before you push. It runs the smoke scenarios
   (`node scripts/smoke.mjs`), the linters and the scanners.
4. Sign each commit and add a sign-off: `git commit -s -S`. The commit
   message rules are in `.githooks/GIT_CONVENTION.md`.

All checks must pass before you push. Never use `--no-verify`.

## License

Apache License 2.0. See [LICENSE](LICENSE).
