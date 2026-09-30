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
