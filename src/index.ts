import type { Plugin } from "@opencode/plugin"
import { setup } from "./v2.js"

/**
 * Pure OpenCode v2 entrypoint. The v2 server-side plugin loader cannot resolve
 * bare npm imports from compiled files, so this module (and everything it
 * pulls in) must only import node builtins, local modules, and host-resolved
 * `@opencode/*` packages. The v1 entrypoint stays in ./server.ts.
 */
export default {
  id: "opencode-productivity",
  setup,
} satisfies Plugin.Plugin
