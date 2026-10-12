import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import type { CatalogModel, CatalogTable } from "simetra/model"
import {
  classifySteps,
  typeChanges,
  typeGuards,
  type EngineAction,
} from "simetra/schema"
import { guardTarget } from "../type-guard"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const table = (
  schema: string,
  name: string,
  columns: Record<string, string>
): CatalogTable => ({
  schema,
  name,
  rowLevelSecurity: "off",
  columns: Object.entries(columns).map(([column, type]) => ({
    name: column,
    type,
    notNull: false,
  })),
  uniques: [],
  checks: [],
  foreignKeys: [],
  indexes: [],
})

// Типи у формі `format_type()`, як їх читає адаптер
const SOURCE: CatalogModel = {
  tables: [
    table("app", "t", {
      c: "text",
      n: "numeric(12,4)",
      x: "integer",
      m: "app.mood",
      arr: "text[]",
      iv: "interval day",
    }),
    table("My App", 'odd"t', { "Col 1": "text" }),
  ],
  enumTypes: [],
  units: [],
}

const step = (sql: string) => ({ id: "s3", sql })

const guards = (sql: string): string[] => {
  const result = typeGuards(step(sql), SOURCE, parse)
  if (!("guards" in result))
    throw new Error(`refused: ${result.refusal.message}`)
  return result.guards
}

const refusal = (sql: string) => {
  const result = typeGuards(step(sql), SOURCE, parse)
  if (!("refusal" in result)) throw new Error("expected a refusal")
  return result.refusal
}

describe("typeGuards", () => {
  it("guards a lossy column type change", () => {
    expect(
      guards(
        `ALTER TABLE "app"."t" ALTER COLUMN "c" TYPE character varying(5) USING "c"::character varying(5)`
      )
    ).toEqual([
      `SELECT count(*) AS lost FROM app.t WHERE c IS NOT NULL AND (c::pg_catalog."varchar"(5))::pg_catalog.text IS DISTINCT FROM c`,
    ])
  })

  it("guards every column of a multi-column step", () => {
    expect(
      guards(
        "ALTER TABLE app.t ALTER COLUMN c TYPE varchar(5) USING c::varchar(5), ALTER COLUMN n TYPE numeric(12,2) USING n::numeric(12,2)"
      )
    ).toEqual([
      `SELECT count(*) AS lost FROM app.t WHERE c IS NOT NULL AND (c::pg_catalog."varchar"(5))::pg_catalog.text IS DISTINCT FROM c`,
      `SELECT count(*) AS lost FROM app.t WHERE n IS NOT NULL AND (n::pg_catalog."numeric"(12,2))::pg_catalog."numeric"(12,4) IS DISTINCT FROM n`,
    ])
  })

  it("does not guard a lossless change", () => {
    expect(
      guards("ALTER TABLE app.t ALTER COLUMN x TYPE bigint USING x::bigint")
    ).toEqual([])
  })

  it("quotes names and qualifies user, array and typmod types", () => {
    expect(
      guards(
        `ALTER TABLE "My App"."odd""t" ALTER COLUMN "Col 1" TYPE app.mood USING "Col 1"::app.mood`
      )
    ).toEqual([
      `SELECT count(*) AS lost FROM "My App"."odd""t" WHERE "Col 1" IS NOT NULL AND ("Col 1"::app.mood)::pg_catalog.text IS DISTINCT FROM "Col 1"`,
    ])
    expect(
      guards(
        "ALTER TABLE app.t ALTER COLUMN arr TYPE varchar(3)[] USING arr::varchar(3)[], ALTER COLUMN iv TYPE interval USING iv::interval"
      )
    ).toEqual([
      `SELECT count(*) AS lost FROM app.t WHERE arr IS NOT NULL AND (arr::pg_catalog."varchar"(3)[])::pg_catalog.text[] IS DISTINCT FROM arr`,
      `SELECT count(*) AS lost FROM app.t WHERE iv IS NOT NULL AND (iv::pg_catalog."interval")::pg_catalog."interval"(8) IS DISTINCT FROM iv`,
    ])
  })

  it("refuses a non-plain USING", () => {
    expect(
      refusal(
        "ALTER TABLE app.t ALTER COLUMN c TYPE varchar(5) USING upper(c)::varchar(5)"
      )
    ).toMatchObject({
      code: "plan.type-guard-unsupported",
      severity: "error",
      params: { step: "s3", reason: "using" },
    })
    // Приведення до іншого типу, ніж новий тип колонки, — теж не `<колонка>::<новий>`
    expect(
      refusal(
        "ALTER TABLE app.t ALTER COLUMN c TYPE varchar(5) USING c::varchar(9)"
      ).params
    ).toEqual({ step: "s3", reason: "using" })
  })

  it("refuses ALTER TYPE … ALTER ATTRIBUTE … TYPE", () => {
    expect(
      refusal("ALTER TYPE app.ct ALTER ATTRIBUTE a TYPE bigint CASCADE").params
    ).toEqual({ step: "s3", reason: "composite" })
  })

  it("refuses when the old type is not visible", () => {
    expect(
      refusal("ALTER TABLE app.zz ALTER COLUMN c TYPE varchar(5)").params
    ).toEqual({ step: "s3", reason: "oldType" })
    expect(
      refusal("ALTER TABLE app.t ALTER COLUMN zz TYPE varchar(5)").params
    ).toEqual({ step: "s3", reason: "oldType" })
  })

  it("refuses a new type it cannot render", () => {
    expect(
      refusal("ALTER TABLE app.t ALTER COLUMN c TYPE app.mood('x')").params
    ).toEqual({ step: "s3", reason: "newType" })
  })
})

describe("typeChanges", () => {
  it("lists every changed column, lossless ones included", () => {
    expect(
      typeChanges(
        step(
          "ALTER TABLE app.t ALTER COLUMN x TYPE bigint, ALTER COLUMN c TYPE varchar(5)"
        ),
        SOURCE,
        parse
      )
    ).toEqual([
      {
        step: "s3",
        schema: "app",
        table: "t",
        column: "x",
        from: "pg_catalog.int4",
        to: "pg_catalog.int8",
        lossless: true,
      },
      {
        step: "s3",
        schema: "app",
        table: "t",
        column: "c",
        from: "pg_catalog.text",
        to: `pg_catalog."varchar"(5)`,
        lossless: false,
      },
    ])
  })
})

describe("guardTarget", () => {
  it("reads the table and column back from a guard", () => {
    const [guard] = guards(
      `ALTER TABLE "My App"."odd""t" ALTER COLUMN "Col 1" TYPE app.mood`
    )
    expect(guardTarget(guard!, parse)).toEqual({
      table: 'My App.odd"t',
      column: "Col 1",
    })
  })

  it("rejects SQL that is not a guard", () => {
    expect(() => guardTarget("SELECT 1", parse)).toThrow(/not a type guard/)
  })
})

describe("classifySteps", () => {
  const action = (sql: string): EngineAction => ({
    sql,
    verb: "alter",
    produces: [],
    consumes: [],
    destroys: [],
    destroyed: [],
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: [],
    lockClass: "accessExclusive",
    dataLoss: false,
    rewriteRisk: true,
  })

  it("puts the guards on the step", () => {
    const [lossy, lossless, refused] = classifySteps(
      [
        action("ALTER TABLE app.t ALTER COLUMN c TYPE varchar(5)"),
        action("ALTER TABLE app.t ALTER COLUMN x TYPE bigint"),
        action("ALTER TABLE app.zz ALTER COLUMN c TYPE varchar(5)"),
      ],
      SOURCE,
      parse,
      2
    )
    expect(lossy).toMatchObject({
      id: "s3",
      class: "destructive",
      guards: [
        `SELECT count(*) AS lost FROM app.t WHERE c IS NOT NULL AND (c::pg_catalog."varchar"(5))::pg_catalog.text IS DISTINCT FROM c`,
      ],
    })
    expect(lossless).toMatchObject({ class: "tableRewrite", guards: [] })
    // Відмову сторожа план збирає окремо через `typeGuards`
    expect(refused).toMatchObject({ class: "destructive", guards: [] })
  })
})
