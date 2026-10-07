import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  fixFiles,
  type SchemaPathResolver,
} from "simetra/compiler"
import { formatMetaFile, metadataIdSchema } from "simetra/model"
import { readReferenceDomain } from "./fixtures/reference-domain"
import { metaFiles, project, uuid } from "./helpers"

/** Детермінований джерело id у формі UUID v4: тести не залежать від випадку. */
function counter(start = 900_000): () => string {
  let n = start
  return () => uuid(++n)
}

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

const options = () => ({ schemaPath, newId: counter() })

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Копія JSON без ключів `id` і `physicalName` на будь-якій глибині. */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "id" && key !== "physicalName")
      .map(([key, item]) => [key, strip(item)])
  )
}

/** Значення ключа за кожним pointer, де він трапляється. */
function valuesOf(value: unknown, key: string, at = ""): Map<string, unknown> {
  const found = new Map<string, unknown>()
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      for (const [p, v] of valuesOf(item, key, `${at}/${index}`)) {
        found.set(p, v)
      }
    })
  } else if (isRecord(value)) {
    for (const [k, item] of Object.entries(value)) {
      if (k === key) found.set(at, item)
      for (const [p, v] of valuesOf(item, key, `${at}/${k}`)) found.set(p, v)
    }
  }
  return found
}

const metaPaths = (files: ReadonlyMap<string, string>) =>
  [...files.keys()].filter((path) => path.endsWith(".meta.json"))

function strippedDomain(): Map<string, string> {
  const files = readReferenceDomain()
  for (const path of metaPaths(files)) {
    files.set(path, JSON.stringify(strip(JSON.parse(files.get(path)!))))
  }
  return files
}

describe("fixFiles", () => {
  it("reconstructs the reference domain", async () => {
    const original = readReferenceDomain()
    const result = await fixFiles(strippedDomain(), options())
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    const fixed = applyChanges(strippedDomain(), result.changes)

    for (const path of metaPaths(original)) {
      const before = JSON.parse(original.get(path)!) as unknown
      const after = JSON.parse(fixed.get(path)!) as unknown
      // Правило відтворює кожне авторське фізичне ім'я дослівно.
      expect(Object.fromEntries(valuesOf(after, "physicalName")), path).toEqual(
        Object.fromEntries(valuesOf(before, "physicalName"))
      )
      const ids = valuesOf(after, "id")
      expect([...ids.keys()], path).toEqual([...valuesOf(before, "id").keys()])
      for (const id of ids.values()) {
        expect(metadataIdSchema.safeParse(id).success, String(id)).toBe(true)
      }
    }
    expect((await compile(fixed)).ok).toBe(true)
  })

  it("keeps existing values", async () => {
    const files = readReferenceDomain()
    const path = "catalogs/Currency/Currency.meta.json"
    const currency = JSON.parse(files.get(path)!) as Json
    const attributes = currency.attributes as Json[]
    attributes.push({
      name: "isoName",
      type: "String",
      length: 3,
    })
    files.set(path, JSON.stringify(currency))

    const result = await fixFiles(files, options())
    expect(result.ok).toBe(true)
    const fixed = applyChanges(files, result.changes)
    const after = JSON.parse(fixed.get(path)!) as Json
    const before = JSON.parse(files.get(path)!) as Json
    const idsBefore = valuesOf(before, "id")
    const namesBefore = valuesOf(before, "physicalName")
    for (const [pointer, id] of idsBefore) {
      expect(valuesOf(after, "id").get(pointer)).toBe(id)
    }
    for (const [pointer, name] of namesBefore) {
      expect(valuesOf(after, "physicalName").get(pointer)).toBe(name)
    }
    const added = (after.attributes as Json[])[1]!
    expect(added.physicalName).toBe("iso_name")
    expect(metadataIdSchema.safeParse(added.id).success).toBe(true)
  })

  it("keeps authored physical names the rule would not produce", async () => {
    // Імена домену збігаються з правилом, тож перерахунок їх не виявив би;
    // тут — імена, яких правило не дало б, на об'єкті, реквізиті й мітці.
    const files = readReferenceDomain()
    const edit = (path: string, change: (data: Json) => void) => {
      const data = JSON.parse(files.get(path)!) as Json
      change(data)
      files.set(path, JSON.stringify(data))
    }
    edit("information-registers/Rates/Rates.meta.json", (data) => {
      data.physicalName = "legacy_tbl"
    })
    edit("catalogs/Counterparty/Counterparty.meta.json", (data) => {
      ;(data.attributes as Json[])[0]!.physicalName = "cp_ref"
    })
    edit("enumerations/AccrualKind/AccrualKind.meta.json", (data) => {
      ;(data.values as Json[])[1]!.physicalName = "legacy_bonus"
    })
    const before = await compile(files)
    expect(before.ok).toBe(true)

    const result = await fixFiles(files, options())
    expect(result.ok).toBe(true)
    const fixed = applyChanges(files, result.changes)
    const read = (path: string) => JSON.parse(fixed.get(path)!) as Json
    expect(
      read("information-registers/Rates/Rates.meta.json").physicalName
    ).toBe("legacy_tbl")
    expect(
      (
        read("catalogs/Counterparty/Counterparty.meta.json")
          .attributes as Json[]
      )[0]!.physicalName
    ).toBe("cp_ref")
    expect(
      (
        read("enumerations/AccrualKind/AccrualKind.meta.json").values as Json[]
      )[1]!.physicalName
    ).toBe("legacy_bonus")
    expect((await compile(fixed)).model!.hash).toBe(before.model!.hash)
  })

  it("a reserved word label compiles without a reserved-word warning", async () => {
    // Мітка — літерал даних (CHECK, `predefined_name`), а не ідентифікатор.
    const files = metaFiles({
      "project.meta.json": project(),
      "enumerations/Status/Status.meta.json": {
        kind: "Enumeration",
        name: "Status",
        values: [{ name: "Order" }],
      },
      "catalogs/Item/Item.meta.json": {
        kind: "Catalog",
        name: "Item",
        predefinedItems: [{ name: "Order" }],
      },
    })
    const result = await fixFiles(files, options())
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    const fixed = applyChanges(files, result.changes)
    const status = JSON.parse(
      fixed.get("enumerations/Status/Status.meta.json")!
    )
    const item = JSON.parse(fixed.get("catalogs/Item/Item.meta.json")!)
    expect(status.values[0].physicalName).toBe("order")
    expect(item.predefinedItems[0].physicalName).toBe("order")
  })

  it("keeps an assigned physicalName even when the word is no longer reserved", async () => {
    // Правило слів змінилося, але physicalName призначено раз (Р5)
    const files = metaFiles({
      "project.meta.json": project(),
      "catalogs/Item/Item.meta.json": {
        kind: "Catalog",
        name: "Item",
        attributes: [
          {
            id: uuid(1),
            name: "key",
            type: "String",
            physicalName: "key_",
          },
        ],
      },
    })
    const first = await fixFiles(files, options())
    const fixed = applyChanges(files, first.changes)
    const second = await fixFiles(fixed, options())
    expect(second.changes).toEqual([])
    const item = JSON.parse(fixed.get("catalogs/Item/Item.meta.json")!)
    expect(item.attributes[0].physicalName).toBe("key_")
  })

  it("idempotent", async () => {
    const first = await fixFiles(strippedDomain(), options())
    const fixed = applyChanges(strippedDomain(), first.changes)
    const second = await fixFiles(fixed, options())
    expect(second.changes).toEqual([])
    expect(second.ok).toBe(true)
  })

  it("adds $schema", async () => {
    const result = await fixFiles(readReferenceDomain(), options())
    const fixed = applyChanges(readReferenceDomain(), result.changes)
    expect(JSON.parse(fixed.get("project.meta.json")!).$schema).toBe(
      "schemas-of/project.meta.json/project.schema.json"
    )
    const path = "documents/ServiceAccrual/ServiceAccrual.meta.json"
    expect(JSON.parse(fixed.get(path)!).$schema).toBe(
      `schemas-of/${path}/documents.schema.json`
    )
  })

  it("canonical form", async () => {
    const files = readReferenceDomain()
    const path = "catalogs/Currency/Currency.meta.json"
    const data = JSON.parse(files.get(path)!) as Json
    // Ключі в зворотному порядку, на кожному рівні — один і той самий зміст.
    const reversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversed)
        : isRecord(value)
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([k, v]) => [k, reversed(v)])
            )
          : value
    files.set(path, JSON.stringify(reversed(data)))
    const result = await fixFiles(files, options())
    const change = result.changes.find((c) => c.path === path)
    expect(change?.content).toBe(
      formatMetaFile({
        ...data,
        $schema: schemaPath(path, "catalogs.schema.json"),
      })
    )
  })

  it("same hash", async () => {
    const files = readReferenceDomain()
    const before = await compile(files)
    const result = await fixFiles(files, options())
    expect(result.ok).toBe(true)
    const after = await compile(applyChanges(files, result.changes))
    expect(after.model!.hash).toBe(before.model!.hash)
  })

  it("leaves a file that is not JSON unchanged", async () => {
    const files = readReferenceDomain()
    const path = "catalogs/Currency/Currency.meta.json"
    files.set(path, "{ not json")
    const result = await fixFiles(files, options())
    expect(result.changes.some((c) => c.path === path)).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.some((d) => d.code === "file.invalid-json")).toBe(
      true
    )
  })

  it("too long name is left to the author", async () => {
    // 64 символи — ім'я саме по собі довше за ліміт; 60 — поліморфний
    // `_type` вивів би за ліміт колонку компілятора.
    const long = `a${"b".repeat(63)}`
    const polymorphic = `p${"q".repeat(59)}`
    const files = metaFiles({
      "project.meta.json": project(),
      "catalogs/Item/Item.meta.json": {
        kind: "Catalog",
        name: "Item",
        attributes: [
          { name: long, type: "String", length: 10 },
          {
            name: polymorphic,
            type: "Ref",
            allowedTypes: [
              { kind: "Catalog", name: "Item" },
              { kind: "Catalog", name: "Other" },
            ],
          },
          { name: "note", type: "String", length: 10 },
        ],
      },
      "catalogs/Other/Other.meta.json": { kind: "Catalog", name: "Other" },
    })
    const result = await fixFiles(files, options())
    expect(result.ok).toBe(false)
    const fixed = applyChanges(files, result.changes)
    const item = JSON.parse(fixed.get("catalogs/Item/Item.meta.json")!) as Json
    const [first, second, third] = item.attributes as Json[]
    expect(first!.physicalName).toBeUndefined()
    expect(second!.physicalName).toBeUndefined()
    expect(third!.physicalName).toBe("note")
    expect(item.physicalName).toBe("item")
    const missing = result.diagnostics
      .filter((d) => d.code === "identity.physical-name-missing")
      .map((d) => d.pointer)
    expect(missing).toEqual([
      "/attributes/0/physicalName",
      "/attributes/1/physicalName",
    ])
    const tooLong = result.diagnostics
      .filter((d) => d.code === "operation.physical-name-too-long")
      .map((d) => d.pointer)
    expect(tooLong).toEqual(["/attributes/0", "/attributes/1"])
  })

  it("a register name whose derived tables would be too long is left to the author", async () => {
    // 50 байтів + `_turnovers_month` (16) > 63, хоча саме ім'я влазить.
    const name = `R${"x".repeat(49)}`
    const files = metaFiles({
      "project.meta.json": project(),
      [`accumulation-registers/${name}/${name}.meta.json`]: {
        kind: "AccumulationRegister",
        name,
        resources: [{ name: "amount", type: "Numeric", precision: 15 }],
      },
    })
    const result = await fixFiles(files, options())
    const fixed = applyChanges(files, result.changes)
    const register = JSON.parse(
      fixed.get(`accumulation-registers/${name}/${name}.meta.json`)!
    ) as Json
    expect(register.physicalName).toBeUndefined()
    expect(
      result.diagnostics.some(
        (d) => d.code === "operation.physical-name-too-long" && d.pointer === ""
      )
    ).toBe(true)
  })
})

describe("applyChanges", () => {
  it("writes and deletes", () => {
    const files = new Map([
      ["a", "1"],
      ["b", "2"],
    ])
    const result = applyChanges(files, [
      { path: "a", content: "10" },
      { path: "b", content: null },
      { path: "c", content: "3" },
    ])
    expect([...result]).toEqual([
      ["a", "10"],
      ["c", "3"],
    ])
    expect(files.get("b")).toBe("2")
  })
})
