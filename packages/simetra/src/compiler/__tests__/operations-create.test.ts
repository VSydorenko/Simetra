import { describe, expect, it } from "vitest"
import {
  addElement,
  addElementInput,
  applyChanges,
  compile,
  createObject,
  createObjectInput,
  resolveTarget,
  type CompiledModel,
  type SchemaPathResolver,
} from "simetra/compiler"
import { metadataIdSchema } from "simetra/model"
import { readReferenceDomain } from "./fixtures/reference-domain"
import { uuid } from "./helpers"

/** Детерміноване джерело id у формі UUID v4. */
function counter(start = 800_000): () => string {
  let n = start
  return () => uuid(++n)
}

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

const options = () => ({ schemaPath, newId: counter() })

type Json = Record<string, unknown>

const WAREHOUSE = "catalogs/Warehouse/Warehouse.meta.json"
const SERVICE_ACCRUAL = "documents/ServiceAccrual/ServiceAccrual.meta.json"
const CURRENCY = "catalogs/Currency/Currency.meta.json"

const codes = (result: { diagnostics: { code: string }[] }) =>
  result.diagnostics.map((d) => d.code)

async function modelOf(files: ReadonlyMap<string, string>) {
  const compiled = await compile(files)
  expect(compiled.diagnostics).toEqual([])
  return compiled.model as CompiledModel
}

describe("createObject", () => {
  it("creates a catalog", async () => {
    const files = readReferenceDomain()
    const result = await createObject(
      files,
      {
        kind: "Catalog",
        name: "Warehouse",
        data: {
          scope: "org",
          attributes: [
            {
              name: "currency",
              type: "Ref",
              ref: { kind: "Catalog", name: "Currency" },
            },
          ],
        },
      },
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => c.path)).toEqual([WAREHOUSE])

    const created = JSON.parse(result.changes[0]!.content!) as Json
    expect(created.$schema).toBe(`schemas-of/${WAREHOUSE}/catalogs.schema.json`)
    expect(created.kind).toBe("Catalog")
    expect(created.physicalName).toBe("warehouse")
    expect(created.kindLabel).toBe("warehouse")
    const attribute = (created.attributes as Json[])[0]!
    expect(attribute.physicalName).toBe("currency_id")
    for (const id of [created.id, attribute.id]) {
      expect(metadataIdSchema.safeParse(id).success, String(id)).toBe(true)
    }
    expect((await compile(applyChanges(files, result.changes))).ok).toBe(true)
  })

  it("changes only the new object's file", async () => {
    // Сторонній файл у неканонічній формі: доповнення не переформатовує його.
    const files = readReferenceDomain()
    files.set(CURRENCY, JSON.stringify(JSON.parse(files.get(CURRENCY)!)))
    const result = await createObject(
      files,
      { kind: "Catalog", name: "Warehouse", data: { scope: "none" } },
      options()
    )
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => c.path)).toEqual([WAREHOUSE])
  })

  it("refuses an existing name", async () => {
    const result = await createObject(
      readReferenceDomain(),
      { kind: "Catalog", name: "Currency", data: { scope: "none" } },
      options()
    )
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(codes(result)).toEqual(["operation.object-exists"])
    expect(result.diagnostics[0]!.file).toBe(CURRENCY)
  })

  it("refuses on a broken input", async () => {
    const files = readReferenceDomain()
    const currency = JSON.parse(files.get(CURRENCY)!) as Json
    currency.codeLength = "three"
    files.set(CURRENCY, JSON.stringify(currency))

    const result = await createObject(
      files,
      { kind: "Catalog", name: "Warehouse", data: { scope: "none" } },
      options()
    )
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(codes(result)).toContain("operation.input-invalid")
    // Діагностика входу пояснює, що саме лагодити.
    expect(result.diagnostics.some((d) => d.file === CURRENCY)).toBe(true)
  })

  it("refuses an explicit id in data, top-level or nested", async () => {
    // Id видає лише `newId`: id видаленого елемента, переданий ззовні,
    // компіляція не відрізнила б від нового, і правило «ніколи не
    // перевикористовується» тихо порушилось би.
    for (const [data, at] of [
      [{ scope: "none", id: uuid(1) }, "/data/id"],
      [
        {
          scope: "none",
          attributes: [{ name: "x", type: "Boolean", id: uuid(2) }],
        },
        "/data/attributes/0/id",
      ],
    ] as const) {
      const result = await createObject(
        readReferenceDomain(),
        { kind: "Catalog", name: "Warehouse", data },
        options()
      )
      expect(result.ok).toBe(false)
      expect(result.changes).toEqual([])
      expect(codes(result)).toEqual(["operation.input-invalid"])
      const d = result.diagnostics[0]!
      expect(d.file).toBe("")
      expect(d.params?.at).toBe(at)
      expect(d.message).toContain(`"id"`)
    }
  })

  it("result that fails compile is not ok", async () => {
    // Документ без обов'язкового `scope`: зміна є, але обгортка її не запише.
    const result = await createObject(
      readReferenceDomain(),
      { kind: "Document", name: "Draft" },
      options()
    )
    expect(result.ok).toBe(false)
    expect(result.changes.map((c) => c.path)).toEqual([
      "documents/Draft/Draft.meta.json",
    ])
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true)
  })
})

describe("addElement", () => {
  it("adds an attribute to a tabular section", async () => {
    const files = readReferenceDomain()
    const result = await addElement(
      files,
      {
        target: {
          kind: "Document",
          name: "ServiceAccrual",
          element: ["services"],
        },
        collection: "attributes",
        element: { name: "note", type: "String", length: 100 },
      },
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => c.path)).toEqual([SERVICE_ACCRUAL])

    const after = applyChanges(files, result.changes)
    const target = resolveTarget(await modelOf(after), after, {
      kind: "Document",
      name: "ServiceAccrual",
      element: ["services", "note"],
    })
    expect(target).toMatchObject({
      ok: true,
      file: SERVICE_ACCRUAL,
      pointer: "/tabularSections/0/attributes/3",
    })
    const added = (
      (
        (JSON.parse(after.get(SERVICE_ACCRUAL)!) as Json)
          .tabularSections as Json[]
      )[0]!.attributes as Json[]
    )[3]!
    expect(added.physicalName).toBe("note")
    expect(target.ok && target.id).toBe(added.id)
    expect(metadataIdSchema.safeParse(added.id).success).toBe(true)
  })

  it("refuses an explicit id in the element, top-level or nested", async () => {
    for (const [element, at] of [
      [{ name: "x", type: "Boolean", id: uuid(3) }, "/element/id"],
      [
        {
          name: "lines",
          attributes: [{ name: "y", type: "Boolean", id: uuid(4) }],
        },
        "/element/attributes/0/id",
      ],
    ] as const) {
      const result = await addElement(
        readReferenceDomain(),
        {
          target: { kind: "Catalog", name: "Currency" },
          collection: element.name === "x" ? "attributes" : "tabularSections",
          element,
        },
        options()
      )
      expect(result.ok).toBe(false)
      expect(result.changes).toEqual([])
      expect(codes(result)).toEqual(["operation.input-invalid"])
      expect(result.diagnostics[0]!.params?.at).toBe(at)
    }
  })

  it("unknown collection", async () => {
    const result = await addElement(
      readReferenceDomain(),
      {
        target: { kind: "Catalog", name: "Currency" },
        collection: "columns",
        element: { name: "x", type: "Boolean" },
      },
      options()
    )
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(codes(result)).toEqual(["operation.collection-unknown"])
  })

  it("unknown target", async () => {
    const result = await addElement(
      readReferenceDomain(),
      {
        target: { kind: "Document", name: "ServiceAccrual", element: ["nope"] },
        collection: "attributes",
        element: { name: "x", type: "Boolean" },
      },
      options()
    )
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(codes(result)).toEqual(["operation.target-not-found"])
  })

  it("adds a scope kind under Project", async () => {
    const files = readReferenceDomain()
    const result = await addElement(
      files,
      {
        target: { kind: "Project" },
        collection: "scopeKinds",
        element: {
          name: "team",
          root: {
            external: { schema: "auth", table: "teams", column: "id" },
          },
          setFunction: { name: "accessible_user_ids" },
        },
      },
      options()
    )
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => c.path)).toEqual(["project.meta.json"])

    const after = applyChanges(files, result.changes)
    const target = resolveTarget(await modelOf(after), after, {
      kind: "Project",
      element: ["team"],
    })
    expect(target).toMatchObject({
      ok: true,
      file: "project.meta.json",
      pointer: "/scopeKinds/2",
    })
    const kinds = (JSON.parse(after.get("project.meta.json")!) as Json)
      .scopeKinds as Json[]
    expect(kinds[2]!.physicalName).toBe("team_id")
  })

  it("refuses an unknown project collection", async () => {
    const result = await addElement(
      readReferenceDomain(),
      {
        target: { kind: "Project" },
        collection: "naming",
        element: { name: "x" },
      },
      options()
    )
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(codes(result)).toEqual(["operation.collection-unknown"])
  })
})

describe("resolveTarget", () => {
  it("resolves objects, nested elements and misses", async () => {
    const files = readReferenceDomain()
    const model = await modelOf(files)
    expect(
      resolveTarget(model, files, { kind: "Catalog", name: "Currency" })
    ).toMatchObject({ ok: true, file: CURRENCY, pointer: "" })
    expect(
      resolveTarget(model, files, {
        kind: "Catalog",
        name: "Currency",
        element: ["Uah"],
      })
    ).toMatchObject({ ok: true, pointer: "/predefinedItems/0" })
    expect(
      resolveTarget(model, files, { kind: "Project", element: ["org"] })
    ).toMatchObject({
      ok: true,
      file: "project.meta.json",
      pointer: "/scopeKinds/0",
    })
    const missing = resolveTarget(model, files, {
      kind: "Catalog",
      name: "Nope",
    })
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.diagnostic.code).toBe(
      "operation.target-not-found"
    )
  })
})

describe("operation inputs", () => {
  it("accept only the operation fields", () => {
    expect(
      createObjectInput.safeParse({ kind: "Catalog", name: "Warehouse" })
        .success
    ).toBe(true)
    // Ім'я стає шляхом файлу: лише PascalCase, без сегментів шляху.
    expect(
      createObjectInput.safeParse({ kind: "Catalog", name: "../Evil" }).success
    ).toBe(false)
    expect(
      addElementInput.safeParse({
        target: { kind: "Project" },
        collection: "scopeKinds",
        element: {},
      }).success
    ).toBe(true)
    expect(
      addElementInput.safeParse({
        target: { kind: "Catalog", name: "Currency" },
        collection: "attributes",
        element: {},
        dryRun: true,
      }).success
    ).toBe(false)
  })
})
