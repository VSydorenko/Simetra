import { describe, expect, it } from "vitest"
import { compile, type PromotionRecord } from "simetra/compiler"
import { PLATFORM_ROLES } from "simetra/model"
import {
  buildPlan,
  type ApplyDatabase,
  type ApplyTransaction,
  type PromotionInput,
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

  it.each([
    { server: "target", promotions: false },
    { server: "shadow", promotions: false },
    { server: "target", promotions: true },
  ])(
    "refuses a plan when the command role is missing on the $server server (promotion: $promotions)",
    async ({ server, promotions }) => {
      const compiled = await compile(
        metaFiles({
          "project.meta.json": project(),
          "catalogs/Party/Party.meta.json": catalog("Party"),
        })
      )
      const urls = {
        target: "postgres://target",
        shadow: "postgres://shadow",
      }
      // Свіжа ціль Postgres 17; роль команд є лише на іншому сервері
      const reader: ApplyDatabase = {
        transaction: (db, _end, fn) =>
          fn({
            query: async <R extends Record<string, unknown>>(sql: string) =>
              (sql.includes("server_version_num")
                ? [{ num: 170004, version: "17.4", major: 17 }]
                : sql.includes("pg_auth_members") &&
                    db.url !== urls[server as "target" | "shadow"]
                  ? [
                      {
                        name: PLATFORM_ROLES.command,
                        attributes: {},
                        memberOf: [],
                        members: [],
                      },
                    ]
                  : []) as unknown as R[],
            extract: () => Promise.reject(new Error("no extract expected")),
          }),
      }
      const scratch: ApplyDatabase = {
        transaction: () => Promise.reject(new Error("no copy expected")),
      }
      // Будь-який виклик двигуна — і `withDesiredShadow` — кидає: відмова
      // мусить прийти до тіні й до гілки промоції
      const engine = new Proxy({} as SchemaEngine, {
        get: (_, name) => {
          throw new Error(`no engine call expected: ${String(name)}`)
        },
      })
      // Запис промоції відмова не читає: вона — до розгалуження
      const records: PromotionInput[] = promotions
        ? [{ record: {} as PromotionRecord, file: "plans/x.promotion.json" }]
        : []
      const outcome = await buildPlan(
        engine,
        { reader, scratch },
        compiled.model!,
        { target: { url: urls.target }, shadowBase: { url: urls.shadow } },
        records
      )
      expect(outcome).toMatchObject({
        status: "refused",
        diagnostics: [
          {
            code: "plan.platform-role-missing",
            params: { role: PLATFORM_ROLES.command, server },
          },
        ],
      })
    }
  )
})
