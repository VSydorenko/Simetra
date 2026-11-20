import { describe, expect, it } from "vitest"
import {
  addElement,
  applyChanges,
  type AddElementInput,
  type SchemaPathResolver,
} from "simetra/compiler"
import { SQL_DEBT_FILE } from "simetra/model"
import { acceptDebt, customTable, metaFiles, project, uuid } from "./helpers"

/** Детерміноване джерело id у формі UUID v4. */
function counter(start = 700_000): () => string {
  let n = start
  return () => uuid(++n)
}

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

const options = () => ({ schemaPath, newId: counter() })

type Json = Record<string, unknown>

const PROJECT_FILE = "project.meta.json"
const ORGANIZATION = "custom-tables/Organization/Organization.meta.json"
const ORDERS = "custom-tables/Orders/Orders.meta.json"
const ORDERS_SQL = "custom-tables/Orders/Orders.sql"
const LOGS = "custom-tables/Logs/Logs.meta.json"
const SCOPE_FUNCTIONS = "sql/public/scope-functions.sql"

// Дослівна політика скоупу прийнятої таблиці: мутація її не торкається,
// межу в базі тримає саме вона.
const ORDERS_POLICY = `CREATE POLICY orders_tenant ON public.orders USING (org_id IN (SELECT public.org_ids()));`

const column = (name: string, physicalName: string, n: number) => ({
  id: uuid(n),
  name,
  physicalName,
  type: "UUID",
  notNull: true,
})

/**
 * Тека після прийому з нуля: проєкт без видів скоупу й три прийняті таблиці —
 * майбутній корінь виду `Organization`, скоуплена `Orders` (з FK носія на ключ
 * кореня й дослівною політикою) і глобальна `Logs`. Скоуп ще ніхто не оголосив.
 */
async function adoptedFolder(): Promise<Map<string, string>> {
  const files = metaFiles({
    [PROJECT_FILE]: project(),
    [ORGANIZATION]: customTable("Organization", {
      primaryKey: { columns: ["id"] },
    }),
    [ORDERS]: customTable("Orders", {
      columns: [column("id", "id", 6001), column("org", "org_id", 6002)],
      primaryKey: { columns: ["id"] },
      foreignKeys: [
        {
          name: "orders_org_fk",
          columns: ["org"],
          references: {
            object: { kind: "CustomTable", name: "Organization" },
            columns: ["id"],
          },
        },
      ],
    }),
    [LOGS]: customTable("Logs"),
    [ORDERS_SQL]: ORDERS_POLICY,
    [SCOPE_FUNCTIONS]: `CREATE FUNCTION public.org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT NULL::uuid $$;`,
  })
  return acceptDebt(files)
}

const orgKind = {
  name: "org",
  root: { object: { kind: "CustomTable", name: "Organization" } },
  setFunction: { name: "org_ids" },
}

const addOrg = (
  scopes: AddElementInput["scopes"],
  overrides: Partial<AddElementInput> = {}
): AddElementInput => ({
  target: { kind: "Project" },
  collection: "scopeKinds",
  element: orgKind,
  scopes,
  ...overrides,
})

const ALL = {
  Organization: { scope: "org" },
  Orders: { scope: "org", scopeColumn: "org" },
  Logs: { scope: "none" },
}

const codes = (result: { diagnostics: { code: string }[] }) =>
  result.diagnostics.map((d) => d.code)

describe("addElement: scopes", () => {
  it("writes the scope kind and the scope of every named table", async () => {
    const files = await adoptedFolder()
    const result = await addElement(files, addOrg(ALL), options())
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => c.path).sort()).toEqual(
      [PROJECT_FILE, ORGANIZATION, ORDERS, LOGS].sort()
    )

    const after = applyChanges(files, result.changes)
    const table = (file: string) => JSON.parse(after.get(file)!) as Json
    expect(table(ORGANIZATION).scope).toBe("org")
    expect(table(ORGANIZATION).scopeColumn).toBeUndefined()
    expect(table(ORDERS)).toMatchObject({ scope: "org", scopeColumn: "org" })
    expect(table(LOGS).scope).toBe("none")
    expect(
      (JSON.parse(after.get(PROJECT_FILE)!) as { scopeKinds: Json[] })
        .scopeKinds[0]
    ).toMatchObject({ name: "org", physicalName: "org_id" })
  })

  // Б3: мутація не торкається SQL і боргу; політика й рядок боргу — байт-у-байт.
  it("leaves verbatim table policies and the debt file untouched", async () => {
    const files = await adoptedFolder()
    expect(JSON.parse(files.get(SQL_DEBT_FILE)!).units).toContain(
      "policy:public.orders.orders_tenant"
    )
    const result = await addElement(files, addOrg(ALL), options())
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => c.path).sort()).toEqual(
      [PROJECT_FILE, ORGANIZATION, ORDERS, LOGS].sort()
    )
    const after = applyChanges(files, result.changes)
    expect(after.get(ORDERS_SQL)).toBe(files.get(ORDERS_SQL))
    expect(after.get(SQL_DEBT_FILE)).toBe(files.get(SQL_DEBT_FILE))
    expect(after.get(SCOPE_FUNCTIONS)).toBe(files.get(SCOPE_FUNCTIONS))
  })

  // Б1: жодна таблиця не отримує скоуп мовчки, «none» мутація не підставляє.
  it("refuses the first kind when a table is left undeclared", async () => {
    const files = await adoptedFolder()
    const result = await addElement(
      files,
      addOrg({
        Organization: ALL.Organization,
        Orders: ALL.Orders,
      }),
      options()
    )
    // Помилка компіляції результату: `ok: false` — обгортка нічого не пише.
    expect(result.ok).toBe(false)
    const missing = result.diagnostics.filter(
      (d) => d.code === "scope.declaration-missing"
    )
    expect(missing.map((d) => d.params)).toEqual([
      { kind: "CustomTable", name: "Logs" },
    ])
  })

  // Р2
  it("refuses scopes for any other collection or target", async () => {
    const files = await adoptedFolder()
    for (const input of [
      {
        target: { kind: "CustomTable", name: "Orders" },
        collection: "columns",
        element: { name: "x", type: "Boolean" },
        scopes: ALL,
      },
      {
        target: { kind: "Project" },
        collection: "naming",
        element: { name: "x" },
        scopes: ALL,
      },
    ] as const) {
      const result = await addElement(files, input, options())
      expect(result.ok).toBe(false)
      expect(result.changes).toEqual([])
      expect(codes(result)).toEqual(["operation.input-invalid"])
      expect(result.diagnostics[0]!.params).toMatchObject({
        scopes: "target",
        at: "/scopes",
      })
    }
  })

  // Р3
  it("refuses a table that does not exist or is not a CustomTable", async () => {
    const files = await adoptedFolder()
    files.set(
      "catalogs/Plain/Plain.meta.json",
      JSON.stringify({
        id: uuid(5001),
        kind: "Catalog",
        name: "Plain",
        physicalName: "plain",
        kindLabel: "plain",
      })
    )
    for (const name of ["Missing", "Plain"]) {
      const result = await addElement(
        files,
        addOrg({ ...ALL, [name]: { scope: "org" } }),
        options()
      )
      expect(result.ok).toBe(false)
      expect(result.changes).toEqual([])
      expect(codes(result)).toEqual(["operation.input-invalid"])
      expect(result.diagnostics[0]!.params).toMatchObject({
        scopes: "table-unknown",
        at: `/scopes/${name}`,
      })
    }
  })

  // Б2: наявну межу тенанта через `add` не переписують.
  it("refuses a table that already declares its scope", async () => {
    const files = await adoptedFolder()
    const orders = JSON.parse(files.get(ORDERS)!) as Json
    orders.scope = "none"
    files.set(ORDERS, JSON.stringify(orders))
    const result = await addElement(files, addOrg(ALL), options())
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(codes(result)).toEqual(["operation.input-invalid"])
    expect(result.diagnostics[0]!.params).toMatchObject({
      scopes: "table-scoped",
      at: "/scopes/Orders",
    })
  })

  // Р8 діє і тут: хибний носій не обходить правило через мутацію.
  it("refuses a scope column without a foreign key to the root", async () => {
    const files = await adoptedFolder()
    const orders = JSON.parse(files.get(ORDERS)!) as Json
    orders.foreignKeys = []
    files.set(ORDERS, JSON.stringify(orders))
    const result = await addElement(files, addOrg(ALL), options())
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("scope.custom-table-column")
  })
})
