export const DEFAULTS = {
  maxActiveWakeups: 50,
  minRepeatSeconds: 60,
  maxActiveBackgroundCommands: 10,
  maxOutputBytesPerStream: 1024 * 1024,
  defaultOutputBytesPerStream: 1024 * 1024,
  defaultPullLineLimit: 200,
  maxPullLineLimit: 5_000,
  cancelGraceMs: 2_000,
  historyLimit: 200,
} as const
