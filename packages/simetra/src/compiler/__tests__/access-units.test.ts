import { describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  accessPolicyNames,
  buildAccessUnits,
  tableGrants,
} from "../access-units"
import type { AccessContract } from "../contracts"
import { loadSqlParser } from "../sql/parse"
import {
  expectClean,
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
  expectClean(result, { allow: ["rights.scope-kind-unread"] })
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

const ITEM = { schema: "public", name: "item" }

function contract(overrides: Partial<AccessContract> = {}): AccessContract {
  return {
    objectId: "00000000-0000-4000-8000-000000000b01",
    table: ITEM,
    publicRead: [],
    ...overrides,
  }
}

const ORG_SCOPE = {
  scopeKindId: "00000000-0000-4000-8000-000000000b02",
  carrier: "org_id",
  setFunction: { schema: "public", name: "org_member_scopes" },
}

async function units(access: AccessContract[]) {
  return buildAccessUnits(access, "supabase", "app", await loadSqlParser())
}

describe("buildAccessUnits", () => {
  it("user readers: revoke from PUBLIC and every API role, select to authenticated", () => {
    expect(tableGrants(ITEM, ["user"], "supabase").sort()).toEqual(
      [
        "REVOKE ALL ON TABLE public.item FROM PUBLIC;",
        "REVOKE ALL ON TABLE public.item FROM anon;",
        "REVOKE ALL ON TABLE public.item FROM service_role;",
        "REVOKE ALL ON TABLE public.item FROM authenticated;",
        "GRANT SELECT ON TABLE public.item TO authenticated;",
      ].sort()
    )
  })

  it("anonymous readers keep the revoke from anon before the grant", () => {
    // ADP схеми `public` дають `anon` усе, зокрема TRUNCATE: грант SELECT
    // сам по собі решти не відкликав би.
    const grants = tableGrants(ITEM, ["user", "anonymous"], "supabase")
    expect(grants).toContain("REVOKE ALL ON TABLE public.item FROM anon;")
    expect(grants).toContain("GRANT SELECT ON TABLE public.item TO anon;")
    expect(grants).toContain(
      "GRANT SELECT ON TABLE public.item TO authenticated;"
    )
    expect(grants.filter((g) => g.startsWith("GRANT"))).toHaveLength(2)
  })

  it("scoped table gets the uncorrelated read policy", async () => {
    const result = await units([contract({ scope: ORG_SCOPE })])
    const policies = result.filter((u) => u.class === "policy")
    expect(policies.map((u) => u.sql)).toEqual([
      "CREATE POLICY item_read ON public.item AS PERMISSIVE FOR SELECT TO authenticated USING (org_id = ANY (ARRAY(SELECT public.org_member_scopes())));",
    ])
  })

  it("public read for anonymous and user opens all rows to both roles", async () => {
    const result = await units([
      contract({ publicRead: ["anonymous", "user"] }),
    ])
    expect(
      result.filter((u) => u.class === "policy").map((u) => u.sql)
    ).toEqual([
      "CREATE POLICY item_public_read ON public.item AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);",
    ])
    expect(result.map((u) => u.sql)).toContain(
      "GRANT SELECT ON TABLE public.item TO anon;"
    )
  })

  it("unscoped table without public read has grants only", async () => {
    const result = await units([contract()])
    expect(result.filter((u) => u.class === "policy")).toEqual([])
    expect(result.every((u) => u.class === "grant")).toBe(true)
    expect(result.map((u) => u.sql).sort()).toEqual(
      tableGrants(ITEM, ["user"], "supabase").sort()
    )
  })

  it("units are generated, owned by the object and never grant on a schema", async () => {
    const result = await units([
      contract({ scope: ORG_SCOPE, publicRead: ["anonymous", "user"] }),
    ])
    for (const unit of result) {
      expect(unit.generator).toBe("access")
      expect(unit.ownerObjectId).toBe(contract().objectId)
      expect(unit.module).toBe("app")
      expect(unit.file).toBeUndefined()
      const grant = (unit.tree as { GrantStmt?: { objtype?: string } })
        .GrantStmt
      expect(grant?.objtype ?? "OBJECT_TABLE").toBe("OBJECT_TABLE")
    }
  })

  it("quotes names that need it", async () => {
    const table = { schema: "App", name: "select" }
    const result = await units([
      contract({
        table,
        scope: { ...ORG_SCOPE, carrier: "Org" },
      }),
    ])
    expect(result.map((u) => u.sql)).toContain(
      'GRANT SELECT ON TABLE "App"."select" TO authenticated;'
    )
    expect(result.find((u) => u.class === "policy")!.sql).toContain(
      'ON "App"."select" AS PERMISSIVE'
    )
    expect(result.find((u) => u.class === "policy")!.sql).toContain(
      'USING ("Org" = ANY'
    )
  })

  it("policy names of a 60-byte table stay within 63 bytes", async () => {
    const table = { schema: "public", name: "t".repeat(60) }
    const names = accessPolicyNames(table)
    for (const name of [names.read, names.publicRead]) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(63)
    }
    expect(names.read).not.toBe(names.publicRead)
    const result = await units([
      contract({ table, scope: ORG_SCOPE, publicRead: ["user"] }),
    ])
    expect(
      result
        .filter((u) => u.class === "policy")
        .map((u) => u.name)
        .sort()
    ).toEqual([names.publicRead, names.read].sort())
  })
})
