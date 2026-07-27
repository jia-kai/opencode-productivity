export interface PreviewPageSlice {
  top: number
  height: number
}

export interface PreviewBreakCandidate {
  position: number
  nextPageTop?: number
}

export function previewPageSlices(
  contentHeight: number,
  breakCandidates: Array<number | PreviewBreakCandidate>,
  pageHeight: number,
  overlap: number,
): PreviewPageSlice[] {
  if (contentHeight <= 0) return []

  const candidates = breakCandidates
    .map((candidate) => typeof candidate === "number" ? { position: candidate } : candidate)
    .filter((candidate) => candidate.position > 0 && candidate.position < contentHeight)
    .sort((left, right) => left.position - right.position)
  const slices: PreviewPageSlice[] = []
  let top = 0

  while (top < contentHeight) {
    const target = top + pageHeight
    if (target >= contentHeight) {
      slices.push({ top, height: contentHeight - top })
      break
    }

    const earliest = top + Math.max(overlap + 1, pageHeight * 0.72)
    const latest = top + pageHeight * 1.12
    const nearby = candidates.filter((candidate) => candidate.position >= earliest && candidate.position <= latest)
    const selected = nearby.filter((candidate) => candidate.position <= target).at(-1) ?? nearby[0]
    const boundary = selected?.position ?? target
    slices.push({ top, height: boundary - top })
    top = Math.max(top + 1, selected?.nextPageTop ?? boundary - overlap)
  }

  return slices
}
