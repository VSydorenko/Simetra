import { describe, expect, it } from "vitest"
import { loadSqlParser } from "simetra/compiler"
import type { PlanStep } from "simetra/schema"
import { runCarrierSteps } from "../../src/schema/apply/execute"
import { rollbackDatabase, testRoleName, withRollback } from "./connection"

/**
 * Фаза кроків копій носіїв (спека промоції §7.2) іде під `row_security = off`.
 * DB-рівень, бо що бачить власник таблиці з `FORCE ROW LEVEL SECURITY` і чим
 * відповідає Postgres на `row_security = off` під політикою, вирішує сам
 * Postgres: без обходу власник без `BYPASSRLS` оновив би нуль рядків, і крок
 * тихо лишив би наявні рядки без копій.
 */
describe("carrier steps in Postgres", () => {
  it("fails loudly on a FORCE ROW LEVEL SECURITY table instead of writing zero rows", async () => {
    const parse = await loadSqlParser()
    const role = testRoleName("force")
    const table = `${role}_t`
    const step: PlanStep = {
      id: "s1",
      origin: "carriers",
      sql: `UPDATE public.${table} SET copy = 1 WHERE copy IS DISTINCT FROM 1`,
      verb: "alter",
      class: "dataStep",
      lockClass: "shareRowExclusive",
      transactionality: "transactional",
      newSegmentBefore: false,
      lockedTables: [{ schema: "public", name: table }],
      produces: [],
      consumes: [],
      destroys: [],
      produced: [],
      destroyed: [],
      consumed: [],
      dataLoss: false,
      rewriteRisk: false,
      guards: [],
    }
    await withRollback(async (client) => {
      // Творець ролі може перемкнутися на неї лише з `set` (Postgres 16+)
      await client.query("SET LOCAL createrole_self_grant = 'set, inherit'")
      await client.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`)
      // Новий власник мусить мати `CREATE` у схемі таблиці
      await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`)
      await client.query(
        `CREATE TABLE public.${table} (id integer, copy integer)`
      )
      await client.query(`INSERT INTO public.${table} VALUES (1, NULL)`)
      await client.query(`ALTER TABLE public.${table} OWNER TO ${role}`)
      await client.query(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`
      )
      await client.query(`SET LOCAL ROLE ${role}`)
      const run = () =>
        rollbackDatabase(client).transaction({ url: "" }, "rollback", (tx) =>
          runCarrierSteps(tx, [step], parse, () => {})
        )
      // Власник без FORCE політик не проходить: крок пише рядок
      await run()
      expect(
        (await client.query(`SELECT copy FROM public.${table}`)).rows
      ).toEqual([{ copy: 1 }])
      await client.query(`UPDATE public.${table} SET copy = NULL`)
      await client.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`)
      // Під FORCE без політик рядків не видно; з `row_security = off`
      // Postgres відхиляє оператор (`42501`), а не оновлює нуль рядків
      await expect(run()).rejects.toMatchObject({ code: "42501" })
    })
  })
})
