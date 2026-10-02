import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  deleteElement,
  deleteInput,
  type CompiledModel,
  type ElementTarget,
} from "simetra/compiler"
import { readReferenceDomain } from "./fixtures/reference-domain"

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

  it("deletes an object with its module file when only its own subtree references it", async () => {
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
    files.set(META, JSON.stringify(scratch))
    files.set(MODULE, "export const marker = 1\n")
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
    ])
  })

  it("refuses a nested referenced element", async () => {
    const files = readReferenceDomain()
    const model = await modelOf(files)
    const doc = model.objects.find((o) => o.name === "ServiceAccrual")!
    const raw = JSON.parse(files.get(SERVICE_ACCRUAL)!) as {
      tabularSections: { name: string }[]
    }
    const sectionPointers = raw.tabularSections.map(
      (s, i) => `/tabularSections/${i}`
    )
    // Ціль — ТЧ, на реквізит якої посилається проведення поза її піддеревом.
    const index = sectionPointers.findIndex((pointer) =>
      model.references.some(
        (r) =>
          r.from.file === SERVICE_ACCRUAL &&
          !r.from.pointer.startsWith(pointer) &&
          r.to.kind === "Element" &&
          idsIn(
            (JSON.parse(files.get(SERVICE_ACCRUAL)!) as Json).tabularSections
              ? (
                  (JSON.parse(files.get(SERVICE_ACCRUAL)!) as Json)
                    .tabularSections as unknown[]
                )[Number(pointer.split("/")[2])]
              : undefined
          ).has(r.to.id)
      )
    )
    expect(index).toBeGreaterThanOrEqual(0)
    const target: ElementTarget = {
      kind: "Document",
      name: "ServiceAccrual",
      element: [raw.tabularSections[index]!.name],
    }
    const result = await deleteElement(files, { target })
    expect(result.ok).toBe(false)
    expect(result.changes).toEqual([])
    expect(result.diagnostics.length).toBeGreaterThan(0)
    for (const d of result.diagnostics) {
      expect(d.code).toBe("operation.delete-referenced")
      expect(d.file).toBe(SERVICE_ACCRUAL)
      expect(d.pointer.startsWith(sectionPointers[index]!)).toBe(false)
    }
    expect(doc.file).toBe(SERVICE_ACCRUAL)
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
