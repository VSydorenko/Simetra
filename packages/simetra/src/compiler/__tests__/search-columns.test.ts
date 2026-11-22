import { describe, expect, it } from "vitest"
import {
  buildClientCatalog,
  buildRuntimeCatalog,
  compile,
  emitEntityTypes,
  type CompiledModel,
} from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import { entityFields, objectEntity } from "../entity-fields"
import {
  commandCoreLayer,
  compileRights,
  policyDomain,
  TICKET_TABLE,
  writeRoles,
} from "./fixtures/rights"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  project,
  uuid,
} from "./helpers"

/**
 * Поля пошуку (спека П2 §5, «Поля пошуку», ADR-0097): кожне поле
 * `String`/`Text` дає збережену згенеровану нормалізовану колонку й
 * одноколонковий індекс `text_pattern_ops`; колонка не поле сутності.
 */

const PARTY = "catalogs/Party/Party.meta.json"
const INVOICE = "documents/Invoice/Invoice.meta.json"
const LOG = "custom-tables/Log/Log.meta.json"

async function compiled(entries: Record<string, unknown>) {
  return compile(metaFiles({ "project.meta.json": project(), ...entries }))
}

async function modelOf(
  entries: Record<string, unknown>
): Promise<CompiledModel> {
  const result = await compiled(entries)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

const tableOf = (model: CompiledModel, name: string): PhysicalTable => {
  const table = model.physical.tables.find((t) => t.name === name)
  expect(table, name).toBeDefined()
  return table!
}

const searchColumns = (table: PhysicalTable) =>
  table.columns.filter((c) => c.origin.searchOf !== undefined)

/** Індекси таблиці, що мають клас операторів, у формі `колонка opclass`. */
const prefixIndexes = (table: PhysicalTable) =>
  table.indexes.flatMap((index) =>
    index.keys.some((k) => k.opclass !== undefined)
      ? [
          index.keys
            .map((k) =>
              "column" in k
                ? `${k.column}${k.opclass === undefined ? "" : ` ${k.opclass.name}`}`
                : k.expression
            )
            .join(", "),
        ]
      : []
  )

async function codesOf(entries: Record<string, unknown>) {
  const result = await compiled(entries)
  return result.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => `${d.code} ${d.pointer}`)
}

describe("search fields: normalized column and prefix index", () => {
  it("a catalog searches by its description by default", async () => {
    const table = tableOf(await modelOf({ [PARTY]: catalog("Party") }), "party")
    expect(searchColumns(table)).toEqual([
      {
        name: "description_search",
        type: "text",
        notNull: false,
        generated: { expression: `lower(description COLLATE "default")` },
        origin: { searchOf: "description" },
      },
    ])
    // Одна колонка: ні скоупу, ні ключа рядка (ADR-0097)
    expect(prefixIndexes(table)).toEqual([
      "description_search text_pattern_ops",
    ])
    expect(
      table.indexes.find((i) =>
        i.keys.some((k) => "column" in k && k.column === "description_search")
      )?.name
    ).toBe("party_description_search_idx")
  })

  it("a catalog with the code as main presentation searches by the code", async () => {
    const table = tableOf(
      await modelOf({
        [PARTY]: catalog("Party", {
          mainPresentation: "Code",
          codeType: "String",
        }),
      }),
      "party"
    )
    expect(searchColumns(table).map((c) => c.origin.searchOf)).toEqual(["code"])
  })

  it("a numeric code is searched by eq and gets no column", async () => {
    const table = tableOf(
      await modelOf({
        [PARTY]: catalog("Party", {
          mainPresentation: "Code",
          codeType: "Number",
        }),
      }),
      "party"
    )
    expect(searchColumns(table)).toEqual([])
    expect(prefixIndexes(table)).toEqual([])
  })

  it("a document searches by its number", async () => {
    const table = tableOf(
      await modelOf({ [INVOICE]: document("Invoice") }),
      "invoice"
    )
    expect(searchColumns(table).map((c) => c.name)).toEqual(["number_search"])
  })

  it("declared fields: String and Text get a column, other scalars and arrays do not", async () => {
    const table = tableOf(
      await modelOf({
        [PARTY]: catalog("Party", {
          attributes: [
            attribute("taxId", { type: "String", length: 20 }),
            attribute("notes", { type: "Text" }),
            attribute("rank", { type: "Integer" }),
            attribute("tags", { type: "String", length: 10, array: true }),
          ],
          search: {
            fields: ["taxId", "notes", "rank", "tags"],
            mode: "startsWith",
          },
        }),
      }),
      "party"
    )
    expect(
      searchColumns(table).map((c) => [c.name, c.origin.searchOf])
    ).toEqual([
      ["tax_id_search", "tax_id"],
      ["notes_search", "notes"],
    ])
    expect(prefixIndexes(table)).toEqual([
      "notes_search text_pattern_ops",
      "tax_id_search text_pattern_ops",
    ])
  })

  it("declared empty fields mean no search", async () => {
    const table = tableOf(
      await modelOf({ [PARTY]: catalog("Party", { search: { fields: [] } }) }),
      "party"
    )
    expect(searchColumns(table)).toEqual([])
  })

  it("a CustomTable column normalizes under the database collation, not its own", async () => {
    const table = tableOf(
      await modelOf({
        [LOG]: customTable("Log", {
          columns: [
            {
              id: uuid(1),
              name: "id",
              physicalName: "id",
              type: "UUID",
              notNull: true,
            },
            {
              id: uuid(2),
              name: "title",
              physicalName: "title",
              type: "Text",
              collation: { name: "C" },
            },
          ],
          primaryKey: { columns: ["id"] },
          search: { fields: ["title"] },
        }),
      }),
      "log"
    )
    expect(searchColumns(table)).toEqual([
      expect.objectContaining({
        name: "title_search",
        generated: { expression: `lower(title COLLATE "default")` },
      }),
    ])
    expect(prefixIndexes(table)).toEqual(["title_search text_pattern_ops"])
  })

  it("a CustomTable without declared fields has no search column", async () => {
    const table = tableOf(
      await modelOf({
        [LOG]: customTable("Log", {
          columns: [
            {
              id: uuid(1),
              name: "id",
              physicalName: "id",
              type: "UUID",
              notNull: true,
            },
            { id: uuid(2), name: "title", physicalName: "title", type: "Text" },
          ],
          primaryKey: { columns: ["id"] },
        }),
      }),
      "log"
    )
    expect(searchColumns(table)).toEqual([])
  })
})

describe("search fields: diagnostics of declared fields", () => {
  it("unknown, duplicate, tabular, ref", async () => {
    expect(
      await codesOf({
        "catalogs/Region/Region.meta.json": catalog("Region"),
        [PARTY]: catalog("Party", {
          attributes: [
            attribute("region", {
              type: "Ref",
              ref: { kind: "Catalog", name: "Region" },
            }),
          ],
          tabularSections: [
            {
              id: uuid(500),
              name: "contacts",
              physicalName: "party_contacts",
              attributes: [attribute("phone", { type: "String", length: 20 })],
            },
          ],
          search: {
            fields: ["nope", "description", "description", "phone", "region"],
          },
        }),
      })
    ).toEqual([
      "search.field-unknown /search/fields/0",
      "search.field-duplicate /search/fields/2",
      "search.field-tabular /search/fields/3",
      "search.field-ref /search/fields/4",
    ])
  })

  it("a standard reference is a ref", async () => {
    expect(
      await codesOf({
        [PARTY]: catalog("Party", {
          hierarchyType: "ItemsOnly",
          search: { fields: ["parent"] },
        }),
      })
    ).toEqual(["search.field-ref /search/fields/0"])
  })

  it("a generated CustomTable column (42P17)", async () => {
    expect(
      await codesOf({
        [LOG]: customTable("Log", {
          columns: [
            {
              id: uuid(1),
              name: "id",
              physicalName: "id",
              type: "UUID",
              notNull: true,
            },
            { id: uuid(2), name: "title", physicalName: "title", type: "Text" },
            {
              id: uuid(3),
              name: "upper",
              physicalName: "upper_title",
              type: "Text",
              generated: { expression: "upper(title)" },
            },
          ],
          primaryKey: { columns: ["id"] },
          search: { fields: ["upper"] },
        }),
      })
    ).toEqual(["search.field-generated /search/fields/0"])
  })

  it("an attribute taking the derived name collides", async () => {
    const codes = await codesOf({
      [PARTY]: catalog("Party", {
        attributes: [
          attribute("other", {
            type: "String",
            length: 5,
            physicalName: "description_search",
          }),
        ],
      }),
    })
    expect(codes).toEqual([
      "physical.column-duplicate /attributes/0/physicalName",
    ])
  })
})

describe("search fields: the column is not an entity field", () => {
  // Довідник з ядром команд: каталог рантайму й ядро будуються лише для таких.
  const ticket = async () => {
    const { model, diagnostics } = await compileRights(
      policyDomain(writeRoles(), commandCoreLayer())
    )
    expect(diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const table = tableOf(model!, TICKET_TABLE)
    // Без нормалізованої колонки решта тверджень нічого б не доводила
    expect(searchColumns(table).map((c) => c.name)).toEqual([
      "description_search",
    ])
    return model!
  }

  it("no entity field, no runtime attribute, no command key, no client name", async () => {
    const model = await ticket()
    const object = model.objects.find((o) => o.name === "Ticket")!
    const entity = objectEntity(model, object)!
    const fields = entityFields(model, entity.main, entity)
    expect(fields.flatMap((f) => f.columns)).not.toContain("description_search")

    const runtime = buildRuntimeCatalog(model)
    const entry = runtime.objects.find((o) => o.name === "Ticket")!
    expect(entry.attributes.map((a) => a.column)).not.toContain(
      "description_search"
    )
    // Ім'я колонки — властивість поля каталогу рантайму
    expect(
      entry.attributes
        .filter((a) => a.search !== undefined)
        .map((a) => [a.name, a.search])
    ).toEqual([["description", "description_search"]])
    // До клієнта ім'я не переходить
    expect(
      JSON.stringify(
        buildClientCatalog(runtime).objects.find((o) => o.name === "Ticket")
      )
    ).not.toContain("description_search")

    const access = model.contracts.access.find(
      (a) => a.table.name === TICKET_TABLE
    )!
    expect(access.command?.insert).toContain("description")
    expect(access.command?.insert).not.toContain("description_search")
    expect(access.command?.update).not.toContain("description_search")
  })

  it("the entity type has no normalized column", async () => {
    expect(emitEntityTypes(await ticket())).not.toContain("description_search")
  })

  it("the kernel result drops the normalized column", async () => {
    const model = await ticket()
    const save = model.sqlUnits.find((u) =>
      u.identity.startsWith(`function:public.${TICKET_TABLE}_save(`)
    )!
    expect(save.sql).toMatch(
      /v_result := \(to_jsonb\(v_row\) - 'description_search'\)/
    )
  })
})
