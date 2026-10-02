import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  renameElement,
  renameInput,
  type CompiledModel,
  type ElementTarget,
  type ResolvedReference,
} from "simetra/compiler"
import { readReferenceDomain } from "./fixtures/reference-domain"
import { kitchenSink } from "./fixtures/kitchen-sink"

type Json = Record<string, unknown>

const SERVICE_ACCRUAL = "documents/ServiceAccrual/ServiceAccrual.meta.json"
const SERVICE_ACCRUAL_SQL = "documents/ServiceAccrual/ServiceAccrual.sql"
const INCOME_EXPENSES =
  "accumulation-registers/IncomeExpenses/IncomeExpenses.meta.json"
const SETTLEMENTS =
  "accumulation-registers/PerformerSettlements/PerformerSettlements.meta.json"
const COUNTERPARTY = "catalogs/Counterparty/Counterparty.meta.json"
const COUNTERPARTY_MODULE = "catalogs/Counterparty/Counterparty.module.ts"
const CONTRACT = "catalogs/Contract/Contract.meta.json"
const ORG_MEMBER = "custom-tables/OrgMember/OrgMember.meta.json"
const ACCRUAL_KIND = "enumerations/AccrualKind/AccrualKind.meta.json"
const PROJECT = "project.meta.json"

const codes = (result: { diagnostics: { code: string }[] }) =>
  result.diagnostics.map((d) => d.code)

async function modelOf(files: ReadonlyMap<string, string>) {
  const compiled = await compile(files)
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return compiled.model as CompiledModel
}

/** Перейменування, яке мусить вдатися; повертає мапу файлів після нього. */
async function renamed(
  files: ReadonlyMap<string, string>,
  target: ElementTarget,
  newName: string
) {
  const result = await renameElement(files, { target, newName })
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  expect(result.ok).toBe(true)
  return { result, after: applyChanges(files, result.changes) }
}

const json = (files: ReadonlyMap<string, string>, path: string) =>
  JSON.parse(files.get(path)!) as Json

const movements = (doc: Json) =>
  (doc.posting as { movements: { fields: Record<string, string> }[] }).movements

describe("renameElement", () => {
  it("renames a register resource used as a fields key", async () => {
    const files = readReferenceDomain()
    const { result, after } = await renamed(
      files,
      {
        kind: "AccumulationRegister",
        name: "IncomeExpenses",
        element: ["income"],
      },
      "revenue"
    )
    expect(result.changes.map((c) => c.path)).toEqual([
      INCOME_EXPENSES,
      SERVICE_ACCRUAL,
    ])
    const [first, second] = movements(json(after, SERVICE_ACCRUAL))
    expect(Object.entries(first!.fields)).toEqual([
      ["counterparty", "doc.counterparty"],
      ["accrualKind", "doc.accrualKind"],
      ["revenue", "row.amount"],
      ["expense", "0"],
    ])
    expect(Object.keys(second!.fields)).toEqual([
      "counterparty",
      "accrualKind",
      "revenue",
      "expense",
    ])
    const resource = (json(after, INCOME_EXPENSES).resources as Json[]).find(
      (r) => r.name === "revenue"
    )!
    expect(resource.physicalName).toBe("income")
  })

  it("renames a resource in balanceControl", async () => {
    const files = readReferenceDomain()
    const { after } = await renamed(
      files,
      {
        kind: "AccumulationRegister",
        name: "PerformerSettlements",
        element: ["amount"],
      },
      "balance"
    )
    const register = json(after, SETTLEMENTS)
    expect(register.balanceControl).toEqual({ resources: ["balance"] })
    expect((register.resources as Json[])[0]).toMatchObject({
      name: "balance",
      physicalName: "amount",
    })
  })

  it("renames a tabular section attribute inside expressions", async () => {
    const files = readReferenceDomain()
    const { result, after } = await renamed(
      files,
      {
        kind: "Document",
        name: "ServiceAccrual",
        element: ["performers", "amount"],
      },
      "total"
    )
    expect(result.changes.map((c) => c.path)).toEqual([SERVICE_ACCRUAL])
    const [first, second] = movements(json(after, SERVICE_ACCRUAL))
    expect(second!.fields.expense).toBe("sum(performers.total)")
    // `row.amount` — реквізит ТЧ `services`, інший елемент.
    expect(first!.fields.income).toBe("row.amount")
  })

  it("renames every token of one expression", async () => {
    const files = readReferenceDomain()
    files.set(
      SERVICE_ACCRUAL,
      files
        .get(SERVICE_ACCRUAL)!
        .replace(
          '"income": "row.amount"',
          '"income": "row.amount + row.amount * 2"'
        )
    )
    const { after } = await renamed(
      files,
      {
        kind: "Document",
        name: "ServiceAccrual",
        element: ["services", "amount"],
      },
      "total"
    )
    // Заміни від кінця до початку: коротше ім'я не зсуває межі наступного токена.
    expect(movements(json(after, SERVICE_ACCRUAL))[0]!.fields.income).toBe(
      "row.total + row.total * 2"
    )
  })

  it("renames a tabular section used in sum", async () => {
    const files = readReferenceDomain()
    const staff = await renamed(
      files,
      { kind: "Document", name: "ServiceAccrual", element: ["performers"] },
      "staff"
    )
    const doc = json(staff.after, SERVICE_ACCRUAL)
    expect(movements(doc)[1]!.fields.expense).toBe("sum(staff.amount)")
    expect((doc.tabularSections as Json[])[1]).toMatchObject({
      name: "staff",
      physicalName: "service_accrual_performers",
    })

    // Та сама роль у формі значення: джерело рядків руху.
    const lines = await renamed(
      files,
      { kind: "Document", name: "ServiceAccrual", element: ["services"] },
      "lines"
    )
    const source = (
      json(lines.after, SERVICE_ACCRUAL).posting as {
        movements: { source: unknown }[]
      }
    ).movements[0]!.source
    expect(source).toEqual({ tabularSection: "lines" })
  })

  it("renames a catalog", async () => {
    const files = readReferenceDomain()
    files.set(COUNTERPARTY_MODULE, "export const marker = 1\n")
    const before = await modelOf(files)
    const { result, after } = await renamed(
      files,
      { kind: "Catalog", name: "Counterparty" },
      "Partner"
    )
    const PARTNER = "catalogs/Partner/Partner.meta.json"
    const PARTNER_MODULE = "catalogs/Partner/Partner.module.ts"
    const changed = new Map(result.changes.map((c) => [c.path, c.content]))
    expect(changed.get(COUNTERPARTY)).toBeNull()
    expect(changed.get(COUNTERPARTY_MODULE)).toBeNull()
    expect(changed.get(PARTNER_MODULE)).toBe("export const marker = 1\n")

    const partner = json(after, PARTNER)
    expect(partner.name).toBe("Partner")
    expect(partner.physicalName).toBe("counterparty")
    expect(partner.id).toBe(json(files, COUNTERPARTY).id)
    expect(json(after, CONTRACT).owners).toEqual([
      { kind: "Catalog", name: "Partner" },
    ])
    for (const [path, text] of after) {
      if (path.endsWith(".meta.json"))
        expect(text, path).not.toMatch(/"Counterparty"/)
    }

    const model = await modelOf(after)
    expect(model.physical).toEqual(before.physical)
  })

  it("renames a document with its sql file", async () => {
    const files = readReferenceDomain()
    const { result, after } = await renamed(
      files,
      { kind: "Document", name: "ServiceAccrual" },
      "Accrual"
    )
    const changed = new Map(result.changes.map((c) => [c.path, c.content]))
    expect(changed.get(SERVICE_ACCRUAL)).toBeNull()
    expect(changed.get(SERVICE_ACCRUAL_SQL)).toBeNull()
    expect(after.get("documents/Accrual/Accrual.sql")).toBe(
      files.get(SERVICE_ACCRUAL_SQL)
    )
    expect(json(after, SETTLEMENTS).recorderTypes).toEqual([
      { kind: "Document", name: "Accrual" },
    ])
  })

  it("renames a CustomTable column used as scopeColumn and in a key", async () => {
    const files = readReferenceDomain()
    const { after } = await renamed(
      files,
      { kind: "CustomTable", name: "OrgMember", element: ["orgId"] },
      "organizationId"
    )
    const table = json(after, ORG_MEMBER)
    expect(table.scopeColumn).toBe("organizationId")
    expect((table.primaryKey as Json).columns).toEqual([
      "organizationId",
      "userId",
    ])
    expect((table.foreignKeys as Json[])[0]!.columns).toEqual([
      "organizationId",
    ])
    expect((table.columns as Json[])[0]).toMatchObject({
      name: "organizationId",
      physicalName: "org_id",
    })
  })

  it("renames a register named in a movements marker", async () => {
    const files = readReferenceDomain()
    const sql = files.get(SERVICE_ACCRUAL_SQL)!
    const { after } = await renamed(
      files,
      { kind: "AccumulationRegister", name: "PerformerSettlements" },
      "Settlements"
    )
    expect(after.get(SERVICE_ACCRUAL_SQL)).toBe(
      sql.replace(
        "-- @movements PerformerSettlements",
        "-- @movements Settlements"
      )
    )
    expect(
      after.has("accumulation-registers/Settlements/Settlements.meta.json")
    ).toBe(true)

    // Кваліфікований маркер лишається кваліфікованим.
    const qualified = new Map(files)
    qualified.set(
      SERVICE_ACCRUAL_SQL,
      sql.replace(
        "-- @movements PerformerSettlements",
        "-- @movements AccumulationRegister.PerformerSettlements"
      )
    )
    const second = await renamed(
      qualified,
      { kind: "AccumulationRegister", name: "PerformerSettlements" },
      "Settlements"
    )
    expect(second.after.get(SERVICE_ACCRUAL_SQL)).toBe(
      sql.replace(
        "-- @movements PerformerSettlements",
        "-- @movements AccumulationRegister.Settlements"
      )
    )
  })

  it("renames an enumeration value used as a default", async () => {
    const files = readReferenceDomain()
    const { after } = await renamed(
      files,
      { kind: "Enumeration", name: "AccrualKind", element: ["Regular"] },
      "Planned"
    )
    const attribute = (json(after, SERVICE_ACCRUAL).attributes as Json[]).find(
      (a) => a.name === "accrualKind"
    )!
    expect(attribute.defaultValue).toBe("Planned")
    expect((json(after, ACCRUAL_KIND).values as Json[])[0]).toMatchObject({
      name: "Planned",
      physicalName: "regular",
      title: { uk: "Планове" },
    })
  })

  it("renames a scope kind", async () => {
    const files = readReferenceDomain()
    const scoped = [...files]
      .filter(([path]) => path.endsWith(".meta.json") && path !== PROJECT)
      .filter(([, text]) => (JSON.parse(text) as Json).scope === "org")
      .map(([path]) => path)
    expect(scoped.length).toBeGreaterThan(1)
    const { after } = await renamed(
      files,
      { kind: "Project", element: ["org"] },
      "organization"
    )
    for (const path of scoped) {
      expect(json(after, path).scope, path).toBe("organization")
    }
    expect((json(after, PROJECT).scopeKinds as Json[])[0]).toMatchObject({
      name: "organization",
      physicalName: "org_id",
    })
  })

  it("refuses a bad new name", async () => {
    const files = readReferenceDomain()
    const bad = await renameElement(files, {
      target: { kind: "Catalog", name: "Counterparty" },
      newName: "bad_name",
    })
    expect(bad.ok).toBe(false)

    const taken = await renameElement(files, {
      target: { kind: "Catalog", name: "Counterparty" },
      newName: "Contract",
    })
    expect(taken.ok).toBe(false)
    expect(codes(taken)).toEqual(["operation.object-exists"])
    expect(taken.changes).toEqual([])

    const missing = await renameElement(files, {
      target: { kind: "Catalog", name: "Nobody" },
      newName: "Somebody",
    })
    expect(codes(missing)).toEqual(["operation.target-not-found"])

    const broken = new Map(files)
    broken.set(CONTRACT, "{")
    const refusedOnBroken = await renameElement(broken, {
      target: { kind: "Catalog", name: "Counterparty" },
      newName: "Partner",
    })
    expect(refusedOnBroken.ok).toBe(false)
    expect(refusedOnBroken.changes).toEqual([])
    expect(codes(refusedOnBroken)).toContain("operation.input-invalid")
  })

  it("refuses an element name taken in the same namespace", async () => {
    const files = readReferenceDomain()
    const result = await renameElement(files, {
      target: {
        kind: "Document",
        name: "ServiceAccrual",
        element: ["comment"],
      },
      newName: "contract",
    })
    expect(result.ok).toBe(false)
    expect(codes(result)).toContain("identity.name-duplicate")
  })

  it("renames a CustomTable column targeted by another table's foreign key", async () => {
    const files = kitchenSink()
    const before = await modelOf(files)
    const { after } = await renamed(
      files,
      { kind: "CustomTable", name: "Ledger", element: ["id"] },
      "entryId"
    )
    const tag = json(after, "custom-tables/LedgerTag/LedgerTag.meta.json")
    const fk = (tag.foreignKeys as Json[])[0]!
    expect((fk.references as Json).columns).toEqual(["entryId"])
    expect((await modelOf(after)).physical).toEqual(before.physical)
  })

  it("rename input is strict and path-safe", () => {
    const target = { kind: "Catalog", name: "Counterparty" }
    expect(renameInput.safeParse({ target, newName: "Partner" }).success).toBe(
      true
    )
    expect(renameInput.safeParse({ target, newName: "../x" }).success).toBe(
      false
    )
    expect(
      renameInput.safeParse({ target, newName: "Partner", dryRun: true })
        .success
    ).toBe(false)
  })
})

/** Логічне ім'я, яке місце посилання читає, — за формою місця. */
function nameAt(
  files: ReadonlyMap<string, string>,
  ref: ResolvedReference
): string {
  const text = files.get(ref.from.file)!
  if (ref.line !== undefined) {
    const line = text.split(/\r?\n/)[ref.line - 1]!
    const token = /@movements\s+(\S+)/.exec(line)![1]!
    return token.slice(token.indexOf(".") + 1)
  }
  const segments = ref.from.pointer
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
  let node: unknown = JSON.parse(text)
  for (const segment of segments) node = (node as Json)[segment]
  if (ref.span !== undefined) {
    return (node as string).slice(ref.span.start, ref.span.end)
  }
  // Ключ `fields` руху: ім'я — сам останній сегмент.
  if (ref.role === "posting.registerField") return segments.at(-1)!
  return typeof node === "string" ? node : String((node as Json).name)
}

/** Ланцюжок імен до елемента з id: об'єкт, вкладені колекції чи вид скоупу. */
function targetOf(model: CompiledModel, id: string): ElementTarget | undefined {
  const scopeKind = model.scopeKinds.find((k) => k.id === id)
  if (scopeKind !== undefined) {
    return { kind: "Project", element: [scopeKind.name] }
  }
  // Ланцюжок — імена кожного іменованого предка нижче за сам об'єкт.
  const chain = (node: unknown, path: string[]): string[] | undefined => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = chain(item, path)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (typeof node !== "object" || node === null) return undefined
    const record = node as Json
    const here =
      typeof record.id === "string" && typeof record.name === "string"
        ? [...path, record.name]
        : path
    if (record.id === id) return here
    for (const child of Object.values(record)) {
      const found = chain(child, here)
      if (found !== undefined) return found
    }
    return undefined
  }
  for (const object of model.objects) {
    if (object.id === id) return { kind: object.kind, name: object.name }
    const found = chain(object.data, [])
    if (found !== undefined) {
      // Перший елемент ланцюжка — сам об'єкт.
      return { kind: object.kind, name: object.name, element: found.slice(1) }
    }
  }
  return undefined
}

const CASCADE_FIXTURES: [string, () => Map<string, string>][] = [
  ["reference domain", readReferenceDomain],
  ["kitchen sink", kitchenSink],
]

/** Стандартні реквізити мають синтетичний id і не перейменовуються. */
const renameable = (references: readonly ResolvedReference[]) =>
  references.filter((r) => !r.to.id.includes("#"))

/** Форма місця з погляду тесту (ключ — поле регістра в `fields` руху). */
const formOf = (r: ResolvedReference) =>
  r.span !== undefined
    ? "token"
    : r.line !== undefined
      ? "marker"
      : r.role === "posting.registerField"
        ? "key"
        : "value"

describe("rename cascade", () => {
  it.each(CASCADE_FIXTURES)(
    "%s: every role is renamed in every form it takes",
    async (_, load) => {
      const files = load()
      const model = await modelOf(files)
      const targets = [
        ...new Set(renameable(model.references).map((r) => r.to.id)),
      ]
      for (const id of targets) {
        const target = targetOf(model, id)
        expect(target, id).toBeDefined()
        const oldName =
          target!.kind === "Project"
            ? target!.element[0]
            : (target!.element?.at(-1) ?? target!.name)
        const newName = `${oldName}Renamed`
        const before = model.references.filter((r) => r.to.id === id)
        for (const r of before) {
          expect(nameAt(files, r), `${r.role} ${r.from.pointer}`).toBe(oldName)
        }

        const result = await renameElement(files, { target: target!, newName })
        expect(
          result.diagnostics.filter((d) => d.severity === "error"),
          `${oldName} → ${newName}`
        ).toEqual([])
        const renamedModel = await modelOf(applyChanges(files, result.changes))
        const after = renamedModel.references.filter((r) => r.to.id === id)
        expect(after.map((r) => r.role).sort()).toEqual(
          before.map((r) => r.role).sort()
        )
        const afterFiles = applyChanges(files, result.changes)
        for (const r of after) {
          expect(nameAt(afterFiles, r), `${r.role} ${r.from.pointer}`).toBe(
            newName
          )
        }
      }
    },
    60_000
  )

  it("the cascade runs exercise every place form and the edge roles", async () => {
    // Самодостатньо, без залежності від порядку тестів: форми й ролі
    // рахуються з тих самих фікстур, які проходить каскад.
    const refs = (
      await Promise.all(
        CASCADE_FIXTURES.map(async ([, load]) =>
          renameable((await modelOf(load())).references)
        )
      )
    ).flat()
    expect([...new Set(refs.map(formOf))].sort()).toEqual([
      "key",
      "marker",
      "token",
      "value",
    ])
    const roles = new Set(refs.map((r) => r.role))
    expect(roles).toContain("constant.enumDefault")
    expect(roles).toContain("customTable.foreignKeyTarget")
  })
})
