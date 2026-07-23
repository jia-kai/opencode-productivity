#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
markdown_path=${1:-"$repo_dir/examples/sample-preview.md"}

if [ -z "${TMUX:-}" ]; then
  echo "error: run this script inside tmux" >&2
  exit 1
fi

if [ ! -f "$markdown_path" ]; then
  echo "error: Markdown file not found: $markdown_path" >&2
  exit 1
fi

cd "$repo_dir"
npm run build

payload=$(
  node --input-type=module -e '
    import { readFileSync } from "node:fs"
    import { dirname, resolve } from "node:path"
    import { encodePreviewPayload } from "./dist/src/preview-payload.js"

    const markdownPath = resolve(process.argv[1])
    const markdown = readFileSync(markdownPath, "utf8")
    const palette = {
      mode: "dark",
      background: "#0f111a",
      panel: "#161922",
      element: "#202431",
      text: "#d8dee9",
      muted: "#8992a7",
      heading: "#82aaff",
      link: "#89ddff",
      code: "#c3e88d",
      quote: "#a6accd",
      border: "#343b4f",
      accent: "#c792ea",
      error: "#ff5370",
      warning: "#ffcb6b",
      success: "#c3e88d"
    }
    process.stdout.write(encodePreviewPayload({
      markdown,
      palette,
      resourcePath: dirname(markdownPath)
    }))
  ' "$markdown_path"
)

exec node "$repo_dir/dist/src/preview-window.js" "$payload"
