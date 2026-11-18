// Запобіжник бази розробника для скриптів, що пишуть дані (`dev-user`, `seed`):
// та сама семантика, що guard даних designer (`packages/designer/src/io/data.ts`).
// Копія, а не імпорт: шаблон копіюється споживачеві без внутрішностей designer.
import pg from "pg"

/** Ознака бази розробника: налаштування рівня бази (`ALTER DATABASE … SET`). */
const ENVIRONMENT_FLAG = "simetra.environment=development"

// Лише `setrole = 0`: налаштування ролі (`ALTER ROLE … SET`, зокрема в
// конкретній базі) ознаки бази не дає, а `current_setting` підробляє
// `options=-c …` самого DSN.
const DEVELOPMENT_FLAG_SQL = `SELECT EXISTS (
  SELECT FROM pg_catalog.pg_db_role_setting d
  JOIN pg_catalog.pg_database b ON b.oid = d.setdatabase
  WHERE b.datname = pg_catalog.current_database() AND d.setrole = 0
    AND $1 = ANY (d.setconfig)) AS development`

const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Хост, який візьме `pg`: `localhost`, петля IPv4, `::1` чи шлях unix-сокета. */
export function isLocalHost(host) {
  if (host === undefined || host === "") return false
  if (host.startsWith("/")) return true
  const h = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (h === "localhost" || h === "::1") return true
  const m = IPV4_LOOPBACK.exec(h)
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255)
}

/** Відмова запобіжника; нічого не записано. */
export class DevGuardRefusal extends Error {}

/**
 * Хост так, як його візьме `pg` з цього DSN (повторний `host`, `socket:`,
 * закодований шлях): розбирає сам `pg`, а не `URL`, який бере інше значення.
 */
export function connectionHost(dsn) {
  return new pg.Client({ connectionString: dsn }).host
}

/** Лише loopback; без запиту до бази. */
export function assertLoopback(dsn) {
  if (!isLocalHost(connectionHost(dsn)))
    throw new DevGuardRefusal(
      "refused: the database host is not loopback; this script runs only against a development database on this machine"
    )
}

/**
 * Loopback і ознака рівня бази. `queryable` — той самий пул (клієнт), що далі
 * пише; `dsn` — той самий рядок, з яким його створено.
 */
export async function assertDevelopmentDatabase(queryable, dsn) {
  assertLoopback(dsn)
  const { rows } = await queryable.query(DEVELOPMENT_FLAG_SQL, [
    ENVIRONMENT_FLAG,
  ])
  if (rows[0]?.development !== true)
    throw new DevGuardRefusal(
      "refused: the database does not carry the database-level flag simetra.environment = 'development' (ALTER DATABASE … SET)"
    )
}
