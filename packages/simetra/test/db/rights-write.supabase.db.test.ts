import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import { COMMAND_SETTING } from "simetra/model"
import {
  type Refusal,
  restoreOwnerRole,
  setLocalSetting,
  testRoleFor,
} from "./connection"
import { type Seed, describeTransaction, deploy } from "./rights-seed"
import { seedWrites, writesModel } from "./rights-write.support"

/**
 * Запис сервісною роллю провайдера (спека прав §5.3, платформна спека
 * §10.5): роль є лише на стеку Supabase. Решта кейсів опису —
 * `rights-write.db.test.ts`.
 */

const SERVICE = testRoleFor("service")!

describe("command writes", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const client = await tx.open()
    await deploy(client, await writesModel())
    // Серверний код споживача досі пише сервісною роллю провайдера: DML їй
    // лише в цій транзакції
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${SERVICE}`
    )
    ids = await seedWrites(client)
  })

  afterAll(() => tx.close())

  const key = (name: string) => {
    // Невідомий ключ дав би `NULL` замість id — і зелений кейс без причини.
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }

  /** Запит власника в точці збереження з відкатом. */
  const probe = async <T>(fn: (client: pg.Client) => Promise<T>) => {
    const client = tx.client()
    await client.query("SAVEPOINT probe")
    try {
      return await fn(client)
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT probe")
    }
  }

  // Спека прав §5.3: тригер ефектів спрацьовує й на записі ролі API, а `EXECUTE` на
  // функціях контексту має лише роль команд. Під правами викликача кожен
  // такий запис упав би на функції контексту; `SECURITY DEFINER` дає йому
  // дійти до раннього виходу без контексту. Права функцій вирішує Postgres.
  it("provider-api-role-write", async () => {
    const written = await probe(async (client) => {
      await client.query(`SET LOCAL ROLE ${SERVICE}`)
      const { rows } = await client.query<{ region_id: string }>(
        "UPDATE public.task SET region_id = $1 WHERE id = $2 RETURNING region_id",
        [key("r2"), key("T2")]
      )
      await restoreOwnerRole(client)
      const after = await client.query<{ region_id: string }>(
        "SELECT region_id FROM public.task WHERE id = $1",
        [key("T2")]
      )
      return {
        rows: rows.map((r) => r.region_id),
        after: after.rows.map((r) => r.region_id),
      }
    })
    expect(written).toEqual({ rows: [key("r2")], after: [key("r2")] })
  })

  // Спека П4 §6.8: зіпсований контекст у сесії ролі API — відмова контракту §6.2,
  // а не тихий запис «без контексту». Першим його читає `BEFORE`-тригер
  // авторства (`SECURITY DEFINER`), і що функція контексту відмовляє саме
  // так під роллю без `EXECUTE` на ній, вирішує Postgres.
  it("provider-api-role-malformed-context", async () => {
    const refusal = await probe(async (client) => {
      await client.query(`SET LOCAL ROLE ${SERVICE}`)
      await setLocalSetting(client, COMMAND_SETTING, "not json")
      try {
        await client.query(
          "UPDATE public.task SET region_id = $1 WHERE id = $2",
          [key("r2"), key("T2")]
        )
        return undefined
      } catch (error) {
        const { code, message, detail } = error as Refusal
        return { code, message, detail }
      }
    })
    expect(refusal).toEqual({
      code: "42501",
      message: "command.context",
      detail: "malformed",
    })
  })
})
