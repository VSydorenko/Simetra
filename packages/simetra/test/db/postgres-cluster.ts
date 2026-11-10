import pg from "pg"
import { quoteIdent } from "simetra/model"
import type { PostgresClusterSet } from "simetra/schema"

import {
  runObjectPatterns,
  runTag,
  testDatabaseName,
  testRoleName,
  testSuperuserUrl,
} from "./connection"

/**
 * Пароль ролей входу, яким `setTestPasswords` їх забезпечує. Лише для
 * локального стека `postgres`: порт з хоста доходить у `pg_hba` правилом
 * `scram-sha-256`, тож роль без пароля не ввійде.
 */
export const TEST_LOGIN_PASSWORD = "simetra-test-login"

/**
 * Набір імен кластера з тегами прогону для одного сценарію. Структура та
 * сама, що в `postgresClusterSet` (платформа та її ролі запиту й входу), але
 * кожне ім'я тегове: прибиральник стека впізнає лишки за тегом, а паралельний
 * сценарій не стикається з іншим.
 */
export function taggedClusterSet(label: string): PostgresClusterSet {
  const command = testRoleName(`${label}_cmd`)
  const user = testRoleName(`${label}_usr`)
  const anonymous = testRoleName(`${label}_anon`)
  return {
    owner: testRoleName(`${label}_own`),
    auth: testRoleName(`${label}_auth`),
    request: [user, anonymous],
    roles: {
      names: [command],
      login: [
        {
          name: testRoleName(`${label}_rt`),
          memberOf: [command, user, anonymous],
        },
      ],
    },
    template: testDatabaseName(`${label}_tpl`),
    database: testDatabaseName(label),
  }
}

/** Усі імена ролей набору: власник, роль `auth`, ролі грантів, запиту й входу. */
export function clusterRoleNames(set: PostgresClusterSet): string[] {
  return [
    set.owner,
    set.auth,
    ...set.roles.names,
    ...set.request,
    ...set.roles.login.map((l) => l.name),
  ]
}

/** Ролі входу набору, які мають мати пароль: власник, `auth`, рантайм. */
function loginRoleNames(set: PostgresClusterSet): string[] {
  return [set.owner, set.auth, ...set.roles.login.map((l) => l.name)]
}

/**
 * DSN ролі входу до цільової бази набору: той самий сервер, що й у
 * суперкористувача стека, пароль — `TEST_LOGIN_PASSWORD`.
 */
export function roleUrl(set: PostgresClusterSet, role: string): string {
  const url = new URL(testSuperuserUrl())
  url.username = role
  url.password = TEST_LOGIN_PASSWORD
  url.pathname = `/${set.database}`
  return url.toString()
}

async function withSuperuser<T>(
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: testSuperuserUrl() })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Ставить `TEST_LOGIN_PASSWORD` наявним ролям входу набору від
 * суперкористувача. Тести, що входять тегованими ролями, кличуть це в
 * `beforeAll`; `roles` паролів не ставить (їх задає оператор поза платформою).
 */
export async function setTestPasswords(set: PostgresClusterSet): Promise<void> {
  await withSuperuser(async (client) => {
    const existing = await client.query<{ rolname: string }>(
      "select rolname from pg_roles where rolname = any($1::text[])",
      [loginRoleNames(set)]
    )
    for (const { rolname } of existing.rows)
      await client.query(
        `alter role ${quoteIdent(rolname)} password '${TEST_LOGIN_PASSWORD}'`
      )
  })
}

/**
 * Прибирає кластер набору: спершу додаткові бази, потім шаблон (знімає
 * `IS_TEMPLATE`, інакше його не видалити), база, ролі. Помилка кроку не
 * зупиняє наступні; перша кидається наприкінці. Видаляє лише об'єкти з тегом
 * цього прогону: ім'я чужого прогону — помилка, а не `DROP`.
 */
export async function dropTaggedCluster(
  set: PostgresClusterSet,
  extraDatabases: readonly string[] = []
): Promise<void> {
  const patterns = runObjectPatterns(runTag())
  const errors: unknown[] = []
  const step = async (client: pg.Client, sql: string): Promise<void> => {
    try {
      await client.query(sql)
    } catch (error) {
      errors.push(error)
    }
  }
  await withSuperuser(async (client) => {
    const databases = [...extraDatabases, set.template, set.database]
    const roles = clusterRoleNames(set)
    for (const name of databases)
      if (!patterns.databases.test(name))
        throw new Error(`Refusing to drop the database "${name}": not tagged`)
    for (const name of roles)
      if (!patterns.roles.test(name))
        throw new Error(`Refusing to drop the role "${name}": not tagged`)
    for (const name of extraDatabases)
      await step(
        client,
        `drop database if exists ${quoteIdent(name)} with (force)`
      )
    const template = await client.query(
      "select 1 from pg_database where datname = $1",
      [set.template]
    )
    if (template.rowCount !== 0)
      await step(
        client,
        `alter database ${quoteIdent(set.template)} is_template false`
      )
    await step(
      client,
      `drop database if exists ${quoteIdent(set.template)} with (force)`
    )
    await step(
      client,
      `drop database if exists ${quoteIdent(set.database)} with (force)`
    )
    for (const name of roles)
      await step(client, `drop role if exists ${quoteIdent(name)}`)
  })
  if (errors.length > 0) throw errors[0]
}
