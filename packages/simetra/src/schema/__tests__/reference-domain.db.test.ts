import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile, type CompiledModel } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import { readCatalog } from "../../../test/db/catalog"
import { expectCatalogMatchesSnapshot } from "../../../test/db/compare"
import { withRollback } from "../../../test/db/connection"
import { readReferenceDomain } from "./reference-domain"

/**
 * Референсний домен на справжньому Postgres 17 (спека П2 §10.1, §10.4): він
 * розгортається, каталог збігається зі знімком, а обгортки рухів обох
 * регістрів документа повертають саме ті виміри й ресурси, яких чекає
 * проведення П3. Кожен збій тут — дефект компілятора чи рендера, а не домену.
 */

async function compiled(): Promise<CompiledModel> {
  const result = await compile(readReferenceDomain())
  expect(result.diagnostics).toEqual([])
  return result.model!
}

/** Розгортає модель у транзакції клієнта й повертає її схеми. */
async function deploy(
  client: pg.Client,
  model: CompiledModel
): Promise<string[]> {
  await client.query(renderDesiredState(model).sql)
  return [...new Set(model.physical.tables.map((table) => table.schema))]
}

/** Вставляє рядок і повертає його `id`. */
async function insert(
  client: pg.Client,
  sql: string,
  params: unknown[]
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `${sql} RETURNING id`,
    params
  )
  return rows[0]!.id
}

describe("reference domain in Postgres", () => {
  it("deploys and the catalog matches the snapshot", async () => {
    const model = await compiled()
    await withRollback(async (client) => {
      const catalog = await readCatalog(client, await deploy(client, model))
      expectCatalogMatchesSnapshot(catalog, model.physical)
      // Функції множини скоупу й обгортки рухів створені там, де їх чекає модель.
      const functions = catalog.functions.map((f) => `${f.schema}.${f.name}`)
      expect(functions).toEqual(
        expect.arrayContaining([
          "app.accessible_org_ids",
          "app.accessible_user_ids",
          "app.service_accrual_income_expenses_movements",
          "app.service_accrual_performer_settlements_movements",
        ])
      )
    })
  })

  it("a document with tabular rows yields movements of both registers", async () => {
    const model = await compiled()
    await withRollback(async (client) => {
      await deploy(client, model)
      // Текст `timestamptz` залежить від поясу сесії — фіксуємо його.
      await client.query("SET LOCAL TimeZone = 'UTC'")

      const user = await insert(
        client,
        "INSERT INTO auth.users (id) VALUES (gen_random_uuid())",
        []
      )
      const org = await insert(
        client,
        "INSERT INTO app.organization (id, description) VALUES (gen_random_uuid(), 'Org')",
        []
      )
      await client.query(
        "INSERT INTO app.org_member (org_id, user_id) VALUES ($1, $2)",
        [org, user]
      )
      // Функція множини `org` бачить організацію учасника: контракт скоупу, на
      // який спиратимуться RLS-політики П3.
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: user, role: "authenticated" }),
      ])
      const { rows: visible } = await client.query(
        "SELECT id FROM app.accessible_org_ids() AS id"
      )
      expect(visible).toEqual([{ id: org }])

      const uah = await insert(
        client,
        `INSERT INTO app.currency (id, code, description, predefined_name)
         VALUES (gen_random_uuid(), 'UAH', 'Гривня', 'uah')`,
        []
      )
      const counterparty = (description: string) =>
        insert(
          client,
          `INSERT INTO app.counterparty (id, org_id, description)
           VALUES (gen_random_uuid(), $1, $2)`,
          [org, description]
        )
      const customer = await counterparty("Customer")
      const first = await counterparty("Performer 1")
      const second = await counterparty("Performer 2")
      const contract = await insert(
        client,
        `INSERT INTO app.contract (id, org_id, owner_id, currency_id)
         VALUES (gen_random_uuid(), $1, $2, $3)`,
        [org, customer, uah]
      )
      const accrual = await insert(
        client,
        `INSERT INTO app.service_accrual
           (org_id, date, counterparty_id, contract_id, accrual_kind)
         VALUES ($1, '2026-03-10 12:00:00+00', $2, $3, 'bonus')`,
        [org, customer, contract]
      )
      // Рядки вставлено не в порядку номерів: обгортки впорядковують самі.
      await client.query(
        `INSERT INTO app.service_accrual_services
           (org_id, parent_id, line_number, service_name, amount)
         VALUES ($1, $2, 2, 'Support', 300), ($1, $2, 1, 'Audit', 1000)`,
        [org, accrual]
      )
      await client.query(
        `INSERT INTO app.service_accrual_performers
           (org_id, parent_id, line_number, performer_id, amount)
         VALUES ($1, $2, 2, $4, 250.5), ($1, $2, 1, $3, 400)`,
        [org, accrual, first, second]
      )

      const { rows: settlements } = await client.query(
        `SELECT period::text, movement_type, performer_id, currency_id,
                amount::numeric(15,2)::text AS amount
           FROM app.service_accrual_performer_settlements_movements($1)`,
        [accrual]
      )
      const period = "2026-03-10 12:00:00+00"
      expect(settlements).toEqual([
        {
          period,
          movement_type: "Receipt",
          performer_id: first,
          currency_id: uah,
          amount: "400.00",
        },
        {
          period,
          movement_type: "Receipt",
          performer_id: second,
          currency_id: uah,
          amount: "250.50",
        },
      ])

      // Конструктор: рядок на кожну послугу (дохід) і рядок шапки з сумою
      // виконавців (витрата), у порядку рухів, далі рядків.
      const { rows: incomeExpenses } = await client.query(
        `SELECT period::text, counterparty_id, accrual_kind,
                income::numeric(15,2)::text AS income,
                expense::numeric(15,2)::text AS expense
           FROM app.service_accrual_income_expenses_movements($1)`,
        [accrual]
      )
      const movement = (income: string, expense: string) => ({
        period,
        counterparty_id: customer,
        accrual_kind: "bonus",
        income,
        expense,
      })
      expect(incomeExpenses).toEqual([
        movement("1000.00", "0.00"),
        movement("300.00", "0.00"),
        movement("0.00", "650.50"),
      ])
    })
  })
})
