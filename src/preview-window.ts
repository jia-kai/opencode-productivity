import { decodePreviewPayload } from "./preview-payload.js"
import { checkPreviewEnvironment } from "./preview-environment.js"
import { previewPageLayout } from "./preview-layout.js"
import {
  createKittyVirtualPlacement,
  deleteKittyImage,
  kittyPlaceholderGrid,
  MAX_PLACEHOLDER_ROWS,
  transmitKittyPng,
} from "./kitty-graphics.js"
import { rasterizeMarkdown } from "./vendor/pi-markdown-preview.js"
import { readFile, rm } from "node:fs/promises"

interface PreviewPage {
  data: Buffer
  width: number
  height: number
}

const encodedPayload = process.argv[2]
if (!encodedPayload) throw new Error("Preview payload is required")

let pages: PreviewPage[] = []
let truncated = false
let index = 0
let imageID = 900_000
let displayedImageID: number | undefined
let closing = false

function pngSize(data: Buffer): { width: number; height: number } {
  if (data.length < 24 || data.toString("ascii", 1, 4) !== "PNG") return { width: 1200, height: 900 }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  }
}

function render(): void {
  if (pages.length === 0) return
  const page = pages[index]
  const maxColumns = Math.max(20, (process.stdout.columns ?? 100) - 2)
  const maxRows = Math.max(5, Math.min((process.stdout.rows ?? 40) - 4, MAX_PLACEHOLDER_ROWS))
  const referenceHeight = Math.max(...pages.map((candidate) => candidate.height))
  const { columns, rows } = previewPageLayout(
    page.width,
    page.height,
    referenceHeight,
    maxColumns,
    maxRows,
  )
  imageID += 1
  const previousImageID = displayedImageID
  displayedImageID = imageID
  process.stdout.write(`${previousImageID === undefined ? "" : deleteKittyImage(previousImageID)}\u001b[2J\u001b[H`)
  process.stdout.write(`OpenCode Markdown preview — ${index + 1}/${pages.length}${truncated ? " (truncated)" : ""}  j/k page  r redraw  q close\n\n`)
  process.stdout.write(transmitKittyPng(page.data, imageID))
  process.stdout.write(createKittyVirtualPlacement(imageID, columns, rows))
  process.stdout.write(kittyPlaceholderGrid(imageID, columns, rows))
}

function close(exitCode = 0): void {
  if (closing) return
  closing = true
  process.stdout.write(`${displayedImageID === undefined ? "" : deleteKittyImage(displayedImageID)}\u001b[2J\u001b[H\u001b[?25h`)
  process.stdin.setRawMode?.(false)
  process.exit(exitCode)
}

async function main(): Promise<void> {
  process.stdout.write("\u001b[?25l\u001b[2J\u001b[HRendering Markdown and LaTeX preview…\n")
  await checkPreviewEnvironment()
  const payload = decodePreviewPayload(encodedPayload)
  const rendered = await rasterizeMarkdown(payload.markdown, payload.palette, {
    resourcePath: payload.resourcePath,
    fontSize: 20,
  })
  try {
    pages = await Promise.all(rendered.pages.map(async (pagePath) => {
      const data = Buffer.from(await readFile(pagePath))
      return { data, ...pngSize(data) }
    }))
    truncated = rendered.truncated
  } finally {
    await rm(rendered.directory, { recursive: true, force: true })
  }

  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (key: string) => {
    if (key === "q" || key === "\u0003" || key === "\u001b") close()
    else if ((key === "\u001b[C" || key === "\u001b[B" || key === "j" || key === "l") && index < pages.length - 1) {
      index += 1
      render()
    } else if ((key === "\u001b[D" || key === "\u001b[A" || key === "k" || key === "h") && index > 0) {
      index -= 1
      render()
    } else if (key === "r") render()
  })
  process.stdout.on("resize", render)
  process.on("SIGTERM", () => close())
  process.on("SIGHUP", () => close())
  render()
}

void main().catch((error) => {
  process.stdout.write(`\nPreview failed: ${error instanceof Error ? error.message : String(error)}\n\nPress q to close.\n`)
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (key: string) => {
    if (key === "q" || key === "\u0003" || key === "\u001b") close(1)
  })
})
