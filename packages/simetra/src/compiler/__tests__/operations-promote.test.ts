import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  derivePromotionFacts,
  promoteInput,
  promoteObject,
  promotionMapping,
  promotionRecordSchema,
  serializeCanonical,
  type ConversionClass,
  type PromoteInput,
  type PromotionRecord,
  type SchemaPathResolver,
} from "simetra/compiler"
import {
  CATALOG_FILE,
  CONTACT_FILE,
  CONTACT_ID,
  COUNTERPARTY_COLUMNS,
  COUNTERPARTY_FILE,
  COUNTERPARTY_ID,
  CREATED_AT_FILL,
  INN_ID,
  INVOICE_FILE,
  counterpartyMapping,
  promotionProject,
} from "./fixtures/promotion"
import {
  attribute,
  catalog,
  customTable,
  metaFiles,
  project,
  scopedProject,
  uuid,
} from "./helpers"

type Json = Record<string, unknown>

/** Детерміноване джерело id у формі UUID v4. */
function counter(start = 900_000): () => string {
  let n = start
  return () => uuid(++n)
}

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

const COMPLETION = { schemaPath, newId: counter() }

// Мапінг колонок — без SQL-модуля й ТЧ: їх перевіряють окремі блоки й
// `operations-promote-sql.test.ts`.
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
          sourceId: INN_ID,
          schema: "app",
          table: "counterparty",
          from: "inn",
          to: "tax_id",
        },
        {
          id: `${COUNTERPARTY_ID}#description`,
          sourceId: COUNTERPARTY_COLUMNS.name,
          schema: "app",
          table: "counterparty",
          from: "name",
          to: "description",
        },
        {
          id: `${COUNTERPARTY_ID}#deletionMark`,
          sourceId: COUNTERPARTY_COLUMNS.isDeleted,
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
        // Коментар таблиці дослівно став описом виду (R24)
        { subject: "Counterparty#comment", class: "metadata" },
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
      sourceId: COUNTERPARTY_COLUMNS.isDeleted,
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
        m.fill.push({
          target: { to: "standard", name: "ref" },
          expression: "md5(name)::uuid",
        })
      })
    )
    // Ключ несе ідентичність рядка: крок його не обчислює.
    expect(result.diagnostics.map((d) => [d.code, d.params?.at])).toEqual([
      ["promote.mapping-unknown", "/columns/inn/name"],
      ["promote.mapping-unknown", "/fill/1/target/name"],
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
      {
        sourceId: COUNTERPARTY_COLUMNS.createdAt,
        schema: "app",
        table: "counterparties",
        column: "created_at",
      },
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
      })
    )
    // Ключ без колонки нічим не заповнити: крок ключа не обчислює.
    expect(brief(result)).toEqual([
      {
        code: "promote.fill-missing",
        file: COUNTERPARTY_FILE,
        pointer: "",
        params: {
          column: "ref",
          kind: "Catalog",
          name: "Counterparty",
          reason: "unmapped",
        },
      },
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
        params: {
          column: "ref",
          kind: "Catalog",
          name: "Counterparty",
          reason: "unmapped",
        },
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
          reason: "raw",
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
      fill: [],
    })
    expect(result.diagnostics.map((d) => [d.code, d.file, d.pointer])).toEqual([
      [
        "promote.reference-not-promoted",
        "custom-tables/CounterpartyContact/CounterpartyContact.meta.json",
        "/columns/1",
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
      fill: [],
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

  it("moves the CustomTable module byte for byte", async () => {
    const files = promotionProject(PARTS)
    // CRLF, хвостові пробіли й табуляція без кінцевого переводу рядка.
    const module = "export const touched = true \r\n\t// ї\u00a0end"
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

/** Факти запису — те, що T2 виводить сам і звіряє (рішення 1 плану П3-2a). */
const factsOf = (record: PromotionRecord) => ({
  tables: record.tables,
  columns: record.columns,
  typeChanges: record.typeChanges,
  retired: record.retired,
  relaxed: record.relaxed,
  tightened: record.tightened,
  rowLevelSecurity: record.rowLevelSecurity,
  deleteSemantics: record.deleteSemantics,
})

/** Факти, виведені зі знімків до й після, як їх виведе T2. */
async function derived(
  files: ReadonlyMap<string, string>,
  record: PromotionRecord,
  changes: Parameters<typeof applyChanges>[1]
) {
  const before = (await compile(files)).model!
  const after = (await compile(applyChanges(files, changes))).model!
  return derivePromotionFacts(
    before.physical,
    {
      physical: after.physical,
      attributeCase: after.project.naming.attributeCase,
    },
    promotionMapping(record)
  )
}

describe("promoteObject: the promotion record", () => {
  const NO_FILL = { ...PARTS, fill: false }

  it("records the hashes before and after, and the adopted column ids", async () => {
    for (const fill of [true, false]) {
      const files = promotionProject(PARTS)
      const before = await compile(files)
      const result = await promoteObject(
        files,
        counterpartyMapping({ ...PARTS, fill }),
        COMPLETION
      )
      expect(errors(result)).toEqual([])
      const after = await compile(applyChanges(files, result.changes))
      expect(result.record!.format).toBe(1)
      expect(result.record!.base).toBe(before.model!.hash)
      expect(result.record!.result).toBe(after.model!.hash)
      // Кожна прийнята колонка — рівно раз у columns або retired, за id.
      const sources = [...result.record!.columns, ...result.record!.retired]
        .map((c) => c.sourceId)
        .sort()
      expect(sources).toEqual(Object.values(COUNTERPARTY_COLUMNS).sort())
    }
    const { result } = await promoted(
      promotionProject(PARTS),
      counterpartyMapping(NO_FILL)
    )
    expect(result.record!.retired).toEqual([
      {
        sourceId: COUNTERPARTY_COLUMNS.createdAt,
        schema: "app",
        table: "counterparties",
        column: "created_at",
      },
    ])
  })

  it("derives the same facts from the snapshots as the record carries", async () => {
    for (const input of [
      counterpartyMapping(PARTS),
      counterpartyMapping(NO_FILL),
    ]) {
      const files = promotionProject(PARTS)
      const { result } = await promoted(files, input)
      expect(errors(result)).toEqual([])
      const facts = await derived(files, result.record!, result.changes)
      expect(facts).toEqual({ ok: true, facts: factsOf(result.record!) })
    }
  })

  it("derives the facts in a snake_case project", async () => {
    const files = promotionProject(PARTS)
    const project = json(files, "project.meta.json")
    files.set(
      "project.meta.json",
      JSON.stringify({ ...project, naming: { attributeCase: "snake_case" } })
    )
    for (const path of [COUNTERPARTY_FILE, INVOICE_FILE]) {
      const raw = JSON.stringify(json(files, path)).replace(
        /"(isDeleted|createdAt|docDate|counterpartyId)"/g,
        (_, name: string) =>
          `"${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}"`
      )
      files.set(path, raw)
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
    const { result } = await promoted(files, input)
    expect(errors(result)).toEqual([])
    expect(result.record!.columns).toContainEqual(
      expect.objectContaining({
        id: `${COUNTERPARTY_ID}#deletionMark`,
        sourceId: COUNTERPARTY_COLUMNS.isDeleted,
        to: "deletion_mark",
      })
    )
    const facts = await derived(files, result.record!, result.changes)
    expect(facts).toEqual({ ok: true, facts: factsOf(result.record!) })
  })

  it("reports a mapping the snapshots do not bear out as a mismatch, not an exception", async () => {
    const files = promotionProject(PARTS)
    const { result } = await promoted(files, counterpartyMapping(PARTS))
    const record = structuredClone(result.record!)
    // Стандартний реквізит, якого вид не має.
    record.columns[0]!.id = `${COUNTERPARTY_ID}#nothing`
    const facts = await derived(files, record, result.changes)
    expect(facts.ok).toBe(false)
    // Виведена колонка, чий id лишився в моделі.
    const retired = structuredClone(result.record!)
    const kept = retired.columns.find(
      (c) => c.sourceId === COUNTERPARTY_COLUMNS.inn
    )!
    retired.columns = retired.columns.filter((c) => c !== kept)
    retired.retired.push({
      sourceId: kept.sourceId,
      schema: "app",
      table: "counterparties",
      column: "inn",
    })
    expect((await derived(files, retired, result.changes)).ok).toBe(false)
  })

  it("names the database objects each conversion class covers", async () => {
    const files = withCounterparty((raw) => {
      raw.comment = "Counterparties of the company"
      ;(raw.columns as Json[])[2]!.comment = "Tax number"
    })
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.columns = counterpartyMapping(NO_FILL).columns
        m.fill = []
        m.into.data = { ...m.into.data, description: { uk: "Контрагенти" } }
        ;(m.columns.inn as { element: Json }).element.description = {
          uk: "ІПН",
        }
        m.conversions["Counterparty#default/isDeleted"] = "removed"
        m.conversions["Counterparty#comment"] = "removed"
        m.conversions["Counterparty#comment/inn"] = "removed"
      })
    )
    expect(errors(result)).toEqual([])
    const at = { schema: "app", table: "counterparties" }
    expect(result.record!.conversions).toEqual([
      {
        subject: "Counterparty#comment",
        class: "removed",
        objects: [{ kind: "comment", ...at }],
      },
      {
        subject: "Counterparty#comment/inn",
        class: "removed",
        objects: [{ kind: "comment", ...at, column: "inn" }],
      },
      {
        subject: "Counterparty#default/isDeleted",
        class: "removed",
        objects: [{ kind: "default", ...at, column: "is_deleted" }],
      },
      {
        subject: "Counterparty#uniques/counterparties_inn_key",
        class: "property",
        objects: [
          { kind: "constraint", ...at, name: "counterparties_inn_key" },
        ],
      },
    ])
  })

  it("finds an unnamed unique by its content and refuses an ambiguous one", async () => {
    const one = withCounterparty((raw) => {
      ;(raw.uniques as Json[]).push({ columns: ["name"] })
    })
    const classified = mapping((m) => {
      m.conversions["Counterparty#uniques/1"] = "removed"
    })
    const { result } = await promoted(one, classified)
    expect(errors(result)).toEqual([])
    const physical = (await compile(one)).model!.physical.tables.find(
      (t) => t.name === "counterparties"
    )!
    const name = physical.uniques.find(
      (u) => u.name !== "counterparties_inn_key"
    )!.name
    expect(
      result.record!.conversions.find(
        (c) => c.subject === "Counterparty#uniques/1"
      )!.objects
    ).toEqual([
      {
        kind: "constraint",
        schema: "app",
        table: "counterparties",
        name,
      },
    ])

    const two = withCounterparty((raw) => {
      ;(raw.uniques as Json[]).push(
        { columns: ["name"] },
        { columns: ["name"] }
      )
    })
    const ambiguous = await promoted(
      two,
      mapping((m) => {
        m.conversions["Counterparty#uniques/1"] = "removed"
        m.conversions["Counterparty#uniques/2"] = "removed"
      })
    )
    expect(ambiguous.result.ok).toBe(false)
    expect(
      brief(ambiguous.result).map((d) => [d.code, d.pointer, d.params?.at])
    ).toEqual([
      [
        "promote.mapping-unknown",
        "/uniques/1",
        "/conversions/Counterparty#uniques~11",
      ],
      [
        "promote.mapping-unknown",
        "/uniques/2",
        "/conversions/Counterparty#uniques~12",
      ],
    ])
  })

  it("round-trips through the strict schema and rejects an unknown key", async () => {
    const { result } = await promoted(
      promotionProject(PARTS),
      counterpartyMapping(PARTS)
    )
    const record = result.record!
    const text = serializeCanonical(record)
    expect(text.endsWith("}\n")).toBe(true)
    expect(promotionRecordSchema.parse(JSON.parse(text))).toEqual(record)
    expect(() => promotionRecordSchema.parse({ ...record, extra: 1 })).toThrow()
    expect(() =>
      promotionRecordSchema.parse({
        ...record,
        conversions: [{ ...record.conversions[0], extra: 1 }],
      })
    ).toThrow()
  })
})

describe("promoteObject: decision 15 — NOT NULL, RLS, comments", () => {
  it("refuses a nullable source of a notNull target without fill", async () => {
    const files = promotionProject(PARTS)
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.fill = []
      })
    )
    // `DEFAULT now()` стандартної колонки наявних NULL не заповнює.
    expect(brief(result)).toEqual([
      {
        code: "promote.fill-missing",
        file: COUNTERPARTY_FILE,
        pointer: "/columns/4",
        params: {
          column: "createdAt",
          kind: "Catalog",
          name: "Counterparty",
          reason: "nullable-source",
          source: "createdAt",
        },
      },
    ])
    const required = (m: PromoteInput) => {
      m.columns.inn = {
        to: "attribute",
        collection: "attributes",
        element: { name: "taxId", required: true },
      }
    }
    const attribute = await promoted(files, mapping(required))
    expect(attribute.result.diagnostics.map((d) => d.params?.reason)).toEqual([
      "nullable-source",
    ])
    const filled = await promoted(
      files,
      mapping((m) => {
        required(m)
        m.fill.push({
          target: { to: "attribute", name: "taxId" },
          expression: "coalesce(inn, '')",
        })
      })
    )
    expect(errors(filled.result)).toEqual([])
    expect(filled.result.record?.tightened).toEqual([
      {
        schema: "app",
        table: "counterparty",
        column: "tax_id",
        constraint: "notNull",
      },
      {
        schema: "app",
        table: "counterparty",
        column: "created_at",
        constraint: "notNull",
      },
    ])
  })

  it("records RLS mode changes off and forced, not enabled", async () => {
    const enabled = await promoted(promotionProject(PARTS))
    expect(enabled.result.record?.rowLevelSecurity).toEqual([])
    for (const mode of ["off", "forced"] as const) {
      const files = withCounterparty((raw) => {
        raw.rowLevelSecurity = mode
      })
      const { result, after } = await promoted(files)
      expect(errors(result)).toEqual([])
      expect(result.record?.rowLevelSecurity).toEqual([
        { schema: "app", table: "counterparties", from: mode, to: "enabled" },
      ])
      expect(json(after, CATALOG_FILE)).not.toHaveProperty("rowLevelSecurity")
    }
  })

  it("classifies a standard-attribute column comment only as removed", async () => {
    const files = withCounterparty((raw) => {
      ;(raw.columns as Json[])[1]!.comment = "Legal name"
    })
    const subject = "Counterparty#comment/name"
    const missing = await promoted(files)
    expect(brief(missing.result)).toEqual([
      {
        code: "promote.unclassified",
        file: COUNTERPARTY_FILE,
        pointer: "/columns/1/comment",
        params: { subject },
      },
    ])
    const metadata = await promoted(
      files,
      mapping((m) => {
        m.conversions[subject] = "metadata"
      })
    )
    expect(metadata.result.diagnostics.map((d) => d.params)).toEqual([
      { subject, class: "metadata", allowed: "removed" },
    ])
    const removed = await promoted(
      files,
      mapping((m) => {
        m.conversions[subject] = "removed"
      })
    )
    expect(errors(removed.result)).toEqual([])
    expect(removed.result.record?.conversions).toContainEqual({
      subject,
      class: "removed",
      objects: [
        {
          kind: "comment",
          schema: "app",
          table: "counterparties",
          column: "name",
        },
      ],
    })
  })

  it("classifies a table comment that into.data replaces", async () => {
    const files = promotionProject(PARTS)
    const replaced = (m: PromoteInput) => {
      m.into.data = { ...m.into.data, description: { en: "Partners" } }
    }
    const { result } = await promoted(files, mapping(replaced))
    expect(
      result.diagnostics.map((d) => [d.code, d.pointer, d.params?.subject])
    ).toEqual([["promote.unclassified", "/comment", "Counterparty#comment"]])
    const same = await promoted(
      files,
      mapping((m) => {
        m.into.data = {
          ...m.into.data,
          description: { uk: "Counterparties of the company", en: "Partners" },
        }
      })
    )
    expect(errors(same.result)).toEqual([])
    const removed = await promoted(
      files,
      mapping((m) => {
        replaced(m)
        m.conversions["Counterparty#comment"] = "removed"
      })
    )
    expect(errors(removed.result)).toEqual([])
    expect(json(removed.after, CATALOG_FILE).description).toEqual({
      en: "Partners",
    })
    // Опис, що збігається з коментарем, — перенесення: клас дає `promote`
    expect(
      same.result.record!.conversions.find(
        (c) => c.subject === "Counterparty#comment"
      )?.class
    ).toBe("metadata")
    expect(
      removed.result.record!.conversions.find(
        (c) => c.subject === "Counterparty#comment"
      )?.class
    ).toBe("removed")
  })

  it("classifies an attribute column comment only when the element replaces it", async () => {
    const files = withCounterparty((raw) => {
      ;(raw.columns as Json[])[2]!.comment = "Taxpayer number"
    })
    const described = (description: Json) => (m: PromoteInput) => {
      m.columns.inn = {
        to: "attribute",
        collection: "attributes",
        element: { name: "taxId", description },
      }
    }
    const subject = "Counterparty#comment/inn"
    const replaced = await promoted(files, mapping(described({ en: "Tax id" })))
    expect(brief(replaced.result)).toEqual([
      {
        code: "promote.unclassified",
        file: COUNTERPARTY_FILE,
        pointer: "/columns/2/comment",
        params: { subject },
      },
    ])
    const removed = await promoted(
      files,
      mapping((m) => {
        described({ en: "Tax id" })(m)
        m.conversions[subject] = "removed"
      })
    )
    expect(errors(removed.result)).toEqual([])
    // Опис, що збігається з коментарем, ключа не потребує.
    const same = await promoted(
      files,
      mapping(described({ uk: "Taxpayer number", en: "Tax id" }))
    )
    expect(errors(same.result)).toEqual([])
    // Без опису коментар сам стає описом (наступний тест).
  })

  // R24 плану П3-2a: дослівно перенесений коментар таблиця виду не несе,
  // тож `promote` сам записує його клас `metadata` — без вибору людини
  it("records a verbatim comment transfer itself with class metadata", async () => {
    const files = withCounterparty((raw) => {
      ;(raw.columns as Json[])[2]!.comment = "Taxpayer number"
    })
    const { result } = await promoted(files)
    expect(errors(result)).toEqual([])
    const at = { schema: "app", table: "counterparties" }
    const comments = result.record!.conversions.filter((c) =>
      c.subject.includes("#comment")
    )
    expect(comments).toEqual([
      {
        subject: "Counterparty#comment",
        class: "metadata",
        objects: [{ kind: "comment", ...at }],
      },
      {
        subject: "Counterparty#comment/inn",
        class: "metadata",
        objects: [{ kind: "comment", ...at, column: "inn" }],
      },
    ])
  })

  it("leaves a verbatim comment transfer to promote, not to the input", async () => {
    const files = withCounterparty((raw) => {
      ;(raw.columns as Json[])[2]!.comment = "Taxpayer number"
    })
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.conversions["Counterparty#comment"] = "removed"
        m.conversions["Counterparty#comment/inn"] = "metadata"
      })
    )
    expect(result.diagnostics.map((d) => [d.code, d.params?.at])).toEqual([
      ["promote.mapping-unknown", "/conversions/Counterparty#comment"],
      ["promote.mapping-unknown", "/conversions/Counterparty#comment~1inn"],
    ])
  })

  it("carries the column title and comment into the attribute", async () => {
    const files = withCounterparty((raw) => {
      Object.assign((raw.columns as Json[])[2]!, {
        title: { en: "Tax id" },
        comment: "Taxpayer number",
      })
    })
    const { result, after } = await promoted(files)
    expect(errors(result)).toEqual([])
    expect(json(after, CATALOG_FILE).attributes).toEqual([
      expect.objectContaining({
        title: { en: "Tax id" },
        description: { uk: "Taxpayer number" },
      }),
    ])
  })
})

describe("promoteObject: foreign keys and references", () => {
  const CONTACT_MAPPING = (
    counterpartyId: PromoteInput["columns"][string]
  ): PromoteInput => ({
    ...mapping(),
    target: { name: "CounterpartyContact" },
    into: { kind: "Catalog", name: "Contact", data: { codeLength: 0 } },
    columns: {
      id: { to: "standard", name: "ref" },
      counterpartyId,
      phone: { to: "standard", name: "description" },
    },
    fill: [],
    conversions: {},
  })
  const attributeOf = (element: Json): PromoteInput["columns"][string] => ({
    to: "attribute",
    collection: "attributes",
    element,
  })

  /** Тека, де `Counterparty` уже довідник, а контакти — ще прийнята таблиця. */
  async function counterpartyPromoted() {
    const files = promotionProject({ ...PARTS, contacts: true })
    const first = await promoted(files, counterpartyMapping(PARTS))
    expect(errors(first.result)).toEqual([])
    return first.after
  }

  it("refuses a foreign key column whose element sets a non-Ref type", async () => {
    const files = await counterpartyPromoted()
    const { result } = await promoted(
      files,
      CONTACT_MAPPING(
        attributeOf({ name: "counterparty", type: "String", length: 36 })
      )
    )
    expect(
      result.diagnostics.map((d) => [d.code, d.pointer, d.params?.reason])
    ).toEqual([["promote.type-unsupported", "/columns/1", "foreignKey"]])
  })

  it("accepts an element Ref to the same target and refuses another target", async () => {
    const files = await counterpartyPromoted()
    const same = await promoted(
      files,
      CONTACT_MAPPING(
        attributeOf({
          name: "counterparty",
          type: "Ref",
          ref: { kind: "Catalog", name: "Counterparty" },
        })
      )
    )
    expect(errors(same.result)).toEqual([])
    const other = await promoted(
      files,
      CONTACT_MAPPING(
        attributeOf({
          name: "counterparty",
          type: "Ref",
          ref: { kind: "Catalog", name: "Contact" },
        })
      )
    )
    expect(other.result.diagnostics.map((d) => d.params?.reason)).toEqual([
      "foreignKey",
    ])
  })

  it("refuses an element Ref to a CustomTable outside the unit", async () => {
    const files = promotionProject(PARTS)
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.columns.inn = attributeOf({
          name: "invoice",
          type: "Ref",
          ref: { kind: "CustomTable", name: "Invoice" },
        })
      })
    )
    expect(brief(result)).toEqual([
      {
        code: "promote.reference-not-promoted",
        file: COUNTERPARTY_FILE,
        pointer: "/columns/2",
        params: { table: "Counterparty", target: "CustomTable Invoice" },
      },
    ])
  })

  it("refuses a standard attribute whose target differs from the foreign key", async () => {
    const files = await counterpartyPromoted()
    const input = CONTACT_MAPPING({ to: "standard", name: "parent" })
    input.into.data = { codeLength: 0, hierarchyType: "ItemsOnly" }
    const { result } = await promoted(files, input)
    expect(
      result.diagnostics.map((d) => [d.code, d.pointer, d.params?.reason])
    ).toEqual([["promote.type-unsupported", "/columns/1", "foreignKey"]])
  })

  it("retargets a self foreign key to the new kind", async () => {
    const files = withCounterparty((raw) => {
      ;(raw.columns as Json[]).push({
        id: uuid(7009),
        name: "parentId",
        physicalName: "parent_id",
        type: "UUID",
      })
      raw.foreignKeys = [
        {
          name: "counterparties_parent_id_fkey",
          columns: ["parentId"],
          references: {
            object: { kind: "CustomTable", name: "Counterparty" },
            columns: ["id"],
          },
        },
      ]
    })
    const asAttribute = await promoted(
      files,
      mapping((m) => {
        m.columns.parentId = attributeOf({ name: "headOffice" })
      })
    )
    expect(errors(asAttribute.result)).toEqual([])
    expect(json(asAttribute.after, CATALOG_FILE).attributes).toContainEqual(
      expect.objectContaining({
        name: "headOffice",
        type: "Ref",
        ref: { kind: "Catalog", name: "Counterparty" },
      })
    )
    const asParent = await promoted(
      files,
      mapping((m) => {
        m.into.data = { ...m.into.data, hierarchyType: "ItemsOnly" }
        m.columns.parentId = { to: "standard", name: "parent" }
      })
    )
    expect(errors(asParent.result)).toEqual([])
    expect(asParent.result.record?.columns).toContainEqual({
      id: `${COUNTERPARTY_ID}#parent`,
      sourceId: uuid(7009),
      schema: "app",
      table: "counterparty",
      from: "parent_id",
      to: "parent_id",
    })
  })
})

describe("promoteObject: cascade through subscriptions and scope kinds", () => {
  const SUBSCRIPTION =
    "event-subscriptions/OnCounterparty/OnCounterparty.meta.json"
  const subscription = (whenChanged: string[]) => ({
    id: uuid(7401),
    kind: "EventSubscription",
    name: "OnCounterparty",
    physicalName: "on_counterparty",
    sources: [{ kind: "CustomTable", name: "Counterparty" }],
    event: "onWrite",
    whenChanged,
    handler: { schema: "app", name: "on_counterparty" },
  })
  const HANDLER = {
    "sql/app/on-counterparty.sql":
      "CREATE FUNCTION app.on_counterparty() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$;",
  }

  it("rewrites a subscription source and its whenChanged columns", async () => {
    const files = promotionProject(PARTS)
    files.set(SUBSCRIPTION, JSON.stringify(subscription(["inn", "name"])))
    for (const [path, text] of Object.entries(HANDLER)) files.set(path, text)
    const { result, after } = await promoted(files)
    expect(errors(result)).toEqual([])
    expect(json(after, SUBSCRIPTION)).toMatchObject({
      sources: [{ kind: "Catalog", name: "Counterparty" }],
      whenChanged: ["taxId", "description"],
    })
  })

  /** Проєкт зі скоупом `org`, корінь якого — прийнята таблиця `Organization`. */
  function scoped(counterparty: Record<string, unknown> = {}) {
    const base = scopedProject()
    const org = base.scopeKinds[0]!
    return metaFiles({
      "project.meta.json": {
        ...base,
        scopeKinds: [
          {
            ...org,
            root: { object: { kind: "CustomTable", name: "Organization" } },
          },
        ],
      },
      "custom-tables/Organization/Organization.meta.json": {
        id: uuid(7501),
        kind: "CustomTable",
        name: "Organization",
        physicalName: "organizations",
        kindLabel: "organization",
        scope: "org",
        columns: [
          {
            id: uuid(7502),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          {
            id: uuid(7503),
            name: "title",
            physicalName: "title",
            type: "Text",
            notNull: true,
          },
        ],
        primaryKey: { columns: ["id"] },
      },
      ...counterparty,
    })
  }

  it("rewrites the root of a scope kind", async () => {
    const files = scoped()
    expect((await compile(files)).diagnostics).toEqual([])
    const { result, after } = await promoted(files, {
      ...mapping(),
      target: { name: "Organization" },
      into: { kind: "Catalog", name: "Organization", data: { codeLength: 0 } },
      columns: {
        id: { to: "standard", name: "ref" },
        title: { to: "standard", name: "description" },
      },
      fill: [],
      conversions: {},
    })
    expect(errors(result)).toEqual([])
    expect(
      (json(after, "project.meta.json").scopeKinds as Json[])[0]!.root
    ).toEqual({ object: { kind: "Catalog", name: "Organization" } })
  })

  it("refuses a nullable scope column and accepts it marked notNull", async () => {
    const files = (notNull: boolean) => {
      const counterparty = withCounterparty((raw) => {
        raw.scope = "org"
        raw.scopeColumn = "orgId"
        ;(raw.columns as Json[]).push({
          id: uuid(7010),
          name: "orgId",
          physicalName: "org_ref",
          type: "UUID",
          notNull,
        })
      })
      return scoped({
        [COUNTERPARTY_FILE]: json(counterparty, COUNTERPARTY_FILE),
      })
    }
    const scope = mapping((m) => {
      m.columns.orgId = { to: "scope" }
    })
    const nullable = files(false)
    expect((await compile(nullable)).diagnostics).toEqual([])
    const { result } = await promoted(nullable, scope)
    expect(brief(result)).toEqual([
      {
        code: "promote.type-unsupported",
        file: COUNTERPARTY_FILE,
        pointer: "/columns/5",
        params: {
          table: "Counterparty",
          column: "orgId",
          reason: "nullable-scope",
          detail: "the scope column allows NULL",
        },
      },
    ])
    expect(result.diagnostics[0]!.hint).toMatch(/notNull/)
    const ok = await promoted(files(true), scope)
    expect(errors(ok.result)).toEqual([])
  })

  it("requires the removed class for a default of the scope column", async () => {
    // Значення скоупу вид у базі не дає (R21): DEFAULT носія скоупу мапінг не
    // покриває, тож він потребує класу, і лише «видалено»
    const counterparty = withCounterparty((raw) => {
      raw.scope = "org"
      raw.scopeColumn = "orgId"
      ;(raw.columns as Json[]).push({
        id: uuid(7010),
        name: "orgId",
        physicalName: "org_ref",
        type: "UUID",
        notNull: true,
        default: "gen_random_uuid()",
      })
    })
    const files = scoped({
      [COUNTERPARTY_FILE]: json(counterparty, COUNTERPARTY_FILE),
    })
    expect((await compile(files)).diagnostics).toEqual([])
    const scope = (cls?: ConversionClass) =>
      mapping((m) => {
        m.columns.orgId = { to: "scope" }
        if (cls !== undefined) m.conversions["Counterparty#default/orgId"] = cls
      })
    const subject = "Counterparty#default/orgId"
    const missing = await promoted(files, scope())
    expect(
      missing.result.diagnostics.map((d) => [d.code, d.params?.subject])
    ).toEqual([["promote.unclassified", subject]])
    const platform = await promoted(files, scope("platform"))
    expect(
      platform.result.diagnostics.map((d) => [d.code, d.params?.allowed])
    ).toEqual([["promote.unclassified", "removed"]])
    const ok = await promoted(files, scope("removed"))
    expect(errors(ok.result)).toEqual([])
    expect(ok.result.record?.conversions).toContainEqual({
      subject,
      class: "removed",
      objects: [
        {
          kind: "default",
          schema: "app",
          table: "counterparties",
          column: "org_ref",
        },
      ],
    })
  })

  it("refuses a reference to the scope column and records the scope carrier", async () => {
    const counterparty = withCounterparty((raw) => {
      raw.scope = "org"
      raw.scopeColumn = "orgId"
      ;(raw.columns as Json[]).push({
        id: uuid(7010),
        name: "orgId",
        physicalName: "org_ref",
        type: "UUID",
        notNull: true,
      })
    })
    const files = scoped({
      [COUNTERPARTY_FILE]: json(counterparty, COUNTERPARTY_FILE),
      [SUBSCRIPTION]: subscription(["orgId"]),
      ...HANDLER,
    })
    expect((await compile(files)).diagnostics).toEqual([])
    const scope = (m: PromoteInput) => {
      m.columns.orgId = { to: "scope" }
    }
    const { result } = await promoted(files, mapping(scope))
    expect(brief(result)).toEqual([
      {
        code: "promote.retired-referenced",
        file: SUBSCRIPTION,
        pointer: "/whenChanged/0",
        params: {
          table: "Counterparty",
          column: "orgId",
          role: "eventSubscription.whenChanged",
        },
      },
    ])
    files.set(SUBSCRIPTION, JSON.stringify(subscription(["inn"])))
    const ok = await promoted(files, mapping(scope))
    expect(errors(ok.result)).toEqual([])
    const orgKindId = (
      json(files, "project.meta.json").scopeKinds as Json[]
    )[0]!.id
    expect(ok.result.record?.columns).toContainEqual({
      id: orgKindId,
      sourceId: uuid(7010),
      schema: "app",
      table: "counterparty",
      from: "org_ref",
      to: "org_id",
    })
  })
})

describe("promoteObject: tabular sections, documents, registers, data steps", () => {
  const WITH_CONTACTS = { module: false, contacts: true, invoice: false }
  const LINE_NUMBER =
    "row_number() over (partition by counterparty_id order by id)"

  /** Мапінг-зразок разом з ТЧ `contacts` з таблиці контактів. */
  const withContacts = (edit: (m: PromoteInput) => void = () => {}) =>
    mapping((m) => {
      m.tabularSections = [
        {
          table: "CounterpartyContact",
          name: "contacts",
          columns: {
            id: { to: "standard", name: "ref" },
            counterpartyId: { to: "standard", name: "parent" },
            phone: {
              to: "attribute",
              collection: "attributes",
              element: { name: "phone" },
            },
          },
        },
      ]
      m.fill.push({
        table: "CounterpartyContact",
        target: { to: "standard", name: "lineNumber" },
        expression: LINE_NUMBER,
      })
      edit(m)
    })

  /** Фікстура з правкою сирого файлу. */
  const edited = (
    files: Map<string, string>,
    path: string,
    edit: (raw: Json) => void
  ) => {
    const raw = json(files, path)
    edit(raw)
    files.set(path, JSON.stringify(raw))
    return files
  }

  /** Рахунок як документ без рухів; дата рахунку — обов'язкова. */
  const invoiceFiles = () =>
    edited(
      promotionProject({ module: false, contacts: false, invoice: true }),
      INVOICE_FILE,
      (raw) => {
        ;(raw.columns as Json[])[2]!.notNull = true
      }
    )
  const invoiceMapping = (edit: (m: Json) => void = () => {}) => {
    const raw: Json = {
      target: { name: "Invoice" },
      into: { kind: "Document", name: "Invoice" },
      columns: {
        id: { to: "standard", name: "ref" },
        number: { to: "standard", name: "number" },
        docDate: { to: "standard", name: "date" },
        status: { to: "attribute", element: { name: "status" } },
        amount: { to: "attribute", element: { name: "amount" } },
        counterpartyId: { to: "retire" },
      },
      fill: [
        {
          target: { to: "standard", name: "posted" },
          expression: "status = 'posted'",
        },
      ],
      conversions: { "Invoice#checks/invoices_status_check": "rowRule" },
    }
    edit(raw)
    return promoteInput.parse(raw)
  }

  /** Прийнята таблиця, що стає регістром відомостей. */
  const PRICE_FILE = "custom-tables/Price/Price.meta.json"
  const price = (overrides: Json = {}) => ({
    id: uuid(7301),
    kind: "CustomTable",
    name: "Price",
    physicalName: "prices",
    kindLabel: "price",
    schema: "app",
    columns: [
      {
        id: uuid(7302),
        name: "id",
        physicalName: "id",
        type: "UUID",
        notNull: true,
      },
      {
        id: uuid(7303),
        name: "item",
        physicalName: "item",
        type: "Text",
        notNull: true,
      },
      {
        id: uuid(7304),
        name: "price",
        physicalName: "price",
        type: "Numeric",
        precision: 15,
        scale: 2,
      },
    ],
    primaryKey: { name: "prices_pkey", columns: ["id"] },
    ...overrides,
  })
  const priceMapping = (data: Json = {}) =>
    promoteInput.parse({
      target: { name: "Price" },
      into: { kind: "InformationRegister", name: "Price", data },
      columns: {
        id: { to: "retire" },
        item: {
          to: "attribute",
          collection: "dimensions",
          element: { name: "item" },
        },
        price: {
          to: "attribute",
          collection: "resources",
          element: { name: "price" },
        },
      },
    })

  it("promotes a catalog with a tabular section from its CustomTable", async () => {
    const files = promotionProject(WITH_CONTACTS)
    const { result, after } = await promoted(files, withContacts())
    expect(errors(result)).toEqual([])
    expect(after.has(CONTACT_FILE)).toBe(false)
    expect(json(after, CATALOG_FILE).tabularSections).toEqual([
      expect.objectContaining({
        id: CONTACT_ID,
        name: "contacts",
        physicalName: "counterparty_contacts",
        attributes: [
          expect.objectContaining({
            id: uuid(7104),
            name: "phone",
            physicalName: "phone",
          }),
        ],
      }),
    ])
    const record = result.record!
    expect(record.tables).toContainEqual({
      id: CONTACT_ID,
      schema: "app",
      from: "counterparty_contacts",
      to: "counterparty_contacts",
    })
    expect(record.columns).toContainEqual({
      id: `${CONTACT_ID}#parent`,
      sourceId: uuid(7103),
      schema: "app",
      table: "counterparty_contacts",
      from: "counterparty_id",
      to: "parent_id",
    })
    // Нумерація рядків за власником лише впорядковує рядки: дозаповнення.
    expect(record.dataSteps.at(-1)).toEqual({
      names: "beforeRenames",
      schema: "app",
      table: "counterparty_contacts",
      key: "id",
      column: "line_number",
      expression: LINE_NUMBER,
      kind: "backfill",
    })
    // Таблиця контактів без RLS — рядки ТЧ беруть RLS власника (рішення 15).
    expect(record.rowLevelSecurity).toEqual([
      {
        schema: "app",
        table: "counterparty_contacts",
        from: "off",
        to: "enabled",
      },
    ])
    // Каскад рядка ТЧ на власника — частина виду.
    expect(record.deleteSemantics).toEqual([])
    const compiled = await compile(after, { baseline: files })
    expect(compiled.diagnostics).toEqual([])
  })

  it("promotes a document: status split into posted and an attribute", async () => {
    const { result, after } = await promoted(invoiceFiles(), invoiceMapping())
    expect(errors(result)).toEqual([])
    const document = json(after, "documents/Invoice/Invoice.meta.json")
    expect(document).toMatchObject({ id: uuid(7201), kindLabel: "invoice" })
    expect(document.attributes).toEqual([
      expect.objectContaining({ name: "status", physicalName: "status" }),
      expect.objectContaining({ name: "amount", physicalName: "amount" }),
    ])
    expect(
      result.record?.dataSteps.map(({ column, kind }) => ({ column, kind }))
    ).toEqual([{ column: "posted", kind: "split" }])
  })

  it("records a conversion when the source column is retired", async () => {
    const { result } = await promoted(
      invoiceFiles(),
      invoiceMapping((m) => {
        ;(m.columns as Json).status = { to: "retire" }
      })
    )
    expect(errors(result)).toEqual([])
    expect(result.record?.dataSteps.map((s) => s.kind)).toEqual(["conversion"])
    expect(result.record?.retired).toContainEqual({
      sourceId: uuid(7205),
      schema: "app",
      table: "invoices",
      column: "status",
    })
  })

  it("records a repair on a mapped column", async () => {
    const files = promotionProject(PARTS)
    const { result } = await promoted(
      files,
      mapping((m) => {
        m.fill.push({
          target: { to: "standard", name: "description" },
          expression: "left(name, 150)",
        })
      })
    )
    expect(errors(result)).toEqual([])
    expect(
      result.record?.dataSteps.find((s) => s.column === "description")?.kind
    ).toBe("repair")
  })

  const label = (m: PromoteInput) => {
    m.into.data = {
      ...m.into.data,
      attributes: [{ name: "label", type: "Text" }],
    }
  }
  it.each([
    [
      "mapped target that rewrites its values",
      "description",
      "coalesce(inn, name)",
      "repair",
    ],
    [
      "mapped target that keeps its values and falls back to a retired column",
      "description",
      "coalesce(name, inn)",
      "conversion",
    ],
    ["reads a retired and a kept column", "label", "name || inn", "conversion"],
    ["reads only a kept column", "label", "upper(name)", "split"],
    ["reads no column", "label", "'unnamed'", "backfill"],
  ])(
    "orders step kinds by priority: %s",
    async (_, target, expression, kind) => {
      const files = promotionProject(PARTS)
      const { result } = await promoted(
        files,
        mapping((m) => {
          label(m)
          m.columns.inn = { to: "retire" }
          m.fill.push({
            target:
              target === "label"
                ? { to: "attribute", name: target }
                : { to: "standard", name: target },
            expression,
          })
        })
      )
      expect(errors(result)).toEqual([])
      expect(
        result.record?.dataSteps.find((s) => s.expression === expression)
      ).toMatchObject({ column: target, kind })
    }
  )

  it("refuses a reference to a tabular section table from inside the unit as unit-unsupported", async () => {
    const files = edited(
      promotionProject(WITH_CONTACTS),
      CONTACT_FILE,
      (raw) => {
        ;(raw.columns as Json[]).push({
          id: uuid(7602),
          name: "altId",
          physicalName: "alt_id",
          type: "UUID",
        })
        ;(raw.foreignKeys as Json[]).push({
          name: "alt_fk",
          columns: ["altId"],
          references: {
            object: { kind: "CustomTable", name: "CounterpartyContact" },
            columns: ["id"],
          },
        })
      }
    )
    const { result, after } = await promoted(
      files,
      withContacts((m) => {
        m.tabularSections[0]!.columns.altId = {
          to: "attribute",
          collection: "attributes",
          element: { name: "alt" },
        }
      })
    )
    expect(after).toEqual(files)
    expect(brief(result)).toEqual([
      {
        code: "promote.unit-unsupported",
        file: CONTACT_FILE,
        pointer: expect.any(String),
        params: {
          kind: "CustomTable",
          name: "CounterpartyContact",
          detail: expect.stringContaining("becomes a tabular section"),
        },
      },
    ])
  })

  it("records steps in old names before renames", async () => {
    const { result } = await promoted(invoiceFiles(), invoiceMapping())
    expect(result.record?.dataSteps[0]).toEqual({
      names: "beforeRenames",
      schema: "app",
      table: "invoices",
      key: "id",
      column: "posted",
      expression: "status = 'posted'",
      kind: "split",
    })
  })

  it("refuses a missing fill for a NOT NULL standard column without default", async () => {
    // Номер документа nullable (реєстр видів); NOT NULL без значення — дата.
    const { result } = await promoted(
      invoiceFiles(),
      invoiceMapping((m) => {
        ;(m.columns as Json).docDate = { to: "retire" }
      })
    )
    expect(brief(result)).toEqual([
      {
        code: "promote.fill-missing",
        file: INVOICE_FILE,
        pointer: "",
        params: {
          column: "date",
          kind: "Document",
          name: "Invoice",
          reason: "unmapped",
        },
      },
    ])
  })

  it("records a NULL fill and a tightened column for a nullable source", async () => {
    const { result } = await promoted(promotionProject(PARTS))
    expect(errors(result)).toEqual([])
    expect(result.record?.dataSteps).toEqual([
      {
        names: "beforeRenames",
        schema: "app",
        table: "counterparties",
        key: "id",
        column: "created_at",
        expression: CREATED_AT_FILL,
        kind: "backfill",
      },
    ])
    expect(result.record?.tightened).toEqual([
      {
        schema: "app",
        table: "counterparty",
        column: "created_at",
        constraint: "notNull",
      },
    ])
  })

  it.each([
    ["(select 1)", "subquery"],
    ["1 union select 2", "subquery"],
    ["count(*)", "aggregate"],
    ["json_arrayagg(phone)", "aggregate"],
    ["other.x", "foreignTable"],
    ["1, 2", "multipleTargets"],
    ["1; select 2", "multipleStatements"],
    ["generate_series(1, 2)", "setReturning"],
    ["random()", "volatile"],
    [
      "row_number() over (partition by counterparty_id)",
      "nondeterministicWindow",
    ],
    [
      "json_arrayagg(phone) over (partition by counterparty_id)",
      "nondeterministicWindow",
    ],
    ["missing_column", "unknownColumn"],
    ["1 as n", "syntax"],
    ["(1", "syntax"],
    // Недоведене детерміноване: поза знімком IMMUTABLE-функцій каталогу
    // (`length` теж — перевантаження `length(bytea, name)` STABLE).
    ["length(phone)", "unknownFunction"],
    ["uuid_generate_v1()", "unknownFunction"],
    ["extensions.uuid_generate_v4()", "volatile"],
    ["txid_current()", "unknownFunction"],
    ["currval('s')", "unknownFunction"],
    ["setseed(0.1)", "unknownFunction"],
    ["pg_sleep(1)", "unknownFunction"],
    ["pg_ls_dir('.')", "unknownFunction"],
    ["query_to_xml('select 1', true, true, '')", "unknownFunction"],
    [
      "table_to_xml('app.counterparty_contacts', true, true, '')",
      "unknownFunction",
    ],
    ["age(phone::timestamptz)", "unknownFunction"],
    ["current_user", "unknownFunction"],
  ])("refuses fill expression %s", async (expression, reason) => {
    const files = promotionProject(WITH_CONTACTS)
    const { result, after } = await promoted(
      files,
      withContacts((m) => {
        m.fill.at(-1)!.expression = expression
      })
    )
    expect(brief(result)).toEqual([
      {
        code: "promote.expression-invalid",
        file: "",
        pointer: "",
        params: { at: "/fill/1/expression", expression, reason },
      },
    ])
    expect(after).toEqual(files)
  })

  it.each([
    "char_length(left(phone, 3))",
    "coalesce(char_length(phone), 0)",
    "row_number() over (order by id)",
    "sum(char_length(phone)) over (order by id)",
    "'2024-01-01'::timestamptz",
    "now()",
  ])("accepts fill expression %s", async (expression) => {
    const files = promotionProject(WITH_CONTACTS)
    const { result } = await promoted(
      files,
      withContacts((m) => {
        m.fill.at(-1)!.expression = expression
      })
    )
    expect(errors(result)).toEqual([])
  })

  it("calls only model functions declared IMMUTABLE", async () => {
    const reasons = async (declaration: string, call = "app.next_line") => {
      const files = promotionProject(WITH_CONTACTS)
      files.set(
        "sql/app/next_line.sql",
        `CREATE FUNCTION app.next_line(p text) RETURNS integer LANGUAGE sql ${declaration} AS $$ SELECT char_length(p) $$;`
      )
      // Функція без позначки — не закрита оболонка, лише борг.
      if (declaration === "") {
        files.set(
          "sql-debt.json",
          JSON.stringify({ units: ["function:app.next_line(text)"] })
        )
      }
      const { result } = await promoted(
        files,
        withContacts((m) => {
          m.fill.at(-1)!.expression = `${call}(phone)`
        })
      )
      return result.diagnostics.map((d) => d.params?.reason ?? d.code)
    }
    expect(await reasons("IMMUTABLE")).toEqual([])
    // Крок даних іде з `search_path = pg_catalog, pg_temp`: голе ім'я —
    // функція каталогу, тож функцію моделі кличуть кваліфікованою.
    expect(await reasons("IMMUTABLE", "next_line")).toEqual([
      "unqualifiedFunction",
    ])
    for (const declaration of ["STABLE", "VOLATILE", ""]) {
      expect(await reasons(declaration), declaration).toEqual([
        "unknownFunction",
      ])
    }
  })

  it("orders by the window key without reading it, and reads window arguments", async () => {
    const kindOf = async (expression: string, retirePhone = false) => {
      const files = promotionProject(WITH_CONTACTS)
      const { result } = await promoted(
        files,
        withContacts((m) => {
          if (retirePhone)
            m.tabularSections[0]!.columns.phone = { to: "retire" }
          m.fill.at(-1)!.expression = expression
        })
      )
      expect(errors(result)).toEqual([])
      return result.record?.dataSteps.at(-1)?.kind
    }
    expect(
      await kindOf("row_number() over (partition by phone order by id)")
    ).toBe("backfill")
    // Виведена колонка в ключі вікна лише впорядковує рядки.
    expect(
      await kindOf("row_number() over (partition by phone order by id)", true)
    ).toBe("backfill")
    expect(await kindOf("char_length(lag(phone) over (order by id))")).toBe(
      "split"
    )
  })

  it.each([
    ["coalesce(created_at, now())", "backfill"],
    ["coalesce(created_at, current_timestamp)", "backfill"],
    ["coalesce(counterparties.created_at, 'now')", "backfill"],
    [
      "coalesce(app.counterparties.created_at, lower('now')::timestamptz)",
      "backfill",
    ],
    ["coalesce(created_at, updated_at)", "split"],
    ["coalesce(created_at, inn::timestamptz)", "conversion"],
  ])(
    "derives the kind of %s on a mapped target from the NULL fallback",
    async (expression, kind) => {
      const files = withCounterparty((raw) => {
        ;(raw.columns as Json[]).push({
          id: uuid(7601),
          name: "updatedAt",
          physicalName: "updated_at",
          type: "DateTime",
        })
      })
      const { result } = await promoted(
        files,
        mapping((m) => {
          m.columns.inn = { to: "retire" }
          ;(m.columns as Json).updatedAt = {
            to: "attribute",
            collection: "attributes",
            element: { name: "lastChange" },
          }
          m.fill[0]!.expression = expression
        })
      )
      expect(errors(result)).toEqual([])
      expect(
        result.record?.dataSteps.find((s) => s.column === "created_at")?.kind
      ).toBe(kind)
    }
  )

  it("refuses transaction time in a repair but allows it in a backfill", async () => {
    const files = promotionProject(PARTS)
    const reason = async (expression: string) =>
      (
        await promoted(
          files,
          mapping((m) => {
            m.fill[0]!.expression = expression
          })
        )
      ).result.diagnostics.map((d) => d.params?.reason)
    for (const expression of [
      "coalesce(now(), created_at)",
      "coalesce(created_at + interval '0', now())",
      "coalesce(current_timestamp, created_at)",
      "coalesce(created_at, created_at, now())",
    ]) {
      expect(await reason(expression), expression).toEqual(["volatile"])
    }
    for (const expression of [
      "coalesce('now'::timestamptz, created_at)",
      "coalesce(CAST(' Today ' AS date), created_at)",
    ]) {
      expect(await reason(expression), expression).toEqual([
        "specialTimeLiteral",
      ])
    }
    const backfill = await promoted(
      files,
      mapping((m) => {
        label(m)
        m.fill.push({
          target: { to: "attribute", name: "label" },
          expression: "now()::text",
        })
      })
    )
    expect(errors(backfill.result)).toEqual([])
    expect(
      backfill.result.record?.dataSteps.find((s) => s.column === "label")?.kind
    ).toBe("backfill")
  })

  it("refuses a cast of a non-literal to a date or time type in a repair", async () => {
    const files = promotionProject(PARTS)
    const reason = async (expression: string) =>
      (
        await promoted(
          files,
          mapping((m) => {
            m.fill[0]!.expression = expression
          })
        )
      ).result.diagnostics.map((d) => d.params?.reason)
    for (const expression of [
      "coalesce(('n' || 'ow')::timestamptz, created_at)",
      `coalesce(json_value(name, '$' returning timestamptz), created_at)`,
      "coalesce(CAST(created_at::text AS timestamptz), created_at)",
    ]) {
      expect(await reason(expression), expression).toEqual(["castToTime"])
    }
    // Рядок `'now'` будь-де у виразі — час транзакції, навіть без явного
    // приведення: невідомий літерал бере тип колонки.
    for (const expression of [
      "coalesce(lower('now')::timestamptz, created_at)",
      `coalesce(json_value('"now"', '$' returning timestamptz), created_at)`,
      "coalesce('now', created_at)",
      "coalesce('Yesterday 10:00', created_at)",
    ]) {
      expect(await reason(expression), expression).toEqual([
        "specialTimeLiteral",
      ])
    }
    for (const expression of [
      "coalesce('2024-01-01'::timestamptz, created_at)",
      "coalesce(timestamptz '2024-01-01', created_at)",
      "coalesce('2024-01-01'::text::timestamptz, created_at)",
      "coalesce(NULL::timestamptz, created_at)",
    ]) {
      expect(await reason(expression), expression).toEqual([])
    }
  })

  it("refuses a fill on a table without a single-column key", async () => {
    const files = metaFiles({
      "project.meta.json": project(),
      "custom-tables/Rate/Rate.meta.json": {
        id: uuid(7311),
        kind: "CustomTable",
        name: "Rate",
        physicalName: "rates",
        schema: "app",
        columns: [
          {
            id: uuid(7312),
            name: "currency",
            physicalName: "currency",
            type: "Text",
            notNull: true,
          },
          {
            id: uuid(7313),
            name: "day",
            physicalName: "day",
            type: "Date",
            notNull: true,
          },
          {
            id: uuid(7314),
            name: "rate",
            physicalName: "rate",
            type: "Numeric",
            precision: 15,
            scale: 4,
          },
        ],
        primaryKey: { name: "rates_pkey", columns: ["currency", "day"] },
      },
    })
    const { result } = await promoted(
      files,
      promoteInput.parse({
        target: { name: "Rate" },
        into: { kind: "InformationRegister", name: "Rate" },
        columns: {
          currency: {
            to: "attribute",
            collection: "dimensions",
            element: { name: "currency" },
          },
          day: {
            to: "attribute",
            collection: "dimensions",
            element: { name: "day" },
          },
          rate: {
            to: "attribute",
            collection: "resources",
            element: { name: "rate", required: true },
          },
        },
        fill: [
          {
            target: { to: "attribute", name: "rate" },
            expression: "coalesce(rate, 0)",
          },
        ],
      })
    )
    expect(result.diagnostics.map((d) => [d.code, d.params?.reason])).toEqual([
      ["promote.expression-invalid", "noKey"],
    ])
  })

  it("promotes an independent information register and drops the label", async () => {
    const files = metaFiles({
      "project.meta.json": project(),
      [PRICE_FILE]: price(),
    })
    const { result, after } = await promoted(files, priceMapping())
    expect(errors(result)).toEqual([])
    const register = json(after, "information-registers/Price/Price.meta.json")
    expect(register).not.toHaveProperty("kindLabel")
    expect(register).toMatchObject({
      id: uuid(7301),
      dimensions: [
        expect.objectContaining({ id: uuid(7303), name: "item", type: "Text" }),
      ],
      resources: [
        expect.objectContaining({
          id: uuid(7304),
          name: "price",
          type: "Numeric",
        }),
      ],
    })
    expect(result.record).toMatchObject({
      kind: "InformationRegister",
      labelDropped: true,
      retired: [{ schema: "app", table: "prices", column: "id" }],
    })
    expect(result.record).not.toHaveProperty("kindLabel")
    const compiled = await compile(after, { baseline: files })
    expect(compiled.diagnostics).toEqual([])
  })

  it("refuses an information register target that a polymorphic Ref points to", async () => {
    const holder = catalog("Holder", {
      attributes: [
        attribute("subject", {
          type: "Ref",
          allowedTypes: [
            { kind: "CustomTable", name: "Price" },
            { kind: "Catalog", name: "Holder" },
          ],
        }),
      ],
    })
    const files = metaFiles({
      "project.meta.json": project(),
      [PRICE_FILE]: price(),
      "catalogs/Holder/Holder.meta.json": holder,
    })
    expect((await compile(files)).diagnostics).toEqual([])
    const { result, after } = await promoted(files, priceMapping())
    expect(brief(result)).toEqual([
      {
        code: "promote.label-target",
        file: PRICE_FILE,
        pointer: "",
        params: { kind: "InformationRegister", name: "Price" },
      },
    ])
    expect(after).toEqual(files)
  })

  // Колонка прийнятої таблиці пари ще не має, але промоція таблиці зробить
  // її парою — мітка цілі мусить уціліти.
  it("refuses an information register target that only an accepted-table column points to", async () => {
    const links = customTable("Links", {
      columns: [
        {
          id: uuid(7350),
          name: "id",
          physicalName: "id",
          type: "UUID",
          notNull: true,
        },
        {
          id: uuid(7351),
          name: "target",
          physicalName: "target",
          type: "Ref",
          allowedTypes: [{ kind: "CustomTable", name: "Price" }],
        },
      ],
    })
    const files = metaFiles({
      "project.meta.json": project(),
      [PRICE_FILE]: price(),
      "custom-tables/Links/Links.meta.json": links,
    })
    expect((await compile(files)).diagnostics).toEqual([])
    const { result, after } = await promoted(files, priceMapping())
    expect(brief(result)).toEqual([
      {
        code: "promote.label-target",
        file: PRICE_FILE,
        pointer: "",
        params: { kind: "InformationRegister", name: "Price" },
      },
    ])
    expect(after).toEqual(files)
  })

  it("refuses a document with posting, a recorder-subordinate register and an accumulation register", async () => {
    const posting = await promoted(
      invoiceFiles(),
      invoiceMapping((m) => {
        ;(m.into as Json).data = { posting: { movements: [] } }
      })
    )
    const priceFiles = metaFiles({
      "project.meta.json": project(),
      [PRICE_FILE]: price(),
    })
    const subordinate = await promoted(
      priceFiles,
      priceMapping({ writeMode: "RecorderSubordinate" })
    )
    const accumulation = priceMapping()
    // Схема входу не пропускає регістр накопичення; гейт тримає реєстр видів.
    ;(accumulation.into as { kind: string }).kind = "AccumulationRegister"
    const balance = await promoted(priceFiles, accumulation)
    for (const { result } of [posting, subordinate, balance]) {
      expect(result.diagnostics.map((d) => d.code)).toEqual([
        "promote.unit-unsupported",
      ])
      expect(result.changes).toEqual([])
    }
    expect(posting.result.diagnostics[0]!.params).toMatchObject({
      detail: "it writes register movements",
    })
    expect(subordinate.result.diagnostics[0]!.params).toMatchObject({
      detail: "its records are written by a recorder",
    })
  })

  it("refuses tabular sections for a kind without them", async () => {
    const files = metaFiles({
      "project.meta.json": project(),
      [PRICE_FILE]: price(),
    })
    const input = priceMapping()
    input.tabularSections = [{ table: "Price", name: "rows", columns: {} }]
    const { result } = await promoted(files, input)
    expect(result.diagnostics.map((d) => [d.code, d.params?.detail])).toEqual([
      ["promote.unit-unsupported", "the kind has no tabular sections"],
    ])
  })

  it("refuses a reference to a CustomTable outside the unit", async () => {
    const { result } = await promoted(
      invoiceFiles(),
      invoiceMapping((m) => {
        ;(m.columns as Json).counterpartyId = {
          to: "attribute",
          element: { name: "counterparty" },
        }
      })
    )
    expect(brief(result)).toEqual([
      {
        code: "promote.reference-not-promoted",
        file: INVOICE_FILE,
        pointer: "/columns/5",
        params: { table: "Invoice", target: "CustomTable Counterparty" },
      },
    ])
  })

  it("refuses a reference to a tabular section table from outside the unit", async () => {
    const files = promotionProject(WITH_CONTACTS)
    files.set(
      "custom-tables/Call/Call.meta.json",
      JSON.stringify({
        id: uuid(7501),
        kind: "CustomTable",
        name: "Call",
        physicalName: "calls",
        kindLabel: "call",
        schema: "app",
        columns: [
          {
            id: uuid(7502),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          {
            id: uuid(7503),
            name: "contactId",
            physicalName: "contact_id",
            type: "UUID",
          },
        ],
        primaryKey: { name: "calls_pkey", columns: ["id"] },
        foreignKeys: [
          {
            name: "calls_contact_id_fkey",
            columns: ["contactId"],
            references: {
              object: { kind: "CustomTable", name: "CounterpartyContact" },
              columns: ["id"],
            },
          },
        ],
      })
    )
    const { result } = await promoted(files, withContacts())
    expect(brief(result)).toEqual([
      {
        code: "promote.unit-unsupported",
        file: "custom-tables/Call/Call.meta.json",
        pointer: "/foreignKeys/0/references/object",
        params: {
          kind: "CustomTable",
          name: "CounterpartyContact",
          detail:
            "it becomes a tabular section, and this customTable.foreignKey references it as an object",
        },
      },
    ])
  })

  it("refuses a fill step naming a table or a target outside the unit", async () => {
    const files = promotionProject(WITH_CONTACTS)
    const { result } = await promoted(
      files,
      withContacts((m) => {
        m.fill.push(
          {
            table: "Invoice",
            target: { to: "standard", name: "lineNumber" },
            expression: "1",
          },
          {
            target: { to: "attribute", name: "nothing" },
            expression: "1",
          }
        )
      })
    )
    expect(result.diagnostics.map((d) => [d.code, d.params?.at])).toEqual([
      ["promote.mapping-unknown", "/fill/2/table"],
      ["promote.mapping-unknown", "/fill/3/target/name"],
    ])
  })

  it("refuses a fill step on the key, mapped or not", async () => {
    const files = promotionProject(WITH_CONTACTS)
    const { result } = await promoted(
      files,
      withContacts((m) => {
        m.fill.push(
          { target: { to: "standard", name: "ref" }, expression: "id" },
          {
            table: "CounterpartyContact",
            target: { to: "standard", name: "ref" },
            expression: "id",
          }
        )
      })
    )
    expect(result.diagnostics.map((d) => [d.code, d.params?.at])).toEqual([
      ["promote.mapping-unknown", "/fill/2/target/name"],
      ["promote.mapping-unknown", "/fill/3/target/name"],
    ])
  })

  it("refuses a new required attribute without defaultValue or fill", async () => {
    const files = promotionProject(WITH_CONTACTS)
    const required = { name: "rank", type: "Integer", required: true }
    const input = (edit: (m: PromoteInput) => void) =>
      withContacts((m) => {
        m.into.data = { ...m.into.data, attributes: [required] }
        m.tabularSections[0]!.data = { attributes: [required] }
        edit(m)
      })
    const missing = await promoted(
      files,
      input(() => {})
    )
    expect(brief(missing.result)).toEqual(
      [COUNTERPARTY_FILE, CONTACT_FILE].map((file) => ({
        code: "promote.fill-missing",
        file,
        pointer: "",
        params: {
          column: "rank",
          kind: "Catalog",
          name: "Counterparty",
          reason: "new-attribute",
        },
      }))
    )
    const supplied = await promoted(
      files,
      input((m) => {
        m.into.data = {
          ...m.into.data,
          attributes: [{ ...required, defaultValue: 0 }],
        }
        m.fill.push({
          table: "CounterpartyContact",
          target: { to: "attribute", name: "rank" },
          expression: "0",
        })
      })
    )
    expect(errors(supplied.result)).toEqual([])
    expect(supplied.result.record?.dataSteps.at(-1)).toMatchObject({
      table: "counterparty_contacts",
      column: "rank",
      kind: "backfill",
    })
  })

  it("refuses a section table whose scope differs from the object's", async () => {
    // Колонка власника без FK: скоуп рядка нічим не пов'язаний з власником.
    const base = promotionProject(WITH_CONTACTS)
    const counterparty = json(base, COUNTERPARTY_FILE)
    counterparty.scope = "org"
    counterparty.scopeColumn = "orgId"
    ;(counterparty.columns as Json[]).push({
      id: uuid(7010),
      name: "orgId",
      physicalName: "org_ref",
      type: "UUID",
      notNull: true,
    })
    const contact = json(base, CONTACT_FILE)
    contact.foreignKeys = []
    contact.scope = "none"
    const files = metaFiles({
      "project.meta.json": scopedProject(),
      "catalogs/Organization/Organization.meta.json": catalog("Organization", {
        scope: "org",
      }),
      [COUNTERPARTY_FILE]: counterparty,
      [CONTACT_FILE]: contact,
    })
    expect((await compile(files)).diagnostics).toEqual([])
    const input = withContacts((m) => {
      m.columns.orgId = { to: "scope" }
    })
    const { result } = await promoted(files, input)
    expect(brief(result)).toEqual([
      {
        code: "promote.unit-unsupported",
        file: CONTACT_FILE,
        pointer: "",
        params: {
          kind: "CustomTable",
          name: "CounterpartyContact",
          detail:
            "its scope none differs from scope org of the object, and tabular section rows take the object's scope",
        },
      },
    ])
    // Той самий скоуп з колонкою скоупу ТЧ: рядок отримує FK на власника.
    contact.scope = "org"
    contact.scopeColumn = "orgId"
    ;(contact.columns as Json[]).push({
      id: uuid(7110),
      name: "orgId",
      physicalName: "org_ref",
      type: "UUID",
      notNull: true,
    })
    files.set(CONTACT_FILE, JSON.stringify(contact))
    const same = await promoted(
      files,
      withContacts((m) => {
        m.columns.orgId = { to: "scope" }
        m.tabularSections[0]!.columns.orgId = { to: "scope" }
      })
    )
    expect(errors(same.result)).toEqual([])
    expect(same.result.record?.deleteSemantics).toEqual([
      expect.objectContaining({
        direction: "own",
        table: "counterparty_contacts",
        columns: ["org_id", "parent_id"],
        from: "none",
        to: "cascade",
      }),
    ])
  })

  it("records a CASCADE foreign key changed to restrict", async () => {
    const files = promotionProject(WITH_CONTACTS)
    const first = await promoted(files, counterpartyMapping(PARTS))
    expect(errors(first.result)).toEqual([])
    const { result } = await promoted(first.after, {
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
      fill: [],
    })
    expect(errors(result)).toEqual([])
    expect(result.record?.deleteSemantics).toEqual([
      {
        direction: "own",
        schema: "app",
        table: "contact",
        constraint: expect.any(String),
        columns: ["counterparty_id"],
        target: "counterparty",
        from: "cascade",
        to: "noAction",
      },
    ])
  })

  it("records a tabular section adopted with NO ACTION gaining the kind's cascade", async () => {
    const files = edited(
      promotionProject(WITH_CONTACTS),
      CONTACT_FILE,
      (raw) => {
        delete (raw.foreignKeys as Json[])[0]!.onDelete
      }
    )
    const { result } = await promoted(files, withContacts())
    expect(errors(result)).toEqual([])
    expect(result.record?.deleteSemantics).toEqual([
      {
        direction: "own",
        schema: "app",
        table: "counterparty_contacts",
        constraint: expect.any(String),
        columns: ["parent_id"],
        target: "counterparty",
        from: "noAction",
        to: "cascade",
      },
    ])
  })

  it("records an incoming CASCADE from a table that stays CustomTable", async () => {
    const files = promotionProject(WITH_CONTACTS)
    const { result } = await promoted(files, counterpartyMapping(PARTS))
    expect(errors(result)).toEqual([])
    expect(result.record?.deleteSemantics).toEqual([
      {
        direction: "incoming",
        schema: "app",
        table: "counterparty_contacts",
        constraint: "counterparty_contacts_counterparty_id_fkey",
        columns: ["counterparty_id"],
        target: "counterparty",
        from: "cascade",
        to: "cascade",
      },
    ])
  })
})
