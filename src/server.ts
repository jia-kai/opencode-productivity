import { tool, type Plugin } from "@opencode-ai/plugin"
import { createProductivityPlugin } from "./plugin.js"

export const server = createProductivityPlugin(tool) as unknown as Plugin

export default server
