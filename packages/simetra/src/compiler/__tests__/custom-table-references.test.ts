import { describe, expect, it } from "vitest"
import type { z } from "zod"
import { customTableSchema, elementNameSchema } from "simetra/model"
import {
  canonicalSnapshot,
  compile,
  type CompileResult,
} from "simetra/compiler"
// Внутрішні шви компілятора: з `simetra/compiler` навмисно не експортуються.
import { readFiles } from "../pipeline"
import { checkIdentity } from "../stages/identity"
import {
  attribute,
  catalog,
  customTable,
  metaFiles,
  project,
  uuid,
} from "./helpers"

const PROJECT = "project.meta.json"
const LOG = "custom-tables/Log/Log.meta.json"
const CURRENCY = "catalogs/Currency/Currency.meta.json"

const LOG_ID = uuid(1)
const COL_ID = uuid(2)
const COL_CODE = uuid(3)
const COL_REF = uuid(4)
const CURRENCY_ID = uuid(5)
const SKU_ID = uuid(6)

const columns = [
  { id: COL_ID, name: "id", physicalName: "id", type: "UUID" },
  {
    id: COL_CODE,
    name: "code",
    physicalName: "code_col",
    type: "String",
    length: 10,
  },
  { id: COL_REF, name: "currency", physicalName: "currency_id", type: "UUID" },
]

/** Таблиця з кожною позицією, що називає колонку за логічним іменем. */
function fullLog({
  skuColumn = "sku",
  ...overrides
}: Record<string, unknown> = {}) {
  return customTable("Log", {
    id: LOG_ID,
    columns,
    primaryKey: { columns: ["id"] },
    uniques: [{ columns: ["code", "id"] }],
    foreignKeys: [
      {
        columns: ["currency"],
        references: {
          object: { kind: "Catalog", name: "Currency" },
          columns: ["ref"],
        },
      },
      {
        columns: ["code"],
        references: {
          object: { kind: "Catalog", name: "Currency" },
          columns: [skuColumn],
        },
      },
    ],
    indexes: [{ keys: [{ column: "code" }], include: ["currency"] }],
    ...overrides,
  })
}

function currency(skuName = "sku") {
  return catalog("Currency", {
    id: CURRENCY_ID,
    attributes: [
      attribute(skuName, {
        id: SKU_ID,
        physicalName: "sku",
        type: "String",
        length: 10,
      }),
    ],
  })
}

function files(entries: Record<string, unknown>) {
  return metaFiles({ [PROJECT]: project(), ...entries })
}

function columnRefs(result: CompileResult) {
  return result
    .model!.references.filter(
      (r) =>
        r.role === "customTable.column" ||
        r.role === "customTable.foreignKeyTarget"
    )
    .map((r) => [r.from.pointer, r.role, r.to.kind, r.to.id])
}

describe("custom table column references", () => {
  it("custom table column lists are indexed", async () => {
    const result = await compile(
      files({ [CURRENCY]: currency(), [LOG]: fullLog() })
    )
    expect(result.diagnostics).toEqual([])
    expect(columnRefs(result)).toEqual([
      ["/foreignKeys/0/columns/0", "customTable.column", "Element", COL_REF],
      [
        "/foreignKeys/0/references/columns/0",
        "customTable.foreignKeyTarget",
        "Element",
        `${CURRENCY_ID}#ref`,
      ],
      ["/foreignKeys/1/columns/0", "customTable.column", "Element", COL_CODE],
      [
        "/foreignKeys/1/references/columns/0",
        "customTable.foreignKeyTarget",
        "Element",
        SKU_ID,
      ],
      ["/indexes/0/include/0", "customTable.column", "Element", COL_REF],
      ["/indexes/0/keys/0/column", "customTable.column", "Element", COL_CODE],
      ["/primaryKey/columns/0", "customTable.column", "Element", COL_ID],
      ["/uniques/0/columns/0", "customTable.column", "Element", COL_CODE],
      ["/uniques/0/columns/1", "customTable.column", "Element", COL_ID],
    ])
    for (const r of result.model!.references) {
      if (r.role.startsWith("customTable.")) {
        expect(r.from).toEqual(
          expect.objectContaining({ file: LOG, objectId: LOG_ID })
        )
      }
    }
  })

  it("foreign key target columns of another object are indexed", async () => {
    const result = await compile(
      files({ [CURRENCY]: currency(), [LOG]: fullLog() })
    )
    const table = result.model!.physical.tables.find((t) => t.name === "log")!
    // Знімок упорядковує FK за іменем, тож перший — за `code_col`.
    expect(table.foreignKeys.map((fk) => [fk.columns, fk.references])).toEqual([
      [["code_col"], { schema: "public", table: "currency", columns: ["sku"] }],
      [
        ["currency_id"],
        { schema: "public", table: "currency", columns: ["id"] },
      ],
    ])
    expect(table.primaryKey?.columns).toEqual(["id"])
    expect(table.uniques.map((u) => u.columns)).toEqual([["code_col", "id"]])
    expect(table.indexes.map((i) => [i.keys, i.include])).toEqual([
      [[{ column: "code_col" }], ["currency_id"]],
    ])
  })

  it("unknown column is reported by stage 2", () => {
    const stage1 = readFiles(
      files({
        [CURRENCY]: currency(),
        [LOG]: fullLog({
          primaryKey: { columns: ["nope"] },
          indexes: [{ keys: [{ column: "gone" }], include: [] }],
          foreignKeys: [
            {
              columns: ["currency"],
              references: {
                object: { kind: "Catalog", name: "Currency" },
                columns: ["missing"],
              },
            },
          ],
        }),
      })
    )
    expect(stage1.diagnostics).toEqual([])
    const stage2 = checkIdentity(
      stage1.objects,
      stage1.brokenNames,
      stage1.project
    )
    expect(
      stage2.diagnostics.map((d) => [d.code, d.file, d.pointer, d.message])
    ).toEqual([
      [
        "customTable.column-unknown",
        LOG,
        "/primaryKey/columns/0",
        'Log has no column "nope"',
      ],
      [
        "customTable.column-unknown",
        LOG,
        "/foreignKeys/0/references/columns/0",
        'Currency has no column "missing"',
      ],
      [
        "customTable.column-unknown",
        LOG,
        "/indexes/0/keys/0/column",
        'Log has no column "gone"',
      ],
    ])
  })

  it("renaming a catalog attribute keeps the custom table canonical fragment", async () => {
    const fragment = async (skuName: string) => {
      const log = fullLog({ skuColumn: skuName })
      const result = await compile(
        files({ [CURRENCY]: currency(skuName), [LOG]: log })
      )
      expect(result.diagnostics).toEqual([])
      const snapshot = canonicalSnapshot(result.model!) as {
        objects: { id: string; data: unknown }[]
      }
      return snapshot.objects.find((o) => o.id === LOG_ID)!.data
    }
    const before = await fragment("sku")
    const after = await fragment("stockCode")
    expect(after).toEqual(before)
    expect(before).toEqual(
      expect.objectContaining({
        primaryKey: { columns: [COL_ID] },
        foreignKeys: [
          expect.objectContaining({
            columns: [COL_REF],
            references: {
              object: { kind: "Catalog", id: CURRENCY_ID },
              columns: [`${CURRENCY_ID}#ref`],
            },
          }),
          expect.objectContaining({
            columns: [COL_CODE],
            references: {
              object: { kind: "Catalog", id: CURRENCY_ID },
              columns: [SKU_ID],
            },
          }),
        ],
      })
    )
  })

  it("every element-name field of CustomTable yields index entries", async () => {
    /**
     * Шляхи (сегменти, масив — `*`) усіх полів `elementNameSchema` у схемі.
     * `.meta()` клонує схему, але def у клона той самий — за ним і впізнаємо.
     */
    const namePaths = (schema: z.core.$ZodType, path: string[]): string[][] => {
      if (schema._zod.def === elementNameSchema._zod.def) return [path]
      const def = schema._zod.def as unknown as {
        type: string
        shape?: Record<string, z.core.$ZodType>
        innerType?: z.core.$ZodType
        element?: z.core.$ZodType
        options?: z.core.$ZodType[]
        in?: z.core.$ZodType
      }
      switch (def.type) {
        case "object":
          return Object.entries(def.shape ?? {}).flatMap(([key, child]) =>
            namePaths(child, [...path, key])
          )
        case "optional":
        case "default":
        case "nullable":
        case "readonly":
        case "prefault":
          return namePaths(def.innerType!, path)
        case "array":
          return namePaths(def.element!, [...path, "*"])
        case "union":
          return def.options!.flatMap((option) => namePaths(option, path))
        case "pipe":
          return namePaths(def.in!, path)
        default:
          return []
      }
    }
    const paths = namePaths(customTableSchema, [])
      // Імена самих колонок — оголошення, а не посилання.
      .filter((path) => path.join("/") !== "columns/*/name")
      .map((path) => `/${path.join("/")}`)
    expect(paths.length).toBeGreaterThan(0)

    // Індекс стадії 2 напряму: `scopeColumn` без виду скоупу — помилка
    // стадії 4, а тут важить лише, чи кожне поле потрапило в індекс.
    const stage1 = readFiles(
      files({
        [CURRENCY]: currency(),
        [LOG]: fullLog({ scopeColumn: "id" }),
      })
    )
    const stage2 = checkIdentity(
      stage1.objects,
      stage1.brokenNames,
      stage1.project
    )
    expect([...stage1.diagnostics, ...stage2.diagnostics]).toEqual([])
    const indexed = stage2.references
      .filter((r) => r.from.file === LOG)
      .map((r) => r.from.pointer.replace(/\/\d+(?=\/|$)/g, "/*"))
    for (const path of paths) expect(indexed).toContain(path)
  })
})
