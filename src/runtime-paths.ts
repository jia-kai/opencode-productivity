import { tmpdir } from "node:os"
import path from "node:path"

export function productivityRuntimeRoot(): string {
  return path.join(tmpdir(), "opencode-productivity")
}

export function productivityRuntimeStateRoot(): string {
  return path.join(productivityRuntimeRoot(), "state")
}

export function productivityRuntimeDirectory(directory: string): string {
  return path.join(productivityRuntimeStateRoot(), hashProjectPath(directory))
}

export function hashProjectPath(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}
