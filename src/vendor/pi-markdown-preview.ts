/*
 * Markdown rasterization adapted from pi-markdown-preview 0.10.0:
 * https://github.com/omaclaren/pi-markdown-preview
 *
 * Copyright Earendil Inc. & contributors. Used under the MIT License; see
 * THIRD_PARTY_NOTICES.md. This extraction intentionally excludes Pi UI,
 * annotations, PDF export, and browser-preview commands.
 */
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import puppeteer from "puppeteer-core"
import { findPreviewBrowser } from "../preview-environment.js"

const VIEWPORT_WIDTH = 1200
const PAGE_HEIGHT = 900
const MAX_HEIGHT = 60_000

export interface PreviewPalette {
  mode: "dark" | "light"
  background: string
  panel: string
  element: string
  text: string
  muted: string
  heading: string
  link: string
  code: string
  quote: string
  border: string
  accent: string
  error: string
  warning: string
  success: string
}

export interface RasterizedPreview {
  directory: string
  pages: string[]
  truncated: boolean
}

export async function rasterizeMarkdown(
  markdown: string,
  palette: PreviewPalette,
  options: { resourcePath?: string; fontSize?: number; signal?: AbortSignal } = {},
): Promise<RasterizedPreview> {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-preview-"))
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined
  try {
    const fragment = await pandocHtml(markdown, options.resourcePath)
    const html = previewHtml(fragment, palette, options.resourcePath, options.fontSize ?? 16)
    const htmlPath = path.join(directory, "preview.html")
    await writeFile(htmlPath, html, "utf8")

    const executablePath = findPreviewBrowser()
    if (!executablePath) {
      throw new Error("No Chromium-based browser found. Install Chromium or set PUPPETEER_EXECUTABLE_PATH.")
    }
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--disable-gpu", "--font-render-hinting=medium"],
    })
    const page = await browser.newPage()
    await page.setViewport({ width: VIEWPORT_WIDTH, height: 900, deviceScaleFactor: 2 })
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" })
    await page.evaluate(async () => {
      if ("fonts" in document) await document.fonts.ready
    })
    if (options.signal?.aborted) throw new Error("Preview rendering cancelled")

    const contentHeight = await page.evaluate(() => {
      const root = document.getElementById("preview-root")
      return root ? Math.ceil(root.getBoundingClientRect().height + 48) : 900
    })
    const height = Math.max(500, Math.min(MAX_HEIGHT, contentHeight))
    await page.setViewport({ width: VIEWPORT_WIDTH, height, deviceScaleFactor: 2 })
    const count = Math.max(1, Math.ceil(height / PAGE_HEIGHT))
    const pages: string[] = []
    for (let index = 0; index < count; index++) {
      if (options.signal?.aborted) throw new Error("Preview rendering cancelled")
      const output = path.join(directory, `page-${index + 1}.png`)
      await page.screenshot({
        path: output,
        type: "png",
        clip: {
          x: 0,
          y: index * PAGE_HEIGHT,
          width: VIEWPORT_WIDTH,
          height: Math.min(PAGE_HEIGHT, height - index * PAGE_HEIGHT),
        },
      })
      pages.push(output)
    }
    return { directory, pages, truncated: contentHeight > MAX_HEIGHT }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  } finally {
    await browser?.close().catch(() => undefined)
  }
}

async function pandocHtml(markdown: string, resourcePath?: string): Promise<string> {
  const command = process.env.PANDOC_PATH?.trim() || "pandoc"
  const args = [
    "-f",
    "markdown+lists_without_preceding_blankline-blank_before_blockquote-blank_before_header+tex_math_dollars+autolink_bare_uris-raw_html",
    "-t",
    "html5",
    "--mathml",
    "--wrap=none",
  ]
  if (resourcePath) args.push(`--resource-path=${resourcePath}`)
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(Buffer.from(chunk)))
    child.once("error", (error: Error & { code?: string }) => {
      reject(error.code === "ENOENT"
        ? new Error("Pandoc was not found. Install pandoc or set PANDOC_PATH.")
        : error)
    })
    child.once("close", (code: number | null) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"))
      else reject(new Error(`Pandoc failed${code === null ? "" : ` with exit code ${code}`}: ${Buffer.concat(stderr).toString("utf8").trim()}`))
    })
    child.stdin.end(markdown)
  })
}

function previewHtml(fragment: string, palette: PreviewPalette, resourcePath: string | undefined, fontSize: number): string {
  const base = resourcePath ? `<base href="${escapeHtml(pathToFileURL(`${path.resolve(resourcePath)}/`).href)}">` : ""
  return `<!doctype html>
<html><head><meta charset="utf-8">${base}<style>
:root {
  color-scheme: ${palette.mode};
  --bg:${palette.background};--panel:${palette.panel};--element:${palette.element};
  --text:${palette.text};--muted:${palette.muted};--heading:${palette.heading};
  --link:${palette.link};--code:${palette.code};--quote:${palette.quote};
  --border:${palette.border};--accent:${palette.accent};--error:${palette.error};
  --warning:${palette.warning};--success:${palette.success};
}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text)}
body{padding:28px;font:${fontSize}px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#preview-root{max-width:1100px;margin:auto;padding:28px;background:var(--panel);border:1px solid var(--border);border-radius:12px}
h1,h2,h3,h4,h5,h6{color:var(--heading);line-height:1.25}a{color:var(--link)}
pre,code{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
code{color:var(--code);background:var(--element);padding:.12em .3em;border-radius:4px}
pre{padding:14px;overflow:auto;background:var(--element);border:1px solid var(--border);border-radius:8px}
pre code{padding:0;background:none}.co{color:var(--muted);font-style:italic}.kw,.cf{color:var(--accent)}
.st,.ch{color:var(--success)}.dv,.bn,.fl{color:var(--warning)}.er,.al{color:var(--error)}
blockquote{margin-left:0;padding:.25em 1em;color:var(--quote);border-left:4px solid var(--accent)}
table{border-collapse:collapse;display:block;max-width:100%;overflow:auto}th,td{padding:7px 12px;border:1px solid var(--border)}
th{background:var(--element)}hr{border:0;border-top:1px solid var(--border)}img,svg{max-width:100%;height:auto}
math[display="block"]{display:block;margin:1em 0;overflow-x:auto}strong{font-weight:700}em{font-style:italic}
</style></head><body><article id="preview-root">${fragment}</article></body></html>`
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}
