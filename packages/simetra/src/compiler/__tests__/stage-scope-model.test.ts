import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { PhysicalSnapshot, PhysicalTable, Project } from "simetra/model"
import { readFiles } from "../stages/files"
import { buildModel } from "../stages/model"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  organization,
  project,
  scopedProject,
  uuid,
} from "./helpers"

const PROJECT = "project.meta.json"
const ORG = "catalogs/Organization/Organization.meta.json"
const CP = "catalogs/Counterparty/Counterparty.meta.json"
const CONTRACT = "catalogs/Contract/Contract.meta.json"

const ORG_KIND_ID = uuid(900)

function ref(kind: string, name: string, extra: Record<string, unknown> = {}) {
  return { type: "Ref", ref: { kind, name }, ...extra }
}

/** Проєкт зі стабільним id виду `org`, щоб перевіряти `origin.scopeKindId`. */
function scopedProjectWith(org: Record<string, unknown> = {}) {
  const base = scopedProject()
  const [first, ...rest] = base.scopeKinds
  return {
    ...base,
    scopeKinds: [{ ...first, id: ORG_KIND_ID, ...org }, ...rest],
  }
}

function files(
  entries: Record<string, unknown>,
  projectFile: unknown = scopedProjectWith()
) {
  return metaFiles({
    [PROJECT]: projectFile,
    [ORG]: organization(),
    ...entries,
  })
}

function compileScoped(
  entries: Record<string, unknown>,
  projectFile?: unknown
): PhysicalSnapshot {
  const result = compile(files(entries, projectFile))
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!.physical
}

/**
 * Лише стадія 3: для моделей, які стадія 4 відкидає, але знімок яких має
 * бути побудований без неможливих FK.
 */
function buildScoped(entries: Record<string, unknown>): PhysicalSnapshot {
  const stage1 = readFiles(files(entries))
  expect(stage1.diagnostics).toEqual([])
  return buildModel(stage1.objects, stage1.project as Project).physical
}

function tableOf(physical: PhysicalSnapshot, name: string): PhysicalTable {
  const table = physical.tables.find((t) => t.name === name)
  expect(table, name).toBeDefined()
  return table!
}

function fkOn(table: PhysicalTable, column: string) {
  return table.foreignKeys.filter((fk) => fk.columns.includes(column))
}

const counterparty = (overrides: Record<string, unknown> = {}) =>
  catalog("Counterparty", { scope: "org", ...overrides })

const contract = (overrides: Record<string, unknown> = {}) =>
  catalog("Contract", {
    scope: "org",
    attributes: [
      attribute("counterparty", {
        physicalName: "counterparty_id",
        ...ref("Catalog", "Counterparty"),
      }),
    ],
    ...overrides,
  })

describe("stage 3: scope", () => {
  it("root has no scope column", () => {
    const physical = compileScoped({ [CP]: counterparty() })
    const root = tableOf(physical, "organization")
    expect(root.columns.map((c) => c.name)).not.toContain("org_id")
    // Ключ кореня і є значенням скоупу.
    expect(root.columns[0]).toMatchObject({
      name: "id",
      origin: { standard: "ref", scopeKindId: ORG_KIND_ID },
    })
    expect(root.uniques.map((u) => u.columns)).toEqual([["code"]])
    expect(root.foreignKeys).toEqual([])
  })

  it("scoped catalog", () => {
    const physical = compileScoped({ [CP]: counterparty() })
    const cp = tableOf(physical, "counterparty")
    expect(cp.columns.slice(0, 3).map((c) => c.name)).toEqual([
      "id",
      "org_id",
      "code",
    ])
    expect(cp.columns[1]).toEqual({
      name: "org_id",
      type: "uuid",
      notNull: true,
      origin: { scopeKindId: ORG_KIND_ID },
    })
    expect(fkOn(cp, "org_id")).toEqual([
      {
        name: "counterparty_org_id_fkey",
        columns: ["org_id"],
        references: {
          schema: "public",
          table: "organization",
          columns: ["id"],
        },
        onDelete: "restrict",
        onUpdate: "noAction",
        deferrable: "no",
      },
    ])
    expect(cp.uniques).toEqual([
      {
        name: "counterparty_org_id_code_key",
        columns: ["org_id", "code"],
        nullsNotDistinct: false,
      },
      {
        name: "counterparty_org_id_id_key",
        columns: ["org_id", "id"],
        nullsNotDistinct: false,
      },
    ])
  })

  it("onRootDelete cascade", () => {
    const physical = compileScoped(
      { [CP]: counterparty() },
      scopedProjectWith({ onRootDelete: "cascade" })
    )
    expect(fkOn(tableOf(physical, "counterparty"), "org_id")).toEqual([
      expect.objectContaining({ onDelete: "cascade" }),
    ])
  })

  it("external root", () => {
    const physical = compileScoped({
      "catalogs/Draft/Draft.meta.json": catalog("Draft", { scope: "user" }),
    })
    const draft = tableOf(physical, "draft")
    expect(draft.columns[1]).toMatchObject({ name: "user_id", notNull: true })
    expect(fkOn(draft, "user_id")).toEqual([
      expect.objectContaining({
        name: "draft_user_id_fkey",
        columns: ["user_id"],
        references: { schema: "auth", table: "users", columns: ["id"] },
        onDelete: "restrict",
      }),
    ])
    expect(draft.uniques.map((u) => u.columns)).toContainEqual([
      "user_id",
      "id",
    ])
  })

  it("tabular section inherits scope", () => {
    const physical = compileScoped({
      "documents/Invoice/Invoice.meta.json": document("Invoice", {
        scope: "org",
        tabularSections: [
          {
            id: uuid(901),
            name: "lines",
            physicalName: "invoice_lines",
            attributes: [attribute("qty", { type: "Integer" })],
          },
        ],
      }),
    })
    const invoice = tableOf(physical, "invoice")
    expect(invoice.uniques.map((u) => u.name)).toContain(
      "invoice_org_id_id_key"
    )
    const lines = tableOf(physical, "invoice_lines")
    expect(lines.columns.map((c) => c.name)).toEqual([
      "id",
      "org_id",
      "parent_id",
      "line_number",
      "qty",
    ])
    expect(lines.columns[1]).toMatchObject({
      notNull: true,
      origin: { scopeKindId: ORG_KIND_ID },
    })
    expect(fkOn(lines, "parent_id")).toEqual([
      expect.objectContaining({
        name: "invoice_lines_org_id_parent_id_fkey",
        columns: ["org_id", "parent_id"],
        references: {
          schema: "public",
          table: "invoice",
          columns: ["org_id", "id"],
        },
        onDelete: "cascade",
      }),
    ])
    // Скоуп-колонка рядка ТЧ посилається на корінь, як у будь-якого об'єкта.
    expect(fkOn(lines, "org_id").map((fk) => fk.name)).toEqual([
      "invoice_lines_org_id_fkey",
      "invoice_lines_org_id_parent_id_fkey",
    ])
  })

  it("same-kind reference is composite", () => {
    const physical = compileScoped({
      [CP]: counterparty(),
      [CONTRACT]: contract(),
    })
    expect(fkOn(tableOf(physical, "contract"), "counterparty_id")).toEqual([
      {
        name: "contract_org_id_counterparty_id_fkey",
        columns: ["org_id", "counterparty_id"],
        references: {
          schema: "public",
          table: "counterparty",
          columns: ["org_id", "id"],
        },
        onDelete: "noAction",
        onUpdate: "noAction",
        deferrable: "no",
      },
    ])
  })

  it("hierarchy parent is composite", () => {
    const physical = compileScoped({
      [CP]: counterparty({ hierarchyType: "ItemsOnly" }),
    })
    expect(fkOn(tableOf(physical, "counterparty"), "parent_id")).toEqual([
      expect.objectContaining({
        name: "counterparty_org_id_parent_id_fkey",
        columns: ["org_id", "parent_id"],
        references: {
          schema: "public",
          table: "counterparty",
          columns: ["org_id", "id"],
        },
        onDelete: "noAction",
      }),
    ])
  })

  it("scoped to global is plain", () => {
    const physical = compileScoped({
      "catalogs/Currency/Currency.meta.json": catalog("Currency", {
        scope: "none",
      }),
      [CP]: counterparty({
        attributes: [
          attribute("currency", {
            physicalName: "currency_id",
            ...ref("Catalog", "Currency"),
          }),
        ],
      }),
    })
    const currency = tableOf(physical, "currency")
    expect(currency.columns.map((c) => c.name)).not.toContain("org_id")
    expect(currency.uniques.map((u) => u.columns)).toEqual([["code"]])
    expect(fkOn(tableOf(physical, "counterparty"), "currency_id")).toEqual([
      expect.objectContaining({
        columns: ["currency_id"],
        references: { schema: "public", table: "currency", columns: ["id"] },
      }),
    ])
  })

  it("crossScope is plain", () => {
    const physical = compileScoped({
      "catalogs/Draft/Draft.meta.json": catalog("Draft", { scope: "user" }),
      [CP]: counterparty({
        attributes: [
          attribute("draft", {
            physicalName: "draft_id",
            ...ref("Catalog", "Draft", { crossScope: true }),
          }),
        ],
      }),
    })
    expect(fkOn(tableOf(physical, "counterparty"), "draft_id")).toEqual([
      expect.objectContaining({
        columns: ["draft_id"],
        references: { schema: "public", table: "draft", columns: ["id"] },
      }),
    ])
  })

  it("crossScope is plain even within one kind", () => {
    const physical = compileScoped({
      [CP]: counterparty(),
      [CONTRACT]: contract({
        attributes: [
          attribute("counterparty", {
            physicalName: "counterparty_id",
            ...ref("Catalog", "Counterparty", { crossScope: true }),
          }),
        ],
      }),
    })
    expect(fkOn(tableOf(physical, "contract"), "counterparty_id")).toEqual([
      expect.objectContaining({ columns: ["counterparty_id"] }),
    ])
  })

  it("reference to custom table is plain", () => {
    const physical = compileScoped({
      "custom-tables/Log/Log.meta.json": logTable(),
      [CP]: counterparty({
        attributes: [
          attribute("log", {
            physicalName: "log_id",
            ...ref("CustomTable", "Log"),
          }),
        ],
      }),
    })
    const log = tableOf(physical, "log")
    expect(log.columns.map((c) => c.name)).toEqual(["id", "org_id"])
    expect(log.uniques).toEqual([])
    expect(log.foreignKeys).toEqual([])
    expect(fkOn(tableOf(physical, "counterparty"), "log_id")).toEqual([
      expect.objectContaining({
        columns: ["log_id"],
        references: { schema: "public", table: "log", columns: ["id"] },
      }),
    ])
  })

  it("scoped constant", () => {
    const physical = compileScoped({
      [CP]: counterparty(),
      "constants/MainCounterparty/MainCounterparty.meta.json": {
        id: uuid(902),
        kind: "Constant",
        name: "MainCounterparty",
        physicalName: "main_counterparty",
        scope: "org",
        ...ref("Catalog", "Counterparty"),
      },
    })
    const constant = tableOf(physical, "main_counterparty")
    expect(constant.columns.map((c) => c.name)).toEqual(["org_id", "value"])
    expect(constant.columns[0]).toMatchObject({
      notNull: true,
      origin: { scopeKindId: ORG_KIND_ID },
    })
    expect(constant.primaryKey).toEqual({
      name: "main_counterparty_pkey",
      columns: ["org_id"],
    })
    expect(constant.checks).toEqual([])
    expect(constant.uniques).toEqual([])
    expect(constant.foreignKeys).toEqual([
      expect.objectContaining({
        name: "main_counterparty_org_id_fkey",
        columns: ["org_id"],
        references: {
          schema: "public",
          table: "organization",
          columns: ["id"],
        },
      }),
      expect.objectContaining({
        name: "main_counterparty_org_id_value_fkey",
        columns: ["org_id", "value"],
        references: {
          schema: "public",
          table: "counterparty",
          columns: ["org_id", "id"],
        },
      }),
    ])
  })

  it("scoped constant with crossScope is plain", () => {
    const physical = compileScoped({
      [CP]: counterparty(),
      "constants/MainCounterparty/MainCounterparty.meta.json": {
        id: uuid(902),
        kind: "Constant",
        name: "MainCounterparty",
        physicalName: "main_counterparty",
        scope: "org",
        ...ref("Catalog", "Counterparty", { crossScope: true }),
      },
    })
    expect(
      tableOf(physical, "main_counterparty").foreignKeys.map((fk) => [
        fk.columns,
        fk.references.columns,
      ])
    ).toEqual([
      [["org_id"], ["id"]],
      [["value"], ["id"]],
    ])
  })

  it("register gets scope column only", () => {
    const physical = compileScoped({
      [CP]: counterparty(),
      "documents/Sale/Sale.meta.json": document("Sale", { scope: "org" }),
      "accumulation-registers/Stock/Stock.meta.json": {
        id: uuid(903),
        kind: "AccumulationRegister",
        name: "Stock",
        physicalName: "stock",
        scope: "org",
        recorderTypes: [{ kind: "Document", name: "Sale" }],
        dimensions: [
          attribute("counterparty", {
            physicalName: "counterparty_id",
            ...ref("Catalog", "Counterparty"),
          }),
        ],
        resources: [attribute("qty", { type: "Integer" })],
      },
    })
    const stock = tableOf(physical, "stock")
    expect(stock.columns[0]).toMatchObject({
      name: "org_id",
      notNull: true,
      origin: { scopeKindId: ORG_KIND_ID },
    })
    expect(stock.uniques).toEqual([])
    // Реєстратор — пара без FK, тож на документ посилання немає.
    expect(stock.foreignKeys).toEqual([
      expect.objectContaining({
        name: "stock_org_id_counterparty_id_fkey",
        columns: ["org_id", "counterparty_id"],
        references: {
          schema: "public",
          table: "counterparty",
          columns: ["org_id", "id"],
        },
      }),
      expect.objectContaining({
        name: "stock_org_id_fkey",
        columns: ["org_id"],
        references: {
          schema: "public",
          table: "organization",
          columns: ["id"],
        },
      }),
    ])
  })

  it("physical name collision with scope column", () => {
    const result = compile(
      files({
        [CP]: counterparty({
          attributes: [attribute("orgCode", { physicalName: "org_id" })],
        }),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.column-duplicate",
        file: CP,
        pointer: "/attributes/0/physicalName",
      }),
    ])
  })

  it("root tabular section keeps plain parent key", () => {
    const physical = compileScoped({
      [CP]: counterparty(),
      [ORG]: organization({
        tabularSections: [
          {
            id: uuid(904),
            name: "partners",
            physicalName: "organization_partners",
            attributes: [
              attribute("counterparty", {
                physicalName: "counterparty_id",
                ...ref("Catalog", "Counterparty"),
              }),
            ],
          },
        ],
      }),
    })
    const rows = tableOf(physical, "organization_partners")
    expect(rows.columns.map((c) => c.name)).toEqual([
      "id",
      "parent_id",
      "line_number",
      "counterparty_id",
    ])
    // parent_id рядка кореня і є значенням скоупу.
    expect(rows.columns[1]!.origin).toEqual({
      standard: "parent",
      scopeKindId: ORG_KIND_ID,
    })
    expect(rows.foreignKeys).toEqual([
      expect.objectContaining({
        name: "organization_partners_parent_id_counterparty_id_fkey",
        columns: ["parent_id", "counterparty_id"],
        references: {
          schema: "public",
          table: "counterparty",
          columns: ["org_id", "id"],
        },
      }),
      expect.objectContaining({
        name: "organization_partners_parent_id_fkey",
        columns: ["parent_id"],
        references: {
          schema: "public",
          table: "organization",
          columns: ["id"],
        },
        onDelete: "cascade",
      }),
    ])
  })

  it("root reference to own-kind target carries scope in its key", () => {
    const physical = compileScoped({
      [CP]: counterparty(),
      [CONTRACT]: contract(),
      "custom-tables/Log/Log.meta.json": logTable(),
      [ORG]: organization({
        attributes: [
          attribute("mainContract", {
            physicalName: "main_contract_id",
            ...ref("Catalog", "Contract"),
          }),
          attribute("log", {
            physicalName: "log_id",
            ...ref("CustomTable", "Log"),
          }),
        ],
      }),
    })
    const root = tableOf(physical, "organization")
    expect(fkOn(root, "main_contract_id")).toEqual([
      {
        name: "organization_id_main_contract_id_fkey",
        columns: ["id", "main_contract_id"],
        references: {
          schema: "public",
          table: "contract",
          columns: ["org_id", "id"],
        },
        onDelete: "noAction",
        onUpdate: "noAction",
        deferrable: "no",
      },
    ])
    expect(fkOn(root, "log_id")).toEqual([
      expect.objectContaining({
        columns: ["log_id"],
        references: { schema: "public", table: "log", columns: ["id"] },
      }),
    ])
  })

  it("reference to a root is plain, even from its own kind", () => {
    // Стадія 4 відкидає посилання на корінь власного виду; стадія 3 все одно
    // будує лише можливий FK — у кореня немає UNIQUE (scope, id).
    const physical = buildScoped({
      [CP]: counterparty({
        attributes: [
          attribute("organization", {
            physicalName: "organization_id",
            ...ref("Catalog", "Organization"),
          }),
        ],
      }),
      [ORG]: organization({ hierarchyType: "ItemsOnly" }),
    })
    expect(fkOn(tableOf(physical, "counterparty"), "organization_id")).toEqual([
      expect.objectContaining({
        columns: ["organization_id"],
        references: {
          schema: "public",
          table: "organization",
          columns: ["id"],
        },
      }),
    ])
    expect(fkOn(tableOf(physical, "organization"), "parent_id")).toEqual([
      expect.objectContaining({
        columns: ["parent_id"],
        references: {
          schema: "public",
          table: "organization",
          columns: ["id"],
        },
      }),
    ])
  })

  it("single-tenant project has no scope columns", () => {
    const strip = (o: Record<string, unknown>) => {
      const rest = { ...o }
      delete rest.scope
      return rest
    }
    const result = compile(
      metaFiles({
        [PROJECT]: project(),
        [ORG]: strip(organization()),
        [CP]: strip(counterparty({ hierarchyType: "ItemsOnly" })),
        [CONTRACT]: strip(contract()),
      })
    )
    expect(result.diagnostics).toEqual([])
    const tables = result.model!.physical.tables
    const columns = tables.flatMap((t) => t.columns)
    expect(columns.filter((c) => c.origin.scopeKindId !== undefined)).toEqual(
      []
    )
    expect(columns.map((c) => c.name)).not.toContain("org_id")
    expect(
      tables.flatMap((t) => t.foreignKeys.map((fk) => fk.columns))
    ).toEqual([["counterparty_id"], ["parent_id"]])
  })
})

function indexesOf(table: PhysicalTable) {
  return table.indexes.map((index) => ({
    name: index.name,
    keys: index.keys.map((key) => ("column" in key ? key.column : "")),
  }))
}

function uniquesOf(table: PhysicalTable) {
  return table.uniques.map((unique) => unique.columns)
}

const uniqueText = (name: string, physicalName: string) =>
  attribute(name, { physicalName, type: "String", length: 20, unique: true })

describe("stage 3: scope indexes", () => {
  it("scoped catalog with codeUnique has no separate code or scope index", () => {
    const physical = compileScoped({ [CP]: counterparty() })
    // `org_id` покриває UNIQUE (org_id, id), `(org_id, code)` — UNIQUE (org_id, code).
    expect(indexesOf(tableOf(physical, "counterparty"))).toEqual([])
  })

  it("scoped catalog without codeUnique indexes code within the scope", () => {
    const physical = compileScoped({
      [CP]: counterparty({ codeUnique: false }),
    })
    expect(indexesOf(tableOf(physical, "counterparty"))).toEqual([
      { name: "counterparty_org_id_code_idx", keys: ["org_id", "code"] },
    ])
  })

  it("scoped document indexes number and date within the scope", () => {
    const physical = compileScoped({
      "documents/Invoice/Invoice.meta.json": document("Invoice", {
        scope: "org",
      }),
    })
    expect(indexesOf(tableOf(physical, "invoice"))).toEqual([
      { name: "invoice_org_id_date_idx", keys: ["org_id", "date"] },
      { name: "invoice_org_id_number_idx", keys: ["org_id", "number"] },
    ])
  })

  it("indexed attribute of a scoped object leads with the scope column", () => {
    const rank = () => attribute("rank", { type: "Integer", indexed: true })
    const physical = compileScoped({
      [CP]: counterparty({ attributes: [rank()] }),
      "catalogs/Currency/Currency.meta.json": catalog("Currency", {
        scope: "none",
        attributes: [rank()],
      }),
    })
    expect(indexesOf(tableOf(physical, "counterparty"))).toEqual([
      { name: "counterparty_org_id_rank_idx", keys: ["org_id", "rank"] },
    ])
    expect(indexesOf(tableOf(physical, "currency"))).toEqual([
      { name: "currency_rank_idx", keys: ["rank"] },
    ])
  })

  it("composite reference gets one index on the full FK", () => {
    const physical = compileScoped({
      [CP]: counterparty(),
      [CONTRACT]: contract({
        attributes: [
          attribute("counterparty", {
            physicalName: "counterparty_id",
            // Явний `indexed` посилання задоволено індексом FK — другого немає.
            indexed: true,
            ...ref("Catalog", "Counterparty"),
          }),
        ],
      }),
    })
    expect(indexesOf(tableOf(physical, "contract"))).toEqual([
      {
        name: "contract_org_id_counterparty_id_idx",
        keys: ["org_id", "counterparty_id"],
      },
    ])
  })

  it("plain reference from a scoped table is indexed on the FK only", () => {
    // Індекс FK служить перевірці при видаленні валюти — за currency_id.
    const physical = compileScoped({
      "catalogs/Currency/Currency.meta.json": catalog("Currency", {
        scope: "none",
      }),
      [CP]: counterparty({
        attributes: [
          attribute("currency", {
            physicalName: "currency_id",
            indexed: true,
            ...ref("Catalog", "Currency"),
          }),
        ],
      }),
    })
    expect(indexesOf(tableOf(physical, "counterparty"))).toEqual([
      { name: "counterparty_currency_id_idx", keys: ["currency_id"] },
    ])
  })

  it("crossScope reference is indexed on the FK only", () => {
    const physical = compileScoped({
      "catalogs/Draft/Draft.meta.json": catalog("Draft", { scope: "user" }),
      [CP]: counterparty({
        attributes: [
          attribute("draft", {
            physicalName: "draft_id",
            ...ref("Catalog", "Draft", { crossScope: true }),
          }),
        ],
      }),
    })
    expect(indexesOf(tableOf(physical, "counterparty"))).toEqual([
      { name: "counterparty_draft_id_idx", keys: ["draft_id"] },
    ])
  })

  it("scoped tabular section row indexes the composite parent key", () => {
    const physical = compileScoped({
      "documents/Invoice/Invoice.meta.json": document("Invoice", {
        scope: "org",
        tabularSections: [
          {
            id: uuid(910),
            name: "lines",
            physicalName: "invoice_lines",
            attributes: [attribute("qty", { type: "Integer" })],
          },
        ],
      }),
    })
    // `org_id` FK на корінь покриває (org_id, parent_id).
    expect(indexesOf(tableOf(physical, "invoice_lines"))).toEqual([
      {
        name: "invoice_lines_org_id_parent_id_idx",
        keys: ["org_id", "parent_id"],
      },
    ])
  })

  it("hierarchy parent is indexed on the composite key", () => {
    const physical = compileScoped({
      [CP]: counterparty({ hierarchyType: "ItemsOnly" }),
    })
    expect(indexesOf(tableOf(physical, "counterparty"))).toEqual([
      {
        name: "counterparty_org_id_parent_id_idx",
        keys: ["org_id", "parent_id"],
      },
    ])
  })

  it("register indexes lead with the scope column", () => {
    const physical = compileScoped({
      [CP]: counterparty(),
      "documents/Sale/Sale.meta.json": document("Sale", { scope: "org" }),
      "accumulation-registers/Stock/Stock.meta.json": {
        id: uuid(911),
        kind: "AccumulationRegister",
        name: "Stock",
        physicalName: "stock",
        scope: "org",
        recorderTypes: [{ kind: "Document", name: "Sale" }],
        dimensions: [
          attribute("counterparty", {
            physicalName: "counterparty_id",
            ...ref("Catalog", "Counterparty"),
          }),
        ],
        resources: [attribute("qty", { type: "Integer" })],
      },
    })
    // Індекс FK `(org_id, counterparty_id)` покриває префікс індексу рухів.
    expect(indexesOf(tableOf(physical, "stock"))).toEqual([
      {
        name: "stock_org_id_counterparty_id_period_idx",
        keys: ["org_id", "counterparty_id", "period"],
      },
      { name: "stock_org_id_period_idx", keys: ["org_id", "period"] },
    ])
  })

  it("root and its tabular section rows keep single-column indexes", () => {
    const physical = compileScoped({
      [ORG]: organization({
        codeUnique: false,
        tabularSections: [
          {
            id: uuid(915),
            name: "notes",
            physicalName: "organization_notes",
            attributes: [attribute("rank", { type: "Integer", indexed: true })],
          },
        ],
      }),
    })
    expect(indexesOf(tableOf(physical, "organization"))).toEqual([
      { name: "organization_code_idx", keys: ["code"] },
    ])
    expect(indexesOf(tableOf(physical, "organization_notes"))).toEqual([
      { name: "organization_notes_parent_id_idx", keys: ["parent_id"] },
      { name: "organization_notes_rank_idx", keys: ["rank"] },
    ])
  })

  it("global catalog reference keeps its single-column index", () => {
    const physical = compileScoped({
      "catalogs/Currency/Currency.meta.json": catalog("Currency", {
        scope: "none",
      }),
      "catalogs/Rate/Rate.meta.json": catalog("Rate", {
        scope: "none",
        attributes: [
          attribute("currency", {
            physicalName: "currency_id",
            ...ref("Catalog", "Currency"),
          }),
        ],
      }),
    })
    // Глобальний код покриває його власний UNIQUE (code).
    expect(indexesOf(tableOf(physical, "rate"))).toEqual([
      { name: "rate_currency_id_idx", keys: ["currency_id"] },
    ])
  })
})

describe("stage 3: uniqueness within scope", () => {
  it("scoped catalog attribute is unique within the scope", () => {
    const physical = compileScoped({
      [CP]: counterparty({ attributes: [uniqueText("taxId", "tax_id")] }),
    })
    const cp = tableOf(physical, "counterparty")
    expect(cp.uniques.map((u) => u.name)).toContain(
      "counterparty_org_id_tax_id_key"
    )
    expect(uniquesOf(cp)).toContainEqual(["org_id", "tax_id"])
    expect(uniquesOf(cp)).not.toContainEqual(["tax_id"])
  })

  it("scoped tabular section attribute is unique within the scope", () => {
    const physical = compileScoped({
      "documents/Invoice/Invoice.meta.json": document("Invoice", {
        scope: "org",
        tabularSections: [
          {
            id: uuid(912),
            name: "lines",
            physicalName: "invoice_lines",
            attributes: [uniqueText("sku", "sku")],
          },
        ],
      }),
    })
    expect(uniquesOf(tableOf(physical, "invoice_lines"))).toEqual([
      ["org_id", "sku"],
    ])
  })

  it("root tabular section attribute is unique within its parent", () => {
    const physical = compileScoped({
      [ORG]: organization({
        attributes: [uniqueText("taxId", "tax_id")],
        tabularSections: [
          {
            id: uuid(913),
            name: "accounts",
            physicalName: "organization_accounts",
            attributes: [uniqueText("iban", "iban")],
          },
        ],
      }),
    })
    expect(uniquesOf(tableOf(physical, "organization_accounts"))).toEqual([
      ["parent_id", "iban"],
    ])
    // Рядки кореня самі є значеннями скоупу — унікальність глобальна.
    expect(uniquesOf(tableOf(physical, "organization"))).toEqual([
      ["code"],
      ["tax_id"],
    ])
  })

  it("register attribute is unique within the scope", () => {
    const physical = compileScoped({
      "documents/Sale/Sale.meta.json": document("Sale", { scope: "org" }),
      "accumulation-registers/Stock/Stock.meta.json": {
        id: uuid(914),
        kind: "AccumulationRegister",
        name: "Stock",
        physicalName: "stock",
        scope: "org",
        recorderTypes: [{ kind: "Document", name: "Sale" }],
        resources: [attribute("qty", { type: "Integer" })],
        attributes: [uniqueText("ticket", "ticket")],
      },
    })
    expect(uniquesOf(tableOf(physical, "stock"))).toEqual([
      ["org_id", "ticket"],
    ])
  })

  it("global object keeps plain uniqueness", () => {
    const physical = compileScoped({
      "catalogs/Currency/Currency.meta.json": catalog("Currency", {
        scope: "none",
        attributes: [uniqueText("isoCode", "iso_code")],
      }),
    })
    expect(uniquesOf(tableOf(physical, "currency"))).toEqual([
      ["code"],
      ["iso_code"],
    ])
  })
})

describe("stage 3: scoped owner", () => {
  it("owner of the same kind is composite", () => {
    const physical = compileScoped({
      [CP]: counterparty(),
      [CONTRACT]: catalog("Contract", {
        scope: "org",
        owners: [{ kind: "Catalog", name: "Counterparty" }],
      }),
    })
    const table = tableOf(physical, "contract")
    expect(fkOn(table, "owner_id")).toEqual([
      expect.objectContaining({
        name: "contract_org_id_owner_id_fkey",
        columns: ["org_id", "owner_id"],
        references: {
          schema: "public",
          table: "counterparty",
          columns: ["org_id", "id"],
        },
        onDelete: "noAction",
      }),
    ])
    expect(indexesOf(table)).toEqual([
      { name: "contract_org_id_owner_id_idx", keys: ["org_id", "owner_id"] },
    ])
  })

  it("root as owner is plain", () => {
    // Стадія 4 відкидає посилання на корінь власного виду; тут — лише форма.
    const physical = buildScoped({
      [CP]: counterparty({
        owners: [{ kind: "Catalog", name: "Organization" }],
      }),
    })
    expect(fkOn(tableOf(physical, "counterparty"), "owner_id")).toEqual([
      expect.objectContaining({
        columns: ["owner_id"],
        references: {
          schema: "public",
          table: "organization",
          columns: ["id"],
        },
      }),
    ])
  })
})

/** Скоуплена прийнята таблиця називає власну uuid-колонку скоупу. */
function logTable() {
  return customTable("Log", {
    scope: "org",
    scopeColumn: "orgRef",
    columns: [
      {
        id: uuid(905),
        name: "id",
        physicalName: "id",
        type: "UUID",
        notNull: true,
      },
      {
        id: uuid(906),
        name: "orgRef",
        physicalName: "org_id",
        type: "UUID",
        notNull: true,
      },
    ],
    primaryKey: { columns: ["id"] },
  })
}
