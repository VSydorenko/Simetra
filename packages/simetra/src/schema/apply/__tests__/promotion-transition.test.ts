import { describe, expect, it } from "vitest"
import {
  applyChanges,
  canonicalSnapshot,
  compile,
  promoteInput,
  promoteObject,
  promotionRecordHash,
  type CompiledModel,
  type PromoteInput,
  type PromotionRecord,
  type SchemaPathResolver,
} from "simetra/compiler"
import {
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  promotionTransition,
  tableKey,
  type ApplyState,
  type FingerprintSection,
  type PromotionInput,
  type TransitionVerdict,
} from "simetra/schema"
import {
  CATALOG_FILE,
  CONTACT_FILE,
  CONTACT_ID,
  COUNTERPARTY_FILE,
  COUNTERPARTY_ID,
  INN_ID,
  counterpartyMapping,
  promotionProject,
} from "../../../compiler/__tests__/fixtures/promotion"
import { uuid } from "../../../compiler/__tests__/helpers"

/**
 * Виявлення переходу й звірка запису (рішення 1 плану П3-2a): кожен рядок
 * таблиці рішень — окремий тест. Marker — канонічний знімок компіляції
 * «до», пропущений через JSON, як його повертає `jsonb`.
 */

type Json = Record<string, unknown>

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

function completion() {
  let n = 900_000
  return { schemaPath, newId: () => uuid(++n) }
}

const PARTS = { module: false, contacts: false, invoice: false }
const NO_FILL = { ...PARTS, fill: false }
const FILE = `plans/${COUNTERPARTY_ID}.promotion.json`

async function compiled(files: ReadonlyMap<string, string>) {
  const result = await compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

function edit(
  files: Map<string, string>,
  path: string,
  change: (raw: Json) => void
): Map<string, string> {
  const raw = JSON.parse(files.get(path)!) as Json
  change(raw)
  files.set(path, JSON.stringify(raw))
  return files
}

interface Promoted {
  before: CompiledModel
  after: CompiledModel
  afterFiles: Map<string, string>
  record: PromotionRecord
}

/** Промоція фікстури: моделі до й після й запис. */
async function promoted(
  files: Map<string, string>,
  input: PromoteInput
): Promise<Promoted> {
  const before = await compiled(files)
  const result = await promoteObject(files, input, completion())
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const afterFiles = applyChanges(files, result.changes)
  return {
    before,
    after: await compiled(afterFiles),
    afterFiles,
    record: result.record!,
  }
}

const counterparty = () =>
  promoted(promotionProject(PARTS), counterpartyMapping(NO_FILL))

/** Промоція `Counterparty` з ТЧ `contacts` з таблиці контактів, без кроків даних. */
async function withContacts(): Promise<Promoted> {
  const files = edit(
    promotionProject({ ...PARTS, contacts: true }),
    CONTACT_FILE,
    (raw) => {
      ;(raw.columns as Json[]).push({
        id: uuid(7105),
        name: "lineNumber",
        physicalName: "line_number",
        type: "Integer",
        notNull: true,
      })
    }
  )
  const mapping = structuredClone(counterpartyMapping(NO_FILL))
  mapping.tabularSections = [
    {
      table: "CounterpartyContact",
      name: "contacts",
      columns: {
        id: { to: "standard", name: "ref" },
        counterpartyId: { to: "standard", name: "parent" },
        lineNumber: { to: "standard", name: "lineNumber" },
        phone: {
          to: "attribute",
          collection: "attributes",
          element: { name: "phone" },
        },
      },
    },
  ]
  return promoted(files, mapping)
}

/** Стан цілі, застосованої до моделі `model`. */
function applied(model: CompiledModel): ApplyState {
  return {
    status: "applied",
    marker: {
      format: 1,
      snapshotHash: model.hash,
      snapshot: JSON.parse(JSON.stringify(canonicalSnapshot(model))),
      scope: { schemas: ["app", "simetra"], provider: "supabase" },
      catalog: { tables: [], enumTypes: [], units: [] },
      engine: { name: "pg-delta", version: "test" },
      fingerprint: {
        version: FINGERPRINT_VERSION,
        sections: Object.fromEntries(
          FINGERPRINT_SECTIONS.map((s) => [s, s])
        ) as Record<FingerprintSection, string>,
      },
      platformVersion: "test",
      planHash: "p".repeat(64),
    },
  }
}

const input = (record: PromotionRecord, file = FILE): PromotionInput => ({
  record,
  file,
})

function transition(p: {
  state: ApplyState
  model: CompiledModel
  records?: readonly PromotionInput[]
  appliedHashes?: ReadonlySet<string>
  liveTables?: ReadonlySet<string>
}): Promise<TransitionVerdict> {
  return promotionTransition({
    records: [],
    appliedHashes: new Set(),
    liveTables: new Set(),
    ...p,
  })
}

const codes = (verdict: TransitionVerdict) =>
  verdict.diagnostics.map((d) => [d.code, d.severity])

describe("promotionTransition: the decision table", () => {
  it("1 refuses a transition without a record", async () => {
    const { before, after } = await counterparty()
    const verdict = await transition({ state: applied(before), model: after })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([["plan.promotion-record-missing", "error"]])
    expect(verdict.diagnostics[0]!.params).toMatchObject({
      objectId: COUNTERPARTY_ID,
      kind: "Catalog",
      name: "Counterparty",
    })
  })

  it("2 refuses a record from another base", async () => {
    const { before, after, record } = await counterparty()
    const verdict = await transition({
      state: applied(before),
      model: after,
      records: [input({ ...record, base: "b".repeat(64) })],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([["plan.promotion-base", "error"]])
    expect(verdict.diagnostics[0]!.params).toMatchObject({
      file: FILE,
      base: "b".repeat(64),
      marker: before.hash,
    })
  })

  it("3 refuses facts that differ", async () => {
    const { before, after, record } = await counterparty()
    const changed = structuredClone(record)
    changed.columns[0]!.to = "renamed"
    const verdict = await transition({
      state: applied(before),
      model: after,
      records: [input(changed)],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([
      ["plan.promotion-record-mismatch", "error"],
    ])
    expect(verdict.diagnostics[0]!.params?.detail).toContain("columns[0]")
    expect(verdict.diagnostics[0]!.params?.detail).toContain("renamed")
  })

  it("3 refuses when a later commit removed a mapped attribute", async () => {
    const { before, afterFiles, record } = await counterparty()
    const later = await compiled(
      edit(afterFiles, CATALOG_FILE, (raw) => {
        raw.attributes = (raw.attributes as Json[]).filter(
          (a) => a.id !== INN_ID
        )
      })
    )
    const verdict = await transition({
      state: applied(before),
      model: later,
      records: [input(record)],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([
      ["plan.promotion-record-mismatch", "error"],
    ])
    expect(verdict.diagnostics[0]!.params?.detail).toContain(INN_ID)
  })

  it("3 refuses a mapping that contradicts identity", async () => {
    const { before, after, record } = await counterparty()
    const changed = structuredClone(record)
    // Власний реквізит зберігає id колонки: інший наступник — не той реквізит.
    const own = changed.columns.find((c) => c.sourceId === INN_ID)!
    own.id = uuid(7999)
    const verdict = await transition({
      state: applied(before),
      model: after,
      records: [input(changed)],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([
      ["plan.promotion-record-mismatch", "error"],
    ])
  })

  it("3 refuses a record that omits a tabular section table", async () => {
    const { before, after, record } = await withContacts()
    // Запис без таблиці ТЧ і всіх її фактів: звірка фактів сама б зійшлась.
    const changed = structuredClone(record)
    const contacts = record.tables.find((t) => t.id === CONTACT_ID)!.to
    changed.tables = changed.tables.filter((t) => t.id !== CONTACT_ID)
    changed.columns = changed.columns.filter((c) => c.table !== contacts)
    changed.retired = changed.retired.filter((c) => c.table !== contacts)
    changed.deleteSemantics = changed.deleteSemantics.filter(
      (d) => d.table !== contacts
    )
    const verdict = await transition({
      state: applied(before),
      model: after,
      records: [input(changed)],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([
      ["plan.promotion-record-mismatch", "error"],
    ])
    expect(verdict.diagnostics[0]!.params?.detail).toContain(CONTACT_ID)
  })

  it("3 refuses a record table that is not a tabular section of the object", async () => {
    const { before, after, record } = await withContacts()
    const foreign = uuid(7998)
    const changed = structuredClone(record)
    changed.tables.push({
      id: foreign,
      schema: "app",
      from: "elsewhere",
      to: "elsewhere",
    })
    const verdict = await transition({
      state: applied(before),
      model: after,
      records: [input(changed)],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([
      ["plan.promotion-record-mismatch", "error"],
    ])
    expect(verdict.diagnostics[0]!.params?.detail).toContain(foreign)
  })

  it("4 accepts a matching record with its tabular section", async () => {
    const { before, after, record } = await withContacts()
    expect(record.tables).toHaveLength(2)
    expect(record.dataSteps).toEqual([])
    const verdict = await transition({
      state: applied(before),
      model: after,
      records: [input(record)],
    })
    expect(verdict).toEqual({
      status: "promotion",
      record,
      recordHash: await promotionRecordHash(record),
      facts: expect.objectContaining({ tables: record.tables }),
      source: expect.arrayContaining([
        expect.objectContaining({ schema: "app", name: "counterparties" }),
      ]),
      diagnostics: [],
    })
  })

  it("5 ignores an applied record with a warning", async () => {
    const { after, record } = await counterparty()
    const hash = await promotionRecordHash(record)
    const verdict = await transition({
      state: applied(after),
      model: after,
      records: [input(record)],
      appliedHashes: new Set([hash]),
    })
    expect(verdict.status).toBe("none")
    expect(codes(verdict)).toEqual([["plan.promotion-applied", "warning"]])
  })

  it("6 refuses a stale record", async () => {
    const { before, record } = await counterparty()
    const verdict = await transition({
      state: applied(before),
      model: before,
      records: [input(record)],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([["plan.promotion-record-stale", "error"]])
  })

  it("7 ignores a record whose object is not adopted here", async () => {
    const { after, record } = await counterparty()
    const verdict = await transition({
      state: applied(after),
      model: after,
      records: [input(record)],
    })
    expect(verdict.status).toBe("none")
    expect(codes(verdict)).toEqual([
      ["plan.promotion-not-applicable", "warning"],
    ])
  })

  it("7 ignores a record whose object the marker does not know", async () => {
    // Об'єкта X у marker немає зовсім (інстанс, де таблицю ніколи не
    // приймали): запис не для цього інстансу — попередження, а не відмова
    const { after, record } = await counterparty()
    const empty = await compiled(
      new Map(
        [...promotionProject(PARTS)].filter(([f]) => f !== COUNTERPARTY_FILE)
      )
    )
    expect(empty.objects.map((o) => o.id)).not.toContain(COUNTERPARTY_ID)
    const verdict = await transition({
      state: applied(empty),
      model: after,
      records: [input(record)],
    })
    expect(verdict.status).toBe("none")
    expect(codes(verdict)).toEqual([
      ["plan.promotion-not-applicable", "warning"],
    ])
  })

  it("8 refuses without a marker when the old table is live", async () => {
    const { after, record } = await counterparty()
    const verdict = await transition({
      state: { status: "fresh" },
      model: after,
      records: [input(record)],
      liveTables: new Set([tableKey("app", "counterparties")]),
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([["plan.promotion-needs-marker", "error"]])
    expect(verdict.diagnostics[0]!.params).toMatchObject({
      table: "app.counterparties",
    })
  })

  it("9 ignores a record in a fresh environment", async () => {
    const { after, record } = await counterparty()
    const verdict = await transition({
      state: { status: "fresh" },
      model: after,
      records: [input(record)],
      liveTables: new Set([tableKey("app", "counterparty")]),
    })
    expect(verdict.status).toBe("none")
    expect(codes(verdict)).toEqual([
      ["plan.promotion-not-applicable", "warning"],
    ])
  })

  it("refuses any other combination with a record as stale", async () => {
    // Вид у marker, а в бажаній моделі — знову CustomTable: таблиця рішень
    // такого рядка не має, і запис не застосовний ні як промоція, ні як ігнор.
    const { before, after, record } = await counterparty()
    const verdict = await transition({
      state: applied(after),
      model: before,
      records: [input(record)],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([["plan.promotion-record-stale", "error"]])
  })
})

describe("promotionTransition: limits of P3-2a", () => {
  const PRICE_FILE = "custom-tables/Price/Price.meta.json"
  const price = {
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
  }
  const priceMapping = promoteInput.parse({
    target: { name: "Price" },
    into: { kind: "InformationRegister", name: "Price", data: {} },
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

  it("refuses two transitions in one plan", async () => {
    const files = promotionProject(PARTS)
    files.set(PRICE_FILE, JSON.stringify(price))
    const first = await promoted(files, counterpartyMapping(NO_FILL))
    const second = await promoted(first.afterFiles, priceMapping)
    const verdict = await transition({
      state: applied(first.before),
      model: second.after,
      records: [input(first.record), input(second.record, "plans/price.json")],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toContainEqual(["plan.promotion-multiple", "error"])
  })

  it("refuses data steps until P3-2b", async () => {
    const { before, after, record } = await promoted(
      promotionProject(PARTS),
      counterpartyMapping(PARTS)
    )
    expect(record.dataSteps).not.toEqual([])
    const verdict = await transition({
      state: applied(before),
      model: after,
      records: [input(record)],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([["plan.promotion-unsupported", "error"]])
    expect(verdict.diagnostics[0]!.params).toMatchObject({
      reason: "dataSteps",
    })
  })

  it("refuses a label translation until P3-3", async () => {
    const { before, after, record } = await counterparty()
    const verdict = await transition({
      state: applied(before),
      model: after,
      records: [
        input({
          ...record,
          labelTranslation: {
            from: ["party"],
            to: "counterparty",
            columns: [],
          },
        }),
      ],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([["plan.promotion-unsupported", "error"]])
    expect(verdict.diagnostics[0]!.params).toMatchObject({
      reason: "labelTranslation",
    })
  })

  it("refuses a unit table without a primary key", async () => {
    const { before, after, record } = await counterparty()
    const state = applied(before)
    if (state.status !== "applied") throw new Error("unreachable")
    const snapshot = state.marker.snapshot as {
      physical: { tables: Json[] }
    }
    for (const table of snapshot.physical.tables) {
      if (table.name === "counterparties") delete table.primaryKey
    }
    const verdict = await transition({
      state,
      model: after,
      records: [input(record)],
    })
    expect(verdict.status).toBe("refused")
    expect(codes(verdict)).toEqual([["plan.promotion-unsupported", "error"]])
    expect(verdict.diagnostics[0]!.params).toMatchObject({
      reason: "primaryKey",
      table: "app.counterparties",
    })
  })

  it("derives incoming delete semantics from the desired model", async () => {
    const { before, afterFiles, record } = await counterparty()
    expect(record.deleteSemantics).toEqual([])
    afterFiles.set(
      "custom-tables/Note/Note.meta.json",
      JSON.stringify({
        id: uuid(7401),
        kind: "CustomTable",
        name: "Note",
        physicalName: "notes",
        kindLabel: "note",
        schema: "app",
        columns: [
          {
            id: uuid(7402),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          {
            id: uuid(7403),
            name: "counterpartyId",
            physicalName: "counterparty_id",
            type: "UUID",
          },
        ],
        primaryKey: { name: "notes_pkey", columns: ["id"] },
        foreignKeys: [
          {
            name: "notes_counterparty_id_fkey",
            columns: ["counterpartyId"],
            references: {
              object: { kind: "Catalog", name: "Counterparty" },
              columns: ["ref"],
            },
            onDelete: "cascade",
          },
        ],
      })
    )
    const later = await compiled(afterFiles)
    const verdict = await transition({
      state: applied(before),
      model: later,
      records: [input(record)],
    })
    expect(verdict.status).toBe("promotion")
    if (verdict.status !== "promotion") return
    expect(verdict.facts.deleteSemantics).toEqual([
      {
        direction: "incoming",
        schema: "app",
        table: "notes",
        constraint: "notes_counterparty_id_fkey",
        columns: ["counterparty_id"],
        target: "counterparty",
        from: "cascade",
        to: "cascade",
      },
    ])
  })
})
