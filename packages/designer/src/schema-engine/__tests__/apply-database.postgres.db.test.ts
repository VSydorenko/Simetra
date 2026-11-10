import pg from "pg"
import { describe, expect, it } from "vitest"
import { ApplyDbError } from "simetra/schema"
import {
  testDatabaseName,
  testSuperuserUrl,
} from "../../../../simetra/test/db/connection"
import { createApplyDatabase } from ".."

const urlOf = (database: string): string => {
  const url = new URL(testSuperuserUrl())
  url.pathname = `/${database}`
  return url.href
}

/** Виконує `fn` з адмін-клієнтом і прибирає названі бази, навіть якщо `fn` кинув. */
async function withDatabases(
  names: string[],
  fn: (admin: pg.Client) => Promise<void>
): Promise<void> {
  const admin = new pg.Client({ connectionString: testSuperuserUrl() })
  await admin.connect()
  const errors: unknown[] = []
  try {
    await fn(admin)
  } catch (error) {
    errors.push(error)
  } finally {
    for (const name of names)
      await admin
        .query(
          `DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`
        )
        .catch((e: unknown) => errors.push(e))
    await admin.end().catch((e: unknown) => errors.push(e))
  }
  if (errors.length > 0) throw errors[0]
}

// DB-тест, бо «CREATE DATABASE поза транзакцією» і сесійні налаштування бази
// доводить лише сервер
describe("ApplyDatabase.statement on the postgres stack", () => {
  it("runs CREATE DATABASE that a transaction refuses, leaving the session settings alone", async () => {
    const viaStatement = testDatabaseName("stmt")
    const viaTransaction = testDatabaseName("stmtx")
    await withDatabases([viaStatement, viaTransaction], async (admin) => {
      const port = createApplyDatabase({ readOnly: false })
      const db = { url: testSuperuserUrl() }
      const inTransaction = await port
        .transaction(db, "rollback", async (tx) => {
          await tx.query(`CREATE DATABASE "${viaTransaction}"`)
        })
        .catch((e: unknown) => e)
      expect(inTransaction).toBeInstanceOf(ApplyDbError)
      expect((inTransaction as ApplyDbError).sqlstate).toBe("25001")

      await port.statement(db, `CREATE DATABASE "${viaStatement}"`)
      const created = await admin.query(
        "select 1 from pg_database where datname = $1",
        [viaStatement]
      )
      expect(created.rowCount).toBe(1)

      // Прелюдія живе й гине з власним з'єднанням
      const fresh = new pg.Client({ connectionString: testSuperuserUrl() })
      await fresh.connect()
      try {
        const { rows } = await fresh.query<{ path: string }>(
          "select current_setting('search_path') as path"
        )
        expect(rows[0]?.path).not.toBe("pg_catalog, pg_temp")
      } finally {
        await fresh.end()
      }
    })
  })

  it("writes into a database that defaults to read-only, in a transaction and in a statement", async () => {
    const name = testDatabaseName("ro")
    await withDatabases([name], async (admin) => {
      await admin.query(`CREATE DATABASE "${name}"`)
      await admin.query(
        `ALTER DATABASE "${name}" SET default_transaction_read_only = on`
      )
      const port = createApplyDatabase({ readOnly: false })
      const db = { url: urlOf(name) }
      await port.transaction(db, "commit", async (tx) => {
        await tx.query("create table in_tx()")
      })
      await port.statement(db, "create table public.in_statement()")
      const client = new pg.Client({ connectionString: db.url })
      await client.connect()
      try {
        const { rows } = await client.query<{ n: string }>(
          "select count(*)::text as n from pg_tables where tablename in ('in_tx', 'in_statement')"
        )
        expect(rows[0]?.n).toBe("2")
      } finally {
        await client.end()
      }
    })
  })

  it("is refused by the read-only port", async () => {
    await expect(
      createApplyDatabase({ readOnly: true }).statement(
        { url: testSuperuserUrl() },
        "select 1"
      )
    ).rejects.toThrow(/read-only/)
  })
})
