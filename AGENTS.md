# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript OpenCode productivity plugin. Core source lives in `src/`: server plugin entrypoints are in `server.ts` and `plugin.ts`, scheduling/background logic is split into modules such as `scheduler.ts`, `background.ts`, `delivery.ts`, and TUI code lives in `tui.tsx` plus `tui-command.ts`. Tests are in `tests/` and compile into `dist/tests/`. Project-local OpenCode wrappers and TUI config live under `.opencode/`; they point at compiled files in `dist/`, so rebuild after source edits. Editable global installs use the generated `.global-opencode-productivity-plugin/` package, which contains only entrypoint wrappers back to this checkout's compiled `dist/` files.

## Build, Test, and Development Commands

- `npm install`: install repo-local dependencies.
- `npm run build`: compile TypeScript with `tsc -p tsconfig.json` into `dist/`.
- `npm test`: run compiled tests with Node's built-in test runner (`dist/tests/*.test.js`).
- `npm run check`: build, then run the deterministic test suite.
- `npm run test:opencode`: build and run the real OpenCode/model integration test with `OPENCODE_REAL_MODEL_TESTS=1`.
- `npm run prepare:global-link`: generate `.global-opencode-productivity-plugin/` wrappers for editable global installs.
- `npm run link:global`: build, generate the dev-link package, and register it as a global editable OpenCode plugin.
- `npm run pack:dry`: inspect package contents before publishing or installing an artifact.

## Coding Style & Naming Conventions

Use strict TypeScript targeting ES2024 with NodeNext modules. Import local compiled modules with explicit `.js` suffixes, as in `import { WakeupScheduler } from "../src/scheduler.js"`. Follow the existing style: two-space indentation, double quotes, no semicolons, named exports for reusable modules, and concise type definitions in `src/types.ts`. Keep plugin tool names and user-visible command names stable unless tests and README examples are updated together.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name files `*.test.ts` under `tests/`, and keep deterministic unit coverage separate from real OpenCode/model integration behavior. Run `npm run check` before submitting ordinary changes. Use `npm run test:opencode` only when changes affect LLM-callable tools, OpenCode plugin wiring, or integration behavior; it depends on a configured real OpenCode environment.

## Commit & Pull Request Guidelines

Current history uses short imperative commit subjects, for example `Add OpenCode productivity plugin`. Keep commits focused and describe the behavior changed. Pull requests should include a brief summary, test results such as `npm run check`, and notes for any OpenCode/TUI behavior changes. Include screenshots or terminal captures when altering visible TUI output or command flows.

## Security & Configuration Tips

This project only supports Unix-like systems. The TUI owns a Unix-domain socket under the system temp directory and announces it through OpenCode's `tui.command.execute` event stream; server plugin instances connect back to that socket, push live status snapshots, and receive TUI action requests. Passive fallback sidebar status is still written under the temp runtime directory keyed by project path, and should not create project-local `.opencode` files. Active TUI action routing is session-scoped from connected peer snapshots, so multiple OpenCode instances in the same directory must not be collapsed into a shared instance. `/new` reset is scoped through TUI IPC only; do not reintroduce server-side `session.new` clearing in `tui-command.ts`. Background command output is retained in memory and tool state is process-scoped. Avoid committing generated `dist/`, `.global-opencode-productivity-plugin/`, local state snapshots, sockets, lock directories, secrets, or machine-specific OpenCode configuration unless the package manifest explicitly requires them.
