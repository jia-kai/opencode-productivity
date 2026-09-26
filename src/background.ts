import { OpenCode, type OpenCodeClient, type ShellInfo } from "@opencode/client"
import { Service } from "@opencode/client/service"

export interface ShellApi {
  list(): Promise<ShellInfo[]>
  remove(id: string): Promise<void>
}

// Server plugins do not expose shell.list/remove. Connect back to this server's
// native API, and verify its PID before reading or stopping any command.
export function nativeShellApi(directory: string): ShellApi {
  let connection: Promise<OpenCodeClient> | undefined
  const client = () => connection ??= (async () => {
    const endpoint = await Service.discover()
    if (!endpoint) throw new Error("Background commands require the OpenCode background service")
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const info = await client.server.info({ signal: AbortSignal.timeout(3_000) })
    if (info.pid !== process.pid) throw new Error("The registered OpenCode service is not this server")
    return client
  })().catch((error) => { connection = undefined; throw error })
  return {
    list: async () => {
      const api = await client()
      return (await api.shell.list({ location: { directory } }, { signal: AbortSignal.timeout(3_000) })).data
    },
    remove: async (id) => {
      const api = await client()
      await api.shell.remove({ id, location: { directory } }, { signal: AbortSignal.timeout(5_000) })
    },
  }
}

export class BackgroundCommands {
  private readonly ids = new Set<string>()

  constructor(private readonly api: ShellApi) {}

  observe(metadata: Record<string, unknown> | undefined) {
    if (metadata?.status === "running" && typeof metadata.shellID === "string") this.ids.add(metadata.shellID)
  }

  async list(sessionID?: string): Promise<ShellInfo[]> {
    if (!this.ids.size) return []
    const shells = await this.api.list()
    const running = new Set(shells.map((shell) => shell.id))
    for (const id of this.ids) if (!running.has(id)) this.ids.delete(id)
    return shells.filter((shell) => this.ids.has(shell.id) && shell.status === "running" &&
      (sessionID === undefined || shell.metadata.sessionID === sessionID))
      .sort((a, b) => b.time.started - a.time.started)
  }

  async kill(id: string, sessionID: string): Promise<ShellInfo> {
    const shell = (await this.list(sessionID)).find((shell) => shell.id === id)
    if (!shell) throw new Error("No running background command with this ID in this session")
    await this.api.remove(id)
    this.ids.delete(id)
    return { ...shell, status: "killed", time: { ...shell.time, completed: Date.now() } }
  }
}
