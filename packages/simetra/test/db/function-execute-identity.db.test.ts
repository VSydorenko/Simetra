import { randomUUID } from "node:crypto"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { quoteIdent } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  acceptDebt,
  catalog,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
import {
  asStackSuperuser,
  claimsFor,
  queryAs,
  testRoleName,
  withRollback,
} from "./connection"
import { testProvider } from "./profile"

/**
 * `REVOKE`/`GRANT EXECUTE` задекларованої функції з лапкованими частинами
 * імені влучає рівно в неї на справжньому Postgres (#297, інваріант І1 плану):
 * поруч лежить чужа функція поза моделлю, текст якої без лапок збігся б з
 * підписом гранту. Перевіряє ACL бази після застосування: роль без грантів
 * не виконує задекларовану (відкликання від `PUBLIC` влучило), роль
 * викликача виконує, а `proacl` чужої лишається `NULL` (її ніхто не чіпав).
 * Схеми несуть тег запуску; усе створено в транзакції тесту, тож відкат
 * прибирає його на будь-якому шляху.
 */

const closedFn = (name: string, args = "") =>
  `CREATE FUNCTION ${name}(${args}) RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT 1 $$;\n`

/** Схема з тегом запуску в нижньому регістрі й її пара у верхньому. */
const lowerSchema = () => testRoleName("fx")
const upperSchema = () => lowerSchema().toUpperCase()

interface Case {
  /** Чужі об'єкти поза моделлю, створені до застосування моделі. */
  foreign: string
  /** SQL моделі в теці схеми `schema`. */
  sql: string
  schema: string
  /** Задекларована функція: ім'я й виклик від ролі. */
  name: string
  call: string
  /** Сигнатури `regprocedure` задекларованої й чужої функцій. */
  declared: string
  other: string
}

async function deployed(client: pg.Client, c: Case): Promise<void> {
  await client.query(c.foreign)
  // Домен моделі в теці SQL — борг ратчета; його прийнято, як у unit-тестах.
  const result = await compile(
    await acceptDebt(
      metaFiles({
        "project.meta.json": project({
          database: { provider: testProvider() },
        }),
        "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
        [`sql/${c.schema}/fns.sql`]: c.sql,
        [`sql/${c.schema}/fns.functions.json`]: JSON.stringify({
          functions: [
            {
              id: uuid(9701),
              function: { schema: c.schema, name: c.name },
              callers: ["user"],
            },
          ],
        }),
      })
    )
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
}

/** Код відмови чи `ok` виклику `sql` від ролі API користувача. */
async function callAsUser(client: pg.Client, sql: string): Promise<string> {
  const result = await queryAs(
    client,
    "user",
    claimsFor("user", randomUUID()),
    sql
  )
  return "code" in result ? result.code : "ok"
}

/**
 * Код відмови чи `ok` виклику від ролі без жодного гранту, з `USAGE` на
 * схемах випадку: інакше `42501` дала б схема, а не ACL функції.
 */
async function callWithoutGrants(
  client: pg.Client,
  schemas: readonly string[],
  sql: string
): Promise<string> {
  const role = testRoleName("nogrant")
  // Роль створює суперкористувач стека: власник профілю ролей не створює.
  await asStackSuperuser(client, () => client.query(`CREATE ROLE ${role}`))
  for (const schema of schemas)
    await client.query(`GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO ${role}`)
  await client.query("SAVEPOINT probe")
  try {
    await client.query(`SET LOCAL ROLE ${role}`)
    await client.query(sql)
    return "ok"
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT probe")
  }
}

const proacl = async (client: pg.Client, signature: string) =>
  (
    await client.query<{ acl: string | null }>(
      "SELECT proacl::text AS acl FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure",
      [signature]
    )
  ).rows[0]?.acl

describe("EXECUTE of a function with quoted name parts in Postgres", () => {
  it.each<{ part: string; make: () => Case & { schemas: string[] } }>([
    {
      // Лише регістр: без лапок `"F"` зводиться до чужої `f` — тихий шлях.
      part: "the name in upper case beside a foreign lower-case name",
      make: () => {
        const s = lowerSchema()
        return {
          schemas: [s],
          foreign: `CREATE SCHEMA ${s}; ${closedFn(`${s}.f`)}`,
          sql: closedFn(`${s}."F"`),
          schema: s,
          name: "F",
          call: `SELECT ${s}."F"()`,
          declared: `${s}."F"()`,
          other: `${s}.f()`,
        }
      },
    },
    {
      part: "the schema in upper case beside a foreign lower-case schema",
      make: () => {
        const s = lowerSchema()
        const S = quoteIdent(upperSchema())
        return {
          schemas: [s, upperSchema()],
          foreign: `CREATE SCHEMA ${s}; ${closedFn(`${s}.f`)}`,
          sql: closedFn(`${S}.f`),
          schema: upperSchema(),
          name: "f",
          call: `SELECT ${S}.f()`,
          declared: `${S}.f()`,
          other: `${s}.f()`,
        }
      },
    },
    {
      // Без лапок `"x,y"` став би двома аргументами `x, y` — чужою функцією.
      part: "an argument type with a comma beside a foreign two-argument overload",
      make: () => {
        const s = lowerSchema()
        return {
          schemas: [s],
          foreign: [
            `CREATE SCHEMA ${s};`,
            `CREATE DOMAIN ${s}.x AS int;`,
            `CREATE DOMAIN ${s}.y AS int;`,
            closedFn(`${s}.f`, `a ${s}.x, b ${s}.y`),
          ].join("\n"),
          sql:
            `CREATE DOMAIN ${s}."x,y" AS int;\n` +
            closedFn(`${s}.f`, `a ${s}."x,y"`),
          schema: s,
          name: "f",
          call: `SELECT ${s}.f(1::${s}."x,y")`,
          declared: `${s}.f(${s}."x,y")`,
          other: `${s}.f(${s}.x, ${s}.y)`,
        }
      },
    },
  ])(
    "$part: the grants hit exactly the declared function",
    async ({ make }) => {
      await withRollback(async (client) => {
        const c = make()
        await deployed(client, c)
        expect(await callAsUser(client, c.call)).toBe("ok")
        expect(await callWithoutGrants(client, c.schemas, c.call)).toBe("42501")
        expect(await proacl(client, c.other)).toBeNull()
        expect(await proacl(client, c.declared)).not.toBeNull()
      })
    }
  )
})
