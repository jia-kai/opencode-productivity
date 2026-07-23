import { tmuxPassthrough } from "./preview-tmux.js"

const PLACEHOLDER = String.fromCodePoint(0x10eeee)
const ROW_DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f,
  0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357,
  0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
  0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484,
  0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
  0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
  0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
  0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658,
].map((codePoint) => String.fromCodePoint(codePoint))

export const MAX_PLACEHOLDER_ROWS = ROW_DIACRITICS.length

export function transmitKittyPng(data: Buffer, imageID: number): string {
  const payload = data.toString("base64")
  const chunks: string[] = []
  for (let offset = 0; offset < payload.length; offset += 4096) chunks.push(payload.slice(offset, offset + 4096))
  return chunks.map((chunk, chunkIndex) => {
    const more = chunkIndex < chunks.length - 1 ? 1 : 0
    const control = chunkIndex === 0
      ? `a=t,f=100,i=${imageID},q=2,m=${more}`
      : `m=${more},q=2`
    return tmuxPassthrough(`\u001b_G${control};${chunk}\u001b\\`)
  }).join("")
}

export function createKittyVirtualPlacement(imageID: number, columns: number, rows: number): string {
  return tmuxPassthrough(`\u001b_Ga=p,U=1,i=${imageID},c=${columns},r=${rows},q=2\u001b\\`)
}

export function deleteKittyImage(imageID: number): string {
  return tmuxPassthrough(`\u001b_Ga=d,d=I,i=${imageID},q=2\u001b\\`)
}

export function kittyPlaceholderGrid(imageID: number, columns: number, rows: number): string {
  const red = (imageID >> 16) & 0xff
  const green = (imageID >> 8) & 0xff
  const blue = imageID & 0xff
  const color = `\u001b[38;2;${red};${green};${blue}m`
  const reset = "\u001b[39m"
  const width = Math.max(1, columns)
  const height = Math.max(1, Math.min(rows, MAX_PLACEHOLDER_ROWS))
  const lines: string[] = []
  for (let row = 0; row < height; row++) {
    lines.push(`${color}${PLACEHOLDER}${ROW_DIACRITICS[row]}${PLACEHOLDER.repeat(width - 1)}${reset}`)
  }
  return lines.join("\n")
}
