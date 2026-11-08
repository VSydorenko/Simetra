import type pg from "pg"
import { compile } from "simetra/compiler"
import { desiredForApply, type ApplyDesired } from "simetra/schema"
import { beforeAll, expect } from "vitest"
import { readOnlyQuery } from "../read-only"
import { catalog, metaFiles, project } from "../../../../simetra/test/support"
import { inTarget as loadTarget, query } from "../../__tests__/support/db"

/**
 * Спільна підготовка тестів читання цілі без сесійного стану: бажаний стан
 * застосування моделі, ціль із ним і сесійні налаштування з'єднання.
 */

export let desired: ApplyDesired

/**
 * Бажаний стан будується до тестів файлу: кожен файл читання кличе це на
 * верхньому рівні, бо хук у модулі підтримки без виклику не реєструвався б
 * у файлі.
 */
export function useApplyDesired(): void {
  beforeAll(async () => {
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project({ defaultSchema: "app" }),
        "catalogs/Party/Party.meta.json": catalog("Party"),
      })
    )
    expect(compiled.diagnostics).toEqual([])
    desired = await desiredForApply(compiled.model!)
  })
}

/**
 * Ціль: бажаний стан застосування моделі плюс `setup`; базу прибирає порт.
 * На відміну від спільного `inTarget`, бажаний стан — модель, а `setup` іде
 * окремим запитом по вже завантаженій цілі.
 */
export const inTarget = <T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> =>
  loadTarget(desired.sql, desired.scope, async (url) => {
    await query(url, setup)
    return fn(url)
  })

export interface Session extends Record<string, unknown> {
  pid: number
  readOnly: string
  searchPath: string
  major: number
}

/** Сесійні налаштування, які могло б лишити читання, і backend, що їх несе. */
export const sessionOf = (pool: pg.Pool): Promise<Session> =>
  readOnlyQuery(
    pool,
    async (client) =>
      (
        await client.query<Session>(
          `select pg_backend_pid() as pid,
                  current_setting('default_transaction_read_only') as "readOnly",
                  current_setting('search_path') as "searchPath",
                  current_setting('server_version_num')::int / 10000 as major`
        )
      ).rows[0]!
  )
