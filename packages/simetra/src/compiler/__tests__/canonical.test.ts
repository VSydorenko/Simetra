import { describe, expect, it } from "vitest"
import {
  canonicalSnapshot,
  canonicalize,
  compile,
  type CompiledModel,
} from "simetra/compiler"
import {
  SALE_FILE,
  STOCK_FILE,
  attribute,
  metaFiles,
  project,
  salesDocument,
} from "./helpers"

const MISC = "sql/public/misc.sql"

const SQL = [
  "CREATE VIEW public.answers AS SELECT 1 AS one;",
  "CREATE FUNCTION public.answer() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 42 $$;",
].join("\n")

/** Той самий SQL: інші пробіли, регістр ключових слів, коментарі, усе на рядок нижче. */
const SQL_REFORMATTED = [
  "-- представлення відповідей",
  "create   view public.answers as",
  "  select 1 as one -- одиниця",
  ";",
  "/* функція */ create function public.answer() returns integer",
  "  language sql immutable as $$ SELECT 42 $$;",
].join("\n")

function chars(...codes: number[]): string {
  return String.fromCharCode(...codes)
}

/** Число з бітового подання IEEE 754 — так задано вектори додатка B RFC 8785. */
function fromBits(hex: string): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(`0x${hex}`))
  return view.getFloat64(0)
}

/**
 * Проєкт з документом (обов'язковий реквізит шапки, ТЧ, рухи-вирази), регістром
 * і спільним `.sql`. Об'єкти будуються один раз: `freshId` дає нові id щоразу.
 */
function fixture(): Record<string, unknown> {
  const entries: Record<string, unknown> = {
    "project.meta.json": project(),
    ...salesDocument({ condition: "row.qty > 0" }),
    [MISC]: SQL,
  }
  const sale = entries[SALE_FILE] as Record<string, unknown>
  sale.attributes = [
    attribute("customer", {
      physicalName: "customer_id",
      type: "Ref",
      ref: { kind: "Catalog", name: "Item" },
      required: true,
    }),
    attribute("comment", {
      physicalName: "comment",
      type: "String",
      length: 100,
    }),
  ]
  return entries
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Ключі кожного об'єкта у зворотному порядку — та сама модель, інший файл. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseKeys(child)])
  )
}

async function compileModel(
  files: ReadonlyMap<string, string>
): Promise<CompiledModel> {
  const result = await compile(files)
  expect(result.diagnostics).toEqual([])
  return result.model!
}

async function hashOf(entries: Record<string, unknown>): Promise<string> {
  return (await compileModel(metaFiles(entries))).hash
}

describe("canonicalize", () => {
  it("canonicalize sorts keys by code units and serializes numbers like JCS", () => {
    // RFC 8785 §3.2.2: приклад з літералами, числами й екрануванням рядка.
    // Символи — кодами: редактор чи форматер не перепише escape-послідовність.
    // Перше число — текстом з RFC: як літерал воно втрачає точність ще в
    // джерелі, а округлення до найближчого double і є частиною вектора.
    expect(
      canonicalize({
        numbers: [Number("333333333.33333329"), 1e30, 4.5, 2e-3, 1e-27],
        string: chars(
          0x20ac,
          0x24,
          0x0f,
          0x0a,
          0x41,
          0x27,
          0x42,
          0x22,
          0x5c,
          0x5c,
          0x22,
          0x2f
        ),
        literals: [null, true, false],
      })
    ).toBe(
      `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${chars(0x20ac)}$\\u000f\\nA'B\\"\\\\\\\\\\"/"}`
    )

    // RFC 8785 §3.2.3: порядок за кодовими одиницями UTF-16 — емодзі (сурогатна
    // пара D83D DE00) стоїть перед U+FB33, хоча його кодова точка більша;
    // localeCompare дав би інший порядок.
    const keys = {
      euro: chars(0x20ac),
      cr: chars(0x0d),
      dalet: chars(0xfb33),
      one: "1",
      emoji: chars(0xd83d, 0xde00),
      control: chars(0x80),
      o: chars(0xf6),
    }
    const sorted = canonicalize({
      [keys.euro]: "Euro Sign",
      [keys.cr]: "Carriage Return",
      [keys.dalet]: "Hebrew Letter Dalet With Dagesh",
      [keys.one]: "One",
      [keys.emoji]: "Emoji: Grinning Face",
      [keys.control]: "Control",
      [keys.o]: "Latin Small Letter O With Diaeresis",
    })
    expect(sorted).toBe(
      "{" +
        [
          `"\\r":"Carriage Return"`,
          `"1":"One"`,
          `"${keys.control}":"Control"`,
          `"${keys.o}":"Latin Small Letter O With Diaeresis"`,
          `"${keys.euro}":"Euro Sign"`,
          `"${keys.emoji}":"Emoji: Grinning Face"`,
          `"${keys.dalet}":"Hebrew Letter Dalet With Dagesh"`,
        ].join(",") +
        "}"
    )

    // RFC 8785 додаток B: бітове подання → очікуваний текст.
    const vectors: [string, string][] = [
      ["0000000000000000", "0"],
      ["8000000000000000", "0"],
      ["0000000000000001", "5e-324"],
      ["8000000000000001", "-5e-324"],
      ["7fefffffffffffff", "1.7976931348623157e+308"],
      ["ffefffffffffffff", "-1.7976931348623157e+308"],
      ["4340000000000000", "9007199254740992"],
      ["c340000000000000", "-9007199254740992"],
      ["4430000000000000", "295147905179352830000"],
      ["44b52d02c7e14af5", "9.999999999999997e+22"],
      ["44b52d02c7e14af6", "1e+23"],
      ["44b52d02c7e14af7", "1.0000000000000001e+23"],
      ["444b1ae4d6e2ef4e", "999999999999999700000"],
      ["444b1ae4d6e2ef4f", "999999999999999900000"],
      ["444b1ae4d6e2ef50", "1e+21"],
      ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
      ["3eb0c6f7a0b5ed8d", "0.000001"],
      ["41b3de4355555553", "333333333.3333332"],
      ["41b3de4355555554", "333333333.33333325"],
      ["41b3de4355555555", "333333333.3333333"],
      ["41b3de4355555556", "333333333.3333334"],
      ["41b3de4355555557", "333333333.33333343"],
      ["becbf647612f3696", "-0.0000033333333333333333"],
      ["43143ff3c1cb0959", "1424953923781206.2"],
    ]
    for (const [bits, text] of vectors) {
      expect(canonicalize(fromBits(bits))).toBe(text)
    }
    expect(canonicalize(1e30)).toBe("1e+30")
    expect(canonicalize(1e-7)).toBe("1e-7")
    expect(canonicalize(-0)).toBe("0")

    // Властивість з undefined пропускається, як у JSON; у масиві — помилка.
    expect(canonicalize({ b: 1, a: undefined })).toBe('{"b":1}')
    expect(() => canonicalize([1, undefined])).toThrow()
    expect(() => canonicalize(undefined)).toThrow()
    expect(() => canonicalize(Number.NaN)).toThrow()
    expect(() => canonicalize(fromBits("7fffffffffffffff"))).toThrow()
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow()
    expect(() => canonicalize({ x: [Number.NEGATIVE_INFINITY] })).toThrow()
    // Самотні сурогати не є I-JSON (RFC 8785 §3.2.2.2).
    expect(() => canonicalize(chars(0xd83d))).toThrow()
    expect(() => canonicalize(chars(0x61, 0xde00))).toThrow()
    expect(() => canonicalize(chars(0xde00, 0xd83d))).toThrow()
    expect(() => canonicalize({ [chars(0xd800)]: 1 })).toThrow()
    expect(canonicalize(chars(0xd83d, 0xde00))).toBe(
      `"${chars(0xd83d, 0xde00)}"`
    )
  })
})

describe("canonical snapshot and hash", () => {
  it("hash is a hex sha256 of the canonical snapshot", async () => {
    const model = await compileModel(metaFiles(fixture()))
    const bytes = new TextEncoder().encode(
      canonicalize(canonicalSnapshot(model))
    )
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
    expect(model.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(model.hash).toBe(hex)
  })

  it("snapshot leaves out files, diagnostics, raw sql and positions", async () => {
    const entries = fixture()
    const model = await compileModel(metaFiles(entries))
    const snapshot = canonicalSnapshot(model) as Record<string, unknown>
    expect(Object.keys(snapshot).sort()).toEqual([
      "actions",
      "contracts",
      "creationOrder",
      "modules",
      "objects",
      "physical",
      "presentation",
      "project",
      "scopeKinds",
      "sqlUnits",
    ])
    const text = canonicalize(snapshot)
    expect(text).not.toContain(MISC)
    expect(text).not.toContain(".meta.json")
    expect(text).not.toContain("SELECT 42 $$")
    expect(text).not.toContain('"location"')
    expect(text).not.toContain('"stmt_location"')
    expect(text).not.toContain('"line"')
    expect(text).not.toContain("requiredChecks")
    for (const unit of snapshot.sqlUnits as Record<string, unknown>[]) {
      expect(Object.keys(unit).sort()).toEqual([
        "class",
        "identity",
        "module",
        "tree",
      ])
    }
  })

  it("snapshot data holds references by id and expressions as ast", async () => {
    const entries = fixture()
    const stockId = (entries[STOCK_FILE] as { id: string }).id
    const model = await compileModel(metaFiles(entries))
    const snapshot = canonicalSnapshot(model) as {
      objects: { name: string; data: Record<string, unknown> }[]
    }
    const sale = snapshot.objects.find((o) => o.name === "Sale")!.data as {
      registerMovements: unknown[]
      attributes: { ref?: unknown }[]
      posting: { movements: Record<string, unknown>[] }
    }
    const itemId = model.objects.find((o) => o.name === "Item")!.id
    expect(sale.registerMovements).toEqual([
      { kind: "AccumulationRegister", id: stockId },
    ])
    expect(sale.attributes[0]!.ref).toEqual({ kind: "Catalog", id: itemId })
    const [movement] = sale.posting.movements
    expect(movement!.register).toEqual({
      kind: "AccumulationRegister",
      id: stockId,
    })
    expect(movement!.movementType).toBe("Expense")
    expect(movement!.fields).toEqual({
      item: { type: "field", base: "row", name: "item" },
      qty: { type: "field", base: "row", name: "qty" },
    })
    expect(movement!.condition).toEqual({
      type: "binary",
      op: ">",
      left: { type: "field", base: "row", name: "qty" },
      right: { type: "number", value: "0" },
    })
  })

  it("snapshot carries the post-C3 physical and contract form", async () => {
    const model = await compileModel(metaFiles(fixture()))
    const snapshot = canonicalSnapshot(model) as {
      physical: unknown
      contracts: unknown
      presentation: unknown
      creationOrder: unknown
      actions: unknown
      modules: unknown
    }
    // Знімок — та сама форма, що в моделі: нічого з фізики й контрактів
    // (generated, where, rowLevelSecurity, numbering, requiredOnPost, …) не
    // відкидається.
    expect(snapshot.physical).toEqual(model.physical)
    expect(snapshot.contracts).toEqual(model.contracts)
    expect(snapshot.presentation).toEqual(model.presentation)
    expect(snapshot.creationOrder).toEqual(model.creationOrder)
    expect(snapshot.actions).toEqual(model.actions)
    expect(snapshot.modules).toEqual(model.modules)
    expect(model.contracts.posting[0]!.requiredOnPost.header).toHaveLength(1)
  })

  it("formatting and comments do not change the hash", async () => {
    const entries = fixture()
    const base = await hashOf(entries)
    const reformatted = await compileModel(
      metaFiles({ ...entries, [MISC]: SQL_REFORMATTED })
    )
    // Оператори справді зсунулися на інші рядки, тож `line` поза хешем.
    const lines = (model: CompiledModel) =>
      model.sqlUnits.filter((u) => u.file === MISC).map((u) => u.line)
    const original = await compileModel(metaFiles(entries))
    expect(lines(original).sort()).toEqual([1, 2])
    expect(lines(reformatted).sort()).toEqual([2, 5])
    expect(reformatted.hash).toBe(base)

    // Пробіли й відступи в JSON-файлі метаданих теж не важать.
    const files = metaFiles(entries)
    files.set(SALE_FILE, JSON.stringify(entries[SALE_FILE], null, 4))
    expect((await compileModel(files)).hash).toBe(base)
  })

  it("key order in a file does not change the hash", async () => {
    const entries = fixture()
    const base = await hashOf(entries)
    const reordered = Object.fromEntries(
      Object.entries(entries).map(([path, content]) => [
        path,
        typeof content === "string" ? content : reverseKeys(content),
      ])
    )
    // Документ з обов'язковим реквізитом: CHECK і requiredOnPost не залежать
    // від порядку ключів у файлі.
    const sale = reordered[SALE_FILE] as {
      attributes: { required?: boolean }[]
    }
    expect(sale.attributes.some((a) => a.required === true)).toBe(true)
    expect(await hashOf(reordered)).toBe(base)
  })

  it("constant change in a sql function body changes the hash", async () => {
    const entries = fixture()
    const changed = { ...entries, [MISC]: SQL.replace("42", "43") }
    expect(await hashOf(changed)).not.toBe(await hashOf(entries))
  })

  it("renaming a logical name changes the hash", async () => {
    const entries = fixture()
    const renamed = clone(entries)
    const sale = renamed[SALE_FILE] as { attributes: { name: string }[] }
    // physicalName лишається: перейменування без DDL усе одно нова модель.
    sale.attributes[1]!.name = "note"
    expect(await hashOf(renamed)).not.toBe(await hashOf(entries))
  })

  it("hash is stable across map insertion order", async () => {
    const files = metaFiles(fixture())
    const reversed = new Map([...files].reverse())
    expect([...reversed.keys()]).not.toEqual([...files.keys()])
    const a = await compileModel(files)
    const b = await compileModel(reversed)
    expect(canonicalize(canonicalSnapshot(b))).toBe(
      canonicalize(canonicalSnapshot(a))
    )
    expect(b.hash).toBe(a.hash)
  })
})
