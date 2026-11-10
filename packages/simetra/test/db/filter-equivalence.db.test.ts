import fc from "fast-check"
import {
  CommandFailure,
  FILTER_OPERATORS,
  keysetFilter,
  encodeRow,
  runtimeCatalogSchema,
  type CommandError,
  type Filter,
  type FilterOperator,
  type OrderBy,
} from "simetra/model"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { DataError } from "../../src/data/errors"
import {
  FILTER_CASES,
  FILTER_REFUSALS,
  FILTER_ROWS,
  FILTER_TABLE_DDL,
  FILTER_VALUES,
  filterObject,
} from "../../src/data/store/__tests__/filter-fixture"
import {
  checkFilterBudget,
  compareRows,
  compileFilter,
  fieldInfoOf,
  filterCollator,
  nullableOf,
} from "../../src/data/store/filter"
import { executeRead, prepareRead } from "../../src/server/read"
import { withRollback } from "./connection"

/*
 * Еквівалентність обчислювача фільтра T4 будівнику T3 (спека П4-B інв. 16,
 * §14.1). DB, а не юніт: множину будівника дає лише справжній Postgres — його
 * колляція, `ILIKE`, приведення `castType` і тризначна логіка. Таблиця
 * тимчасова в транзакції `withRollback`: на стеку нічого не лишається.
 */

const catalog = runtimeCatalogSchema.parse({
  format: 1,
  snapshotHash: "filter-equivalence",
  provider: "supabase",
  objects: [filterObject],
})
const object = { kind: filterObject.kind, name: filterObject.name }
const info = fieldInfoOf(filterObject)
const collator = filterCollator()

type Outcome = { keys: string[] } | { error: object }

const errorOf = ({ code, path, reason }: CommandError) => ({
  code,
  ...(path === undefined ? {} : { path }),
  ...(reason === undefined ? {} : { reason }),
})

/** Рядки читання T3 у порядку сервера: `prepareRead` + `executeRead` над клієнтом тесту. */
async function serverRows(
  client: pg.Client,
  query: { where?: Filter; orderBy?: OrderBy; limit?: number } = {}
): Promise<{ rows: Record<string, unknown>[] } | { error: object }> {
  const prepared = prepareRead(catalog, { object, limit: 200, ...query })
  if ("error" in prepared) return { error: errorOf(prepared.error) }
  const result = await executeRead(
    prepared.object,
    prepared.plan,
    async (statement) =>
      (await client.query(statement.text, statement.params)).rows as Record<
        string,
        unknown
      >[],
    null
  )
  if ("error" in result) return { error: errorOf(result.error) }
  if (!("rows" in result)) throw new Error("a list read counted")
  // Без `known` маркерів нема.
  return { rows: result.rows as Record<string, unknown>[] }
}

/** Множина ключів будівника T3. */
async function serverKeys(client: pg.Client, where?: Filter): Promise<Outcome> {
  const read = await serverRows(client, where === undefined ? {} : { where })
  if ("error" in read) return read
  return { keys: read.rows.map((row) => row.ref as string).sort() }
}

/** Множина ключів обчислювача T4 над рядками, прочитаними з бази. */
function clientKeys(
  rows: readonly Record<string, unknown>[],
  where: Filter
): Outcome {
  try {
    const test = compileFilter(where, info, collator)
    return {
      keys: rows
        .filter(test)
        .map((row) => row.ref as string)
        .sort(),
    }
  } catch (error) {
    if (error instanceof CommandFailure) return { error: errorOf(error.error) }
    // Поля генерованих фільтрів відомі: `DataError` тут — розбіжність.
    if (error instanceof DataError) return { error: { code: error.code } }
    throw error
  }
}

/** Таблиця фікстури в транзакції тесту й рядки, як їх декодує читання T3. */
async function seeded(client: pg.Client): Promise<Record<string, unknown>[]> {
  await client.query(FILTER_TABLE_DDL)
  for (const row of FILTER_ROWS) {
    await client.query(
      "INSERT INTO pg_temp.filter_rows" +
        " SELECT * FROM jsonb_populate_record(null::pg_temp.filter_rows, $1::jsonb)",
      [JSON.stringify(encodeRow(filterObject, row))]
    )
  }
  const read = await serverRows(client)
  if (!("rows" in read)) throw new Error("fixture read refused")
  return read.rows
}

// Генеративні фільтри: глибина до 3, оператори §4.1, значення з фікстури, з
// `%`, `_` і діакритикою, зрідка `NULL` чи значення чужого типу — відмови
// теж мають збігтися.
const attributes = [...Object.keys(FILTER_VALUES), "tags", "payload", "memo"]
const anyValue = Object.values(FILTER_VALUES).flat()

const valueFor = (attribute: string): fc.Arbitrary<unknown> => {
  const own = FILTER_VALUES[attribute] ?? ["m"]
  return fc.oneof(
    { weight: 8, arbitrary: fc.constantFrom(...own) },
    { weight: 1, arbitrary: fc.constant(null) },
    { weight: 1, arbitrary: fc.constantFrom(...anyValue) }
  )
}

const conditionArb: fc.Arbitrary<Filter> = fc
  .tuple(
    fc.constantFrom(...attributes),
    fc.constantFrom<FilterOperator>(...FILTER_OPERATORS)
  )
  .chain(([attribute, op]): fc.Arbitrary<Filter> => {
    if (op === "isNull") return fc.constant({ attribute, op })
    const value =
      op === "in"
        ? fc.array(valueFor(attribute), { minLength: 1, maxLength: 3 })
        : valueFor(attribute)
    return value.map((v) => ({ attribute, op, value: v }))
  })

const tree = (depth: number): fc.Arbitrary<Filter> =>
  depth === 1
    ? conditionArb
    : fc.oneof(
        { weight: 3, arbitrary: conditionArb },
        {
          weight: 1,
          arbitrary: fc
            .array(tree(depth - 1), { minLength: 1, maxLength: 3 })
            .map((and): Filter => ({ and })),
        },
        {
          weight: 1,
          arbitrary: fc
            .array(tree(depth - 1), { minLength: 1, maxLength: 3 })
            .map((or): Filter => ({ or })),
        },
        {
          weight: 1,
          arbitrary: tree(depth - 1).map((not): Filter => ({ not })),
        }
      )

describe("T4 filter evaluator against the T3 read builder", () => {
  it("selects the same keys as the builder on fixtures and generated filters", async () => {
    await withRollback(async (client) => {
      // Обчислювач порівнює рядки колатором en-US — колляцією бази (§4.2).
      const { rows: collation } = await client.query(
        "SELECT datlocprovider AS provider, datlocale AS locale" +
          " FROM pg_database WHERE datname = current_database()"
      )
      expect(collation).toEqual([{ provider: "i", locale: "en-US" }])
      const rows = await seeded(client)
      expect(rows).toHaveLength(FILTER_ROWS.length)
      const keyOf = (n: number) => FILTER_ROWS[n - 1]!.ref as string

      for (const [name, filter, expected] of FILTER_CASES) {
        const server = await serverKeys(client, filter)
        expect(server, name).toEqual({ keys: expected.map(keyOf).sort() })
        expect(clientKeys(rows, filter), name).toEqual(server)
      }
      for (const [name, filter, error] of FILTER_REFUSALS) {
        // Невідоме для T4 — помилка розробника, для T3 — `command.invalid`.
        if ((error as { code: string }).code.startsWith("data.")) continue
        const server = await serverKeys(client, filter)
        expect(server, name).toEqual({ error })
        expect(clientKeys(rows, filter), name).toEqual(server)
      }

      // Кожен прогін — під точкою збереження: помилка драйвера в одному
      // фільтрі не перериває транзакцію й не отруює звуження контрприкладу.
      await fc.assert(
        fc.asyncProperty(tree(3), async (filter) => {
          await client.query("SAVEPOINT filter_case")
          try {
            expect(clientKeys(rows, filter)).toEqual(
              await serverKeys(client, filter)
            )
          } finally {
            await client.query("ROLLBACK TO SAVEPOINT filter_case")
          }
        }),
        { numRuns: 200 }
      )
    })
  })

  // Порядок `full` (компаратор) і порядок `window` (`ORDER BY` бази й
  // keyset) мають збігатися для не-рядкових типів, з NULL з обох боків.
  // Рядки тут не звіряються: `full` сортує їх мовою користувача (Рд29).
  it("orders like ORDER BY and pages by keyset without loss or duplicates", async () => {
    await withRollback(async (client) => {
      const rows = await seeded(client)
      const orders: OrderBy[] = (
        ["amount", "status", "day", "at", "flag"] as const
      ).flatMap((attribute) =>
        (["asc", "desc"] as const).flatMap((direction) => [
          [{ attribute, direction }],
          [{ attribute, direction, nulls: "first" as const }],
          [{ attribute, direction, nulls: "last" as const }],
        ])
      )
      orders.push([
        { attribute: "flag", direction: "desc", nulls: "last" },
        { attribute: "day", direction: "asc", nulls: "first" },
        { attribute: "ref", direction: "desc" },
      ])
      for (const orderBy of orders) {
        const name = JSON.stringify(orderBy)
        const expected = [...rows]
          .sort(compareRows(orderBy, info, "ref", collator))
          .map((row) => row.ref as string)
        const server = await serverRows(client, { orderBy })
        expect(server, name).toEqual({ rows: expect.any(Array) })
        const ordered = (server as { rows: Record<string, unknown>[] }).rows
        expect(
          ordered.map((row) => row.ref),
          name
        ).toEqual(expected)

        const paged: string[] = []
        let where: Filter | undefined
        for (;;) {
          if (where !== undefined) checkFilterBudget(where)
          const page = await serverRows(client, {
            orderBy,
            limit: 3,
            ...(where === undefined ? {} : { where }),
          })
          if (!("rows" in page)) throw new Error(`${name}: page refused`)
          if (page.rows.length === 0) break
          paged.push(...page.rows.map((row) => row.ref as string))
          const last = page.rows[page.rows.length - 1]!
          where = keysetFilter(
            orderBy,
            { values: last, key: last.ref as string, direction: "after" },
            "ref",
            nullableOf(info)
          )
        }
        expect(paged, name).toEqual(expected)
      }
    })
  })
})
