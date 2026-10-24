import { describe, expect, it } from "vitest"
import { carrierBackfillRefusals } from "simetra/schema"
import { rollbackDatabase, testRoleName, withRollback } from "./connection"

/**
 * Відмова плану без кроку даних для копій носіїв (Р2a2-11) читає таблицю під
 * `row_security = off`. DB-рівень, бо що бачить власник таблиці з
 * `FORCE ROW LEVEL SECURITY` і чим відповідає Postgres на `row_security =
 * off` під політикою, вирішує сам Postgres: без обходу власник без
 * `BYPASSRLS` бачив би нуль рядків, і план тихо пропустив би таблицю з
 * даними без копій.
 */
describe("carrier backfill refusal in Postgres", () => {
  it("fails loudly on a FORCE ROW LEVEL SECURITY table instead of reading zero rows", async () => {
    const role = testRoleName("force")
    const table = `${role}_t`
    await withRollback(async (client) => {
      // Творець ролі може перемкнутися на неї лише з `set` (Postgres 16+)
      await client.query("SET LOCAL createrole_self_grant = 'set, inherit'")
      await client.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`)
      // Новий власник мусить мати `CREATE` у схемі таблиці
      await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`)
      await client.query(`CREATE TABLE public.${table} (id integer)`)
      await client.query(`INSERT INTO public.${table} VALUES (1)`)
      await client.query(`ALTER TABLE public.${table} OWNER TO ${role}`)
      await client.query(
        `ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`
      )
      await client.query(`SET LOCAL ROLE ${role}`)
      const pending = [
        { table: { schema: "public", name: table }, columns: ["assignee_id"] },
      ]
      const refusals = () =>
        rollbackDatabase(client).transaction({ url: "" }, "rollback", (tx) =>
          carrierBackfillRefusals(tx, pending)
        )
      // Власник без FORCE політик не проходить: рядок видно — відмова
      expect(await refusals()).toMatchObject([
        { code: "plan.carrier-backfill-missing" },
      ])
      await client.query(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`)
      // Під FORCE без політик рядків не видно; з `row_security = off`
      // Postgres відхиляє запит (`42501`), а не повертає «рядків немає»
      await expect(refusals()).rejects.toMatchObject({ code: "42501" })
    })
  })
})
