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

const SQLSTATE = /^[0-9A-Z]{5}$/

function codeOf(error: Error): string | undefined {
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/**
 * Єдина межа, на якій помилка підключення чи запиту стає текстом для
 * виводу. Текст складається лише зі стабільних фраз, `describe` і коду
 * помилки: повідомлення драйвера й двигуна не цитуються, бо несуть ім'я
 * користувача («password authentication failed for user …»), а інші —
 * будь-що з рядка підключення. Наші власні відмови вже безпечні й ідуть як є.
 */
export function connectionErrorMessage(
  error: unknown,
  describe: string
): string {
  if (error instanceof DatabaseRefusal) return error.message
  if (!(error instanceof Error))
    return `The database call to ${describe} failed. Nothing changed.`
  if (error.name === "ShadowServerMismatchError") return error.message
  if (error.name === "ShadowProvisionError")
    return `A shadow database cannot be created next to ${describe}: the connecting role lacks CREATEDB. Point --shadow-url-env at a server where it has it. Nothing changed.`
  if (error instanceof AggregateError && error.errors.length > 0)
    return connectionErrorMessage(error.errors[0], describe)
  const code = codeOf(error)
  if (code !== undefined && UNREACHABLE.has(code))
    return `The database at ${describe} is unreachable (${code}). Check the host and port in the connection string. Nothing changed.`
  switch (code) {
    case "28P01":
    case "28000":
      return `Authentication to the database at ${describe} failed. Check the user and password in the connection string. Nothing changed.`
    case "3D000":
      return `The database at ${describe} does not exist. Nothing changed.`
    case "42501":
      return `The connecting role lacks a privilege this tool needs on ${describe} (SQLSTATE 42501). Nothing changed.`
  }
  if (code !== undefined && SQLSTATE.test(code))
    return `The database call to ${describe} failed (SQLSTATE ${code}). Nothing changed.`
  if (error instanceof TypeError && /url/i.test(error.message))
    return "The connection string is not a valid URL. Nothing changed."
  return `The database call to ${describe} failed (${error.name}). Nothing changed.`
}

/**
 * Підключення одного виклику: будь-який виняток підключення чи запиту стає
 * відмовою з текстом `connectionErrorMessage` до того, як потрапить у
 * будь-який канал виводу. Пули відкриває й закриває двигун усередині `fn`.
 */
export async function withDatabase<T>(
  resource: DatabaseResource,
  fn: (db: DatabaseContext) => Promise<T>
): Promise<T> {
  try {
    return await fn(await resource.connect())
  } catch (error) {
    throw new DatabaseRefusal(connectionErrorMessage(error, resource.describe))
  }
}
