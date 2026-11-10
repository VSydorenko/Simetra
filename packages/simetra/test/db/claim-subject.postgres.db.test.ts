// `sub` сесії у SQL фікстур профілю `postgres` (`claimSubject`) має форму
// `current_user_id()` платформи: налаштування, задане `set_config(…, true)` у
// попередній транзакції сесії, читається як `''`, а `''::jsonb` падає
// (`22P02`). DB-рівень, бо значення налаштування після транзакції й форму
// `pg_get_expr` вирішує сервер.
import pg from "pg"
import { SESSION_CLAIMS_SETTING } from "simetra/model"
import { describe, expect, it } from "vitest"
import { claimSubject } from "../../src/schema/__tests__/fixtures/e1-fixtures"
import { setLocalSetting, testDatabaseUrl, withRollback } from "./connection"

const SUBJECT = claimSubject("postgres")
const SUB = "00000000-0000-4000-8000-000000000001"

describe("the claim subject of postgres fixtures", () => {
  it("reads NULL after claims a previous transaction of the session set", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() })
    await client.connect()
    try {
      await client.query("BEGIN")
      await setLocalSetting(
        client,
        SESSION_CLAIMS_SETTING,
        JSON.stringify({ sub: SUB })
      )
      await client.query("COMMIT")
      const { rows } = await client.query(`SELECT ${SUBJECT.sql} AS sub`)
      expect(rows).toEqual([{ sub: null }])
    } finally {
      await client.end()
    }
  })

  it("reads sub from the claims of the transaction", async () => {
    await withRollback(async (client) => {
      await setLocalSetting(
        client,
        SESSION_CLAIMS_SETTING,
        JSON.stringify({ sub: SUB })
      )
      const { rows } = await client.query(`SELECT ${SUBJECT.sql} AS sub`)
      expect(rows).toEqual([{ sub: SUB }])
    })
  })

  it("deparses in a policy the way the round-trip fixture expects", async () => {
    await withRollback(async (client) => {
      await client.query(
        "CREATE TEMP TABLE claim_probe (owner_id uuid) ON COMMIT DROP"
      )
      await client.query(
        `CREATE POLICY claim_probe ON pg_temp.claim_probe USING (owner_id = ${SUBJECT.sql})`
      )
      const { rows } = await client.query<{ qual: string }>(
        `SELECT pg_catalog.pg_get_expr(polqual, polrelid) AS qual
           FROM pg_catalog.pg_policy WHERE polname = 'claim_probe'`
      )
      expect(rows).toEqual([{ qual: `(owner_id = ${SUBJECT.deparsed})` }])
    })
  })
})
