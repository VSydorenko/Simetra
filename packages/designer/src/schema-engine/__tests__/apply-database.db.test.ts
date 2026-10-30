import { describe, expect, it } from "vitest"
import {
  ApplyConnectionLost,
  ApplyDbError,
  type EngineScope,
} from "simetra/schema"
import { createApplyDatabase } from ".."
import { inTarget, query } from "../../__tests__/support/db"

/**
 * Порт виконання застосування. Ціль кожного тесту —
 * окрема база від `withDesiredShadow`; база стеку лише читається.
 */

const APP = "create schema app;"
const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

const tableExists = async (url: string): Promise<boolean> =>
  (await query(url, "select to_regclass('app.x') as t"))[0]?.["t"] !== null

describe("ApplyDatabase (pg)", () => {
  it("commits on commit", async () => {
    await inTarget(APP, scope, async (url) => {
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
    await inTarget(APP, scope, async (url) => {
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
    await inTarget(APP, scope, async (url) => {
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
    await inTarget(APP, scope, async (url) => {
      const error = await createApplyDatabase({ readOnly: false })
        .transaction({ url }, "commit", (tx) => tx.query("select 1/0"))
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ApplyDbError)
      expect((error as ApplyDbError).sqlstate).toBe("22012")
    })
  })

  it("passes query params", async () => {
    await inTarget(APP, scope, async (url) => {
      const rows = await createApplyDatabase({ readOnly: false }).transaction(
        { url },
        "rollback",
        (tx) => tx.query<{ v: string }>("select $1::text as v", ["a"])
      )
      expect(rows).toEqual([{ v: "a" }])
    })
  })

  it("read-only transaction refuses writes", async () => {
    await inTarget(APP, scope, async (url) => {
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
    await inTarget(APP, scope, async (url) => {
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

  it("runs at READ COMMITTED whatever the database default", async () => {
    await inTarget(APP, scope, async (url) => {
      const database = new URL(url).pathname.slice(1)
      await query(
        url,
        `create table app.x (id int); alter database "${database}" set default_transaction_isolation = 'repeatable read'`
      )
      for (const readOnly of [false, true]) {
        const seen = await createApplyDatabase({ readOnly }).transaction(
          { url },
          "rollback",
          async (tx) => {
            const [level] = await tx.query<{ level: string }>(
              "select current_setting('transaction_isolation') as level"
            )
            const before = await tx.query<{ n: number }>(
              "select count(*)::int as n from app.x"
            )
            // Коміт іншої сесії між операторами видно наступному оператору:
            // знімок береться на кожен оператор, а не на першому
            await query(url, "insert into app.x values (1)")
            const after = await tx.query<{ n: number }>(
              "select count(*)::int as n from app.x"
            )
            return { level: level!.level, seen: after[0]!.n - before[0]!.n }
          }
        )
        expect(seen).toEqual({ level: "read committed", seen: 1 })
      }
    })
  })

  it("passes a programming error through, not as a lost connection", async () => {
    await inTarget(APP, scope, async (url) => {
      const circular: Record<string, unknown> = {}
      circular.self = circular
      const error = await createApplyDatabase({ readOnly: false })
        .transaction({ url }, "commit", async (tx) => {
          await tx.query("create table app.x()")
          await tx.query("select $1::jsonb", [circular])
        })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(TypeError)
      expect(error).not.toBeInstanceOf(ApplyConnectionLost)
      expect(await tableExists(url)).toBe(false)
    })
  })

  it("connection loss becomes ApplyConnectionLost", async () => {
    await inTarget(APP, scope, async (url) => {
      const error = await createApplyDatabase({ readOnly: false })
        .transaction({ url }, "commit", async (tx) => {
          const pid = (
            await tx.query<{ pid: number }>("select pg_backend_pid() as pid")
          )[0]?.pid
          await query(url, `select pg_terminate_backend(${String(pid)})`)
          await tx.query("select 1")
        })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ApplyConnectionLost)
    })
  })
})
