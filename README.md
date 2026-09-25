# OpenCode Productivity Plugin

OpenCode 2 plugin with scheduled wakeups and prompt history search.

## Development

Requires OpenCode 2.0.16 and Node 26 or newer.

```sh
npm install
npm run check
npm run link
opencode
```

`npm run link` builds this checkout and registers it with the global OpenCode 2 installation. Run it again after source changes, then restart any open TUI.

## Editable global install

```sh
npm run link
```

This builds the plugin, writes small server and TUI entrypoints under `~/.config/opencode/plugins/opencode-productivity-plugin/` (or `$XDG_CONFIG_HOME/opencode/plugins/`), and restarts the OpenCode background service. The entrypoints point to this checkout's `dist/` files, so future changes only need another `npm run link` and a TUI restart. The script refuses to replace files that it did not generate.

## Wakeups

The model can call `ScheduleWakeup`, `ListWakeups`, and `CancelWakeup`. A wakeup belongs to the session that scheduled it; when due, it sends a synthetic message to that session. Timers are kept in the OpenCode server process and are lost when that process stops.

The TUI shows active timers in the session sidebar. `/oc-timers` opens the full active timer list and lets you cancel one. The list uses OpenCode 2's plugin RPC, so it follows the connected server. No separate socket or background command process is used.

## Prompt history

Use `ctrl+r` or `/oc-history words to find` in the TUI. Queries require complete words, separated by spaces, and all words must appear in the prompt. Matching prompts are shown newest first. Selecting a prompt inserts it into the composer for review or editing, without submitting it. This uses the focused OpenTUI editor because OpenCode 2 does not expose a public composer insertion method. The command reads up to 4,096 recent manually entered prompts from OpenCode's local SQLite database; the word index filters those prompts in memory.

The history search reads the local database at `~/.local/share/opencode/opencode.db` or `OPENCODE_HISTORY_DB` when set. It is intended for a local TUI, including when the connected OpenCode server is remote.
