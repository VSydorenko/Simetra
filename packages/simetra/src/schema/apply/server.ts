import type { EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { ApplyTransaction } from "./port"

/**
 * Найменший `server_version_num`, з яким працює платформа (платформна спека
 * §1: Postgres 17). Підтримки старіших версій немає свідомо.
 */
export const MIN_SERVER_VERSION_NUM = 170000

/**
 * Відмова для сервера, старішого за мінімум платформи, — до будь-якого
 * версійно залежного читання: без неї `readServerFacts` на Postgres 16 упав
 * би сирим `42703` на `datlocale`, а не зрозумілою причиною.
 */
export async function serverVersionRefusal(
  tx: ApplyTransaction
): Promise<EngineDiagnostic | undefined> {
  const [row] = await tx.query<{ num: number; version: string }>(
    "SELECT pg_catalog.current_setting('server_version_num')::int AS num, pg_catalog.current_setting('server_version') AS version"
  )
  if (row === undefined) throw new Error("server_version_num returned no row")
  return row.num < MIN_SERVER_VERSION_NUM
    ? applyDiagnostic("apply.server-unsupported", "error", {
        version: row.version,
      })
    : undefined
}

/**
 * Факти сервера й поточної бази, від яких залежить, як кроки й заміри
 * поводяться на даних (спека промоції §8): мажорна версія, кодування,
 * упорядкування й класифікація символів, провайдер локалі та версія
 * упорядкування. Копія на сервері з іншими фактами — не копія цієї цілі:
 * той самий `ORDER BY` чи унікальний індекс там дає інший результат.
 */
export interface ServerFacts {
  major: number
  encoding: string
  collate: string
  ctype: string
  /** `datlocprovider` як є: `c`, `i` чи `b`. */
  localeProvider: string
  locale: string | null
  collationVersion: string | null
}

/**
 * Факти сервера поточної бази одним запитом до `pg_database`. Імена колонок
 * — поля `ServerFacts`, а об'єкт будується явно: зайве поле рядка не мусить
 * потрапити в план під `planHash`.
 */
export async function readServerFacts(
  tx: ApplyTransaction
): Promise<ServerFacts> {
  const [row] = await tx.query<{
    major: number
    encoding: string
    collate: string
    ctype: string
    localeProvider: string
    locale: string | null
    collationVersion: string | null
  }>(
    [
      "SELECT pg_catalog.current_setting('server_version_num')::int / 10000 AS major,",
      '  pg_catalog.pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS "collate",',
      '  d.datctype AS ctype, d.datlocprovider::text AS "localeProvider",',
      '  d.datlocale AS locale, d.datcollversion AS "collationVersion"',
      "FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()",
    ].join("\n")
  )
  if (row === undefined) throw new Error("pg_database has no current database")
  return {
    major: row.major,
    encoding: row.encoding,
    collate: row.collate,
    ctype: row.ctype,
    localeProvider: row.localeProvider,
    locale: row.locale,
    collationVersion: row.collationVersion,
  }
}

/**
 * Поля фактів у порядку звіту розбіжності. Запис, а не масив: нове поле
 * `ServerFacts` без місця тут — помилка типів, а не мовчки пропущений факт.
 */
const SERVER_FACT_FIELDS: Readonly<Record<keyof ServerFacts, true>> = {
  major: true,
  encoding: true,
  collate: true,
  ctype: true,
  localeProvider: true,
  locale: true,
  collationVersion: true,
}

/**
 * Які факти сервера різняться (спека промоції §8): відмова копії
 * називає їх, щоб людина знала, що виправляти в копії, а не лише «інший
 * сервер». Значення — скаляри, тож досить порівняння `!==`.
 */
export function differingServerFacts(
  planned: ServerFacts,
  live: ServerFacts
): (keyof ServerFacts)[] {
  return (Object.keys(SERVER_FACT_FIELDS) as (keyof ServerFacts)[]).filter(
    (k) => planned[k] !== live[k]
  )
}
