# OpenCode Productivity Plugin

Scheduled wakeups, background command management, and prompt history search for OpenCode 2.

## Install

Requires a Unix-like system, OpenCode 2.0.16, and Node.js 26 or newer.

```sh
git clone https://github.com/jia-kai/opencode-productivity.git
cd opencode-productivity
npm install
npm run link
opencode
```

`npm run link` builds the plugin, installs it globally, and restarts the OpenCode background service. Restart any open OpenCode TUI afterward. Keep this checkout in place: the installed plugin points to its compiled files. To apply source updates, run `npm run link` again.

## Tools

### Wakeups

Ask the agent to resume a task later—for example, “Check the build again in five minutes.” Wakeups send a message to the session that scheduled them and can run once or repeat.

| Agent tool               | Purpose                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `ScheduleWakeup`         | Schedule by time (`runAt`) or delay (`delaySeconds`), with optional `repeatSeconds`. |
| `ListWakeups`            | Show wakeups and their status.                                                       |
| `CancelWakeup`           | Cancel a wakeup by ID or name.                                                       |

Active timers appear in the sidebar. Use `/oc-timers` to view or cancel them. Timers are lost when the OpenCode server stops.

### Background commands

Run a command with OpenCode's built-in `shell` tool using `background: true`, or press `Ctrl+B` while a shell command is running. Running commands appear in the sidebar and in the agent's context.

| Agent tool               | Purpose                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------ |
| `ListBackgroundCommands` | List the current session's running commands, shell IDs, PIDs, and output files.      |
| `KillBackgroundCommand`  | Stop a command and its process tree by shell ID.                                     |

Use `/oc-background` to view commands and stop one after confirmation. Stopping a command also deletes its captured output file.

Background management requires the normal OpenCode background service; `--standalone` servers are unsupported. Only commands observed while the plugin is active are tracked. Processes detached by scripts with `&` are not managed.

### Prompt history

Press `Ctrl+R` or enter `/oc-history words to find` to search previous prompts. Search uses complete words and requires every word to match. Results appear newest first; selecting one inserts it into the composer for editing without sending it.

Search covers up to 4,096 recent manually entered prompts in the local OpenCode database, even when connected to a remote server. Set `OPENCODE_HISTORY_DB` to use a different database path.

