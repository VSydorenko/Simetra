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
  catalog,
  metaFiles,
  organization,
  project,
  salesDocument,
  scopedProject,
  uuid,
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

interface SaleFile {
  id: string
  attributes: { id: string; name: string }[]
  tabularSections: {
    id: string
    name: string
    attributes: { id: string; name: string }[]
  }[]
  posting: { movements: Record<string, unknown>[] }
}

interface StockFile {
  dimensions: { id: string; name: string }[]
  resources: { id: string; name: string }[]
}

type Fragment = { name: string; data: { posting: unknown } }

/** Канонічний текст елемента `objects` знімка з цим іменем. */
function fragment(model: CompiledModel, name: string): Fragment {
  const { objects } = canonicalSnapshot(model) as { objects: Fragment[] }
  return objects.find((o) => o.name === name)!
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
    const sale0 = entries[SALE_FILE] as SaleFile
    const [goods] = sale0.tabularSections
    const stock = entries[STOCK_FILE] as StockFile
    const row = (name: string) => ({
      type: "field",
      source: "row",
      elementId: goods!.attributes.find((a) => a.name === name)!.id,
    })
    expect(movement!.source).toEqual({ tabularSectionId: goods!.id })
    // Ключі `fields` — id полів регістра, а не їхні імена.
    expect(movement!.fields).toEqual({
      [stock.dimensions[0]!.id]: row("item"),
      [stock.resources[0]!.id]: row("qty"),
    })
    expect(movement!.condition).toEqual({
      type: "binary",
      op: ">",
      left: row("qty"),
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
    expect(snapshot.presentation).toMatchObject({
      defaultLocale: model.project.defaultLocale,
      objects: expect.any(Array),
    })
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

describe("references in the snapshot", () => {
  it("renaming a register field keeps the referencing document fragment", async () => {
    // Поле регістра обрано тому, що його ім'я є в документі лише як ключ
    // `fields` руху: реквізит ТЧ документа носить ім'я ще й у власному
    // `data` документа, тож його фрагмент змінився б за самим іменем.
    const entries = fixture()
    const renamed = clone(entries)
    const stock = renamed[STOCK_FILE] as StockFile
    stock.resources[0]!.name = "quantity"
    const sale = renamed[SALE_FILE] as SaleFile
    const [movement] = sale.posting.movements as {
      fields: Record<string, string>
    }[]
    movement!.fields = { item: "row.item", quantity: "row.qty" }

    const before = await compileModel(metaFiles(entries))
    const after = await compileModel(metaFiles(renamed))
    expect(after.hash).not.toBe(before.hash)
    expect(canonicalize(fragment(after, "Sale"))).toBe(
      canonicalize(fragment(before, "Sale"))
    )
  })

  it("swapping attribute ids changes the referencing expression", async () => {
    // Імена лишаються, вираз посилається на те саме ім'я — змінюється лише
    // id цілі. З іменами в AST фрагмент `posting` був би тим самим.
    const entries = fixture()
    const swapped = clone(entries)
    const goods = (swapped[SALE_FILE] as SaleFile).tabularSections[0]!
    const qty = goods.attributes.find((a) => a.name === "qty")!
    const amount = goods.attributes.find((a) => a.name === "amount")!
    ;[qty.id, amount.id] = [amount.id, qty.id]

    const before = fragment(await compileModel(metaFiles(entries)), "Sale").data
    const after = fragment(await compileModel(metaFiles(swapped)), "Sale").data
    expect(canonicalize(after.posting)).not.toBe(canonicalize(before.posting))
  })

  it("aggregates in constructor are canonical by id", async () => {
    /** Рухи з шапки документа з агрегатами над ТЧ, названою `section`. */
    const aggregate = (entries: Record<string, unknown>, section: string) => {
      const sale = entries[SALE_FILE] as SaleFile
      sale.tabularSections[0]!.name = section
      sale.posting.movements[0] = {
        ...sale.posting.movements[0],
        source: "document",
        condition: `count(${section}) > 0`,
        fields: { item: "doc.customer", qty: `sum(${section}.qty)` },
      }
      return entries
    }
    const entries = aggregate(fixture(), "goods")
    const sale = entries[SALE_FILE] as SaleFile
    const goods = sale.tabularSections[0]!
    const qtyId = goods.attributes.find((a) => a.name === "qty")!.id
    const stock = entries[STOCK_FILE] as StockFile
    const before = fragment(await compileModel(metaFiles(entries)), "Sale")
    const [movement] = (
      before.data.posting as { movements: Record<string, unknown>[] }
    ).movements
    expect(movement!.condition).toEqual({
      type: "binary",
      op: ">",
      left: { type: "count", tabularSectionId: goods.id },
      right: { type: "number", value: "0" },
    })
    expect(
      (movement!.fields as Record<string, unknown>)[stock.resources[0]!.id]
    ).toEqual({ type: "sum", tabularSectionId: goods.id, elementId: qtyId })

    // Та сама модель з перейменованою ТЧ: ті самі id, інші імена.
    const renamed = aggregate(clone(entries), "lines")
    const after = fragment(await compileModel(metaFiles(renamed)), "Sale")
    expect(canonicalize(after.data.posting)).toBe(
      canonicalize(before.data.posting)
    )
  })

  it("a standard attribute keeps its node form across naming styles", async () => {
    const condition = async (attributeCase: string, text: string) => {
      const entries: Record<string, unknown> = {
        ...fixture(),
        "project.meta.json": project({ naming: { attributeCase } }),
      }
      const sale = entries[SALE_FILE] as SaleFile
      sale.posting.movements[0]!.condition = text
      const model = await compileModel(metaFiles(entries))
      const { data } = fragment(model, "Sale") as {
        data: { posting: { movements: { condition: unknown }[] } }
      }
      return { id: sale.id, node: data.posting.movements[0]!.condition }
    }
    const camel = await condition("camelCase", "not doc.deletionMark")
    const snake = await condition("snake_case", "not doc.deletion_mark")
    const node = (id: string) => ({
      type: "unary",
      op: "not",
      operand: {
        type: "field",
        source: "doc",
        elementId: `${id}#deletionMark`,
      },
    })
    expect(camel.node).toEqual(node(camel.id))
    expect(snake.node).toEqual(node(snake.id))
  })
})

describe("scope kinds in the snapshot", () => {
  /** Проєкт з двома видами скоупу і двома довідниками, що можуть бути коренем `org`. */
  function scoped(): Record<string, unknown> {
    return {
      "project.meta.json": scopedProject(),
      "catalogs/Organization/Organization.meta.json": organization(),
      "catalogs/Company/Company.meta.json": catalog("Company", {
        scope: "org",
      }),
    }
  }

  type ScopeKindFile = {
    id: string
    name: string
    physicalName: string
    title?: unknown
    root: {
      object?: { kind: string; name: string }
      external?: { table: string }
    }
    setFunction: { name: string }
    onRootDelete?: string
  }

  async function hashWith(
    entries: Record<string, unknown>,
    change: (kinds: ScopeKindFile[], entries: Record<string, unknown>) => void
  ): Promise<string> {
    const changed = clone(entries)
    const { scopeKinds } = changed["project.meta.json"] as {
      scopeKinds: ScopeKindFile[]
    }
    change(scopeKinds, changed)
    return hashOf(changed)
  }

  it("snapshot holds scope kinds only in resolved form", async () => {
    const entries = scoped()
    const model = await compileModel(metaFiles(entries))
    const snapshot = canonicalSnapshot(model) as {
      project: Record<string, unknown>
      scopeKinds: Record<string, unknown>[]
    }
    expect(snapshot.project).not.toHaveProperty("scopeKinds")
    // Решта полів проєкту — без посилань за іменем.
    expect(Object.keys(snapshot.project).sort()).toEqual([
      "defaultLocale",
      "defaultSchema",
      "name",
      "naming",
      "timezone",
    ])
    const organizationId = model.objects.find(
      (o) => o.name === "Organization"
    )!.id
    const [org, user] = snapshot.scopeKinds
    expect(org).toEqual({
      id: model.scopeKinds[0]!.id,
      name: "org",
      physicalName: "org_id",
      root: { kind: "Catalog", id: organizationId },
      setFunction: { schema: "public", name: "org_ids" },
      onRootDelete: "restrict",
    })
    expect(user!.root).toEqual({
      external: { schema: "auth", table: "users", column: "id" },
    })
  })

  it("changing each scope kind field changes the hash", async () => {
    const entries = scoped()
    const base = await hashOf(entries)
    const variants: Record<
      string,
      (kinds: ScopeKindFile[], entries: Record<string, unknown>) => void
    > = {
      id: (kinds) => {
        kinds[0]!.id = uuid(9001)
      },
      name: (kinds, all) => {
        kinds[0]!.name = "tenant"
        for (const file of [
          "catalogs/Organization/Organization.meta.json",
          "catalogs/Company/Company.meta.json",
        ]) {
          ;(all[file] as { scope: string }).scope = "tenant"
        }
      },
      physicalName: (kinds) => {
        kinds[0]!.physicalName = "tenant_id"
      },
      title: (kinds) => {
        kinds[0]!.title = { uk: "Організація" }
      },
      "root object": (kinds) => {
        kinds[0]!.root = { object: { kind: "Catalog", name: "Company" } }
      },
      "root external": (kinds) => {
        kinds[1]!.root = {
          external: { schema: "auth", table: "members", column: "id" },
        } as ScopeKindFile["root"]
      },
      setFunction: (kinds) => {
        kinds[0]!.setFunction = { name: "tenant_ids" }
      },
      onRootDelete: (kinds) => {
        kinds[0]!.onRootDelete = "cascade"
      },
    }
    for (const [field, change] of Object.entries(variants)) {
      expect(await hashWith(entries, change), field).not.toBe(base)
    }
  })
})

describe("sql text in the hash", () => {
  const SALE_SQL = "documents/Sale/Sale.sql"
  const BLOCK =
    "-- @movements Stock\nSELECT now(), 'Expense', null::uuid, 7 ORDER BY 1\n-- @end\n"

  function withBlock(block: string): Record<string, unknown> {
    return { ...blockEntries, [SALE_SQL]: block }
  }

  // Документ без конструктора: рухи в `Stock` дає блок запиту.
  const blockEntries: Record<string, unknown> = {
    "project.meta.json": project(),
    ...salesDocument({}, { posting: undefined }),
  }

  it("whitespace and a comment inside a movements block keep the hash", async () => {
    const base = await hashOf(withBlock(BLOCK))
    const reformatted =
      "-- @movements Stock\n  select now() ,\n    'Expense', -- вид руху\n    null::uuid,  7\n  order by 1\n-- @end\n"
    expect(await hashOf(withBlock(reformatted))).toBe(base)
  })

  it("a constant change inside a movements block changes the hash", async () => {
    const base = await hashOf(withBlock(BLOCK))
    expect(await hashOf(withBlock(BLOCK.replace("7", "8")))).not.toBe(base)
  })

  it("whitespace inside a language sql function body changes the hash", async () => {
    // Задокументоване обмеження: тіло функції — рядок `prosrc`, і компілятор
    // його не нормалізує; переформатування тіла — нова модель.
    const entries = fixture()
    const base = await hashOf(entries)
    const spaced = SQL.replace("SELECT 42", () => "SELECT  42")
    expect(spaced).not.toBe(SQL)
    expect(await hashOf({ ...entries, [MISC]: spaced })).not.toBe(base)
  })
})
