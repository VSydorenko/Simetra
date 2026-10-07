import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  deleteElement,
  deleteInput,
  type CompiledModel,
} from "simetra/compiler"
import { isInsideElement } from "../operations/delete"
import { readReferenceDomain } from "./fixtures/reference-domain"
import { attribute, catalog, metaFiles, project } from "./helpers"

type Json = Record<string, unknown>

const SERVICE_ACCRUAL = "documents/ServiceAccrual/ServiceAccrual.meta.json"

async function modelOf(files: ReadonlyMap<string, string>) {
  const compiled = await compile(files)
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return compiled.model as CompiledModel
}

/** Id цілі й усіх вкладених у неї елементів (будь-який ключ `id` у піддереві). */
function idsIn(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((n) => idsIn(n, into))
  else if (typeof node === "object" && node !== null) {
    for (const [k, v] of Object.entries(node)) {
      if (k === "id" && typeof v === "string") into.add(v)
      else idsIn(v, into)
    }
  }
  return into
}

const place = (d: { file: string; pointer: string }) => `${d.file}#${d.pointer}`

describe("deleteElement", () => {
  it("refuses to delete a referenced catalog", async () => {
    const files = readReferenceDomain()
    const model = await modelOf(files)
    const currency = model.objects.find((o) => o.name === "Currency")!
    const doc = JSON.parse(files.get(currency.file)!) as Json
    const ids = idsIn(doc)
    // Очікувані місця виводяться з індексу, а не списком руками (рішення R2).
    const expected = model.references
      .filter((r) => ids.has(r.to.id) && r.from.objectId !== currency.id)
      .map((r) => `${r.from.file}#${r.from.pointer}`)
    expect(expected.length).toBeGreaterThan(0)

    const result = await deleteElement(files, {
      target: { kind: "Catalog", name: "Currency" },
    })
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      result.diagnostics.map(() => "operation.delete-referenced")
    )
    expect(new Set(result.diagnostics.map(place))).toEqual(new Set(expected))
    const files_ = new Set(result.diagnostics.map((d) => d.file))
    expect(files_).toContain("catalogs/Contract/Contract.meta.json")
    expect(files_).toContain(
      "constants/DefaultCurrency/DefaultCurrency.meta.json"
    )
  })

  it("refusal places carry real ranges: JSON by pointer, .sql by marker line", async () => {
    // Без діапазону кожне місце друкувалося як `файл:1:1`, і «тут» у тексті
    // відмови не відрізняло одне посилання від іншого.
    const files = readReferenceDomain()
    const model = await modelOf(files)
    const register = model.objects.find(
      (o) => o.name === "PerformerSettlements"
    )!
    const marker = model.references.find(
      (r) => r.to.id === register.id && r.line !== undefined
    )!
    expect(marker.from.file.endsWith(".sql")).toBe(true)

    const result = await deleteElement(files, {
      target: { kind: "AccumulationRegister", name: "PerformerSettlements" },
    })
    expect(result.ok).toBe(false)
    const json = result.diagnostics.filter((d) => d.file === SERVICE_ACCRUAL)
    expect(json.length).toBeGreaterThan(0)
    for (const d of json) {
      expect(d.range).toBeDefined()
      expect(d.range!.start.line).toBeGreaterThan(0)
    }
    const sql = result.diagnostics.find((d) => d.file === marker.from.file)!
    expect(sql.range?.start.line).toBe(marker.line! - 1)
  })

  it("deletes an unreferenced attribute", async () => {
    const files = readReferenceDomain()
    const result = await deleteElement(files, {
      target: {
        kind: "Document",
        name: "ServiceAccrual",
        element: ["comment"],
      },
    })
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => c.path)).toEqual([SERVICE_ACCRUAL])
    const after = applyChanges(files, result.changes)
    const doc = JSON.parse(after.get(SERVICE_ACCRUAL)!) as {
      attributes: { name: string }[]
    }
    expect(doc.attributes.map((a) => a.name)).not.toContain("comment")
    expect(doc.attributes.length).toBeGreaterThan(0)
  })

  it("deletes an object with its module and sql files when only its own subtree references it", async () => {
    // Документ із `.sql` у довідковому домені видалити не можна за побудовою:
    // його рекордери вписані в регістри, а чистий вхід вимагає обох сторін
    // зв'язку. Тому синтетичний довідник із `.module.ts` і посиланням на себе.
    const files = readReferenceDomain()
    const scratch = JSON.parse(
      files.get("catalogs/Currency/Currency.meta.json")!
    ) as Json
    const fresh = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(fresh)
      else if (typeof node === "object" && node !== null) {
        const o = node as Json
        if (typeof o.id === "string") o.id = randomUUID()
        Object.values(o).forEach(fresh)
      }
    }
    fresh(scratch)
    scratch.name = "Scratch"
    scratch.physicalName = "scratch"
    scratch.kindLabel = "scratch"
    delete scratch.$schema
    ;(scratch.attributes as Json[]).push({
      id: randomUUID(),
      name: "parent",
      physicalName: "parent_id",
      title: { uk: "Батько" },
      type: "Ref",
      ref: { kind: "Catalog", name: "Scratch" },
    })
    const META = "catalogs/Scratch/Scratch.meta.json"
    const MODULE = "catalogs/Scratch/Scratch.module.ts"
    const SQL = "catalogs/Scratch/Scratch.sql"
    files.set(META, JSON.stringify(scratch))
    files.set(MODULE, "export const marker = 1\n")
    files.set(SQL, "-- scratch\n")
    const model = await modelOf(files)
    const own = model.objects.find((o) => o.name === "Scratch")!
    expect(
      model.references.some(
        (r) => r.to.id === own.id && r.from.objectId === own.id
      )
    ).toBe(true)

    const result = await deleteElement(files, {
      target: { kind: "Catalog", name: "Scratch" },
    })
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(result.ok).toBe(true)
    expect(
      [...result.changes].sort((a, b) => a.path.localeCompare(b.path))
    ).toEqual([
      { path: META, content: null },
      { path: MODULE, content: null },
      { path: SQL, content: null },
    ])
  })

  it("refuses a nested referenced element", async () => {
    const files = readReferenceDomain()
    const model = await modelOf(files)
    const doc = model.objects.find((o) => o.name === "ServiceAccrual")!
    const raw = JSON.parse(files.get(SERVICE_ACCRUAL)!) as {
      tabularSections: { name: string }[]
    }
    // ТЧ, на реквізити якої посилається проведення поза її піддеревом.
    const blockersOf = (index: number) => {
      const pointer = `/tabularSections/${index}`
      const ids = idsIn(raw.tabularSections[index])
      return model.references.filter(
        (r) =>
          ids.has(r.to.id) &&
          !(
            r.from.objectId === doc.id &&
            (r.from.pointer === pointer ||
              r.from.pointer.startsWith(`${pointer}/`))
          )
      )
    }
    const index = raw.tabularSections.findIndex(
      (_, i) => blockersOf(i).length > 0
    )
    expect(index).toBeGreaterThanOrEqual(0)
    const expected = blockersOf(index).map(
      (r) => `${r.from.file}#${r.from.pointer}`
    )

    const result = await deleteElement(files, {
      target: {
        kind: "Document",
        name: "ServiceAccrual",
        element: [raw.tabularSections[index]!.name],
      },
    })
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(result.diagnostics.map((d) => d.code)).toEqual(
      result.diagnostics.map(() => "operation.delete-referenced")
    )
    expect(new Set(result.diagnostics.map(place))).toEqual(new Set(expected))
  })

  it("treats only the element subtree as inside", () => {
    // Посилань усередині піддерева елемента модель не містить (знайдені
    // ролі виходять лише з рівня об'єкта), тож гілку «всередині» доводить
    // сам предикат, яким користується deleteElement.
    const target = { file: "a.meta.json", pointer: "/tabularSections/1" }
    const inside = (file: string, pointer: string) =>
      isInsideElement(target, { file, pointer })
    expect(inside("a.meta.json", "/tabularSections/1")).toBe(true)
    expect(inside("a.meta.json", "/tabularSections/1/attributes/0")).toBe(true)
    expect(inside("a.meta.json", "/tabularSections/10")).toBe(false)
    expect(inside("a.meta.json", "/tabularSections/10/attributes/0")).toBe(
      false
    )
    expect(inside("a.meta.json", "/posting/movements/0")).toBe(false)
    expect(inside("b.meta.json", "/tabularSections/1")).toBe(false)
  })

  it("refuses to delete a catalog that a subscription listens to", async () => {
    const subscription = "event-subscriptions/Stamp/Stamp.meta.json"
    const files = metaFiles({
      "project.meta.json": project(),
      "catalogs/Contract/Contract.meta.json": catalog("Contract", {
        attributes: [attribute("number", { type: "String", length: 20 })],
      }),
      [subscription]: {
        id: "00000000-0000-4000-8000-000000007101",
        kind: "EventSubscription",
        name: "Stamp",
        physicalName: "stamp",
        sources: [{ kind: "Catalog", name: "Contract" }],
        event: "onWrite",
        whenChanged: ["number"],
        handler: { name: "stamp" },
      },
      "sql/public/stamp.sql":
        "CREATE FUNCTION public.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$;",
    })
    await modelOf(files)
    const result = await deleteElement(files, {
      target: { kind: "Catalog", name: "Contract" },
    })
    expect(result.ok).toBe(false)
    expect(
      result.diagnostics.map((d) => [d.code, d.file, d.pointer, d.params?.role])
    ).toEqual([
      [
        "operation.delete-referenced",
        subscription,
        "/sources/0",
        "eventSubscription.source",
      ],
      [
        "operation.delete-referenced",
        subscription,
        "/whenChanged/0",
        "eventSubscription.whenChanged",
      ],
    ])
  })

  it("reports a missing target", async () => {
    const result = await deleteElement(readReferenceDomain(), {
      target: { kind: "Catalog", name: "Nope" },
    })
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "operation.target-not-found",
    ])
  })

  it("keeps the strict input schema", () => {
    expect(
      deleteInput.safeParse({
        target: { kind: "Catalog", name: "Currency" },
        confirm: true,
      }).success
    ).toBe(false)
  })
})
