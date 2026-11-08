import { afterAll, beforeAll } from "vitest"
import {
  compareFingerprints,
  readFingerprint,
  type CatalogFingerprint,
  type EngineScope,
  type FingerprintSection,
} from "simetra/schema"
import { createApplyDatabase } from ".."
import {
  testRoleName,
  testSuperuserUrl,
} from "../../../../simetra/test/support"
import {
  asSuperuser,
  dropRoles,
  inTarget as loadTarget,
  query,
} from "../../__tests__/support/db"

/**
 * Спільна підготовка тестів SQL-відбитку каталогу: межа, роль і фікстура
 * цілі. Ціль кожного тесту — окрема база від `withDesiredShadow`; база стеку
 * лише читається. Тестова роль — спільна для кластера, тож її створює й
 * прибирає суперкористувач стеку.
 */

export const scope: EngineScope = { schemas: ["app"], provider: "supabase" }
export const ROLE = testRoleName("fingerprint_owner")

/** Базовий стан цілі: таблиця, функція, політика, грант. */
export const FIXTURE = `
  create type app.mood as enum ('a');
  create table app.t (id int primary key, name text);
  create function app.f() returns int language sql as $$ select 1 $$;
  create policy p on app.t for select to authenticated using (true);
  grant select on app.t to authenticated;
  grant create on schema app to ${ROLE};
`

/**
 * Роль фікстури створюється до тестів файлу й прибирається після: кожен файл
 * відбитку кличе це на верхньому рівні, бо хуки в модулі підтримки без
 * виклику не реєструвалися б у файлі.
 */
export function useFingerprintRole(): void {
  beforeAll(() =>
    query(
      testSuperuserUrl(),
      `create role ${ROLE} nologin; grant ${ROLE} to postgres;`
    )
  )
  afterAll(() => dropRoles(ROLE))
}

/**
 * Розгортає `create schema app` і `setup` у тимчасову базу; її прибирає порт.
 * На відміну від спільного `inTarget`, бажаний стан — лише схема, а `setup`
 * іде окремим запитом по вже завантаженій цілі.
 */
export const inTarget = <T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> =>
  loadTarget("create schema app;", scope, async (url) => {
    await query(url, setup)
    return fn(url)
  })

export const read = (url: string): Promise<CatalogFingerprint> =>
  createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    (tx) => readFingerprint(tx, scope)
  )

/** Секції, що змінилися від `mutate`, з власником. */
export async function changedBy(
  url: string,
  mutate: () => Promise<unknown>
): Promise<FingerprintSection[]> {
  const before = await read(url)
  await mutate()
  const result = compareFingerprints(before, await read(url), { owner: true })
  if (!result.comparable) throw new Error("same version must be comparable")
  return result.differing
}

/** Секція типових привілеїв відбитку цілі з фікстурою й `setup` від суперкористувача. */
export const defaultPrivilegesSection = (setup: string): Promise<string> =>
  inTarget(FIXTURE, async (url) => {
    await query(asSuperuser(url), setup)
    return (await read(url)).sections.defaultPrivileges
  })
