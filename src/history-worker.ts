import { parentPort, workerData } from "node:worker_threads"
import { loadPromptHistoryEntries, preparePromptHistoryEntries } from "./history.js"

const { dbPath, limit } = workerData as { dbPath: string; limit: number }
parentPort?.postMessage(preparePromptHistoryEntries(loadPromptHistoryEntries(dbPath, limit)))
