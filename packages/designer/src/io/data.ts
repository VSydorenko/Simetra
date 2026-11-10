import pg from "pg"
import {
  PLATFORM_ROLES,
  PLATFORM_SCHEMA,
  PROVIDER_API_ROLES,
  type DatabaseProvider,
  type SessionClaims,
} from "simetra/model"
import { fromPgPool, readRoleOf } from "simetra/server"
import { z, ZodError } from "zod"
import type { DataResource, DataSession } from "../tools/types"
import { DataGuardRefusal } from "./data-guard-refusal"
import {
  classifyDatabaseError,
  DatabaseRefusal,
  describeConnection,
  isProgramBug,
} from "./database"
import { UsageError } from "./usage-error"

/**
 * Ознака бази розробника — налаштування рівня бази, яке ставить оператор
 * (`ALTER DATABASE … SET` від суперкористувача). Сесійне `options=-c …` чи
 * налаштування ролі її не дають: їх може задати сам рядок підключення.
 */
export const DEVELOPMENT_ENVIRONMENT = {
  setting: "simetra.environment",
  value: "development",
} as const

const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Хост, який візьме `pg`, — машина розробника: `localhost`, петля IPv4
 * `127.0.0.0/8`, `::1` чи шлях unix-сокета. DNS не розв'язується: ім'я, що
 * лише вказує на петлю, — уже не «ця машина» за формою рядка.
 */
export function isLocalHost(host: string | undefined): boolean {
  if (host === undefined || host === "") return false
  if (host.startsWith("/")) return true
  const h = host.toLowerCase()
  if (h === "localhost" || h === "::1") return true
  const m = IPV4_LOOPBACK.exec(h)
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255)
}

/**
 * Факти ролі входу й ознаки бази одним оператором. Роль перевіряється
 * фактами, не іменем: ім'я `simetra_runtime` не доводить, що роль не
 * суперкористувач і не мігратор. Відсутня в кластері роль команд дає
 * `false`, а не `42704`, — підзапит з `COALESCE`.
 */
export const DATA_GUARD_FACTS_SQL = `SELECT r.rolsuper, r.rolbypassrls,
  COALESCE((SELECT pg_catalog.pg_has_role(session_user, c.oid, 'SET')
            FROM pg_catalog.pg_roles c WHERE c.rolname = $1), false) AS command,
  COALESCE(pg_catalog.pg_has_role(session_user, n.nspowner, 'MEMBER'), false) AS migrator,
  COALESCE((SELECT pg_catalog.pg_has_role(session_user, s.oid, 'MEMBER')
            FROM pg_catalog.pg_roles s WHERE s.rolname = $2), false) AS service,
  EXISTS (SELECT FROM pg_catalog.pg_db_role_setting d
          JOIN pg_catalog.pg_database b ON b.oid = d.setdatabase
          WHERE b.datname = pg_catalog.current_database() AND d.setrole = 0
            AND $3 = ANY (d.setconfig)) AS development
FROM pg_catalog.pg_roles r
LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = $4
WHERE r.rolname = session_user`

/** Параметри {@link DATA_GUARD_FACTS_SQL} для профілю провайдера. */
export function dataGuardFactsParams(
  provider: DatabaseProvider
): (string | null)[] {
  return [
    PLATFORM_ROLES.command,
    PROVIDER_API_ROLES[provider].service,
    `${DEVELOPMENT_ENVIRONMENT.setting}=${DEVELOPMENT_ENVIRONMENT.value}`,
    PLATFORM_SCHEMA,
  ]
}

interface GuardFacts {
  rolsuper: boolean
  rolbypassrls: boolean
  command: boolean
  migrator: boolean
  service: boolean
  development: boolean
}

/**
 * Claims сесії інструмента: права — користувача `--as`, агент лише
 * названий в `act` (RFC 8693) і прав не дає.
 */
export function dataSession(
  provider: DatabaseProvider,
  o: { as: string; agent?: string }
): SessionClaims {
  const role = readRoleOf(provider)
  return {
    sub: o.as,
    ...(role === undefined ? {} : { role }),
    ...(o.agent === undefined ? {} : { act: { sub: o.agent } }),
  }
}

/**
 * Запит фактів сирим клієнтом пулу (булеві — `boolean`, а не текст порту
 * рантайму) у транзакції лише читання. Клієнт звільняється до повернення:
 * за `max: 1` незвільнений клієнт заблокував би рантайм.
 */
async function checkGuards(
  pool: pg.Pool,
  provider: DatabaseProvider
): Promise<void> {
  const client = await pool.connect()
  // Обрив backend між запитами не має валити процес: причина й так дійде
  // через запит
  client.on("error", () => {})
  let facts: GuardFacts | undefined
  let broken = false
  try {
    await client.query("BEGIN READ ONLY")
    const { rows } = await client.query<GuardFacts>(
      DATA_GUARD_FACTS_SQL,
      dataGuardFactsParams(provider)
    )
    await client.query("COMMIT")
    facts = rows[0]
  } catch (error) {
    broken = true
    throw error
  } finally {
    client.release(broken)
  }
  // Роль — першою: вхід мігратора відмовляє ще до питання про базу
  if (
    facts === undefined ||
    facts.rolsuper ||
    facts.rolbypassrls ||
    facts.migrator ||
    facts.service ||
    !facts.command
  )
    throw new DataGuardRefusal("login-refused")
  if (!facts.development) throw new DataGuardRefusal("not-development")
}

/**
 * Ресурс даних з імені змінної, зафіксованого при запуску. Порожня змінна —
 * ресурсу немає, `invoke` відмовить `no-data`. Пул — на виклик (`open`), і
 * кожен виклик заново проходить запобіжники.
 */
export function dataResource(
  env: NodeJS.ProcessEnv,
  o: { urlEnv: string; as: string; agent?: string }
): DataResource | undefined {
  const url = env[o.urlEnv]
  if (url === undefined || url === "") return undefined
  return {
    describe: describeConnection(url),
    as: o.as,
    ...(o.agent === undefined ? {} : { agent: o.agent }),
    async open(provider): Promise<DataSession> {
      let host: string | undefined
      try {
        // Той самий хост, що візьме `pg` (`?host=`, `PGHOST`); з'єднання
        // конструктор не відкриває
        host = new pg.Client({ connectionString: url }).host
      } catch {
        // Без `cause`: помилка розбору несе сам рядок (`input`)
        throw new DatabaseRefusal(
          `The connection string in ${o.urlEnv} is not a valid URL. Nothing changed.`
        )
      }
      if (!isLocalHost(host)) throw new DataGuardRefusal("not-local")
      const pool = new pg.Pool({ connectionString: url, max: 1 })
      // Помилка простого клієнта не має валити процес (MCP-сервер)
      pool.on("error", () => {})
      try {
        await checkGuards(pool, provider)
      } catch (error) {
        await pool.end().catch(() => {})
        throw error
      }
      return {
        database: fromPgPool(pool),
        session: dataSession(provider, o),
        close: () => pool.end(),
      }
    },
  }
}

/**
 * Збій роботи з базою даних виклику: лише параметри `database.failed`
 * (адреса й код), без `cause` і тексту драйвера, — `run` інструмента
 * повертає їх діагностикою.
 */
export class DataFailure extends Error {
  override name = "DataFailure"
  constructor(readonly params: Readonly<Record<string, string>>) {
    super("database.failed")
  }
}

/** Межа помилок `withData`: правило `withDatabase`, плюс власні відмови й вади. */
function boundary(error: unknown, describe: string): unknown {
  // Відмова запобіжника вже безпечна, а вада програми (зокрема `ZodError`
  // каталогу з `createCommandRuntime`) не маскується під збій бази
  if (
    error instanceof DataGuardRefusal ||
    error instanceof ZodError ||
    isProgramBug(error)
  )
    return error
  const c = classifyDatabaseError(error, { target: describe })
  if (c.kind === "refusal") return new DatabaseRefusal(c.message)
  const { sqlstate, ...rest } = c.params
  return new DataFailure(sqlstate === undefined ? rest : { ...rest, sqlstate })
}

/**
 * Сесія даних одного виклику — єдина межа помилок бази для інструментів
 * даних. `CommandFailure` до неї не доходить: `fn` повертає її як дані.
 * Пул закривається тут, у `finally`, на будь-якому результаті.
 */
export async function withData<T>(
  resource: DataResource,
  provider: DatabaseProvider,
  fn: (s: DataSession) => Promise<T>
): Promise<T> {
  let session: DataSession
  try {
    session = await resource.open(provider)
  } catch (error) {
    throw boundary(error, resource.describe)
  }
  let result: T
  try {
    result = await fn(session)
  } catch (error) {
    await closeQuietly(session)
    throw boundary(error, resource.describe)
  }
  await closeQuietly(session)
  return result
}

/**
 * Закриття пулу — поза межею результату: після успішного `fn` команда вже
 * закомічена, тож збій закриття не має підміняти ні результат, ні помилку
 * `fn`. У журнал — лише факт, без тексту драйвера (він несе ім'я входу).
 */
async function closeQuietly(session: DataSession): Promise<void> {
  try {
    await session.close()
  } catch {
    process.stderr.write("simetra: closing the data session failed\n")
  }
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Прапорець бере ім'я змінної, а не значення: підказки й `instructions`
 * повторюють argv запуску, тож рядок підключення, переданий замість імені,
 * потрапив би агентові. Значення в тексті не цитується.
 */
export function checkEnvName(flag: string, value: string): void {
  if (!ENV_NAME.test(value))
    throw new UsageError(
      `${flag} takes the name of an environment variable (letters, digits and underscores, not starting with a digit), not its value.`
    )
}

const isGuid = (value: string): boolean => z.guid().safeParse(value).success

/**
 * Спільна перевірка прапорців даних MCP і CLI. Типової змінної немає:
 * доступ від імені користувача — явне рішення людини, тож прапорці йдуть
 * разом або не йдуть зовсім. Значення в текст помилки не потрапляють.
 */
export function parseDataLaunch(flags: {
  dataUrlEnv?: string
  as?: string
  agent?: string
}): { urlEnv: string; as: string; agent?: string } | undefined {
  const { dataUrlEnv, as, agent } = flags
  if (dataUrlEnv === undefined && as === undefined && agent === undefined)
    return undefined
  if (as === undefined)
    throw new UsageError(
      agent === undefined
        ? "--data-url-env needs --as with the UUID of the user the data tools act as."
        : "--agent needs --as: the agent acts on behalf of the user named by --as."
    )
  if (dataUrlEnv === undefined)
    throw new UsageError(
      "--as needs --data-url-env with the name of the environment variable that holds the connection string of the development database."
    )
  checkEnvName("--data-url-env", dataUrlEnv)
  if (!isGuid(as)) throw new UsageError("--as takes a user UUID.")
  if (agent !== undefined && !isGuid(agent))
    throw new UsageError("--agent takes an agent UUID.")
  return { urlEnv: dataUrlEnv, as, ...(agent === undefined ? {} : { agent }) }
}
