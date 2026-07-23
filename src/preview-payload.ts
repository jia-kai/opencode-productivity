import type { PreviewPalette } from "./vendor/pi-markdown-preview.js"
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib"

export const MAX_PREVIEW_CLI_PAYLOAD_LENGTH = 96 * 1024

export interface PreviewPayload {
  markdown: string
  palette: PreviewPalette
  resourcePath?: string
}

export function encodePreviewPayload(payload: PreviewPayload): string {
  const compressed = brotliCompressSync(Buffer.from(JSON.stringify(payload)), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
    },
  })
  return compressed.toString("base64url")
}

export function decodePreviewPayload(encoded: string): PreviewPayload {
  const decoded = brotliDecompressSync(Buffer.from(encoded, "base64url"))
  const payload = JSON.parse(decoded.toString("utf8")) as Partial<PreviewPayload>
  if (typeof payload.markdown !== "string" || !payload.palette || typeof payload.palette !== "object") {
    throw new Error("Invalid preview payload")
  }
  if (payload.resourcePath !== undefined && typeof payload.resourcePath !== "string") {
    throw new Error("Invalid preview resource path")
  }
  return payload as PreviewPayload
}
