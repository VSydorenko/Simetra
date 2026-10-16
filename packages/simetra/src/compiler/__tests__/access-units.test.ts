import { describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  STOCK_FILE,
  SALE_FILE,
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  organization,
  project,
  salesDocument,
  scopedProject,
} from "./helpers"

async function compiled(entries: Record<string, unknown>) {
  const result = await compile(metaFiles(entries))
  expect(result.diagnostics).toEqual([])
  return result.model!
}

function scoped(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "project.meta.json": scopedProject(),
    "catalogs/Organization/Organization.meta.json": organization(),
    ...extra,
  }
}

/** ТЧ `lines`; фізичне ім'я таблиці рядків ТЧ задає файл, тож воно явне. */
function lines(physicalName: string) {
  return {
    id: "00000000-0000-4000-8000-000000000a01",
    name: "lines",
    physicalName,
    attributes: [attribute("note", { type: "String", length: 20 })],
  }
}

function accessOf(model: CompiledModel, table: string) {
  return model.contracts.access.filter((a) => a.table.name === table)
}

describe("accessContracts", () => {
  it("scoped catalog and its tabular section carry the scope column", async () => {
    const model = await compiled(
      scoped({
        "catalogs/Counterparty/Counterparty.meta.json": catalog(
          "Counterparty",
          { scope: "org", tabularSections: [lines("counterparty_lines")] }
        ),
      })
    )
    const id = model.objects.find((o) => o.name === "Counterparty")!.id
    const records = model.contracts.access.filter((a) => a.objectId === id)
    expect(records.map((r) => r.table.name)).toEqual([
      "counterparty",
      "counterparty_lines",
    ])
    const org = model.scopeKinds.find((k) => k.name === "org")!
    expect(org.setFunction).toEqual(model.scopeKinds[0]!.setFunction)
    for (const record of records) {
      expect(record.scope).toEqual({
        scopeKindId: org.id,
        carrier: "org_id",
        setFunction: model.scopeKinds[0]!.setFunction,
      })
      expect(record.publicRead).toEqual([])
    }
  })

  it("scope root keys its own rows by id and its section rows by parent_id", async () => {
    const model = await compiled({
      "project.meta.json": scopedProject(),
      "catalogs/Organization/Organization.meta.json": organization({
        tabularSections: [lines("organization_lines")],
      }),
    })
    expect(accessOf(model, "organization")[0]!.scope?.carrier).toBe("id")
    expect(accessOf(model, "organization_lines")[0]!.scope?.carrier).toBe(
      "parent_id"
    )
  })

  it("scoped accumulation register derived tables carry their own scope column", async () => {
    const scope = { scope: "org" }
    const entries = salesDocument()
    Object.assign(entries[SALE_FILE] as object, scope)
    Object.assign(entries[STOCK_FILE] as object, scope)
    entries["catalogs/Item/Item.meta.json"] = catalog("Item", scope)
    const model = await compiled(scoped(entries))
    const stockId = model.objects.find((o) => o.name === "Stock")!.id
    const parts = model.physical.tables
      .filter((t) => t.origin.objectId === stockId)
      .map((t) => t.origin.part ?? "main")
      .sort()
    expect(parts).toEqual(["main", "totals", "turnoversMonth"])
    const records = model.contracts.access.filter((a) => a.objectId === stockId)
    expect(records).toHaveLength(3)
    for (const record of records) expect(record.scope?.carrier).toBe("org_id")
  })

  it("unscoped catalog without publicRead has no scope and no public read", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      "catalogs/Region/Region.meta.json": catalog("Region"),
    })
    expect(model.contracts.access).toEqual([
      {
        objectId: model.objects.find((o) => o.name === "Region")!.id,
        table: { schema: "public", name: "region" },
        publicRead: [],
      },
    ])
  })

  it("anon public read opens both request roles, authenticated only the user", async () => {
    const model = await compiled(
      scoped({
        "catalogs/Region/Region.meta.json": catalog("Region", {
          scope: "none",
          publicRead: "anon",
        }),
        "catalogs/Counterparty/Counterparty.meta.json": catalog(
          "Counterparty",
          { scope: "org", publicRead: "authenticated" }
        ),
      })
    )
    expect(accessOf(model, "region")[0]!.publicRead).toEqual([
      "anonymous",
      "user",
    ])
    expect(accessOf(model, "counterparty")[0]!.publicRead).toEqual(["user"])
  })

  it("adopted tables and kinds without RLS have no access record", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      "catalogs/Contract/Contract.meta.json": catalog("Contract", {
        attributes: [attribute("number", { type: "String", length: 20 })],
      }),
      "custom-tables/Legacy/Legacy.meta.json": customTable("Legacy", {
        rowLevelSecurity: "enabled",
      }),
      "event-subscriptions/Stamp/Stamp.meta.json": {
        id: "00000000-0000-4000-8000-000000000a02",
        kind: "EventSubscription",
        name: "Stamp",
        physicalName: "stamp",
        sources: [{ kind: "Catalog", name: "Contract" }],
        event: "beforeWrite",
        handler: { schema: "public", name: "stamp" },
      },
      "sql/public/stamp.sql":
        "CREATE FUNCTION public.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$;",
    })
    const legacy = model.physical.tables.find((t) => t.name === "legacy")!
    expect(legacy.rowLevelSecurity).toBe("enabled")
    expect(model.contracts.access.map((a) => a.table.name)).toEqual([
      "contract",
    ])
  })

  it("records are ordered by schema, then table name", async () => {
    const model = await compiled(
      scoped({
        "catalogs/Zeta/Zeta.meta.json": catalog("Zeta", { scope: "org" }),
        "catalogs/Alpha/Alpha.meta.json": catalog("Alpha", {
          scope: "org",
          schema: "app",
        }),
        "documents/Invoice/Invoice.meta.json": document("Invoice", {
          scope: "org",
        }),
      })
    )
    const tables = model.contracts.access.map(
      (a) => `${a.table.schema}.${a.table.name}`
    )
    expect(tables).toEqual(
      [...tables].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    )
    expect(tables[0]).toBe("app.alpha")
  })
})
