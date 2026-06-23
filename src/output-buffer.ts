export interface OutputBufferSnapshot {
  text: string
  maxBytes: number
  totalBytes: number
  totalLines: number
  retainedBytes: number
  omittedBytes: number
  truncated: boolean
  headBytes: number
  tailBytes: number
  headText: string
  tailText: string
  availableLineRanges: OutputLineRange[]
}

export interface OutputLineRange {
  startLine: number
  endLine: number
}

export class OutputBuffer {
  private readonly headLimit: number
  private readonly tailLimit: number
  private fullChunks: Buffer[] = []
  private fullBytes = 0
  private headChunks: Buffer[] = []
  private tailChunks: Buffer[] = []
  private headBytes = 0
  private tailBytes = 0
  private totalBytes = 0
  private totalNewlines = 0
  private hasOutput = false
  private endsWithNewline = false
  private truncated = false
  private tailStartsAtLineBoundary = true

  constructor(private readonly maxBytes: number) {
    this.headLimit = Math.floor(maxBytes / 2)
    this.tailLimit = maxBytes - this.headLimit
  }

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.totalBytes += buffer.length
    this.countLines(buffer)

    if (!this.truncated) {
      this.fullChunks.push(buffer)
      this.fullBytes += buffer.length
      if (this.fullBytes > this.maxBytes) this.convertToHeadTail()
      return
    }

    this.appendTail(buffer)
  }

  text(): string {
    return this.snapshot().text
  }

  snapshot(): OutputBufferSnapshot {
    const totalLines = this.totalLines()
    if (!this.truncated) {
      const text = Buffer.concat(this.fullChunks, this.fullBytes).toString("utf8")
      return {
        text,
        maxBytes: this.maxBytes,
        totalBytes: this.totalBytes,
        totalLines,
        retainedBytes: this.fullBytes,
        omittedBytes: 0,
        truncated: false,
        headBytes: Math.min(this.fullBytes, this.headLimit),
        tailBytes: this.fullBytes,
        headText: text.slice(0, this.headLimit),
        tailText: text,
        availableLineRanges: totalLines > 0 ? [{ startLine: 0, endLine: totalLines }] : [],
      }
    }

    const rawHead = Buffer.concat(this.headChunks, this.headBytes).toString("utf8")
    const rawTail = Buffer.concat(this.tailChunks, this.tailBytes).toString("utf8")
    const head = completeHeadText(rawHead)
    const tail = completeTailText(rawTail, this.tailStartsAtLineBoundary)
    const omittedBytes = Math.max(0, this.totalBytes - this.headBytes - this.tailBytes)
    const headLines = countTextLines(head)
    const tailLines = countTextLines(tail)
    const tailStartLine = Math.max(headLines, totalLines - tailLines)
    const availableLineRanges: OutputLineRange[] = [
      ...(headLines > 0 ? [{ startLine: 0, endLine: headLines }] : []),
      ...(tailLines > 0 ? [{ startLine: tailStartLine, endLine: totalLines }] : []),
    ]
    return {
      text: `${head}\n[... ${omittedBytes} bytes omitted ...]\n${tail}`,
      maxBytes: this.maxBytes,
      totalBytes: this.totalBytes,
      totalLines,
      retainedBytes: this.headBytes + this.tailBytes,
      omittedBytes,
      truncated: omittedBytes > 0,
      headBytes: this.headBytes,
      tailBytes: this.tailBytes,
      headText: head,
      tailText: tail,
      availableLineRanges,
    }
  }

  private convertToHeadTail(): void {
    const full = Buffer.concat(this.fullChunks, this.fullBytes)
    const head = Buffer.from(full.subarray(0, this.headLimit))
    const tailStart = Math.max(0, full.length - this.tailLimit)
    const tail = Buffer.from(full.subarray(tailStart))
    this.headChunks = head.length ? [head] : []
    this.tailChunks = tail.length ? [tail] : []
    this.headBytes = head.length
    this.tailBytes = tail.length
    this.tailStartsAtLineBoundary = tailStart === 0 || full[tailStart - 1] === 10
    this.fullChunks = []
    this.fullBytes = 0
    this.truncated = true
  }

  private appendTail(buffer: Buffer): void {
    if (this.tailLimit <= 0) return
    this.tailChunks.push(buffer)
    this.tailBytes += buffer.length
    while (this.tailBytes > this.tailLimit && this.tailChunks.length > 0) {
      const first = this.tailChunks[0]
      const overflow = this.tailBytes - this.tailLimit
      if (first.length <= overflow) {
        this.tailChunks.shift()
        this.tailBytes -= first.length
        this.tailStartsAtLineBoundary = first[first.length - 1] === 10
      } else {
        const removed = first.subarray(0, overflow)
        this.tailChunks[0] = Buffer.from(first.subarray(overflow))
        this.tailBytes -= overflow
        this.tailStartsAtLineBoundary = removed[removed.length - 1] === 10
      }
    }
  }

  private countLines(buffer: Buffer): void {
    if (buffer.length === 0) return
    const text = buffer.toString("utf8")
    this.hasOutput = true
    this.totalNewlines += text.match(/\n/g)?.length ?? 0
    this.endsWithNewline = text.endsWith("\n")
  }

  private totalLines(): number {
    if (!this.hasOutput) return 0
    return this.totalNewlines + (this.endsWithNewline ? 0 : 1)
  }
}

function countTextLines(text: string): number {
  if (!text) return 0
  if (text.endsWith("\n")) {
    const normalized = text.slice(0, -1)
    return normalized ? normalized.split(/\r?\n/).length : 1
  }
  return text.split(/\r?\n/).length
}

function completeHeadText(text: string): string {
  if (!text || text.endsWith("\n")) return text
  const lastNewline = text.lastIndexOf("\n")
  return lastNewline === -1 ? "" : text.slice(0, lastNewline + 1)
}

function completeTailText(text: string, startsAtLineBoundary: boolean): string {
  if (!text) return text
  if (startsAtLineBoundary) return text
  const firstNewline = text.indexOf("\n")
  return firstNewline === -1 ? "" : text.slice(firstNewline + 1)
}
