import pg from "pg"
import {
  runApplicationName,
  runTag,
  superuserClient,
  testDatabaseUrl,
} from "../../../../simetra/test/support"

/**
 * Облік тіней, які двигун створив у цьому тестовому файлі. «Наша» тінь —
 * лише та, чию провізію записано тут: нове ім'я на стеку ще не наше,
 * паралельна сесія створює такі самі. Записують тільки обгортки
 * `provisionCoLocatedShadow` і `provisionTemplateShadow` із `db-setup.ts`; ізоляція файлів vitest дає
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
 * `provisionCoLocatedShadow` and `provisionTemplateShadow` wrappers in
 * `db-setup.ts`; returns `p` unchanged.
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

/** How long the drop of a template shadow waits for the backends of this run. */
const RUN_BACKENDS_TIMEOUT_MS = 10_000

/**
 * Waits until no backend with the `application_name` of this run is
 * connected to `database`, observed by the stack superuser from another
 * database; throws with the pids and names of the backends left after
 * `timeoutMs`.
 */
export async function waitForRunBackendsGone(
  database: string,
  timeoutMs = RUN_BACKENDS_TIMEOUT_MS
): Promise<void> {
  const name = runApplicationName(runTag())
  const observer = await superuserClient()
  try {
    // Межа — за годинником, а не за числом спроб: запит спостерігача теж
    // забирає час
    const deadline = Date.now() + timeoutMs
    let left: { pid: number; application_name: string }[] = []
    for (;;) {
      left = (
        await observer.query<{ pid: number; application_name: string }>(
          "SELECT pid, application_name FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND application_name = $2",
          [database, name]
        )
      ).rows
      if (left.length === 0) return
      if (Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(
      `backends of this run are still connected to ${database} after ${timeoutMs} ms: ${left
        .map((b) => `${b.pid} (${b.application_name})`)
        .join(", ")}`
    )
  } finally {
    await observer.end()
  }
}

/**
 * Wraps the `cleanup` of a template shadow so that the drop waits until the
 * backends of this run have left the shadow (`waitForRunBackendsGone`).
 * A closed `pg` client returns before its backend leaves the server, and the
 * engine drops the shadow `WITH (FORCE)` as the owner of the profile: the
 * tests log in as the stack superuser, and the owner may not end a
 * superuser's backend (`42501`). A backend still there after the wait is a
 * client left open, named in the error. Called only by the
 * `provisionTemplateShadow` wrapper in `db-setup.ts`.
 */
export function awaitRunBackends<
  T extends { name: string; cleanup(): Promise<unknown> },
>(shadow: T): T {
  return {
    ...shadow,
    cleanup: async () => {
      await waitForRunBackendsGone(shadow.name)
      return shadow.cleanup()
    },
  }
}

/** Невдалі `DROP` тіней цього файлу: ім'я → SQLSTATE (або його відсутність). */
const dropFailures = new Map<string, string>()

/**
 * Wraps the `cleanup` of a template shadow so that a failed drop is recorded
 * under the shadow's name; the leftover check then names its cause. Called
 * only by the `provisionTemplateShadow` wrapper in `db-setup.ts`.
 */
export function recordDropFailures<
  T extends {
    cleanup(): Promise<{ shadow: string; sqlstate?: string } | undefined>
  },
>(shadow: T): T {
  return {
    ...shadow,
    cleanup: async () => {
      const failure = await shadow.cleanup()
      if (failure !== undefined)
        dropFailures.set(
          failure.shadow,
          failure.sqlstate === undefined
            ? "no SQLSTATE"
            : `SQLSTATE ${failure.sqlstate}`
        )
      return failure
    },
  }
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
  // Причина, якщо прибирання двигуна її повідомило: інакше тінь лишилась
  // без `DROP` (виняток до прибирання) або `DROP` іншого шляху змовчав
  const named = leftovers.map((name) => {
    const cause = dropFailures.get(name)
    return cause === undefined ? name : `${name} (engine drop failed: ${cause})`
  })
  const message = `Shadow databases this test file left behind: ${named.join(", ")}`
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      `${message}; ${failures.length} of them could not be dropped`
    )
  throw new Error(`${message}; dropped`)
}
