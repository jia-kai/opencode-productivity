import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = process.cwd()
const linkDirectory = path.join(root, ".global-opencode-productivity-plugin")
const serverModule = pathToFileURL(path.join(root, "dist/src/server.js")).href
const tuiModule = pathToFileURL(path.join(root, "dist/src/tui.js")).href

await mkdir(linkDirectory, { recursive: true })

await writeFile(
  path.join(linkDirectory, "package.json"),
  `${JSON.stringify(
    {
      name: "opencode-productivity-plugin-dev-link",
      version: "0.0.0",
      private: true,
      type: "module",
      main: "./server.js",
      exports: {
        "./server": "./server.js",
        "./tui": "./tui.js",
      },
    },
    null,
    2,
  )}\n`,
)

await writeFile(
  path.join(linkDirectory, "server.js"),
  `export { default, server } from ${JSON.stringify(serverModule)}\n`,
)

await writeFile(
  path.join(linkDirectory, "tui.js"),
  `export { default, id, tui } from ${JSON.stringify(tuiModule)}\n`,
)
