import type { Diagnostic, FileChange } from "simetra/compiler"
import type { DbConnection } from "simetra/schema"
import type { z } from "zod"

/** Імена окремо від записів каталогу: `main.ts` реєструє лінощі підкоманди, не тягнучи компілятор. */
export const TOOL_NAMES = [
  "compile",
  "explain",
  "fix",
  "create",
  "add",
  "rename",
  "delete",
  "introspect",
  "diff",
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/**
 * Дві осі замість одного ефекту: запис файлів (у git, лише після чистої
 * компіляції) і дія над базою (поза git) відрізняються незворотністю, тож
 * дозвіл і тертя для них різні. Масиви — для тестів повного добутку осей.
 */
export const FILES_ACCESS = ["read", "write"] as const
export type FilesAccess = (typeof FILES_ACCESS)[number]
export const DATABASE_ACCESS = ["none", "read", "write"] as const
export type DatabaseAccess = (typeof DATABASE_ACCESS)[number]

/** Відкрите підключення одного виклику: ціль і, за потреби, база для тіні. */
export interface DatabaseContext {
  target: DbConnection
  shadowBase?: DbConnection
  /** `host:port/db` без користувача й пароля — єдине, що можна показати. */
  describe: string
}

/**
 * Підключення — ресурс запуску, а не вхід інструмента: агент не може
 * спрямувати виклик на іншу базу. Лінивий — `connect` лише на виклик, тож
 * запуск без бази й інструменти без бази пулів не відкривають.
 */
export interface DatabaseResource {
  /** `host:port/db` без користувача й пароля. */
  describe: string
  connect(): Promise<DatabaseContext>
}

/** Ресурс бази отримує лише інструмент, що оголосив вісь `database`. */
export interface ToolContext {
  dir: string
  database?: DatabaseResource
}

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
  files: FilesAccess
  database: DatabaseAccess
  destructive: boolean
  run(ctx: ToolContext, input: z.infer<I>): Promise<RunOutcome<D>>
}

export type RefusalReason =
  "invalid-input" | "read-only" | "no-database" | "unconfirmed" | "refused"

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
  readOnly: boolean
  dryRun: boolean
  confirmed: boolean
  /** Хто викликає: від цього залежить, як підказка радить дати підключення. */
  channel: "cli" | "mcp"
  database?: DatabaseResource
  /**
   * Ім'я змінної середовища з рядком підключення, зафіксоване при запуску:
   * відмова без підключення має назвати саме її. Типово `SIMETRA_DATABASE_URL`.
   */
  databaseEnv?: string
  /** Argv запуску сервера: з нього будується підказка про `--read-only`. */
  launchArgs?: readonly string[]
}

/** Виводить типи входу й даних з аргументів, щоб записи не писали generics. */
export function defineTool<I extends z.ZodType, D = undefined>(
  tool: Tool<I, D>
): Tool<I, D> {
  return tool
}
