import type { PreviewPalette } from "./vendor/pi-markdown-preview.js"

export function latestAssistantMarkdown(api: any): string | undefined {
  const route = api.route?.current
  const sessionID = route?.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
  if (!sessionID) return undefined
  const messages = api.state?.session?.messages?.(sessionID)
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as Record<string, unknown>
    const info = typeof message.info === "object" && message.info ? message.info as Record<string, unknown> : message
    if (info.role !== "assistant") continue
    const id = typeof info.id === "string" ? info.id : typeof message.id === "string" ? message.id : undefined
    if (!id) continue
    const parts = api.state?.part?.(id)
    if (!Array.isArray(parts)) continue
    const text = parts
      .filter((part: unknown) => typeof part === "object" && part !== null && (part as Record<string, unknown>).type === "text")
      .map((part: unknown) => (part as Record<string, unknown>).text)
      .filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n\n")
    if (text) return text
  }
  return undefined
}

export function previewPalette(api: any): PreviewPalette {
  const theme = api.theme?.current ?? {}
  const background = cssColor(theme.background, "#101418")
  return {
    mode: luminance(theme.background) >= 0.5 ? "light" : "dark",
    background,
    panel: cssColor(theme.backgroundPanel, background),
    element: cssColor(theme.backgroundElement, cssColor(theme.backgroundPanel, background)),
    text: cssColor(theme.markdownText, cssColor(theme.text, "#d8dee9")),
    muted: cssColor(theme.textMuted, "#89929b"),
    heading: cssColor(theme.markdownHeading, cssColor(theme.primary, "#88c0d0")),
    link: cssColor(theme.markdownLink, cssColor(theme.accent, "#81a1c1")),
    code: cssColor(theme.markdownCode, "#a3be8c"),
    quote: cssColor(theme.markdownBlockQuote, cssColor(theme.textMuted, "#89929b")),
    border: cssColor(theme.border, "#3b4252"),
    accent: cssColor(theme.accent, cssColor(theme.primary, "#88c0d0")),
    error: cssColor(theme.error, "#bf616a"),
    warning: cssColor(theme.warning, "#ebcb8b"),
    success: cssColor(theme.success, "#a3be8c"),
  }
}

function colorInts(color: unknown): [number, number, number, number] | undefined {
  if (!color || typeof color !== "object") return undefined
  const value = color as { toInts?: () => [number, number, number, number]; r?: number; g?: number; b?: number; a?: number }
  if (typeof value.toInts === "function") return value.toInts()
  if ([value.r, value.g, value.b].every((channel) => typeof channel === "number")) {
    return [value.r!, value.g!, value.b!, typeof value.a === "number" ? value.a : 255]
  }
  return undefined
}

function cssColor(color: unknown, fallback: string): string {
  const values = colorInts(color)
  if (!values) return fallback
  const [red, green, blue, alpha] = values
  return `rgba(${red},${green},${blue},${Math.max(0, Math.min(1, alpha / 255))})`
}

function luminance(color: unknown): number {
  const values = colorInts(color)
  if (!values) return 0
  const convert = (channel: number) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * convert(values[0]) + 0.7152 * convert(values[1]) + 0.0722 * convert(values[2])
}
