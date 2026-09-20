# OpenCode Productivity Plugin

OpenCode plugin that adds:

- prompt history search for the TUI/user path
- process-scoped scheduled wakeups callable by the LLM, with wakeup messages delivered back to the originating session when possible
- process-scoped background shell commands callable by the LLM, with completion summaries delivered back to the originating session when possible

## Disclaimer

This is my personal workflow tooling. I take no responsibility for its usability, reliability, or fit for anyone else's setup. Despite the `opencode-` naming, this project is not affiliated with, endorsed by, maintained by, or related to the OpenCode team in any way.

## Platform

This plugin only supports Unix-like systems. It uses Unix process behavior for background command management and Unix-domain sockets for TUI/server IPC. Windows is intentionally unsupported.

## Install

Install local project dependencies:

```sh
npm install
```

The install writes only repo-local `node_modules` and lockfiles; it does not install global npm packages.

Build the plugin:

```sh
npm run build
```

### Project-local development

This repo includes a project-local OpenCode v2 plugin in `.opencode/`. From this directory, `opencode` (v2) loads:

- `.opencode/plugins/productivity/index.ts` (server plugin)
- `.opencode/plugins/productivity/tui.ts` (TUI plugin)

Those wrappers point at the compiled package files under `dist/`, so run `npm run build` after edits before restarting OpenCode.

### OpenCode v2 support

OpenCode v2 ships a new plugin API; v1 plugin implementations do not run under v2. The compiled entrypoints therefore expose hybrid default exports, following the same approach as the dynamic-context-pruning migration:

- `dist/src/server.js` default-exports `{ id, setup, server }`: v2 loaders consume `id` + `setup` (`src/v2.ts`), v1 loaders consume `server` (`src/plugin.ts`).
- `dist/src/tui.js` default-exports `{ id, setup, tui }`: v2 loaders consume `id` + `setup` (`src/tui-v2.tsx`), v1 loaders consume `tui`.

Known v2 gaps: wakeup/background notes are delivered as synthetic session messages, and the prompt-history picker copies the selected prompt to the clipboard (OSC52) instead of inserting it into the composer, because v2 has no composer-insertion API.

### Editable global development

For a global OpenCode install that stays linked to this working tree, register the generated dev-link package by absolute path:

```sh
npm run link:global
```

That script runs:

```sh
npm run build
npm run prepare:global-link
opencode plugin -g "$PWD/.global-opencode-productivity-plugin" --force
```

The generated `.global-opencode-productivity-plugin/` directory contains only tiny package entrypoints that import this checkout's compiled `dist/` files by absolute file URL. It intentionally excludes the repo-local `.opencode/` development config, so global editable installs do not copy this repo's `.opencode` wrappers into other projects.

After code changes, run `npm run build` and restart OpenCode. The global OpenCode config still points at this checkout's compiled files, like `pip install -e`.

If you install globally, also disable OpenCode's default session rename shortcut in your global TUI config if you want `ctrl+r` to belong only to prompt history:

```json
{
  "keybinds": {
    "session_rename": "none"
  }
}
```

To remove it, delete the `.global-opencode-productivity-plugin` path from your global OpenCode plugin config.

### Packaged global install

For a non-editable package artifact, install the package through OpenCode:

```sh
npm run build
npm pack
opencode plugin -g ./opencode-productivity-plugin-0.1.0.tgz --force
```

The package exposes separate OpenCode entrypoints:

- `opencode-productivity-plugin/server`
- `opencode-productivity-plugin/tui`

OpenCode v2 loads both entrypoints of a package plugin registered through `opencode plugin`. If prompt history commands such as `ctrl+r` or `/oc-history` do not appear after a packaged install, run `opencode plugin list` and check the server log under `~/.local/share/opencode/log/` for plugin load errors.

For local project development, this repo uses explicit file wrappers in `.opencode/` instead of the package spec above.

## Tools

- `ScheduleWakeup`: schedule a one-shot or repeated reminder with a required short unique `name` plus exactly one of `runAt` or `delaySeconds`.
- `ListWakeups`: list active and recently fired wakeups, including name, ID, run time, and due timing.
- `CancelWakeup`: cancel a wakeup by `id` or `name`.
- `RunInBackground`: start a non-interactive shell command with a required short unique `name`. The tool notifies the originating session when the command finishes, so a separate wakeup is usually unnecessary just to check completion.
- `BackgroundStatus`: inspect one background command by `id` or `name`, including process metadata, runtime, and whether output is available.
- `PullBackgroundOutput`: read retained stdout/stderr from a running or completed background command by `id` or `name`, using `lineOffset` plus `limit`, or `tail`. If requested lines have been omitted from memory, the response includes an explanatory `message` plus `availableLineRanges`.
- `ListBackgroundCommands`: list background command status.
- `CancelBackgroundCommand`: terminate a running command by `id` or `name`.

Wakeup/background launch names must be unique within the active OpenCode process and 40 characters or fewer; duplicate names fail. Wakeup tool responses include `currentLocalTime` with local display time, timezone, and epoch milliseconds so the model can reason about relative schedules without guessing the user’s clock. Background command status responses include name, ID, `processStatus`, `runtimeMs`, `runtimeSeconds`, `outputAvailable`, and `outputRetention`; stdout/stderr text is read through `PullBackgroundOutput`.

For a one-time wakeup, omit `repeatSeconds` or pass `repeatSeconds: 0`. For a repeated wakeup, pass a positive `repeatSeconds`; positive repeat intervals shorter than 60 seconds are rejected. Example one-time relative wakeup:

```json
{
  "name": "wakeup-2min-test",
  "message": "2 minute test wakeup fired.",
  "delaySeconds": 120,
  "repeatSeconds": 0,
  "label": "2min test"
}
```

State is intentionally in-memory and tied to the active OpenCode process, not isolated per session. Each wakeup/background command records the originating `sessionID` so wakeup messages, completion summaries, and user cancellation notices can be delivered back to that session best-effort. List/status/cancel APIs operate over the active plugin process state. Background stdout/stderr is memory-only: each stream keeps up to 1 MiB total, split between a head buffer and a tail buffer so both startup output and recent output remain visible after the limit is exceeded. `maxOutputBytes` can lower that per-command stream limit, but values above 1 MiB are rejected. `outputRetention.totalBytes` is the counter for the total stream size observed, including omitted bytes. No stdout/stderr temp files are written by the background tools, and the TUI status snapshot omits captured stdout/stderr. In the TUI, `/new` clears wakeups, kills running background processes, and clears background history/output for the plugin instance associated with the current session.

## Tests

Run the fast deterministic suite:

```sh
npm run check
```

Run the real OpenCode/model integration suite:

```sh
npm run test:opencode
```

That suite calls `opencode run --format json` and asks the configured model to invoke every LLM-callable tool:

- `ScheduleWakeup`, `ListWakeups`, `CancelWakeup`
- `RunInBackground`, `BackgroundStatus`, `PullBackgroundOutput`, `ListBackgroundCommands`, `CancelBackgroundCommand`

The background integration test writes a temporary shell script that emits stdout and stderr, sleeps while still running, then emits final output. The model must start that script with `RunInBackground` using a unique name, pull the intermediate stdout/stderr with `PullBackgroundOutput`, inspect/list state by name or ID, and cancel the process. Set `OPENCODE_REAL_MODEL=provider/model` to override the model and `OPENCODE_REAL_MODEL_TIMEOUT_MS=180000` to adjust each test timeout.

Run only the real TUI prompt-history search integration test:

```sh
npm run build
OPENCODE_TUI_TESTS=1 node dist/tests/opencode-tools.integration.test.js
```

That test first reads prompt history from the current OpenCode system to verify history lookup is available, then creates a deterministic temporary SQLite history fixture, opens the real OpenCode TUI in a pseudo-terminal, opens the Prompt History dialog with `ctrl+r` or `/oc-history`, submits a query that matches nothing, then submits a query for a deeply buried fixture prompt and asserts that the custom scorer surfaces it in the results dialog.

## TUI history search

The TUI plugin registers a `Search Prompt History` palette command with slash aliases through OpenCode v2's keymap layer.

Open the command palette and choose `Search Prompt History`, press `ctrl+r` (the plugin binds it, overriding the default `session_rename` shortcut), or run `/oc-history`. The dialog re-ranks matches on every keystroke with the custom scorer; `↑`/`↓` move the selection, `enter` copies the selected prompt to the clipboard (OSC52, since OpenCode v2 does not expose a composer-insertion API), and `esc` closes. If the custom overlay is unavailable, it falls back to a two-step prompt/select flow using the host dialogs.

Search indexes at most the 4,096 most recent manually entered prompts and gives the dialog only the best 100 current matches to keep burst typing responsive. System messages, synthetic plugin notifications, and synthetic file-attachment expansions are excluded.

### Markdown and LaTeX preview

The TUI command `/oc-preview` renders the latest assistant response as themed Markdown and opens it in a new tmux window, displayed through the local Kitty terminal. Inline LaTeX can use `$...$` or `\(...\)`, and display LaTeX can use `$$...$$` or `\[...\]`; expressions supported by Pandoc MathML render with the surrounding Markdown, including headings, lists, tables, blockquotes, code blocks, and local images. Responses are split into terminal-shaped pages at a consistent readable scale. Page boundaries prefer blank space between Markdown blocks and repeat about three lines of text context; images, code blocks, tables, and display math restart cleanly after the gap. Unusually tall blocks fall back to a fixed-height break. Use `j`/`k` (or the arrow keys) to change pages, `r` to redraw, and `q` or Esc to close the preview window.

Preview prerequisites:

- `pandoc` on `PATH`, or `PANDOC_PATH` pointing to the executable
- a Chromium-based browser at a standard system path, or `PUPPETEER_EXECUTABLE_PATH`
- OpenCode running inside tmux 3.3 or newer, with `set -g allow-passthrough on`
- Kitty as the local terminal at the end of the SSH connection
- `tmux` on the remote `PATH`, or `OPENCODE_PREVIEW_TMUX` pointing to the tmux executable
- Node.js on `PATH`, or `OPENCODE_PREVIEW_NODE` pointing to the Node.js executable

Before launching, `/oc-preview` runs one centralized environment preflight for tmux membership, tmux 3.3+, pane passthrough, unsupported nested tmux, Node.js, Pandoc, and Chromium. The result—including a failure—is cached for the lifetime of that process, so later preview calls perform no repeated probes. The standalone viewer runs the same cached preflight in its own process and leaves any actionable failure message visible in its tmux window.

Kitty does not need to be installed on the remote machine. The plugin serializes the Markdown, resolved OpenCode palette, and resource directory; compresses the payload with maximum-quality Brotli; and passes its base64url representation as the viewer's command-line argument. The viewer owns Markdown conversion, Chromium rasterization, paging, keyboard input, and Kitty output. It loads all rendered pages into memory and removes its temporary render directory before presenting the first page.

PNG data is sent inline through tmux and the existing terminal connection; this implementation assumes a single tmux layer. The viewer uses Kitty Unicode-placeholder placements, allowing tmux to hide, restore, clip, and redraw the image with its owning pane. Chromium's sandbox remains enabled. CLI payloads are capped at 96 KiB to stay below common per-argument operating-system limits. Command-line arguments may be visible to other processes owned by the same user, so `/oc-preview` should not be used for responses containing secrets on an untrusted shared account. The rasterization core is adapted from `pi-markdown-preview`; see `THIRD_PARTY_NOTICES.md`.

To test the viewer directly from a tmux pane with the included sample:

```sh
./scripts/test-preview.sh
```

Pass another Markdown file as the first argument to test custom content:

```sh
./scripts/test-preview.sh path/to/document.md
```

The keymap binding for `ctrl+r` takes precedence over OpenCode's default `session_rename` shortcut while the plugin's layer is active.

The command also registers the TUI slash alias:

```text
/oc-history
```

Selecting an entry appends it to the current prompt editor without sending a message to the LLM.

## TUI status

The TUI shows productivity state in the right/sidebar panel:

- scheduled wakeups
- recent background commands
- command status and timing details

Use `/oc-wakeups` to view or cancel scheduled wakeups. Use `/oc-background` to view background commands, read retained stdout/stderr tails, or cancel a running command. `/new` clears wakeups, kills running background commands, and clears background history for the plugin instance associated with the current session.

Status is best-effort and updates while OpenCode is running. The TUI owns a Unix-domain socket keyed by the project path and the shared OpenCode process ID. Server plugin instances in that process discover the socket and push live status snapshots; session IDs select the correct in-memory plugin peer. Tool state remains in memory for the active OpenCode process, and captured stdout/stderr is not written to project files. If no plugin instance is associated with the current session yet, TUI management actions may be unavailable until that session uses one of the wakeup/background tools.
