import { afterAll, describe, expect, it } from "vitest"
import pg from "pg"
import {
  runtimeObjectSchema,
  type RuntimeCatalog,
  type RuntimeObject,
} from "simetra/model"
import { sample } from "../../src/server/__tests__/fixtures"
import { mapDatabaseError, refOf } from "../../src/server/errors"
import {
  fromPgPool,
  normalizeError,
  type DatabaseClient,
  type PgPoolLike,
} from "../../src/server/port"
import { testDatabaseUrl } from "./connection"

/**
 * Мапінг відмов на справжній формі помилки Postgres і `pg` (спека П4 §6.5,
 * §6.10): що `TABLE` і обмеження `23503` видалення називають таблицю, яка
 * посилається, і що обрив сокета без SQLSTATE порт бачить як утрату
 * з'єднання, — вирішують сервер і драйвер, unit-фейк цього не доводить.
 * Таблиці — тимчасові `ON COMMIT DROP` у транзакції тесту: на стеку нічого не
 * лишається.
 */

const pool = new pg.Pool({ connectionString: testDatabaseUrl() })
afterAll(async () => {
  await pool.end()
})

// Об'єкти каталогу над тимчасовими таблицями: мапінг читає лише ім'я таблиці
// й обмеження, решта — `sample`.
const node: RuntimeObject = runtimeObjectSchema.parse({
  ...sample,
  table: { schema: "pg_temp", name: "refusal_node" },
  constraints: [
    {
      name: "refusal_node_link_fkey",
      kind: "foreignKey",
      columns: ["link_col"],
    },
  ],
})
const child: RuntimeObject = runtimeObjectSchema.parse({
  ...sample,
  id: "00000000-0000-4000-8000-0000000000c1",
  name: "RefusalChild",
  kindLabel: "refusal_child",
  table: { schema: "pg_temp", name: "refusal_child" },
  constraints: [
    {
      name: "refusal_child_link_fkey",
      kind: "foreignKey",
      columns: ["link_col"],
    },
  ],
  tabularSections: [],
})
const catalog: RuntimeCatalog = {
  format: 1,
  snapshotHash: "hash",
  provider: "postgres",
  objects: [node, child],
}

const ROOT = "00000000-0000-4000-8000-0000000000a1"
const LEAF = "00000000-0000-4000-8000-0000000000a2"

/** Помилка `statement` у транзакції з таблицями `setup`; транзакцію відкочено. */
async function refusalOf(
  setup: readonly string[],
  statement: string,
  commit = false
): Promise<unknown> {
  const client = await fromPgPool(pool).connect()
  let thrown: unknown
  try {
    await client.query("BEGIN")
    for (const text of setup) await client.query(text)
    await client.query(statement, [ROOT])
    if (commit) await client.query("COMMIT")
  } catch (error) {
    thrown = error
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
    client.release()
  }
  expect(thrown).toBeDefined()
  return thrown
}

const NODE = [
  `CREATE TEMP TABLE refusal_node (id uuid PRIMARY KEY, link_col uuid
     CONSTRAINT refusal_node_link_fkey REFERENCES refusal_node) ON COMMIT DROP`,
  `INSERT INTO refusal_node VALUES ('${ROOT}', NULL), ('${LEAF}', '${ROOT}')`,
]
const childOf = (deferred: boolean) => [
  `CREATE TEMP TABLE refusal_node (id uuid PRIMARY KEY, link_col uuid) ON COMMIT DROP`,
  `CREATE TEMP TABLE refusal_child (id uuid PRIMARY KEY, link_col uuid
     CONSTRAINT refusal_child_link_fkey REFERENCES refusal_node
     ${deferred ? "DEFERRABLE INITIALLY DEFERRED" : ""}) ON COMMIT DROP`,
  `INSERT INTO refusal_node VALUES ('${ROOT}', NULL)`,
  `INSERT INTO refusal_child VALUES ('${LEAF}', '${ROOT}')`,
]
const DELETE = "DELETE FROM refusal_node WHERE id = $1"
const deleting = {
  kind: "write" as const,
  object: node,
  operation: "delete" as const,
}
const REFERENCED = {
  code: "command.invalid",
  reason: "referenced",
  object: refOf(node),
}

describe("23503 of a delete on Postgres", () => {
  // Батько ієрархії з дітьми: FK тієї самої таблиці.
  it("a self reference names the table itself and maps to referenced", async () => {
    const error = normalizeError(await refusalOf(NODE, DELETE))
    expect(error).toMatchObject({
      code: "23503",
      table: "refusal_node",
      constraint: "refusal_node_link_fkey",
    })
    expect(mapDatabaseError(error, catalog, deleting)).toEqual(REFERENCED)
  })

  // Без Р10 мапінг назвав би реквізит `link` об'єкта `RefusalChild`.
  it("a row of another object names the referencing table and maps to referenced", async () => {
    const error = normalizeError(await refusalOf(childOf(false), DELETE))
    expect(error).toMatchObject({
      code: "23503",
      table: "refusal_child",
      constraint: "refusal_child_link_fkey",
    })
    expect(mapDatabaseError(error, catalog, deleting)).toEqual(REFERENCED)
  })

  it("a deferred FK refuses on COMMIT and maps to referenced by the deletes", async () => {
    const error = normalizeError(await refusalOf(childOf(true), DELETE, true))
    expect(error).toMatchObject({
      code: "23503",
      table: "refusal_child",
      constraint: "refusal_child_link_fkey",
    })
    expect(mapDatabaseError(error, catalog, undefined, [node])).toEqual(
      REFERENCED
    )
  })
})

describe("connection loss without SQLSTATE on pg", () => {
  // Обрив сокета під запитом: `pg` шле `error` клієнта раніше, ніж відхиляє
  // запит без SQLSTATE (`Client#_handleErrorEvent`), — порт називає це
  // утратою з'єднання, а не вадою драйвера.
  it("a socket closed under a query is a lost connection", async () => {
    const raw: pg.PoolClient[] = []
    const tapped: PgPoolLike = {
      async connect() {
        const client = await pool.connect()
        raw.push(client)
        return client
      },
    }
    const client: DatabaseClient = await fromPgPool(tapped).connect()
    let thrown: unknown
    try {
      const query = client.query("SELECT pg_sleep(0.5)")
      const socket = (
        raw[0] as unknown as { connection: { stream: { destroy(): void } } }
      ).connection.stream
      socket.destroy()
      await query
    } catch (error) {
      thrown = error
    } finally {
      client.release(true)
    }
    const error = normalizeError(thrown)
    expect(error.code).toBeUndefined()
    expect(error.connectionLost).toBe(true)
  })
})
