import { parentPort, workerData } from "node:worker_threads"
import { loadPromptHistoryEntries, preparePromptHistoryEntries } from "./history.js"

const { dbPath, limit, since } = workerData as { dbPath: string; limit: number; since?: number }
parentPort?.postMessage(preparePromptHistoryEntries(loadPromptHistoryEntries(dbPath, limit, since ?? 0)))
