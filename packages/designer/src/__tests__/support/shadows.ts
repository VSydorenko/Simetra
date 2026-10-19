import pg from "pg"
import { testDatabaseUrl } from "../../../../simetra/test/support"

/**
 * Облік тіней, які двигун створив у цьому тестовому файлі. «Наша» тінь —
 * лише та, чию провізію записано тут: нове ім'я на стеку ще не наше,
 * паралельна сесія створює такі самі. Записує тільки обгортка
 * `provisionCoLocatedShadow` із `db-setup.ts`; ізоляція файлів vitest дає
 * кожному файлу свій екземпляр модуля, тож облік — на файл.
 *
 * Модуль свідомо не імпортує `./db`: той тягне адаптер, а адаптер —
 * замоканий `@supabase/pg-delta`, фабрика якого вантажить цей модуль, і
 * імпорт замкнувся б у коло.
 */

const provisioned: string[] = []
/**
 * Провізії, що ще йдуть: ім'я тіні відоме лише з результату провізії, тож
 * перевірка спершу чекає їх — тест, що вийшов за тайм-аут посеред
 * `CREATE DATABASE`, дістане ім'я своєї тіні, щойно провізія завершиться.
 */
const inFlight = new Set<Promise<unknown>>()

/**
 * Records the name of a shadow the engine provisions. Called only by the
 * `provisionCoLocatedShadow` wrapper in `db-setup.ts`; returns `p` unchanged.
 */
export function recordProvision<T extends { name: string }>(
  p: Promise<T>
): Promise<T> {
  const recorded = p.then((shadow) => {
    provisioned.push(shadow.name)
    return shadow
  })
  // Окремий проміс, що завжди виконується: відмову провізії отримує
  // двигун, а не необроблений проміс у наборі. Провізія, що впала, тіні не
  // лишає — `CREATE DATABASE` її останній крок, — тож і чекати на неї
  // перевірці нічого
  const settled = recorded.then(
    () => undefined,
    () => undefined
  )
  inFlight.add(settled)
  void settled.then(() => inFlight.delete(settled))
  return recorded
}

/** Names of every shadow provisioned in this test file, in order. */
export function provisionedShadows(): readonly string[] {
  return [...provisioned]
}

async function onStack<R extends pg.QueryResultRow>(
  sql: string,
  params: unknown[]
): Promise<R[]> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  try {
    return (await client.query<R>(sql, params)).rows
  } finally {
    await client.end()
  }
}

/**
 * Shadows of this test file that are still on the stack, after waiting for
 * provisions in flight. With `from` (a `provisionedShadows().length` taken
 * earlier), only the shadows provisioned since then.
 */
export async function leftoverShadows(from = 0): Promise<string[]> {
  await Promise.all([...inFlight])
  // Позначка, а не весь облік: тест, що питає зсередини своєї цілі, бачив би
  // і саму ціль — вона теж тінь і жива до кінця `inTarget`
  const names = provisioned.slice(from)
  if (names.length === 0) return []
  const rows = await onStack<{ name: string }>(
    "select datname as name from pg_database where datname = any($1) order by 1",
    [names]
  )
  return rows.map((r) => r.name)
}

/**
 * Throws, naming them, when shadows of this test file are left on the stack;
 * drops them first, since they are this file's own.
 */
export async function expectNoLeftoverShadows(): Promise<void> {
  const leftovers = await leftoverShadows()
  if (leftovers.length === 0) return
  // Збій одного `DROP` не зупиняє решту й не губиться: він іде поруч із
  // переліком сиріт, а не замість нього
  const failures: unknown[] = []
  for (const name of leftovers) {
    try {
      await onStack(
        `drop database if exists "${name.replaceAll('"', '""')}" with (force)`,
        []
      )
    } catch (error) {
      failures.push(error)
    }
  }
  const message = `Shadow databases this test file left behind: ${leftovers.join(", ")}`
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `${message}; ${failures.length} of them could not be dropped`
    )
  throw new Error(`${message}; dropped`)
}
