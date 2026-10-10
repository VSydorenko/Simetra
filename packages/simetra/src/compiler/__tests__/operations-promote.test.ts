import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  promoteObject,
  type PromoteInput,
  type SchemaPathResolver,
} from "simetra/compiler"
import {
  CATALOG_FILE,
  COUNTERPARTY_FILE,
  COUNTERPARTY_ID,
  INN_ID,
  INVOICE_FILE,
  counterpartyMapping,
  promotionProject,
} from "./fixtures/promotion"
import { uuid } from "./helpers"

type Json = Record<string, unknown>

/** Детерміноване джерело id у формі UUID v4. */
function counter(start = 900_000): () => string {
  let n = start
  return () => uuid(++n)
}

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

const COMPLETION = { schemaPath, newId: counter() }

// Задача 7 ще не класифікує SQL-одиниць і не промотує ТЧ.
const PARTS = { module: false, contacts: false }

const json = (files: ReadonlyMap<string, string>, path: string) =>
  JSON.parse(files.get(path)!) as Json

const errors = (result: { diagnostics: { severity: string }[] }) =>
  result.diagnostics.filter((d) => d.severity === "error")

const brief = (result: {
  diagnostics: {
    code: string
    file: string
    pointer: string
    params?: Record<string, unknown>
  }[]
}) =>
  result.diagnostics.map((d) => ({
    code: d.code,
    file: d.file,
    pointer: d.pointer,
    params: d.params,
  }))

/** Мапінг-зразок зі зміною: `edit` правлячи копію. */
function mapping(edit: (input: PromoteInput) => void = () => {}): PromoteInput {
  const input = structuredClone(counterpartyMapping(PARTS))
  edit(input)
  return input
}

/** Фікстура з правкою файлу `Counterparty` (сирий JSON). */
function withCounterparty(
  edit: (raw: Json) => void,
  extra: Record<string, unknown> = {}
): Map<string, string> {
  const files = promotionProject(PARTS)
  const raw = json(files, COUNTERPARTY_FILE)
  edit(raw)
  files.set(COUNTERPARTY_FILE, JSON.stringify(raw))
  for (const [path, value] of Object.entries(extra)) {
    files.set(path, JSON.stringify(value))
  }
  return files
}

async function promoted(
  files: ReadonlyMap<string, string>,
  input: PromoteInput = mapping()
) {
  const result = await promoteObject(files, input, COMPLETION)
  return { result, after: applyChanges(files, result.changes) }
}

describe("promoteObject: catalog from one CustomTable", () => {
  it("promotes a catalog: ids carried, names canonical, CustomTable gone", async () => {
    const files = promotionProject(PARTS)
    const { result, after } = await promoted(files, counterpartyMapping(PARTS))
    expect(errors(result)).toEqual([])
    expect(result.ok).toBe(true)
    expect(after.has(COUNTERPARTY_FILE)).toBe(false)
    const cat = json(after, CATALOG_FILE)
    expect([cat.id, cat.physicalName, cat.kindLabel]).toEqual([
      COUNTERPARTY_ID,
      "counterparty",
      "counterparty",
    ])
    expect(cat.schema).toBe("app")
    expect(cat.description).toEqual({ uk: "Counterparties of the company" })
    expect(cat.attributes).toEqual([
      expect.objectContaining({
        id: INN_ID,
        name: "taxId",
        physicalName: "tax_id",
        type: "Text",
      }),
    ])
    expect(result.record?.columns).toEqual(
      expect.arrayContaining([
        {
          id: INN_ID,
          schema: "app",
          table: "counterparty",
          from: "inn",
          to: "tax_id",
        },
        {
          id: `${COUNTERPARTY_ID}#description`,
          schema: "app",
          table: "counterparty",
          from: "name",
          to: "description",
        },
        {
          id: `${COUNTERPARTY_ID}#deletionMark`,
          schema: "app",
          table: "counterparty",
          from: "is_deleted",
          to: "deletion_mark",
        },
      ])
    )
    expect(result.record?.tables).toEqual([
      {
        id: COUNTERPARTY_ID,
        schema: "app",
        from: "counterparties",
        to: "counterparty",
      },
    ])
    expect(result.record).toMatchObject({
      objectId: COUNTERPARTY_ID,
      kind: "Catalog",
      kindLabel: "counterparty",
      labelDropped: false,
      conversions: [
        {
          subject: "Counterparty#uniques/counterparties_inn_key",
          class: "property",
        },
      ],
      retired: [],
    })
  })

  it("rewrites references from other files to the new kind and names", async () => {
    const files = promotionProject(PARTS)
    const { result, after } = await promoted(files)
    expect(errors(result)).toEqual([])
    const invoice = json(after, INVOICE_FILE)
    expect(invoice.foreignKeys).toEqual([
      expect.objectContaining({
        columns: ["counterpartyId"],
        references: {
          object: { kind: "Catalog", name: "Counterparty" },
          columns: ["ref"],
        },
      }),
    ])
    expect(result.changes.map((c) => [c.path, c.content === null])).toEqual([
      [CATALOG_FILE, false],
      [COUNTERPARTY_FILE, true],
      [INVOICE_FILE, false],
    ])
  })

  it("writes references to standard attributes in the project's style", async () => {
    const files = promotionProject(PARTS)
    const project = json(files, "project.meta.json")
    files.set(
      "project.meta.json",
      JSON.stringify({ ...project, naming: { attributeCase: "snake_case" } })
    )
    // Стиль проєкту стосується й прийнятих таблиць: логічні імена колонок.
    for (const path of [COUNTERPARTY_FILE, INVOICE_FILE]) {
      const raw = json(files, path)
      files.set(
        path,
        JSON.stringify(raw).replace(
          /"(isDeleted|createdAt|docDate|counterpartyId)"/g,
          (_, name: string) =>
            `"${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}"`
        )
      )
    }
    const input = mapping((m) => {
      m.columns = {
        id: { to: "standard", name: "ref" },
        name: { to: "standard", name: "description" },
        inn: {
          to: "attribute",
          collection: "attributes",
          element: { name: "tax_id" },
        },
        is_deleted: { to: "standard", name: "deletionMark" },
        created_at: { to: "standard", name: "createdAt" },
      }
    })
    const { result, after } = await promoted(files, input)
    expect(errors(result)).toEqual([])
    expect(json(after, CATALOG_FILE).attributes).toEqual([
      expect.objectContaining({ name: "tax_id", physicalName: "tax_id" }),
    ])
    expect(result.record?.columns).toContainEqual({
      id: `${COUNTERPARTY_ID}#deletionMark`,
      schema: "app",
      table: "counterparty",
      from: "is_deleted",
      to: "deletion_mark",
    })
  })

  it("refuses an unplaced column", async () => {
    const files = promotionProject(PARTS)
    const { result } = await promoted(
      files,
      mapping((m) => {
        delete m.columns.inn
      })
    )
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(brief(result)).toEqual([
      {
        code: "promote.column-unplaced",
        file: COUNTERPARTY_FILE,
        pointer: "/columns/2",
        params: { table: "Counterparty", column: "inn" },
      },
    ])
  })

  it("refuses a mapping to an unknown column, a standard attribute the kind lacks, a target mapped twice or a conversion key naming nothing", async () => {
    const files = promotionProject(PARTS)
    const cases: [(m: PromoteInput) => void, string][] = [
      [(m) => (m.columns.nope = { to: "retire" }), "/columns/nope"],
      // codeLength 0: коду в довідника немає.
      [
        (m) => (m.columns.inn = { to: "standard", name: "code" }),
        "/columns/inn/name",
      ],
      // Друга колонка з тією самою ціллю — у порядку колонок.
      [
        (m) => (m.columns.inn = { to: "standard", name: "description" }),
        "/columns/inn",
      ],
      [
        (m) => (m.conversions["Counterparty#uniques/nothing"] = "removed"),
        "/conversions/Counterparty#uniques~1nothing",
      ],
      [(m) => (m.into.data = { codeLength: -1 }), "/into/data/codeLength"],
    ]
    for (const [edit, at] of cases) {
      const { result } = await promoted(files, mapping(edit))
      expect(result.ok, at).toBe(false)
      expect(
        result.diagnostics.map((d) => [d.code, d.params?.at]),
        at
      ).toEqual([["promote.mapping-unknown", at]])
    }
  })

  it("refuses the kind key on a column that is not the single uuid key", async () => {
    const files = promotionProject({ ...PARTS, invoice: false })
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.columns.id = { to: "retire" }
        m.columns.inn = { to: "standard", name: "ref" }
        m.fill = [
          {
            target: { to: "standard", name: "ref" },
            expression: "gen_random_uuid()",
          },
        ]
      })
    )
    expect(result.diagnostics.map((d) => [d.code, d.params?.at])).toEqual([
      ["promote.mapping-unknown", "/columns/inn/name"],
    ])
  })

  it("records a type change of a column mapped to a standard attribute", async () => {
    const files = promotionProject(PARTS)
    const { result } = await promoted(files)
    expect(result.record?.typeChanges).toEqual([
      {
        schema: "app",
        table: "counterparty",
        column: "description",
        from: "text",
        to: "character varying(150)",
      },
    ])
  })

  it("records a type change an element sets", async () => {
    const files = promotionProject(PARTS)
    const { result, after } = await promoted(
      files,
      mapping((m) => {
        m.columns.inn = {
          to: "attribute",
          collection: "attributes",
          element: { name: "taxId", type: "String", length: 12 },
        }
      })
    )
    expect(errors(result)).toEqual([])
    expect(json(after, CATALOG_FILE).attributes).toEqual([
      expect.objectContaining({ id: INN_ID, type: "String", length: 12 }),
    ])
    expect(result.record?.typeChanges).toContainEqual({
      schema: "app",
      table: "counterparty",
      column: "tax_id",
      from: "text",
      to: "character varying(12)",
    })
  })

  it("refuses an unclassified unique", async () => {
    const files = promotionProject(PARTS)
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.conversions = {}
      })
    )
    expect(brief(result)).toEqual([
      {
        code: "promote.unclassified",
        file: COUNTERPARTY_FILE,
        pointer: "/uniques/0",
        params: { subject: "Counterparty#uniques/counterparties_inn_key" },
      },
    ])
  })

  it("names an unnamed structural element by its index", async () => {
    const files = withCounterparty((raw) => {
      ;(raw.uniques as Json[]).push({ columns: ["name"] })
    })
    const { result } = await promoted(files)
    expect(result.diagnostics.map((d) => [d.code, d.params?.subject])).toEqual([
      ["promote.unclassified", "Counterparty#uniques/1"],
    ])
    const classified = await promoted(
      files,
      mapping((m) => {
        m.conversions["Counterparty#uniques/1"] = "removed"
      })
    )
    expect(errors(classified.result)).toEqual([])
  })

  it("refuses a column default without an element defaultValue or a conversion", async () => {
    const files = promotionProject(PARTS)
    const archived = (m: PromoteInput) => {
      m.columns.isDeleted = {
        to: "attribute",
        collection: "attributes",
        element: { name: "archived" },
      }
    }
    const { result } = await promoted(files, mapping(archived))
    expect(brief(result)).toEqual([
      {
        code: "promote.default-unplaced",
        file: COUNTERPARTY_FILE,
        pointer: "/columns/3",
        params: {
          table: "Counterparty",
          column: "isDeleted",
          subject: "Counterparty#default/isDeleted",
        },
      },
    ])
    // `deletionMark` тепер ніхто не несе, але в нього є власне значення.
    for (const edit of [
      (m: PromoteInput) => {
        archived(m)
        m.conversions["Counterparty#default/isDeleted"] = "removed"
      },
      (m: PromoteInput) => {
        archived(m)
        ;(m.columns.isDeleted as { element: Json }).element.defaultValue = false
      },
    ]) {
      const ok = await promoted(files, mapping(edit))
      expect(errors(ok.result)).toEqual([])
    }
  })

  it("records a relaxed NOT NULL and a retired column", async () => {
    const files = promotionProject(PARTS)
    const { result, after } = await promoted(
      files,
      mapping((m) => {
        m.columns.createdAt = { to: "retire" }
      })
    )
    expect(errors(result)).toEqual([])
    expect(result.record?.retired).toEqual([
      { schema: "app", table: "counterparties", column: "created_at" },
    ])
    expect(result.record?.relaxed).toEqual([
      {
        schema: "app",
        table: "counterparty",
        column: "description",
        constraint: "notNull",
      },
    ])
    expect(result.record?.columns.map((c) => c.from)).not.toContain(
      "created_at"
    )
    expect(json(after, CATALOG_FILE).attributes).toHaveLength(1)
  })

  it("refuses a reference to a retired column", async () => {
    const files = promotionProject(PARTS)
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.columns.id = { to: "retire" }
        // Ключ виду без колонки — його заповнює крок даних (задача 8).
        m.fill = [
          {
            target: { to: "standard", name: "ref" },
            expression: "gen_random_uuid()",
          },
        ]
      })
    )
    expect(brief(result)).toEqual([
      {
        code: "promote.retired-referenced",
        file: INVOICE_FILE,
        pointer: "/foreignKeys/0/references/columns/0",
        params: {
          table: "Counterparty",
          column: "id",
          role: "customTable.foreignKeyTarget",
        },
      },
    ])
  })

  it("refuses a missing value for the kind key", async () => {
    const files = promotionProject({ ...PARTS, invoice: false })
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.columns.id = { to: "retire" }
      })
    )
    expect(brief(result)).toEqual([
      {
        code: "promote.fill-missing",
        file: COUNTERPARTY_FILE,
        pointer: "",
        params: { column: "ref", kind: "Catalog", name: "Counterparty" },
      },
    ])
  })

  it("refuses a PgEnum column whose labels the Enumeration lacks", async () => {
    const enumFile = "pg-enums/CounterpartyKind/CounterpartyKind.meta.json"
    const enumerationFile =
      "enumerations/CounterpartyKind/CounterpartyKind.meta.json"
    const enumeration = (labels: string[]) => ({
      id: uuid(7301),
      kind: "Enumeration",
      name: "CounterpartyKind",
      physicalName: "counterparty_kind",
      values: labels.map((label, i) => ({
        id: uuid(7310 + i),
        name: label === "person" ? "Person" : "Company",
        physicalName: label,
      })),
    })
    const files = (labels: string[]) =>
      withCounterparty(
        (raw) => {
          ;(raw.columns as Json[]).push({
            id: uuid(7007),
            name: "kind",
            physicalName: "kind",
            type: "PgEnum",
            enum: { kind: "PgEnum", name: "CounterpartyKind" },
          })
        },
        {
          [enumFile]: {
            id: uuid(7300),
            kind: "PgEnum",
            name: "CounterpartyKind",
            physicalName: "counterparty_kind",
            schema: "app",
            values: ["person", "company"],
          },
          [enumerationFile]: enumeration(labels),
        }
      )
    const toEnumeration = (m: PromoteInput) => {
      m.columns.kind = {
        to: "attribute",
        collection: "attributes",
        element: {
          name: "partyKind",
          type: "Ref",
          ref: { kind: "Enumeration", name: "CounterpartyKind" },
        },
      }
    }
    const { result } = await promoted(files(["person"]), mapping(toEnumeration))
    expect(brief(result)).toEqual([
      {
        code: "promote.enum-labels",
        file: COUNTERPARTY_FILE,
        pointer: "/columns/5",
        params: {
          table: "Counterparty",
          column: "kind",
          enum: "CounterpartyKind",
          labels: "company",
        },
      },
    ])
    const text = await promoted(
      files(["person", "company"]),
      mapping((m) => {
        m.columns.kind = {
          to: "attribute",
          collection: "attributes",
          element: { name: "partyKind", type: "Text" },
        }
      })
    )
    expect(text.result.diagnostics.map((d) => d.code)).toEqual([
      "promote.enum-labels",
    ])
    const ok = await promoted(
      files(["person", "company"]),
      mapping(toEnumeration)
    )
    expect(errors(ok.result)).toEqual([])
  })

  it("refuses a column type without an attribute counterpart", async () => {
    const files = withCounterparty((raw) => {
      ;(raw.columns as Json[]).push({
        id: uuid(7008),
        name: "point",
        physicalName: "point",
        type: "Raw",
        pgType: "point",
      })
    })
    const point = (m: PromoteInput) => {
      m.columns.point = {
        to: "attribute",
        collection: "attributes",
        element: { name: "point" },
      }
    }
    const { result } = await promoted(files, mapping(point))
    expect(brief(result)).toEqual([
      {
        code: "promote.type-unsupported",
        file: COUNTERPARTY_FILE,
        pointer: "/columns/5",
        params: {
          table: "Counterparty",
          column: "point",
          detail: "raw type point",
        },
      },
    ])
    const retired = await promoted(
      files,
      mapping((m) => {
        m.columns.point = { to: "retire" }
      })
    )
    expect(errors(retired.result)).toEqual([])
  })

  it("turns a foreign key column into a Ref and refuses one outside the unit", async () => {
    const files = promotionProject({
      module: false,
      contacts: true,
      invoice: false,
    })
    const { result, after } = await promoted(files, {
      ...mapping(),
      target: { name: "CounterpartyContact" },
      into: { kind: "Catalog", name: "Contact", data: { codeLength: 0 } },
      columns: {
        id: { to: "standard", name: "ref" },
        counterpartyId: {
          to: "attribute",
          collection: "attributes",
          element: { name: "counterparty" },
        },
        phone: { to: "standard", name: "description" },
      },
      conversions: {},
    })
    expect(result.diagnostics.map((d) => [d.code, d.file, d.pointer])).toEqual([
      [
        "promote.reference-not-promoted",
        "custom-tables/CounterpartyContact/CounterpartyContact.meta.json",
        "/foreignKeys/0/references/object",
      ],
    ])
    expect(after).toEqual(files)

    // Ціль FK уже вид 1С: колонка стає `Ref` на нього.
    const first = await promoted(files, counterpartyMapping({ ...PARTS }))
    expect(errors(first.result)).toEqual([])
    const second = await promoted(first.after, {
      ...mapping(),
      target: { name: "CounterpartyContact" },
      into: { kind: "Catalog", name: "Contact", data: { codeLength: 0 } },
      columns: {
        id: { to: "standard", name: "ref" },
        counterpartyId: {
          to: "attribute",
          collection: "attributes",
          element: { name: "counterparty" },
        },
        phone: { to: "standard", name: "description" },
      },
      conversions: {},
    })
    expect(errors(second.result)).toEqual([])
    expect(
      json(second.after, "catalogs/Contact/Contact.meta.json").attributes
    ).toEqual([
      expect.objectContaining({
        name: "counterparty",
        physicalName: "counterparty_id",
        type: "Ref",
        ref: { kind: "Catalog", name: "Counterparty" },
        required: true,
      }),
    ])
  })

  it("refuses an id anywhere in the input", async () => {
    const files = promotionProject(PARTS)
    const cases: [(m: PromoteInput) => void, string][] = [
      [
        (m) => ((m.columns.inn as { element: Json }).element.id = uuid(1)),
        "/columns/inn/element/id",
      ],
      [(m) => (m.into.data = { id: uuid(2) }), "/into/data/id"],
      [
        (m) =>
          (m.into.data = {
            attributes: [{ id: uuid(3), name: "extra", type: "Text" }],
          }),
        "/into/data/attributes/0/id",
      ],
    ]
    for (const [edit, at] of cases) {
      const { result } = await promoted(files, mapping(edit))
      expect(
        result.diagnostics.map((d) => [d.code, d.params?.at]),
        at
      ).toEqual([["operation.input-invalid", at]])
    }
  })

  it("refuses a missing target and a taken name", async () => {
    const files = promotionProject(PARTS)
    const missing = await promoted(
      files,
      mapping((m) => {
        m.target.name = "Nope"
      })
    )
    expect(missing.result.diagnostics.map((d) => d.code)).toEqual([
      "operation.target-not-found",
    ])
    const first = await promoted(files)
    const taken = await promoted(
      first.after,
      mapping((m) => {
        m.target.name = "Invoice"
      })
    )
    expect(taken.result.diagnostics.map((d) => d.code)).toEqual([
      "operation.object-exists",
    ])
  })

  it("moves the TypeScript module of the table next to the kind file", async () => {
    const files = promotionProject(PARTS)
    const module = "export const touched = true\n"
    files.set("custom-tables/Counterparty/Counterparty.module.ts", module)
    const { result, after } = await promoted(files)
    expect(errors(result)).toEqual([])
    expect(after.has("custom-tables/Counterparty/Counterparty.module.ts")).toBe(
      false
    )
    expect(after.get("catalogs/Counterparty/Counterparty.module.ts")).toBe(
      module
    )
  })

  it("compiles the result with the baseline: no assigned-once diagnostics", async () => {
    const files = promotionProject(PARTS)
    const { result, after } = await promoted(files)
    expect(result.ok).toBe(true)
    const compiled = await compile(after, { baseline: files })
    expect(
      compiled.diagnostics.filter(
        (d) => d.code === "identity.assigned-once-changed"
      )
    ).toEqual([])
    expect(compiled.ok).toBe(true)
  })
})
