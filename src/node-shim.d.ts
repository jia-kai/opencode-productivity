declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void
    deepEqual(actual: unknown, expected: unknown, message?: string): void
    ok(value: unknown, message?: string): void
    throws(fn: () => unknown, expected?: RegExp): void
    match(value: string, regexp: RegExp, message?: string): void
    fail(message?: string): never
  }
  export default assert
}

declare module "node:test" {
  interface TestFn {
    (name: string, fn: () => unknown | Promise<unknown>): void
    skip(name: string, fn?: () => unknown | Promise<unknown>): void
  }
  const test: TestFn
  export default test
}

declare module "node:fs" {
  export interface Stats {
    mtimeMs: number
    isSocket(): boolean
  }
  export interface Dirent {
    name: string
    isDirectory(): boolean
    isFile(): boolean
    isSocket(): boolean
  }
  export function existsSync(path: string): boolean
  export function chmodSync(path: string, mode: number): void
  export function lstatSync(path: string): Stats
  export function statSync(path: string): Stats
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function mkdtempSync(prefix: string): string
  export function readFileSync(path: string, encoding: "utf8"): string
  export function rmdirSync(path: string): void
  export function unlinkSync(path: string): void
  export function writeFileSync(path: string, data: string | Uint8Array): void
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void
}

declare module "node:os" {
  export function homedir(): string
  export function tmpdir(): string
}

declare module "node:path" {
  const path: {
    join(...parts: string[]): string
    dirname(path: string): string
    resolve(...parts: string[]): string
  }
  export default path
}

declare module "node:child_process" {
  import type { EventEmitter } from "node:events"

  export interface ChildProcessWithoutNullStreams extends EventEmitter {
    pid?: number
    killed: boolean
    exitCode: number | null
    stdout: EventEmitter
    stderr: EventEmitter
    kill(signal?: string): boolean
  }

  export interface SpawnOptions {
    cwd?: string
    env?: Record<string, string | undefined>
    shell?: boolean
    stdio?: ["ignore", "pipe", "pipe"]
    detached?: boolean
  }

  export function spawn(
    command: string,
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams

  export function spawn(
    command: string,
    args: string[],
    options?: SpawnOptions,
  ): ChildProcessWithoutNullStreams
}

declare module "node:events" {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this
    once(event: string, listener: (...args: any[]) => void): this
    off(event: string, listener: (...args: any[]) => void): this
  }
}

declare module "node:net" {
  import type { EventEmitter } from "node:events"

  export interface Socket extends EventEmitter {
    setEncoding(encoding: string): this
    setTimeout(timeout: number, callback?: () => void): this
    write(data: string): boolean
    end(data?: string): this
    destroy(): this
  }

  export interface Server extends EventEmitter {
    listen(path: string): this
    close(callback?: () => void): this
  }

  const net: {
    createServer(connectionListener?: (socket: Socket) => void): Server
    createConnection(path: string): Socket
  }
  export type { Socket, Server }
  export default net
}

declare module "node:sqlite" {
  export interface StatementSync {
    all(...args: unknown[]): Array<Record<string, unknown>>
    run(...args: unknown[]): unknown
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean })
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}

declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined
  }
  interface Process {
    env: ProcessEnv
    platform: string
    pid: number
    cwd(): string
    getBuiltinModule(id: "node:sqlite"): typeof import("node:sqlite")
    kill(pid: number, signal?: Signals | 0): boolean
  }
  interface Timeout {
    unref?(): void
  }
  type Signals = string
}

declare const process: NodeJS.Process

declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): NodeJS.Timeout
declare function clearTimeout(timeout: NodeJS.Timeout): void
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): NodeJS.Timeout
declare function clearInterval(timeout: NodeJS.Timeout): void

declare class Buffer extends Uint8Array {
  static from(input: string | Uint8Array): Buffer
  static from(input: string, encoding: string): Buffer
  static isBuffer(input: unknown): input is Buffer
  static concat(list: Buffer[], totalLength?: number): Buffer
  subarray(start?: number, end?: number): Buffer
  toString(encoding?: string, start?: number, end?: number): string
  readUInt32BE(offset: number): number
  readonly length: number
}
