import type { Diagnostic, FileChange } from "simetra/compiler"
import type { z } from "zod"

export type ToolName =
  "compile" | "explain" | "fix" | "create" | "add" | "rename" | "delete"

/** `files` — інструмент змінює файли теки; лише його вмикає `--allow-write`. */
export type Effect = "read" | "files"

/** `run` лише читає теку й викликає операцію; запис робить `invoke`. */
export interface RunOutcome<D> {
  ok: boolean
  changes: FileChange[]
  diagnostics: Diagnostic[]
  data?: D
  refusal?: string
}

export interface Tool<I extends z.ZodType = z.ZodType, D = unknown> {
  name: ToolName
  /** Англійською: MCP і `--help` беруть опис звідси. */
  description: string
  input: I
  effect: Effect
  destructive: boolean
  run(ctx: { dir: string }, input: z.infer<I>): Promise<RunOutcome<D>>
}

export type RefusalReason =
  "invalid-input" | "write-disabled" | "unconfirmed" | "refused"

export interface ToolResult<D = unknown> {
  ok: boolean
  written: boolean
  changes: { path: string; deleted: boolean }[]
  diagnostics: Diagnostic[]
  data?: D
  refusal?: { reason: RefusalReason; message: string }
}

export interface InvokeOptions {
  dir: string
  allowWrite: boolean
  dryRun: boolean
  confirmed: boolean
  /** Argv запуску сервера: з нього будується підказка про `--allow-write`. */
  launchArgs?: readonly string[]
}

/** Виводить типи входу й даних з аргументів, щоб записи не писали generics. */
export function defineTool<I extends z.ZodType, D = undefined>(
  tool: Tool<I, D>
): Tool<I, D> {
  return tool
}
