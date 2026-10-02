import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile, type CompiledModel } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import { readCatalog } from "../../../test/db/catalog"
import { expectCatalogMatchesSnapshot } from "../../../test/db/compare"
import { withRollback } from "../../../test/db/connection"
import {
  accumulationRegisters,
  customTables,
  enumerations,
  FIXTURES,
  movementQuery,
  saleDocument,
} from "./fixtures/e1-fixtures"

/**
 * Перший доказ на справжньому Postgres 17 (спека П2 §8.3, §10): скомпільована
 * модель розгортається, а каталог після розгортання збігається зі знімком.
 * Кожен збій тут — дефект компілятора (фізика) чи рендера (форма SQL).
 */

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const result = await compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/** Розгортає модель у транзакції клієнта й повертає її схеми. */
async function deploy(
  client: pg.Client,
  model: CompiledModel
): Promise<string[]> {
  await client.query(renderDesiredState(model).sql)
  return [
    ...new Set([
      ...model.physical.tables.map((table) => table.schema),
      ...model.physical.enumTypes.map((type) => type.schema),
    ]),
  ]
}

/** Код помилки Postgres (SQLSTATE) і порушене обмеження з винятку `pg`. */
async function sqlError(
  work: Promise<unknown>
): Promise<{ code?: string; constraint?: string } | undefined> {
  try {
    await work
    return undefined
  } catch (error) {
    const { code, constraint } = error as {
      code?: string
      constraint?: string
    }
    return { code, constraint }
  }
}

/** Організація — корінь скоупу `org`: на неї посилається кожен скоуплений рядок. */
async function insertOrganization(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "INSERT INTO app.organization (id) VALUES (gen_random_uuid()) RETURNING id"
  )
  return rows[0]!.id
}

describe("deploy the desired state to Postgres", () => {
  for (const [name, fixture] of FIXTURES) {
    it(name, async () => {
      const model = await compiled(fixture())
      await withRollback(async (client) => {
        const schemas = await deploy(client, model)
        const catalog = await readCatalog(client, schemas)
        expectCatalogMatchesSnapshot(catalog, model.physical)
        // Функції одиниць і обгортки рухів створені там, де їх чекає модель.
        const functions = catalog.functions.map((f) => `${f.schema}.${f.name}`)
        for (const unit of model.sqlUnits) {
          if (unit.class === "function" || unit.class === "movementQuery") {
            expect(functions).toContain(`${unit.schema}.${unit.name}`)
          }
        }
      })
    })
  }

  it("the comparison notices a snapshot that differs from the catalog", async () => {
    const model = await compiled(customTables())
    await withRollback(async (client) => {
      const catalog = await readCatalog(client, await deploy(client, model))
      const audit = model.physical.tables.find((t) => t.name === "audit")!
      const tampered: ((table: PhysicalTable) => PhysicalTable)[] = [
        (t) => ({ ...t, columns: [...t.columns].reverse() }),
        (t) => ({
          ...t,
          foreignKeys: t.foreignKeys.map((fk) => ({
            ...fk,
            onDelete: "restrict",
          })),
        }),
        (t) => ({
          ...t,
          uniques: t.uniques.map((u) => ({
            ...u,
            nullsNotDistinct: !u.nullsNotDistinct,
          })),
        }),
        (t) => ({
          ...t,
          indexes: t.indexes.map((index) => ({ ...index, where: undefined })),
        }),
        (t) => ({ ...t, indexes: [] }),
        (t) => ({ ...t, rowLevelSecurity: "forced" }),
        (t) => ({
          ...t,
          columns: t.columns.map((c) =>
            c.name === "email" ? { ...c, notNull: true } : c
          ),
        }),
        (t) => ({
          ...t,
          foreignKeys: t.foreignKeys.map((fk) => ({
            ...fk,
            references: { ...fk.references, table: "organization" },
          })),
        }),
        (t) => ({
          ...t,
          indexes: t.indexes.map((index) => ({
            ...index,
            unique: !index.unique,
          })),
        }),
      ]
      for (const change of tampered) {
        const physical = {
          ...model.physical,
          tables: model.physical.tables.map((t) =>
            t === audit ? change(t) : t
          ),
        }
        expect(() => expectCatalogMatchesSnapshot(catalog, physical)).toThrow()
      }
    })
  })

  it("the comparison notices enum values in another order", async () => {
    const model = await compiled(enumerations())
    await withRollback(async (client) => {
      const catalog = await readCatalog(client, await deploy(client, model))
      expect(model.physical.enumTypes).not.toEqual([])
      const physical = {
        ...model.physical,
        enumTypes: model.physical.enumTypes.map((type) => ({
          ...type,
          values: [...type.values].reverse(),
        })),
      }
      expect(() => expectCatalogMatchesSnapshot(catalog, physical)).toThrow()
    })
  })

  it("nulls not distinct rejects a second row with null dimension", async () => {
    const model = await compiled(accumulationRegisters())
    await withRollback(async (client) => {
      await deploy(client, model)
      const org = await insertOrganization(client)
      const insert = () =>
        client.query(
          `INSERT INTO app.stock_turnovers_month (org_id, item_id, lot, month)
           VALUES ($1, NULL, NULL, '2026-01-01')`,
          [org]
        )
      await insert()
      expect(await sqlError(insert())).toEqual({
        code: "23505",
        constraint: "stock_turnovers_month_org_id_item_id_lot_month_key",
      })
    })
  })

  it("number_period is generated in the project time zone", async () => {
    const model = await compiled(saleDocument())
    await withRollback(async (client) => {
      await deploy(client, model)
      const org = await insertOrganization(client)
      // 23:30 UTC 31 січня — це вже 1 лютого в Києві: місяць нумерації — лютий.
      const { rows } = await client.query<{ number_period: string }>(
        `INSERT INTO app.sale (org_id, date)
         VALUES ($1, '2026-01-31 23:30:00+00')
         RETURNING number_period::text`,
        [org]
      )
      expect(rows).toEqual([{ number_period: "2026-02-01" }])
    })
  })

  it("movement wrapper returns rows", async () => {
    const model = await compiled(movementQuery())
    await withRollback(async (client) => {
      await deploy(client, model)
      // Текст `timestamptz` залежить від поясу сесії — фіксуємо його.
      await client.query("SET LOCAL TimeZone = 'UTC'")
      const org = await insertOrganization(client)
      const {
        rows: [ids],
      } = await client.query<{ item: string; sale: string }>(
        `WITH item AS (
           INSERT INTO app.item (id, org_id) VALUES (gen_random_uuid(), $1)
           RETURNING id
         ), sale AS (
           INSERT INTO app.sale (org_id, date)
           VALUES ($1, '2026-03-10 12:00:00+00') RETURNING id
         )
         SELECT item.id AS item, sale.id AS sale FROM item, sale`,
        [org]
      )
      await client.query(
        `INSERT INTO app.sale_goods (org_id, parent_id, line_number, item_id, qty)
         VALUES ($1, $2, 2, $3, 5), ($1, $2, 1, $3, 3)`,
        [org, ids!.sale, ids!.item]
      )
      const { rows } = await client.query(
        `SELECT period::text, movement_type, item_id, qty::text
           FROM app.sale_stock_movements($1)`,
        [ids!.sale]
      )
      expect(rows).toEqual([
        {
          period: "2026-03-10 12:00:00+00",
          movement_type: "Expense",
          item_id: ids!.item,
          qty: "3.000",
        },
        {
          period: "2026-03-10 12:00:00+00",
          movement_type: "Expense",
          item_id: ids!.item,
          qty: "5.000",
        },
      ])
    })
  })
})
