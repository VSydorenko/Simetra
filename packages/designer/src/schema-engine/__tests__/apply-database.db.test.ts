import pg from "pg"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ApplyConnectionLost,
  ApplyDbError,
  type EngineScope,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../../simetra/test/support"

/**
 * Порт виконання застосування (план П3-1, задача 3). Ціль кожного тесту —
 * окрема база від `withDesiredShadow`; база стеку лише читається.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

async function inTarget<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    "create schema app;",
    scope,
    (target) => fn(target.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

/** Один запит із окремого з'єднання; з'єднання закривається одразу. */
async function other<R extends Record<string, unknown>>(
  url: string,
  sql: string
): Promise<R[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<R>(sql)).rows
  } finally {
    await client.end()
  }
}

const tableExists = async (url: string): Promise<boolean> =>
  (await other(url, "select to_regclass('app.x') as t"))[0]?.["t"] !== null

describe("ApplyDatabase (pg)", () => {
  it("commits on commit", async () => {
    await inTarget(async (url) => {
      await createApplyDatabase({ readOnly: false }).transaction(
        { url },
        "commit",
        async (tx) => {
          await tx.query("create table app.x()")
        }
      )
      expect(await tableExists(url)).toBe(true)
    })
  })

  it("rolls back on rollback", async () => {
    await inTarget(async (url) => {
      await createApplyDatabase({ readOnly: false }).transaction(
        { url },
        "rollback",
        async (tx) => {
          await tx.query("create table app.x()")
        }
      )
      expect(await tableExists(url)).toBe(false)
    })
  })

  it("rolls back and rethrows when fn throws", async () => {
    await inTarget(async (url) => {
      const boom = new Error("boom")
      const error = await createApplyDatabase({ readOnly: false })
        .transaction({ url }, "commit", async (tx) => {
          await tx.query("create table app.x()")
          throw boom
        })
        .catch((e: unknown) => e)
      expect(error).toBe(boom)
      expect(await tableExists(url)).toBe(false)
    })
  })

  it("normalizes statement errors", async () => {
    await inTarget(async (url) => {
      const error = await createApplyDatabase({ readOnly: false })
        .transaction({ url }, "commit", (tx) => tx.query("select 1/0"))
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ApplyDbError)
      expect((error as ApplyDbError).sqlstate).toBe("22012")
    })
  })

  it("passes query params", async () => {
    await inTarget(async (url) => {
      const rows = await createApplyDatabase({ readOnly: false }).transaction(
        { url },
        "rollback",
        (tx) => tx.query<{ v: string }>("select $1::text as v", ["a"])
      )
      expect(rows).toEqual([{ v: "a" }])
    })
  })

  it("read-only transaction refuses writes", async () => {
    await inTarget(async (url) => {
      const error = await createApplyDatabase({ readOnly: true })
        .transaction({ url }, "rollback", (tx) =>
          tx.query("create table app.x()")
        )
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ApplyDbError)
      expect((error as ApplyDbError).sqlstate).toBe("25006")
    })
  })

  it("leaves no session state", async () => {
    await inTarget(async (url) => {
      // Свіже з'єднання завжди має сесійне `off`, тож доказ — усередині
      // транзакції: читання лише в неї, сесія лишилась за замовчуванням
      const rows = await createApplyDatabase({ readOnly: true }).transaction(
        { url },
        "rollback",
        (tx) =>
          tx.query<{ tx: string; session: string }>(
            "select current_setting('transaction_read_only') as tx, current_setting('default_transaction_read_only') as session"
          )
      )
      expect(rows).toEqual([{ tx: "on", session: "off" }])
    })
  })

  it("connection loss becomes ApplyConnectionLost", async () => {
    await inTarget(async (url) => {
      const error = await createApplyDatabase({ readOnly: false })
        .transaction({ url }, "commit", async (tx) => {
          const pid = (
            await tx.query<{ pid: number }>("select pg_backend_pid() as pid")
          )[0]?.pid
          await other(url, `select pg_terminate_backend(${String(pid)})`)
          await tx.query("select 1")
        })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ApplyConnectionLost)
    })
  })
})
