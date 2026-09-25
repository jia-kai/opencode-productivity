# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript OpenCode 2 productivity plugin. Core source lives in `src/`: `server.ts` registers wakeup tools, `scheduler.ts` and `delivery.ts` handle timers, `rpc.ts` shares timer state with the TUI, `tui.tsx` renders commands and timer lists, and `history.ts` searches local prompt history. Tests are in `tests/` and compile into `dist/tests/`. `npm run link` installs small server and TUI wrappers in the global OpenCode plugins directory; they point at this checkout's compiled `dist/` files.

## Build, Test, and Development Commands

- `npm install`: install repo-local dependencies.
- `npm run build`: compile TypeScript with `tsc -p tsconfig.json` into `dist/`.
- `npm test`: run compiled tests with Node's built-in test runner (`dist/tests/*.test.js`).
- `npm run check`: build, then run the deterministic test suite.
- `npm run link`: build, install editable global OpenCode 2 wrappers, and restart the background service.
- `npm run pack:dry`: inspect package contents before publishing or installing an artifact.

## Coding Style & Naming Conventions

Use strict TypeScript targeting ES2024 with NodeNext modules. Import local compiled modules with explicit `.js` suffixes, as in `import { WakeupScheduler } from "../src/scheduler.js"`. Follow the existing style: two-space indentation, double quotes, no semicolons, and named exports for reusable modules. Keep plugin tool names and user-visible command names stable unless tests and README examples are updated together.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name files `*.test.ts` under `tests/`. Run `npm run check` before submitting ordinary changes. Manually verify changed OpenCode tool wiring and TUI behavior in a PTY.

## Commit & Pull Request Guidelines

Current history uses short imperative commit subjects, for example `Add OpenCode productivity plugin`. Keep commits focused and describe the behavior changed. Pull requests should include a brief summary, test results such as `npm run check`, and notes for any OpenCode/TUI behavior changes. Include screenshots or terminal captures when altering visible TUI output or command flows.

## Security & Configuration Tips

This project only supports Unix-like systems. Wakeup state is held in the OpenCode server process and shared with the TUI through OpenCode 2 plugin RPC. Prompt history reads the local OpenCode SQLite database. Global wrapper files are generated under the user's OpenCode config directory, outside the repository. Avoid committing generated `dist/`, local state snapshots, secrets, or machine-specific OpenCode configuration unless the package manifest explicitly requires them.
