import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"
import os from "node:os"

const root = fileURLToPath(new URL("..", import.meta.url))
const pluginPath = path.join(root, ".global-opencode-productivity-plugin")
const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json")

const config = JSON.parse(readFileSync(configPath, "utf8"))
const plugin = Array.isArray(config.plugin) ? config.plugin : []

if (plugin.includes(pluginPath)) {
  console.log(`${pluginPath} already registered in ${configPath}`)
} else {
  config.plugin = [...plugin, pluginPath]
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n")
  console.log(`Registered ${pluginPath} in ${configPath}`)
}
