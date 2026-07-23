export interface PreviewPageLayout {
  columns: number
  rows: number
}

export function previewPageLayout(
  pageWidth: number,
  pageHeight: number,
  referenceHeight: number,
  maxColumns: number,
  maxRows: number,
): PreviewPageLayout {
  let columns = maxColumns
  const referenceRows = Math.max(1, Math.ceil((referenceHeight / pageWidth) * columns / 2))
  if (referenceRows > maxRows) {
    columns = Math.max(1, Math.floor((pageWidth / referenceHeight) * maxRows * 2))
  }
  const rows = Math.max(1, Math.min(maxRows, Math.ceil((pageHeight / pageWidth) * columns / 2)))
  return { columns, rows }
}
