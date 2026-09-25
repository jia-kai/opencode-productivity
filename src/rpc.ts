import { Rpc } from "@opencode/plugin/rpc"

export const ProductivityRpc = Rpc.define({
  id: "productivity",
  methods: {
    list: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    cancel: {
      input: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {
    changed: { schema: { type: "object", additionalProperties: false } },
  },
})
