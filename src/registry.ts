import { mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { BackgroundCommandRecord } from "./background.js"
import type { BackgroundStatusSnapshot, ProductivityStatusSnapshot } from "./status.js"
import type { WakeupRecord } from "./scheduler.js"
import { productivityRuntimeDirectory, productivityRuntimeStateRoot } from "./runtime-paths.js"

export interface ProductivityInstanceSnapshot extends ProductivityStatusSnapshot {
  instanceID: string
  serverPid: number
  socketPath: string
  sessions: string[]
  connected: boolean
  connectedAt?: string
  connectedSessionID?: string
}

export interface ProductivityRegistry {
  updatedAt: string
  instances: ProductivityInstanceSnapshot[]
}

export interface ProductivityRegistryManager {
  write(instance: Omit<ProductivityInstanceSnapshot, "updatedAt" | "commands" | "connected" | "connectedAt" | "connectedSessionID"> & { commands: BackgroundCommandRecord[] }): void
  remove(instanceID: string): void
  read(): ProductivityRegistry
  select(sessionID?: string): ProductivityInstanceSnapshot | undefined
}

const INSTANCE_TTL_MS = 5_000
const LOCK_TTL_MS = 5_000

export function createProductivityRegistry(directory: string): ProductivityRegistryManager {
  return {
    write(instance) {
      withRegistryLock(directory, () => {
        const registry = readProductivityRegistryUnlocked(directory)
        const previous = registry.instances.find((item) => item.instanceID === instance.instanceID)
        const now = new Date().toISOString()
        const entry: ProductivityInstanceSnapshot = {
          ...instance,
          updatedAt: now,
          connected: previous?.connected ?? false,
          connectedAt: previous?.connectedAt,
          connectedSessionID: previous?.connectedSessionID,
          commands: instance.commands.map(stripOutput),
        }
        const instances = pruneInstances(registry.instances, entry.instanceID)
        instances.push(entry)
        writeRegistryUnlocked(directory, { updatedAt: now, instances })
      })
    },
    remove(instanceID) {
      withRegistryLock(directory, () => {
        const registry = readProductivityRegistryUnlocked(directory)
        const instances = pruneInstances(registry.instances, instanceID)
        if (instances.length) writeRegistryUnlocked(directory, { updatedAt: new Date().toISOString(), instances })
        else deleteRegistryUnlocked(directory)
      })
    },
    read() {
      return readProductivityRegistryUnlocked(directory)
    },
    select(sessionID) {
      return selectAndConnectProductivityInstance(directory, sessionID)
    },
  }
}

export function readProductivityRegistry(directory: string): ProductivityRegistry {
  return readProductivityRegistryUnlocked(directory)
}

export function cleanupStaleProductivityRuntimeFiles(): void {
  try {
    for (const entry of readdirSync(productivityRuntimeStateRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      cleanupRuntimeStateDirectory(path.join(productivityRuntimeStateRoot(), entry.name))
    }
  } catch {
    // Missing or unreadable runtime directories are harmless.
  }
}

export function selectProductivityInstance(registry: ProductivityRegistry, sessionID?: string): ProductivityInstanceSnapshot | undefined {
  return selectFromInstances(registry.instances.filter(isFreshInstance).filter((instance) => processExists(instance.serverPid)), sessionID)
}

export function selectAndConnectProductivityInstance(directory: string, sessionID?: string): ProductivityInstanceSnapshot | undefined {
  return withRegistryLock(directory, () => {
    const registry = readProductivityRegistryUnlocked(directory)
    const instances = pruneInstances(registry.instances)
    const selected = selectFromInstances(instances, sessionID)
    if (!selected) {
      if (instances.length) writeRegistryUnlocked(directory, { updatedAt: new Date().toISOString(), instances })
      else deleteRegistryUnlocked(directory)
      return undefined
    }
    const now = new Date().toISOString()
    const updated = instances.map((instance) => instance.instanceID === selected.instanceID
      ? { ...instance, connected: true, connectedAt: now, connectedSessionID: sessionID }
      : instance)
    writeRegistryUnlocked(directory, { updatedAt: now, instances: updated })
    return updated.find((instance) => instance.instanceID === selected.instanceID)
  })
}

export function productivityRegistryPath(directory: string): string {
  return path.join(productivityRuntimeDirectory(directory), "productivity-registry.json")
}

export function legacyProductivityRegistryPath(directory: string): string {
  return path.join(directory, ".opencode", "productivity-registry.json")
}

export function deleteLegacyProductivityRegistry(directory: string): void {
  rmSync(legacyProductivityRegistryPath(directory), { force: true })
  rmSync(`${legacyProductivityRegistryPath(directory)}.lock`, { recursive: true, force: true })
}

function selectFromInstances(instances: ProductivityInstanceSnapshot[], sessionID?: string): ProductivityInstanceSnapshot | undefined {
  if (sessionID) {
    const connected = instances
      .filter((instance) => instance.connectedSessionID === sessionID)
      .sort(compareUpdatedDesc)[0]
    if (connected) return connected
    const match = instances
      .filter((instance) => instance.sessions.includes(sessionID))
      .sort(compareUpdatedDesc)[0]
    if (match) return match
    return undefined
  }
  return instances.sort(compareUpdatedDesc)[0]
}

function readProductivityRegistryUnlocked(directory: string): ProductivityRegistry {
  try {
    const parsed = JSON.parse(readFileSync(productivityRegistryPath(directory), "utf8")) as Partial<ProductivityRegistry>
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      instances: Array.isArray(parsed.instances) ? parsed.instances.filter(isInstanceSnapshot) : [],
    }
  } catch {
    return { updatedAt: "", instances: [] }
  }
}

function writeRegistryUnlocked(directory: string, registry: ProductivityRegistry): void {
  const file = productivityRegistryPath(directory)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(registry, null, 2))
}

function deleteRegistryUnlocked(directory: string): void {
  rmSync(productivityRegistryPath(directory), { force: true })
  removeEmptyRuntimeDirectory(directory)
}

function withRegistryLock<Value>(directory: string, fn: () => Value): Value | undefined {
  const lock = `${productivityRegistryPath(directory)}.lock`
  try {
    mkdirSync(path.dirname(lock), { recursive: true })
    try {
      mkdirSync(lock)
    } catch (error) {
      if (!isStaleLock(lock)) return undefined
      rmdirSync(lock)
      mkdirSync(lock)
    }
    try {
      return fn()
    } finally {
      rmdirSync(lock)
    }
  } catch {
    return undefined
  }
}

function pruneInstances(instances: ProductivityInstanceSnapshot[], exceptInstanceID?: string): ProductivityInstanceSnapshot[] {
  return instances.filter((instance) => {
    if (instance.instanceID === exceptInstanceID) return false
    return isFreshInstance(instance) && processExists(instance.serverPid)
  })
}

function isFreshInstance(instance: ProductivityInstanceSnapshot): boolean {
  return Date.now() - Date.parse(instance.updatedAt) < INSTANCE_TTL_MS
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && (error as { code?: unknown }).code === "EPERM"
  }
}

function isStaleLock(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_TTL_MS
  } catch {
    return false
  }
}

function removeEmptyRuntimeDirectory(directory: string): void {
  try {
    rmSync(productivityRuntimeDirectory(directory), { recursive: false })
  } catch {
    // The directory may still contain the status snapshot or another live file.
  }
}

function cleanupRuntimeStateDirectory(directory: string): void {
  const registryPath = path.join(directory, "productivity-registry.json")
  const statusPath = path.join(directory, "productivity-state.json")
  const lockPath = `${registryPath}.lock`
  try {
    if (isStaleLock(lockPath)) rmSync(lockPath, { recursive: true, force: true })
    const registry = readRegistryFile(registryPath)
    if (registry) {
      const instances = pruneInstances(registry.instances)
      if (instances.length) writeFileSync(registryPath, JSON.stringify({ updatedAt: new Date().toISOString(), instances }, null, 2))
      else rmSync(registryPath, { force: true })
    }
    const status = readStatusFile(statusPath)
    if (status && (!status.ipc?.serverPid || !processExists(status.ipc.serverPid))) rmSync(statusPath, { force: true })
    rmSync(directory, { recursive: false })
  } catch {
    // Keep live or concurrently updated runtime directories.
  }
}

function readRegistryFile(file: string): ProductivityRegistry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ProductivityRegistry>
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      instances: Array.isArray(parsed.instances) ? parsed.instances.filter(isInstanceSnapshot) : [],
    }
  } catch {
    return undefined
  }
}

function readStatusFile(file: string): Partial<ProductivityStatusSnapshot> | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Partial<ProductivityStatusSnapshot>
  } catch {
    return undefined
  }
}

function isInstanceSnapshot(value: unknown): value is ProductivityInstanceSnapshot {
  if (typeof value !== "object" || value === null) return false
  const item = value as Partial<ProductivityInstanceSnapshot>
  return typeof item.instanceID === "string"
    && typeof item.serverPid === "number"
    && typeof item.socketPath === "string"
    && typeof item.updatedAt === "string"
    && Array.isArray(item.sessions)
    && Array.isArray(item.wakeups)
    && Array.isArray(item.commands)
}

function compareUpdatedDesc(a: ProductivityInstanceSnapshot, b: ProductivityInstanceSnapshot): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
}

function stripOutput(command: BackgroundCommandRecord): BackgroundStatusSnapshot {
  const { stdout: _stdout, stderr: _stderr, ...status } = command
  return status
}
