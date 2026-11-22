import { describe, expect, it } from "vitest"
import {
  applyChanges,
  compile,
  fixFiles,
  type SchemaPathResolver,
} from "simetra/compiler"
import { formatMetaFile, metadataIdSchema } from "simetra/model"
import { guardStatement } from "../operations/fix-repair"
import { readReferenceDomain } from "./fixtures/reference-domain"
import {
  REASSIGN_ACTION_ID,
  policyDomain,
  withRoles,
  writeRoles,
} from "./fixtures/rights"
import {
  expectClean,
  acceptDebt,
  catalog,
  customTable,
  metaFiles,
  project,
  SCOPE_FUNCTIONS_FILE,
  uuid,
} from "./helpers"

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

/** Копія JSON без призначених ключів (`id`, `physicalName`, `kindLabel`) на будь-якій глибині. */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["id", "physicalName", "kindLabel"].includes(key))
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
    expectClean(result, { allow: ["rights.scope-kind-unread"] })
    expect(result.ok).toBe(true)
    const fixed = applyChanges(strippedDomain(), result.changes)

    for (const path of metaPaths(original)) {
      const before = JSON.parse(original.get(path)!) as unknown
      const after = JSON.parse(fixed.get(path)!) as unknown
      // Правило відтворює кожне авторське фізичне ім'я дослівно.
      expect(Object.fromEntries(valuesOf(after, "physicalName")), path).toEqual(
        Object.fromEntries(valuesOf(before, "physicalName"))
      )
      expect((after as Json).kindLabel, path).toBe((before as Json).kindLabel)
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

  it("fix assigns kindLabel project-wide, never changing an existing one", async () => {
    // Однойменні об'єкти різних PG-схем: мітка — літерал даних, унікальний
    // на весь проєкт, тож друга отримує суфікс за порядком файлів.
    const files = metaFiles({
      "project.meta.json": project(),
      "catalogs/Contract/Contract.meta.json": {
        kind: "Catalog",
        name: "Contract",
      },
      "documents/Contract/Contract.meta.json": {
        kind: "Document",
        name: "Contract",
        schema: "billing",
      },
      "documents/Order/Order.meta.json": {
        kind: "Document",
        name: "Order",
        kindLabel: "contract_x",
      },
    })
    const result = await fixFiles(files, options())
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    const fixed = applyChanges(files, result.changes)
    const label = (path: string) =>
      (JSON.parse(fixed.get(path)!) as Json).kindLabel
    expect(label("catalogs/Contract/Contract.meta.json")).toBe("contract")
    expect(label("documents/Contract/Contract.meta.json")).toBe("contract_")
    expect(label("documents/Order/Order.meta.json")).toBe("contract_x")
    // Мітка — не ідентифікатор: зарезервоване слово її не зсуває, а
    // фізичне ім'я того ж об'єкта зсуває.
    const order = JSON.parse(
      fixed.get("documents/Order/Order.meta.json")!
    ) as Json
    expect(order.physicalName).toBe("order_")

    const again = await fixFiles(fixed, options())
    expect(again.changes).toEqual([])
  })

  it("a reserved word kind label is not shifted", async () => {
    const files = metaFiles({
      "project.meta.json": project(),
      "documents/Order/Order.meta.json": { kind: "Document", name: "Order" },
    })
    const result = await fixFiles(files, options())
    expect(result.ok).toBe(true)
    const order = JSON.parse(
      applyChanges(files, result.changes).get(
        "documents/Order/Order.meta.json"
      )!
    ) as Json
    expect(order.physicalName).toBe("order_")
    expect(order.kindLabel).toBe("order")
  })

  it("fix labels a custom table only with a single uuid key", async () => {
    const column = (name: string, type: string) => ({
      name,
      type,
      notNull: true,
    })
    const files = metaFiles({
      "project.meta.json": project(),
      "custom-tables/Note/Note.meta.json": {
        kind: "CustomTable",
        name: "Note",
        columns: [column("id", "UUID")],
        primaryKey: { name: "note_pk", columns: ["id"] },
      },
      "custom-tables/Tag/Tag.meta.json": {
        kind: "CustomTable",
        name: "Tag",
        columns: [column("tag", "Text")],
        primaryKey: { name: "tag_pk", columns: ["tag"] },
      },
      "custom-tables/Log/Log.meta.json": {
        kind: "CustomTable",
        name: "Log",
        columns: [column("id", "UUID")],
      },
    })
    const result = await fixFiles(files, options())
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    const fixed = applyChanges(files, result.changes)
    const read = (name: string) =>
      JSON.parse(fixed.get(`custom-tables/${name}/${name}.meta.json`)!) as Json
    expect(read("Note").kindLabel).toBe("note")
    expect(read("Tag")).not.toHaveProperty("kindLabel")
    expect(read("Log")).not.toHaveProperty("kindLabel")
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

describe("fixFiles: debt ratchet", () => {
  const DEBT = "sql-debt.json"
  const TABLE_SQL = "custom-tables/T/T.sql"
  const tableFiles = (sql: string, debt?: string[]) =>
    metaFiles({
      "project.meta.json": project(),
      "custom-tables/T/T.meta.json": customTable("T"),
      [TABLE_SQL]: sql,
      ...(debt === undefined
        ? {}
        : { [DEBT]: JSON.stringify({ units: debt }) }),
    })

  it("fix drops stale debt entries and never adds new ones", async () => {
    const files = tableFiles(
      "CREATE POLICY p ON public.t USING (true);\nCREATE POLICY q ON public.t USING (true);",
      ["policy:public.t.gone", "policy:public.t.p"]
    )
    const result = await fixFiles(files, options())
    const fixed = applyChanges(files, result.changes)
    expect(JSON.parse(fixed.get(DEBT)!)).toEqual({
      $schema: `schemas-of/${DEBT}/sql-debt.schema.json`,
      units: ["policy:public.t.p"],
    })
    // Нова одиниця лишається поза переліком: ратчет далі її звітує.
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((d) => [d.code, d.params?.identity])).toEqual(
      [["sql.debt-grows", "policy:public.t.q"]]
    )
  })

  it("fix clears sql.debt-stale of a deleted debt unit", async () => {
    // Оператор боргу видалено: компіляція називає запис застарілим, а `fix`
    // прибирає рівно його.
    const files = tableFiles("CREATE POLICY p ON public.t USING (true);", [
      "policy:public.t.gone",
      "policy:public.t.p",
    ])
    const before = await compile(files)
    expect(before.diagnostics.map((d) => [d.code, d.params?.identity])).toEqual(
      [["sql.debt-stale", "policy:public.t.gone"]]
    )
    const result = await fixFiles(files, options())
    expect(result.ok).toBe(true)
    expect(result.diagnostics).toEqual([])
    const fixed = applyChanges(files, result.changes)
    expect(JSON.parse(fixed.get(DEBT)!).units).toEqual(["policy:public.t.p"])
  })

  it("fix sorts and deduplicates the list", async () => {
    const files = tableFiles(
      "CREATE POLICY p ON public.t USING (true);\nCREATE POLICY q ON public.t USING (true);",
      ["policy:public.t.q", "policy:public.t.p", "policy:public.t.q"]
    )
    const result = await fixFiles(files, options())
    expect(result.ok).toBe(true)
    const fixed = applyChanges(files, result.changes)
    expect(JSON.parse(fixed.get(DEBT)!).units).toEqual([
      "policy:public.t.p",
      "policy:public.t.q",
    ])
  })

  it("fix does not create sql-debt.json", async () => {
    const files = tableFiles("CREATE POLICY p ON public.t USING (true);")
    const result = await fixFiles(files, options())
    expect(result.changes.map((c) => c.path)).not.toContain(DEBT)
    expect(result.diagnostics.map((d) => d.code)).toEqual(["sql.debt-grows"])
  })

  it("fix keeps the list when the debt of the folder is unknown", async () => {
    // Нерозібраний `.sql` не дає одиниць: звуження за ними стерло б записи.
    const files = tableFiles("CREATE POLICY p ON", ["policy:public.t.p"])
    const result = await fixFiles(files, options())
    expect(result.changes.map((c) => c.path)).not.toContain(DEBT)
  })
})

describe("fixFiles: sql.generated-grant", () => {
  const DEBT = "sql-debt.json"
  const GRANTS = "sql/public/g.sql"
  const OTHER =
    "CREATE FUNCTION public.other() RETURNS integer LANGUAGE sql STABLE AS $$ SELECT 1 $$;"
  const OTHER_GRANT = "GRANT EXECUTE ON FUNCTION public.other() TO anon;"
  const OWNED_GRANT = "GRANT EXECUTE ON FUNCTION public.my_orgs() TO anon;"

  /** Вид скоупу з функцією множини `public.my_orgs()`; борг теки прийнято. */
  const grantFiles = (sql: string) =>
    acceptDebt(
      metaFiles({
        "project.meta.json": project({
          scopeKinds: [
            {
              id: uuid(9301),
              name: "org",
              physicalName: "org_id",
              root: { object: { kind: "Catalog", name: "Organization" } },
              setFunction: { name: "my_orgs" },
            },
          ],
        }),
        "catalogs/Organization/Organization.meta.json": catalog(
          "Organization",
          { scope: "org" }
        ),
        [GRANTS]: sql,
      })
    )

  it("fix cuts only the contradicting statement and narrows the debt", async () => {
    const files = await grantFiles(
      `${OTHER}\n\n${OWNED_GRANT}\n\n${OTHER_GRANT}\n`
    )
    expect(JSON.parse(files.get(DEBT)!).units).toContain(
      "grant:grant:function:public.my_orgs():anon:execute"
    )
    const before = await compile(files)
    expect(
      before.diagnostics
        .filter((d) => d.code !== "rights.scope-kind-unread")
        .map((d) => d.code)
    ).toEqual(["sql.generated-grant"])
    const result = await fixFiles(files, options())
    expectClean(result, { allow: ["rights.scope-kind-unread"] })
    expect(result.ok).toBe(true)
    const fixed = applyChanges(files, result.changes)
    expect(fixed.get(GRANTS)).toBe(`${OTHER}\n\n${OTHER_GRANT}\n`)
    expect(JSON.parse(fixed.get(DEBT)!).units).toEqual([
      "grant:grant:function:public.other():anon:execute",
    ])
    expectClean(await compile(fixed), { allow: ["rights.scope-kind-unread"] })
  })

  it("fix leaves a statement that also grants on another object", async () => {
    // Виріз забрав би й законний грант на `public.other()`: оператор ділить людина.
    const mixed =
      "GRANT EXECUTE ON FUNCTION public.my_orgs(), public.other() TO anon;"
    const files = await grantFiles(`${OTHER}\n\n${mixed}\n`)
    const result = await fixFiles(files, options())
    expect(result.ok).toBe(false)
    expect(
      result.diagnostics
        .filter((d) => d.code !== "rights.scope-kind-unread")
        .map((d) => [d.code, d.params?.object])
    ).toEqual([["sql.generated-grant", "public.my_orgs()"]])
    expect(result.changes.map((c) => c.path)).not.toContain(GRANTS)
    expect(applyChanges(files, result.changes).get(GRANTS)).toBe(
      files.get(GRANTS)
    )
  })

  it("fix deletes a file left without statements", async () => {
    const files = await grantFiles(`${OWNED_GRANT}\n`)
    const result = await fixFiles(files, options())
    expect(result.ok).toBe(true)
    expect(result.changes).toContainEqual({ path: GRANTS, content: null })
    const fixed = applyChanges(files, result.changes)
    expect(fixed.has(GRANTS)).toBe(false)
    expect(JSON.parse(fixed.get(DEBT)!).units).toEqual([])
  })

  it("fix cuts a verbatim grant on a declared function", async () => {
    // ACL задекларованої функції належить платформі повністю (спека
    // декларацій функцій §5.1): дослівний грант на неї — лише її ціль.
    const declaredSql =
      "CREATE FUNCTION public.svc() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;\n"
    const files = await acceptDebt(
      metaFiles({
        "project.meta.json": project(),
        "sql/public/fns.sql": declaredSql,
        "sql/public/fns.functions.json": JSON.stringify({
          functions: [
            {
              id: uuid(9311),
              function: { name: "svc" },
              callers: ["service"],
            },
          ],
        }),
        [GRANTS]: `${OTHER}\n\nGRANT EXECUTE ON FUNCTION public.svc() TO anon;\n\n${OTHER_GRANT}\n`,
      })
    )
    expect(
      (await compile(files)).diagnostics.map((d) => [d.code, d.params?.object])
    ).toEqual([["sql.generated-grant", "public.svc()"]])
    const result = await fixFiles(files, options())
    expect(result.ok).toBe(true)
    const fixed = applyChanges(files, result.changes)
    expect(fixed.get(GRANTS)).toBe(`${OTHER}\n\n${OTHER_GRANT}\n`)
    expectClean(await compile(fixed))
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

describe("fixFiles: function declarations (repair mode)", () => {
  const SQL = "sql/public/fns.sql"
  const FUNCTIONS = "sql/public/fns.functions.json"
  const CHECK = {
    action: "read",
    object: { kind: "Document" as const, name: "Task" },
    row: "p_row",
  }
  const create = (
    name: string,
    body = "BEGIN PERFORM 1; END",
    { head = "SECURITY DEFINER", lang = "plpgsql", literal = "$$" } = {}
  ) =>
    `CREATE FUNCTION public.${name}(p_row uuid) RETURNS void LANGUAGE ${lang} STABLE ${head} SET search_path = '' AS ${literal}${body}${literal};\n`
  const declared = (name: string, check: unknown = CHECK, id?: string) => ({
    ...(id === undefined ? {} : { id }),
    function: { name },
    callers: ["user"],
    check,
  })
  const folder = (sql: string, functions?: unknown[], layer = withRoles) => {
    const files = layer()
    files.set(SQL, sql)
    if (functions !== undefined) {
      files.set(FUNCTIONS, JSON.stringify({ functions }))
    }
    return files
  }
  const sqlAfter = (files: Map<string, string>, result: { changes: never[] }) =>
    applyChanges(files, result.changes).get(SQL)!
  const errorCodes = (r: {
    diagnostics: readonly { severity: string; code: string }[]
  }) => r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)

  describe("(а) ids of function declarations", () => {
    it("assigns an id to every record without one and keeps the existing ones", async () => {
      const files = folder(
        create(
          "f",
          "BEGIN PERFORM simetra.rights_require('read', 'task', p_row); END"
        ) +
          create(
            "g",
            "BEGIN PERFORM simetra.rights_require('read', 'task', p_row); END"
          ),
        [declared("f"), declared("g", CHECK, uuid(5001))]
      )
      const result = await fixFiles(files, options())
      expect(result.ok).toBe(true)
      const records = (
        JSON.parse(applyChanges(files, result.changes).get(FUNCTIONS)!) as {
          functions: { function: { name: string }; id?: string }[]
        }
      ).functions
      expect(records.map((r) => r.function.name)).toEqual(["f", "g"])
      expect(metadataIdSchema.safeParse(records[0]!.id).success).toBe(true)
      expect(records[1]!.id).toBe(uuid(5001))
    })
  })

  describe("(в) the call guard (Б1)", () => {
    it("inserts rights_require with the declared action, the kind label and the row parameter", async () => {
      const files = folder(create("f"), [declared("f")])
      const result = await fixFiles(files, options())
      expect(sqlAfter(files, result as never)).toBe(
        create(
          "f",
          "BEGIN PERFORM simetra.rights_require('read', 'task', p_row); PERFORM 1; END"
        )
      )
      // Підсумок доводить `guardOf`: помилок немає зовсім.
      expect(errorCodes(result)).toEqual([])
      expect(result.ok).toBe(true)
    })

    it("puts the guard on its own line with the indent of the body", async () => {
      const files = folder(create("f", "BEGIN\n  PERFORM 1;\nEND"), [
        declared("f"),
      ])
      const result = await fixFiles(files, options())
      expect(sqlAfter(files, result as never)).toBe(
        create(
          "f",
          "BEGIN\n  PERFORM simetra.rights_require('read', 'task', p_row);\n  PERFORM 1;\nEND"
        )
      )
      expect(result.ok).toBe(true)
    })

    it("a CRLF body gets the guard like an LF one", async () => {
      const files = folder(create("f", "BEGIN\r\n  PERFORM 1;\r\nEND"), [
        declared("f"),
      ])
      const result = await fixFiles(files, options())
      expect(sqlAfter(files, result as never)).toBe(
        create(
          "f",
          "BEGIN\r\n  PERFORM simetra.rights_require('read', 'task', p_row);\r\n  PERFORM 1;\r\nEND"
        )
      )
      expect(errorCodes(result)).toEqual([])
    })

    it("a scope target gets rights_require_scope", async () => {
      const files = folder(create("f").replace("p_row uuid", "p_org uuid"), [
        declared("f", {
          action: "create",
          object: CHECK.object,
          scope: "p_org",
        }),
      ])
      const result = await fixFiles(files, options())
      expect(errorCodes(result)).toEqual([])
      expect(sqlAfter(files, result as never)).toContain(
        "BEGIN PERFORM simetra.rights_require_scope('create', 'task', p_org);"
      )
    })

    it("a check without a target gets NULL", async () => {
      // Довідник без носіїв рядка: ціль для нього заборонена.
      const files = folder(create("f"), [
        declared("f", {
          action: "read",
          object: { kind: "Catalog", name: "Note" },
        }),
      ])
      files.set(
        "catalogs/Note/Note.meta.json",
        JSON.stringify(catalog("Note", { scope: "none" }))
      )
      const result = await fixFiles(files, options())
      expect(errorCodes(result)).toEqual([])
      expect(sqlAfter(files, result as never)).toContain(
        "BEGIN PERFORM simetra.rights_require('read', 'note', NULL);"
      )
    })

    it("a custom action is written as its uuid, not its name", async () => {
      const files = folder(
        create("f"),
        [declared("f", { ...CHECK, action: "reassign" })],
        () => policyDomain(writeRoles())
      )
      const result = await fixFiles(files, options())
      expect(errorCodes(result)).toEqual([])
      expect(sqlAfter(files, result as never)).toContain(
        `rights_require('${REASSIGN_ACTION_ID}', 'task', p_row);`
      )
    })

    it("quotes a label with an apostrophe and a target that needs quotes", () => {
      expect(
        guardStatement(
          { schema: "simetra", name: "rights_require" },
          "read",
          "o'brien",
          "Row"
        )
      ).toBe("PERFORM simetra.rights_require('read', 'o''brien', \"Row\");")
    })

    it("takes the label and the action from the contract of the named object", async () => {
      // Мітка — не вигадана: у тілі лежить саме `kindLabel` об'єкта check.
      const files = folder(create("f"), [declared("f")])
      files.set(
        "documents/Task/Task.meta.json",
        JSON.stringify({
          ...JSON.parse(files.get("documents/Task/Task.meta.json")!),
          kindLabel: "task_x",
        })
      )
      const result = await fixFiles(files, options())
      expect(sqlAfter(files, result as never)).toContain("'read', 'task_x'")
    })
  })

  describe("(в) bodies fix does not touch (Б2)", () => {
    const untouched = async (sql: string, check: unknown = CHECK) => {
      const files = folder(sql, [declared("f", check, uuid(5101))])
      const result = await fixFiles(files, options())
      expect(applyChanges(files, result.changes).get(SQL)).toBe(sql)
      return result
    }

    it.each([
      ["DECLARE", create("f", "DECLARE v int; BEGIN PERFORM 1; END")],
      [
        "an outer EXCEPTION section",
        create("f", "BEGIN PERFORM 1; EXCEPTION WHEN OTHERS THEN NULL; END"),
      ],
      [
        "a guard with other arguments",
        create(
          "f",
          "BEGIN PERFORM simetra.rights_require('create', 'task', p_row); END"
        ),
      ],
      [
        "a guard of the wrong form",
        create(
          "f",
          "BEGIN PERFORM simetra.rights_require_scope('read', 'task', p_row); END"
        ),
      ],
      [
        "a guard that is not evaluated (WHERE false)",
        create(
          "f",
          "BEGIN PERFORM simetra.rights_require('read', 'task', p_row) WHERE false; PERFORM 1; END"
        ),
      ],
      [
        "a guard call deeper in the body",
        create(
          "f",
          "BEGIN PERFORM 1; IF true THEN PERFORM simetra.rights_require('read', 'task', p_row); END IF; END"
        ),
      ],
      [
        "a guard named by a unicode escape",
        create(
          "f",
          "BEGIN PERFORM 1; PERFORM simetra.U&\"rights\\005frequire\"('read', 'task', p_row); END"
        ),
      ],
      [
        "a single-quoted body",
        create("f", "BEGIN PERFORM 1; END", { literal: "'" }),
      ],
    ])(
      "%s: the body stays byte for byte, the error stays",
      async (_name, sql) => {
        const result = await untouched(sql)
        expect(result.ok).toBe(false)
        // Хибний запобіжник судить ще й `platform-function-call`: помилка
        // лишається в обох випадках, тіло — без змін (`untouched`).
        expect(
          errorCodes(result).some(
            (code) =>
              code === "sql.declaration-check-not-applied" ||
              code === "sql.platform-function-call"
          )
        ).toBe(true)
      }
    )

    it("a sql-language body is not touched", async () => {
      const sql = create("f", " SELECT 1 ", { lang: "sql" })
      const result = await untouched(sql)
      expect(errorCodes(result)).toContain("sql.declaration-check-not-applied")
    })

    it("an invoker function is not touched", async () => {
      const files = folder(create("f", "BEGIN PERFORM 1; END", { head: "" }), [
        declared("f", undefined, uuid(5102)),
      ])
      const result = await fixFiles(files, options())
      expect(result.changes.map((c) => c.path)).not.toContain(SQL)
    })

    it("the guard goes after the outer BEGIN, past a label and a comment with begin", async () => {
      const files = folder(
        create("f", "/* begin */ <<blk>> -- begin\nBEGIN PERFORM 1; END"),
        [declared("f")]
      )
      const result = await fixFiles(files, options())
      expect(sqlAfter(files, result as never)).toBe(
        create(
          "f",
          "/* begin */ <<blk>> -- begin\nBEGIN PERFORM simetra.rights_require('read', 'task', p_row); PERFORM 1; END"
        )
      )
      expect(errorCodes(result)).toEqual([])
    })
  })

  describe("repair mode (Б5)", () => {
    const g = create("g", "DECLARE v int; BEGIN PERFORM 1; END")

    it("writes what it fixed and leaves the other function with its repair-class error", async () => {
      const files = folder(create("f") + g, [declared("f"), declared("g")])
      const result = await fixFiles(files, options())
      expect(result.ok).toBe(false)
      expect(result.written).toBe(true)
      expect(
        result.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => [d.code, d.params?.name])
      ).toEqual([["sql.declaration-check-not-applied", "g"]])
      expect(sqlAfter(files, result as never)).toContain(
        "rights_require('read', 'task', p_row); PERFORM 1;"
      )
    })

    it("writes nothing when it removes no repair-class error", async () => {
      // Лишилась лише `g`: механічне доповнення (id) є, але ремонту немає.
      const files = folder(g, [declared("g")])
      const result = await fixFiles(files, options())
      expect(result.ok).toBe(false)
      expect(result.written).toBeUndefined()
    })

    it("writes nothing when the folder has an error outside the class", async () => {
      const files = folder(create("f"), [declared("f")])
      files.set("catalogs/Broken/Broken.meta.json", "{")
      const result = await fixFiles(files, options())
      expect(result.ok).toBe(false)
      expect(result.written).toBeUndefined()
    })

    it("a clean result is written as before, without the marker", async () => {
      const files = folder(create("f"), [declared("f", CHECK, uuid(5201))])
      const result = await fixFiles(files, options())
      expect(result.ok).toBe(true)
      expect(result.written).toBeUndefined()
      expect(result.changes.map((c) => c.path)).toContain(SQL)
    })
  })

  describe("(г) a declaration that became a platform form (Б5)", () => {
    const TEAM_SQL = "sql/public/team.sql"
    const TEAM_FUNCTIONS = "sql/public/team.functions.json"
    const teamFiles = (callers: string[]) => {
      const files = metaFiles({
        "project.meta.json": project({
          scopeKinds: [
            {
              id: uuid(9401),
              name: "team",
              physicalName: "team_id",
              root: {
                external: { schema: "public", table: "teams", column: "id" },
              },
              setFunction: { schema: "public", name: "team_ids" },
            },
          ],
        }),
        "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
        [TEAM_SQL]: `CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT NULL::uuid $$;\n`,
        [TEAM_FUNCTIONS]: JSON.stringify({
          functions: [
            { id: uuid(9402), function: { name: "team_ids" }, callers },
          ],
        }),
      })
      // Функція множини — авторська (`team.sql`): спільний файл фікстури
      // створив би другу.
      files.delete(SCOPE_FUNCTIONS_FILE)
      return files
    }

    it("removes the declaration the forms cover with the same callers", async () => {
      const files = teamFiles(["user", "command", "service"])
      expect(errorCodes(await compile(files, { repair: true }))).toContain(
        "sql.declaration-platform-form"
      )
      const result = await fixFiles(files, options())
      expect(result.ok).toBe(true)
      expect(
        result.changes.find((c) => c.path === TEAM_FUNCTIONS)?.content
      ).toBeNull()
    })

    it("does not write a form wider than the declaration and reports the warning", async () => {
      const files = teamFiles(["service"])
      const result = await fixFiles(files, options())
      expect(result.changes.map((c) => c.path)).not.toContain(TEAM_FUNCTIONS)
      expect(errorCodes(result)).toContain("sql.declaration-platform-form")
      expect(
        result.diagnostics
          .filter((d) => d.code === "sql.declaration-platform-form-widens")
          .map((d) => d.params?.roles)
      ).toEqual(["user, command"])
      const [warning] = result.diagnostics.filter(
        (d) => d.code === "sql.declaration-platform-form-widens"
      )
      expect(warning!.params?.declined).toBe(1)
      expect(warning!.message).toContain("its declaration is not removed")
      expect(warning!.message).not.toContain("declaration is removed")
      expect(result.written).toBeUndefined()
    })
  })

  describe("(д) ALTER DEFAULT PRIVILEGES (Б6)", () => {
    const ADP_FILE = "sql/app/adp.sql"
    const FNS = "sql/public/fns.sql"
    const base = (adp: string) =>
      acceptDebt(
        metaFiles({
          "project.meta.json": project(),
          "catalogs/Item/Item.meta.json": catalog("Item"),
          // Недекларована definer-функція лишає помилку класу, тож результат
          // пишеться як ремонт, а не як чистий.
          [FNS]:
            "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;\n",
          [ADP_FILE]: adp,
        })
      )
    const run = async (adp: string) => {
      const files = await base(adp)
      const result = await fixFiles(files, options())
      return { files, result, after: applyChanges(files, result.changes) }
    }
    const ADP_FN = (to: string, scope = "IN SCHEMA app ") =>
      `ALTER DEFAULT PRIVILEGES ${scope}GRANT EXECUTE ON FUNCTIONS TO ${to};\n`
    const adpErrors = (r: { diagnostics: readonly { code: string }[] }) =>
      r.diagnostics.filter((d) => d.code === "sql.default-privileges-execute")

    it("cuts only the flagged statement, next to a table ADP", async () => {
      const tables =
        "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO anon;\n"
      const { result, after } = await run(`${tables}\n${ADP_FN("anon")}`)
      expect(adpErrors(result)).toEqual([])
      expect(after.get(ADP_FILE)).toBe(`${tables}\n`)
      expect(result.written).toBe(true)
    })

    it("cuts the whole statement with mixed grantees", async () => {
      const { result, after } = await run(
        ADP_FN("anon, authenticated, PUBLIC, simetra_command")
      )
      expect(adpErrors(result)).toEqual([])
      expect(after.has(ADP_FILE)).toBe(false)
    })

    it("leaves the provider owner's statement in the managed schema with the preset", async () => {
      const preset =
        "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, PUBLIC;\n"
      const { result, after } = await run(preset)
      // Змішаний отримувач (PUBLIC) — помилка лишається людині, текст без змін.
      expect(adpErrors(result)).toHaveLength(1)
      expect(after.get(ADP_FILE)).toBe(preset)
    })

    it("leaves the provider owner's statement over several schemas when one is managed", async () => {
      const multi =
        "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public, app GRANT EXECUTE ON FUNCTIONS TO anon, PUBLIC;\n"
      const { result, after } = await run(multi)
      expect(adpErrors(result)).toHaveLength(1)
      expect(after.get(ADP_FILE)).toBe(multi)
    })

    it("leaves the provider owner's statement in public with API-role grantees only", async () => {
      const preset =
        "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;\n"
      const { result, after } = await run(preset)
      expect(adpErrors(result)).toEqual([])
      expect(after.get(ADP_FILE)).toBe(preset)
    })

    it("cuts an ADP of a CRLF file next to a table ADP", async () => {
      const tables =
        "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO anon;\r\n"
      const { result, after } = await run(
        `${tables}\r\n${ADP_FN("anon").replace("\n", "\r\n")}`
      )
      expect(adpErrors(result)).toEqual([])
      expect(after.get(ADP_FILE)).toBe(`${tables}\r\n`)
    })

    it("cuts an ADP and inserts a guard in the same file", async () => {
      // Вставка запобіжника зсуває рядки: вирізання не мусить шукати одиницю
      // за застарілим рядком.
      // Тіло в кілька рядків: вставка додає рядок і зсуває ADP нижче.
      const sql =
        create("f", "BEGIN\n  PERFORM 1;\nEND") + "\n" + ADP_FN("anon")
      const files = await acceptDebt(
        folder(sql, [declared("f", CHECK, uuid(5301))])
      )
      const result = await fixFiles(files, options())
      const after = applyChanges(files, result.changes).get(SQL)!
      expect(after).not.toContain("DEFAULT PRIVILEGES")
      expect(after).toContain("rights_require('read', 'task', p_row)")
      expect(errorCodes(result)).toEqual([])
    })

    it("cuts a global statement whose grantees are PUBLIC and the API roles", async () => {
      const { result, after } = await run(ADP_FN("PUBLIC, anon", ""))
      expect(adpErrors(result)).toEqual([])
      expect(after.has(ADP_FILE)).toBe(false)
    })

    it("leaves a global statement that also names the command role", async () => {
      const statement = ADP_FN("PUBLIC, simetra_command", "")
      const { result, after } = await run(statement)
      expect(adpErrors(result)).toHaveLength(1)
      expect(after.get(ADP_FILE)).toBe(statement)
    })

    it("narrows the debt of the cut statement", async () => {
      const { files, after } = await run(ADP_FN("anon"))
      const units = (map: ReadonlyMap<string, string>) =>
        (JSON.parse(map.get("sql-debt.json")!) as { units: string[] }).units
      expect(units(files).some((u) => u.includes("defaultPrivileges"))).toBe(
        true
      )
      expect(units(after).some((u) => u.includes("defaultPrivileges"))).toBe(
        false
      )
    })
  })
})
