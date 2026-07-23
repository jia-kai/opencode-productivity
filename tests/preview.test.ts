import test from "node:test"
import assert from "node:assert/strict"
import { latestAssistantMarkdown, previewPalette } from "../src/preview-support.js"
import { decodePreviewPayload, encodePreviewPayload } from "../src/preview-payload.js"
import { previewTmuxArgs, tmuxPassthrough } from "../src/preview-tmux.js"
import {
  createKittyVirtualPlacement,
  deleteKittyImage,
  kittyPlaceholderGrid,
  transmitKittyPng,
} from "../src/kitty-graphics.js"
import { previewPageLayout } from "../src/preview-layout.js"
import { PreviewEnvironmentError, tmuxVersionSupported } from "../src/preview-environment.js"
import { PANDOC_MARKDOWN_FORMAT } from "../src/vendor/pi-markdown-preview.js"

function color(red: number, green: number, blue: number, alpha = 255) {
  return { toInts: () => [red, green, blue, alpha] as [number, number, number, number] }
}

test("latestAssistantMarkdown returns text parts from the newest assistant message", () => {
  const parts = new Map([
    ["assistant-old", [{ type: "text", text: "old" }]],
    ["assistant-new", [{ type: "text", text: "new" }, { type: "tool", text: "hidden" }, { type: "text", text: "answer" }]],
  ])
  const api = {
    route: { current: { name: "session", params: { sessionID: "session-1" } } },
    state: {
      session: {
        messages: () => [
          { id: "assistant-old", role: "assistant" },
          { id: "user", role: "user" },
          { id: "assistant-new", role: "assistant" },
        ],
      },
      part: (id: string) => parts.get(id) ?? [],
    },
  }
  assert.equal(latestAssistantMarkdown(api), "new\n\nanswer")
})

test("previewPalette maps resolved OpenCode colors to CSS and detects light mode", () => {
  const api = {
    theme: {
      current: {
        background: color(250, 250, 250),
        backgroundPanel: color(245, 245, 245),
        backgroundElement: color(235, 235, 235),
        text: color(20, 20, 20),
        markdownText: color(30, 30, 30),
        markdownHeading: color(0, 80, 180),
        markdownLink: color(0, 100, 200),
        markdownCode: color(120, 30, 90),
        markdownBlockQuote: color(80, 80, 80),
        textMuted: color(100, 100, 100),
        border: color(200, 200, 200),
        accent: color(20, 120, 220),
        error: color(200, 20, 20),
        warning: color(180, 120, 0),
        success: color(20, 140, 60),
      },
    },
  }
  const palette = previewPalette(api)
  assert.equal(palette.mode, "light")
  assert.equal(palette.background, "rgba(250,250,250,1)")
  assert.equal(palette.heading, "rgba(0,80,180,1)")
})

test("previewTmuxArgs safely quotes the viewer shell command expected by tmux", () => {
  assert.deepEqual(
    previewTmuxArgs("/opt/node with spaces", "/plugin/preview window.js", "payload'with-quote"),
    [
      "new-window",
      "-n",
      "oc-preview",
      `'/opt/node with spaces' '/plugin/preview window.js' 'payload'\"'\"'with-quote'`,
    ],
  )
})

test("tmuxPassthrough wraps Kitty commands and doubles embedded escapes", () => {
  assert.equal(
    tmuxPassthrough("\u001b_Ga=d\u001b\\"),
    "\u001bPtmux;\u001b\u001b_Ga=d\u001b\u001b\\\u001b\\",
  )
})

test("preview payload survives maximum-quality Brotli and base64url transport", () => {
  const payload = {
    markdown: "# Result\n\n$e^{i\\pi}+1=0$\n".repeat(100),
    palette: {
      mode: "dark" as const,
      background: "#000",
      panel: "#111",
      element: "#222",
      text: "#eee",
      muted: "#999",
      heading: "#fff",
      link: "#0af",
      code: "#fa0",
      quote: "#aaa",
      border: "#333",
      accent: "#0ff",
      error: "#f00",
      warning: "#ff0",
      success: "#0f0",
    },
    resourcePath: "/workspace/project",
  }
  const encoded = encodePreviewPayload(payload)
  assert.match(encoded, /^[A-Za-z0-9_-]+$/)
  assert.deepEqual(decodePreviewPayload(encoded), payload)
})

test("preview Pandoc input supports dollar and backslash LaTeX delimiters", () => {
  assert.match(PANDOC_MARKDOWN_FORMAT, /\+tex_math_dollars/)
  assert.match(PANDOC_MARKDOWN_FORMAT, /\+tex_math_single_backslash/)
})

test("Kitty graphics use a tmux-safe virtual placement and Unicode placeholder grid", () => {
  const transmitted = transmitKittyPng(Buffer.from("png"), 42)
  assert.match(transmitted, /a=t,f=100,i=42,q=2,m=0/)
  assert.match(createKittyVirtualPlacement(42, 2, 2), /a=p,U=1,i=42,c=2,r=2,q=2/)
  assert.equal(
    kittyPlaceholderGrid(42, 2, 2),
    "\u001b[38;2;0;0;42m\u{10eeee}\u0305\u{10eeee}\u001b[39m\n"
      + "\u001b[38;2;0;0;42m\u{10eeee}\u030d\u{10eeee}\u001b[39m",
  )
  assert.match(deleteKittyImage(42), /a=d,d=I,i=42,q=2/)
})

test("preview pages keep the same horizontal scale when the last page is shorter", () => {
  const fullPage = previewPageLayout(2400, 1800, 1800, 100, 36)
  const shortPage = previewPageLayout(2400, 600, 1800, 100, 36)
  assert.equal(fullPage.columns, 96)
  assert.equal(shortPage.columns, 96)
  assert.equal(fullPage.rows, 36)
  assert.equal(shortPage.rows, 12)
})

test("preview environment diagnostics parse supported tmux versions and centralize messages", () => {
  assert.equal(tmuxVersionSupported("tmux 3.3"), true)
  assert.equal(tmuxVersionSupported("tmux 3.7b"), true)
  assert.equal(tmuxVersionSupported("tmux 3.2a"), false)
  assert.equal(tmuxVersionSupported("not tmux"), false)
  const error = new PreviewEnvironmentError(["Pandoc is missing.", "Nested tmux is unsupported."])
  assert.equal(
    error.message,
    "Preview environment is not ready:\n- Pandoc is missing.\n- Nested tmux is unsupported.",
  )
})
