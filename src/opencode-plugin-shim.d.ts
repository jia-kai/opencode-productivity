declare module "@opencode-ai/plugin" {
  export type Plugin = (ctx: unknown) => Promise<Record<string, unknown>> | Record<string, unknown>
  interface SchemaValue {
    optional(): SchemaValue
    describe(text: string): SchemaValue
  }
  export const tool: {
    (definition: unknown): unknown
    schema: {
      string(): SchemaValue
      number(): SchemaValue
      boolean(): SchemaValue
    }
  }
}
