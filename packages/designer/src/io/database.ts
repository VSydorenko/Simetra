import { diagnostic, localize, type Diagnostic } from "simetra/compiler"
import {
  ShadowCreateRefusedError,
  ShadowServerError,
  ShadowServerMismatchError,
} from "../schema-engine/errors"
import type { DatabaseContext, DatabaseResource } from "../tools/types"
import { UsageError } from "./usage-error"

/**
 * Відмова виклику бази з текстом, який уже безпечно показати: без рядка
 * підключення, користувача й пароля. Помилка використання — викликач може
 * виправити її сам (змінна середовища, сервер тіні).
 */
export class DatabaseRefusal extends UsageError {
  override name = "DatabaseRefusal"
}

/**
 * `host:port/db` — єдине про підключення, що можна показати. Рядок, який не
 * розбирається як URL, не цитуємо: він міг би бути самим паролем.
 */
export function describeConnection(url: string): string {
  try {
    const u = new URL(url)
    const db = decodeURIComponent(u.pathname.replace(/^\//, ""))
    return `${u.hostname}:${u.port === "" ? "5432" : u.port}/${db}`
  } catch {
    return "the configured database"
  }
}

/**
 * Ресурс запуску з імен змінних, зафіксованих при запуску. Без змінної цілі
 * ресурсу немає — `invoke` відмовить з її ім'ям. Значення читається тут, а
 * пули відкриває лише виклик інструмента бази.
 */
export function databaseResource(
  env: NodeJS.ProcessEnv,
  names: { url: string; shadow?: string }
): DatabaseResource | undefined {
  const url = env[names.url]
  if (url === undefined || url === "") return undefined
  const describe = describeConnection(url)
  return {
    describe,
    async connect(): Promise<DatabaseContext> {
      if (names.shadow === undefined) return { target: { url }, describe }
      const shadowUrl = env[names.shadow]
      // Названа при запуску змінна без значення — помилка конфігу, а не
      // мовчазний перехід на co-located тінь
      if (shadowUrl === undefined || shadowUrl === "")
        throw new DatabaseRefusal(
          `The environment variable ${names.shadow} named by --shadow-url-env is not set. Nothing changed.`
        )
      return { target: { url }, shadowBase: { url: shadowUrl }, describe }
    },
  }
}

/** Мережеві коди Node: база недосяжна, і повторити варто після виправлення адреси. */
const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
])

/**
 * Код Node (`EPIPE`, `ERR_INVALID_URL`) перевіряється раніше за SQLSTATE: обидва
 * бувають п'ятисимвольними, а класу SQLSTATE на `E` у Postgres немає.
 */
const NODE_CODE = /^E[A-Z_]+$/
const SQLSTATE = /^[0-9A-Z]{5}$/

/**
 * Збій драйвера без коду, що означає втрачене чи не встановлене з'єднання.
 * Текст лише розпізнається, ніколи не цитується.
 */
const LOST_CONNECTION = /^Connection terminated|^timeout expired/

function codeOf(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/** Адреси, якими межа називає сервер збою. */
export interface DatabaseNames {
  target: string
  /** `host:port/db` окремого сервера тіні, коли його названо при запуску. */
  shadow?: string
}

/**
 * Класифікація помилки бази на межі. `refusal` — підключення не відбулося
 * чи його не можна вживати (немає зв'язку, автентифікації, бази, права,
 * адреса хибна): викликач виправляє це сам, код 2. Решта — збій самої
 * роботи з базою (`failure`): діагностика `database.failed`, код 1.
 */
export type DatabaseErrorClass =
  | { kind: "refusal"; message: string }
  | {
      kind: "failure"
      params: { database: string; error: string; sqlstate?: string }
    }

const refusal = (message: string): DatabaseErrorClass => ({
  kind: "refusal",
  message: `${message} Nothing changed.`,
})

/**
 * Єдина межа, на якій помилка підключення чи запиту стає текстом для
 * виводу. Текст складається лише зі стабільних фраз, адреси `host:port/db` і
 * коду помилки: повідомлення драйвера й двигуна не цитуються, бо несуть ім'я
 * користувача («password authentication failed for user …»), а інші —
 * будь-що з рядка підключення. Наші власні відмови вже безпечні й ідуть як є.
 */
export function classifyDatabaseError(
  error: unknown,
  names: DatabaseNames
): DatabaseErrorClass {
  const describe = names.target
  if (error instanceof DatabaseRefusal)
    return { kind: "refusal", message: error.message }
  if (error instanceof ShadowServerMismatchError)
    return { kind: "refusal", message: error.message }
  if (error instanceof ShadowCreateRefusedError) {
    const where = error.onShadowBase ? (names.shadow ?? describe) : describe
    return refusal(
      `A shadow database cannot be created on ${where}: the connecting role lacks CREATEDB.${error.onShadowBase ? "" : " Point --shadow-url-env at a server where it has it."}`
    )
  }
  // Збій окремого сервера тіні — та сама класифікація, але з його адресою
  if (error instanceof ShadowServerError)
    return classifyDatabaseError(error.cause, {
      target: names.shadow ?? describe,
    })
  if (error instanceof AggregateError && error.errors.length > 0)
    return classifyDatabaseError(error.errors[0], names)
  if (!(error instanceof Error))
    return { kind: "failure", params: { database: describe, error: "unknown" } }
  const code = codeOf(error)
  if (code !== undefined && NODE_CODE.test(code)) {
    if (UNREACHABLE.has(code))
      return refusal(
        `The database at ${describe} is unreachable (${code}). Check the host and port in the connection string.`
      )
    if (code === "ERR_INVALID_URL")
      return refusal("The connection string is not a valid URL.")
    return {
      kind: "failure",
      params: { database: describe, error: `${error.name} ${code}` },
    }
  }
  if (code !== undefined && SQLSTATE.test(code)) {
    if (code.startsWith("28"))
      return refusal(
        `Authentication to the database at ${describe} failed. Check the user and password in the connection string.`
      )
    if (code.startsWith("08"))
      return refusal(
        `The connection to the database at ${describe} failed (SQLSTATE ${code}).`
      )
    if (code === "3D000")
      return refusal(`The database at ${describe} does not exist.`)
    if (code === "42501")
      return refusal(
        `The connecting role lacks a privilege this tool needs on ${describe} (SQLSTATE 42501).`
      )
    return {
      kind: "failure",
      params: { database: describe, error: error.name, sqlstate: code },
    }
  }
  if (code === undefined && LOST_CONNECTION.test(error.message))
    return refusal(
      `The connection to the database at ${describe} was lost or timed out.`
    )
  return { kind: "failure", params: { database: describe, error: error.name } }
}

/**
 * Текст класифікованої помилки для виводу: відмова — її стабільна фраза,
 * збій — англійський текст `database.failed`, той самий, що в діагностиці.
 */
export function connectionErrorMessage(
  error: unknown,
  describe: string,
  tool = "database"
): string {
  const c = classifyDatabaseError(error, { target: describe })
  return c.kind === "refusal"
    ? c.message
    : localize({ code: "database.failed", params: { tool, ...c.params } }, "en")
        .message
}

export type DatabaseOutcome<T> =
  { ok: true; value: T } | { ok: false; diagnostic: Diagnostic }

/**
 * Підключення одного виклику — єдина межа помилок бази. Відмова
 * (`DatabaseRefusal`) летить до `invoke` і стає кодом 2; збій роботи з базою
 * стає діагностикою `database.failed` (код 1, MCP `isError`). Сирий виняток
 * далі не йде: SDK MCP показав би агенту його текст. Пули відкриває й
 * закриває двигун усередині `fn`.
 */
export async function withDatabase<T>(
  resource: DatabaseResource,
  tool: string,
  fn: (db: DatabaseContext) => Promise<T>
): Promise<DatabaseOutcome<T>> {
  let names: DatabaseNames = { target: resource.describe }
  try {
    const db = await resource.connect()
    if (db.shadowBase !== undefined)
      names = { ...names, shadow: describeConnection(db.shadowBase.url) }
    return { ok: true, value: await fn(db) }
  } catch (error) {
    const c = classifyDatabaseError(error, names)
    if (c.kind === "refusal") throw new DatabaseRefusal(c.message)
    return {
      ok: false,
      diagnostic: diagnostic("database.failed", "", "", { tool, ...c.params }),
    }
  }
}
