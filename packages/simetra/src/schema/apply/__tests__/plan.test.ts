import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  buildPlan,
  type ApplyDatabase,
  type ApplyTransaction,
  type SchemaEngine,
} from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
} from "../../../compiler/__tests__/helpers"

/**
 * Конвеєр плану на фейковому порті — лише те, що не потребує справжньої
 * бази; решта — у `build-plan.db.test.ts` designer.
 */
describe("buildPlan", () => {
  it("refuses a server older than Postgres 17 before reading its facts", async () => {
    // Платформна спека §1: Postgres 17 — мінімум; без цієї відмови читання
    // фактів упало б сирим `42703` на `datlocale`
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Party/Party.meta.json": catalog("Party"),
      })
    )
    expect(compiled.diagnostics).toEqual([])
    const statements: string[] = []
    const tx: ApplyTransaction = {
      query: async <R extends Record<string, unknown>>(sql: string) => {
        statements.push(sql)
        return (sql.includes("server_version_num")
          ? [{ num: 160004, version: "16.4" }]
          : []) as unknown as R[]
      },
      extract: () => Promise.reject(new Error("no extract expected")),
    }
    const reader: ApplyDatabase = {
      transaction: (_db, _end, fn) => fn(tx),
    }
    const scratch: ApplyDatabase = {
      transaction: () => Promise.reject(new Error("no copy expected")),
    }
    // Двигун не потрібен: відмова — до будь-якого витягу
    const engine = new Proxy({} as SchemaEngine, {
      get: (_, name) => {
        throw new Error(`no engine call expected: ${String(name)}`)
      },
    })
    const outcome = await buildPlan(
      engine,
      { reader, scratch },
      compiled.model!,
      { target: { url: "postgres://fake" } },
      []
    )
    expect(outcome).toMatchObject({
      status: "refused",
      diagnostics: [
        { code: "apply.server-unsupported", params: { version: "16.4" } },
      ],
    })
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain("server_version_num")
  })
})
