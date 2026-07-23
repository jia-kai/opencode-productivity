import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

export interface PreviewEnvironment {
  node: string
  tmux: string
  pandoc: string
  browser: string
}

export class PreviewEnvironmentError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Preview environment is not ready:\n${problems.map((problem) => `- ${problem}`).join("\n")}`)
    this.name = "PreviewEnvironmentError"
  }
}

let cachedEnvironment: Promise<PreviewEnvironment> | undefined

export function checkPreviewEnvironment(): Promise<PreviewEnvironment> {
  cachedEnvironment ??= inspectPreviewEnvironment()
  return cachedEnvironment
}

export function findPreviewBrowser(): string | undefined {
  const configured = process.env.PUPPETEER_EXECUTABLE_PATH ?? process.env.CHROME_PATH
  if (configured && existsSync(configured)) return configured
  const candidates = process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium",
      ]
  return candidates.find(existsSync)
}

export function tmuxVersionSupported(output: string): boolean {
  const match = /\btmux\s+(\d+)\.(\d+)/i.exec(output)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 3 || (major === 3 && minor >= 3)
}

async function inspectPreviewEnvironment(): Promise<PreviewEnvironment> {
  const problems: string[] = []
  const node = process.env.OPENCODE_PREVIEW_NODE?.trim() || "node"
  const tmux = process.env.OPENCODE_PREVIEW_TMUX?.trim() || "tmux"
  const pandoc = process.env.PANDOC_PATH?.trim() || "pandoc"

  if (!process.env.TMUX) {
    problems.push("OpenCode must be running inside tmux.")
  }

  const [nodeResult, tmuxVersion, pandocResult, processTree] = await Promise.all([
    runCapture(node, ["--version"]),
    runCapture(tmux, ["-V"]),
    runCapture(pandoc, ["--version"]),
    runCapture("ps", ["-eo", "pid=,ppid=,comm="]),
  ])

  if (!nodeResult.ok) {
    problems.push(`Node.js is unavailable as "${node}". Set OPENCODE_PREVIEW_NODE to its executable.`)
  }
  if (!tmuxVersion.ok) {
    problems.push(`tmux is unavailable as "${tmux}". Set OPENCODE_PREVIEW_TMUX to its executable.`)
  } else if (!tmuxVersionSupported(tmuxVersion.stdout)) {
    problems.push(`tmux 3.3 or newer is required; found "${tmuxVersion.stdout.trim() || "unknown version"}".`)
  }
  if (!pandocResult.ok) {
    problems.push(`Pandoc is unavailable as "${pandoc}". Install it or set PANDOC_PATH.`)
  }

  if (process.env.TMUX && processTree.ok && tmuxAncestorCount(processTree.stdout, process.pid) > 1) {
    problems.push("Nested tmux sessions are not supported; run OpenCode in a single tmux layer.")
  }

  if (process.env.TMUX && tmuxVersion.ok && tmuxVersionSupported(tmuxVersion.stdout)) {
    const passthrough = await runCapture(tmux, ["show-options", "-g", "-v", "allow-passthrough"])
    const value = passthrough.stdout.trim()
    if (!passthrough.ok || (value !== "on" && value !== "all")) {
      problems.push('tmux graphics passthrough is disabled. Add "set -g allow-passthrough on" to tmux.conf and reload it.')
    }
  }

  const browser = findPreviewBrowser()
  if (!browser) {
    problems.push("No Chromium-based browser was found. Install Chromium or set PUPPETEER_EXECUTABLE_PATH.")
  }

  if (problems.length > 0) throw new PreviewEnvironmentError(problems)
  return { node, tmux, pandoc, browser: browser! }
}

function tmuxAncestorCount(processTable: string, startPID: number): number {
  const processes = new Map<number, { parent: number; command: string }>()
  for (const line of processTable.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    processes.set(Number(match[1]), { parent: Number(match[2]), command: match[3] })
  }
  let count = 0
  let pid = startPID
  const visited = new Set<number>()
  while (pid > 0 && !visited.has(pid)) {
    visited.add(pid)
    const entry = processes.get(pid)
    if (!entry) break
    if (/(^|\/)tmux(?:$|:)/.test(entry.command)) count += 1
    pid = entry.parent
  }
  return count
}

async function runCapture(command: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)))
    child.once("error", () => resolve({ ok: false, stdout: "" }))
    child.once("close", (code: number | null) => {
      resolve({ ok: code === 0, stdout: Buffer.concat(stdout).toString("utf8") })
    })
  })
}
