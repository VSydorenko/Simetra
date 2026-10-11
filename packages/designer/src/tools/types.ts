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
  "promote",
  "introspect",
  "diff",
  "plan",
  "apply",
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

/**
 * Каталог артефактів плану в корені проєкту, поруч із текою метаданих:
 * єдиний виняток із межі теки для запису (спека designer §3.2).
 */
export const PLANS_DIR = "plans"

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
  /**
   * Корінь проєкту — батько теки метаданих (`dirname(resolve(dir))`): там
   * лежить `plans/`, і відносно нього `apply` читає артефакт.
   */
  root: string
  database?: DatabaseResource
  /** Вміст теки в `HEAD`: лише CLI його дає, MCP змін поза `fix` не перевіряє. */
  baseline?: ReadonlyMap<string, string>
}

/** `run` лише читає теку й викликає операцію; запис робить `invoke`. */
export interface RunOutcome<D> {
  ok: boolean
  changes: FileChange[]
  diagnostics: Diagnostic[]
  data?: D
  refusal?: string
  /**
   * Файли поза текою метаданих — лише артефакт плану в `plans/` кореня
   * проєкту (спека designer §3.2). Пише їх `invoke`, як і `changes`.
   */
  artifacts?: FileChange[]
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
  | "invalid-input"
  | "read-only"
  | "database-write-disabled"
  | "no-database"
  | "unconfirmed"
  | "refused"

export interface ToolResult<D = unknown> {
  ok: boolean
  written: boolean
  changes: { path: string; deleted: boolean }[]
  diagnostics: Diagnostic[]
  data?: D
  refusal?: { reason: RefusalReason; message: string }
  /** Шляхи артефактів відносно кореня проєкту: записані чи (dry-run) ні. */
  artifacts?: string[]
}

export interface InvokeOptions {
  dir: string
  readOnly: boolean
  /**
   * Запис у базу (`database: "write"`): CLI вмикає його завжди — людина, що
   * запускає `apply`, і є рішенням, — а MCP лише з прапорцем запуску
   * `--allow-database-write`.
   */
  allowDatabaseWrite: boolean
  dryRun: boolean
  confirmed: boolean
  /** Хто викликає: від цього залежить, як підказка радить дати підключення. */
  channel: "cli" | "mcp"
  database?: DatabaseResource
  /** Базовий стан для полів, призначених раз (див. `ToolContext.baseline`). */
  baseline?: ReadonlyMap<string, string>
  /**
   * Ім'я змінної середовища з рядком підключення, зафіксоване при запуску:
   * відмова без підключення має назвати саме її. Типово `SIMETRA_DATABASE_URL`.
   */
  databaseEnv?: string
  /** Argv запуску сервера: з нього будуються підказки про прапорці запуску. */
  launchArgs?: readonly string[]
}

/** Виводить типи входу й даних з аргументів, щоб записи не писали generics. */
export function defineTool<I extends z.ZodType, D = undefined>(
  tool: Tool<I, D>
): Tool<I, D> {
  return tool
}
