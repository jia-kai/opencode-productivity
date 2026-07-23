export function previewTmuxArgs(
  node: string,
  viewerPath: string,
  payload: string,
): string[] {
  return [
    "new-window",
    "-n",
    "oc-preview",
    shellCommand([node, viewerPath, payload]),
  ]
}

function shellCommand(args: string[]): string {
  return args.map((arg) => `'${arg.replaceAll("'", `'\"'\"'`)}'`).join(" ")
}

export function tmuxPassthrough(sequence: string): string {
  return `\u001bPtmux;${sequence.replaceAll("\u001b", "\u001b\u001b")}\u001b\\`
}
