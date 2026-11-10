// Модель з'єднання тестів на стеку `postgres` для з'єднань рушія: порт
// застосування й тінь pg-delta з адреси тестів стартують власником (спека
// профілю §10.3, запобіжник 1). Решту моделі перевіряє
// `simetra/test/db/connection-model.postgres.db.test.ts`.
import { provisionCoLocatedShadow, withDatabaseName } from "@supabase/pg-delta"
import pg from "pg"
import { PROVIDER_OWNER_ROLES } from "simetra/model"
import { describe, expect, it } from "vitest"
import {
  testDatabaseUrl,
  testProvider,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import { createApplyDatabase } from "../schema-engine"

const OWNER = PROVIDER_OWNER_ROLES[testProvider()]
const SUPERUSER = new URL(testSuperuserUrl()).username

describe("engine connections from the test URL start as the owner", () => {
  it("(i) the apply port's connection", async () => {
    const rows = await createApplyDatabase({ readOnly: false }).transaction(
      { url: testDatabaseUrl() },
      "rollback",
      (tx) =>
        tx.query<{ current: string; session: string }>(
          "SELECT current_user AS current, session_user AS session"
        )
    )
    expect(rows).toEqual([{ current: OWNER, session: SUPERUSER }])
  })

  it("(iv) withDatabaseName keeps options: the engine's shadow runs as the owner", async () => {
    const shadow = await provisionCoLocatedShadow(testDatabaseUrl())
    try {
      // Адреса тіні від рушія і та, що будує тест через `withDatabaseName`
      for (const url of [
        shadow.url,
        withDatabaseName(testDatabaseUrl(), shadow.name),
      ]) {
        const client = new pg.Client({ connectionString: url })
        await client.connect()
        try {
          const { rows } = await client.query(
            "SELECT current_user AS current, current_database() AS database"
          )
          expect(rows).toEqual([{ current: OWNER, database: shadow.name }])
        } finally {
          await client.end()
        }
      }
    } finally {
      await shadow.cleanup()
    }
  })
})
