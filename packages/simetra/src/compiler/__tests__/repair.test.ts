import { describe, expect, it } from "vitest"
import {
  addElement,
  applyChanges,
  compile,
  createObject,
  deleteElement,
  fixFiles,
  promoteObject,
  renameElement,
  type SchemaPathResolver,
} from "simetra/compiler"
import {
  diagnostic,
  newRepairErrors,
  repairKeys,
  type Diagnostic,
} from "../diagnostics"
import { completeAndCompile } from "../operations/fix"
import { compileInput } from "../operations/refuse"
import { counterpartyMapping, promotionProject } from "./fixtures/promotion"
import { acceptDebt, catalog, metaFiles, project, uuid } from "./helpers"

function counter(start = 870_000): () => string {
  let n = start
  return () => uuid(++n)
}

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

const options = () => ({ schemaPath, newId: counter() })

const ITEM = "catalogs/Item/Item.meta.json"
const FNS = "sql/public/fns.sql"
const FNS_FUNCTIONS = "sql/public/fns.functions.json"
const TEAM_SQL = "sql/public/team.sql"
const TEAM_FUNCTIONS = "sql/public/team.functions.json"
const ADP = "sql/app/adp.sql"

const definer = (name: string) =>
  `CREATE FUNCTION ${name}() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;\n`

/**
 * Тека з помилками лише класу ремонту: недекларована definer-функція, яку
 * роль API виконує за типовими привілеями провайдера, — те, що лишає
 * зворотна генерація (спека декларацій функцій §5.5).
 */
function repairOnly(entries: Record<string, unknown> = {}) {
  return metaFiles({
    "project.meta.json": project(),
    [ITEM]: catalog("Item"),
    [FNS]: definer("public.f"),
    ...entries,
  })
}

const errors = (r: { diagnostics: readonly Diagnostic[] }) =>
  r.diagnostics.filter((d) => d.severity === "error")

const keys = (r: { diagnostics: readonly Diagnostic[] }) =>
  errors(r).map((d) => [d.code, d.params?.schema, d.params?.name])

const F_KEY = ["sql.definer-caller-unchecked", "public", "f"]

const addNote = {
  target: { kind: "Catalog" as const, name: "Item" },
  collection: "attributes",
  element: { name: "note", type: "Boolean" },
}

describe("the fixture", () => {
  it("has only one repair-class error", async () => {
    expect(keys(await compile(repairOnly()))).toEqual([F_KEY])
  })
})

// Інваріант 5: модель з помилками класу не доходить до плану.
describe("compile: repair mode", () => {
  it("without the option a folder with repair-class errors only gives no model", async () => {
    const compiled = await compile(repairOnly())
    expect(compiled.ok).toBe(false)
    expect(compiled.model).toBeUndefined()
  })

  it("with repair it gives the model and stays not ok", async () => {
    const compiled = await compile(repairOnly(), { repair: true })
    expect(compiled.ok).toBe(false)
    expect(compiled.model).toBeDefined()
    expect(keys(compiled)).toEqual([F_KEY])
  })

  it("with repair an error outside the class still gives no model", async () => {
    const compiled = await compile(
      repairOnly({
        [ITEM]: catalog("Item", {
          attributes: [
            {
              id: uuid(870_900),
              name: "owner",
              physicalName: "owner",
              type: "Ref",
              ref: { kind: "Catalog", name: "Missing" },
            },
          ],
        }),
      }),
      { repair: true }
    )
    expect(compiled.ok).toBe(false)
    expect(compiled.model).toBeUndefined()
  })

  it("fix on such a folder writes nothing", async () => {
    const result = await fixFiles(repairOnly(), options())
    expect(result.ok).toBe(false)
    expect(result.written).toBeUndefined()
    expect(keys(result)).toEqual([F_KEY])
  })

  it("promote on such a folder writes nothing", async () => {
    const files = await acceptDebt(promotionProject({ module: false }))
    files.set("sql/app/rpc.sql", definer("app.rpc"))
    expect(keys(await compile(files))).toEqual([
      ["sql.definer-caller-unchecked", "app", "rpc"],
    ])
    const result = await promoteObject(
      files,
      counterpartyMapping({ module: false }),
      options()
    )
    expect(result.ok).toBe(false)
    expect(result.written).toBeUndefined()
    expect(result.changes).toEqual([])
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "operation.input-invalid"
    )
  })
})

describe("mutations on a folder with repair-class errors only", () => {
  it("add writes the result: ok false, written, the class errors in diagnostics", async () => {
    const files = repairOnly()
    const result = await addElement(files, addNote, options())
    expect(result.ok).toBe(false)
    expect(result.written).toBe(true)
    expect(result.changes.map((c) => c.path)).toEqual([ITEM])
    expect(keys(result)).toEqual([F_KEY])
    const after = applyChanges(files, result.changes)
    expect(
      (
        JSON.parse(after.get(ITEM)!) as { attributes: { name: string }[] }
      ).attributes.map((a) => a.name)
    ).toEqual(["note"])
  })

  it("create writes the result the same way", async () => {
    const result = await createObject(
      repairOnly(),
      { kind: "Catalog", name: "Store", data: {} },
      options()
    )
    expect(result.ok).toBe(false)
    expect(result.written).toBe(true)
    expect(result.changes.map((c) => c.path)).toEqual([
      "catalogs/Store/Store.meta.json",
    ])
    expect(keys(result)).toEqual([F_KEY])
  })

  it("on a clean folder add stays ok without written", async () => {
    const files = repairOnly()
    files.delete(FNS)
    const result = await addElement(files, addNote, options())
    expect(result.ok).toBe(true)
    expect(result.written).toBeUndefined()
  })

  it("refuses an input with an error outside the class", async () => {
    const files = repairOnly({ "catalogs/Broken/Broken.meta.json": "{" })
    const result = await addElement(files, addNote, options())
    expect(result.ok).toBe(false)
    expect(result.written).toBeUndefined()
    expect(result.changes).toEqual([])
    expect(result.diagnostics[0]!.code).toBe("operation.input-invalid")
  })

  it("does not write a result with an error outside the class", async () => {
    const result = await addElement(
      repairOnly(),
      {
        ...addNote,
        element: {
          name: "owner",
          type: "Ref",
          ref: { kind: "Catalog", name: "Missing" },
        },
      },
      options()
    )
    expect(result.ok).toBe(false)
    expect(result.written).toBeUndefined()
    expect(errors(result).map((d) => d.code)).toContain("reference.unresolved")
  })

  it("a declared function that becomes a set function loses its declaration in the same change", async () => {
    // Функція, задекларована сервісною, стає функцією множини нового виду
    // скоупу: без переходу (Р12) декларація на форму платформи була б новою
    // помилкою класу, а з ним зникає в тій самій зміні, тож результат
    // пишеться з помилкою класу входу.
    const files = repairOnly({
      // Без явного `none` новий вид скоупу вимагав би скоупу від `Item`.
      [ITEM]: catalog("Item", { scope: "none" }),
      [TEAM_SQL]: `CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT NULL::uuid $$;\n`,
      [TEAM_FUNCTIONS]: JSON.stringify({
        functions: [
          {
            id: uuid(870_901),
            function: { name: "team_ids" },
            callers: ["service"],
          },
        ],
      }),
    })
    expect(keys(await compile(files))).toEqual([F_KEY])
    const result = await addElement(
      files,
      {
        target: { kind: "Project" },
        collection: "scopeKinds",
        element: {
          name: "team",
          root: {
            external: { schema: "public", table: "teams", column: "id" },
          },
          setFunction: { schema: "public", name: "team_ids" },
        },
      },
      options()
    )
    expect(result.ok).toBe(false)
    expect(result.written).toBe(true)
    expect(keys(result)).toEqual([F_KEY])
    expect(result.changes.map((c) => [c.path, c.content === null])).toEqual([
      ["project.meta.json", false],
      [TEAM_FUNCTIONS, true],
    ])
    expect(
      result.diagnostics
        .filter((d) => d.code === "sql.declaration-platform-form-widens")
        .map((d) => d.params?.roles)
    ).toEqual(["user, command"])
  })

  it("rename refuses", async () => {
    const result = await renameElement(repairOnly(), {
      target: { kind: "Catalog", name: "Item" },
      newName: "Goods",
    })
    expect(result.ok).toBe(false)
    expect(result.written).toBeUndefined()
    expect(result.changes).toEqual([])
    expect(result.diagnostics[0]!.code).toBe("operation.input-invalid")
  })

  it("delete refuses", async () => {
    const result = await deleteElement(repairOnly(), {
      target: { kind: "Catalog", name: "Item" },
    })
    expect(result.ok).toBe(false)
    expect(result.written).toBeUndefined()
    expect(result.changes).toEqual([])
    expect(result.diagnostics[0]!.code).toBe("operation.input-invalid")
  })
})

/**
 * Правило «до/після» хвоста мутації над теками, які мутація ще не вміє
 * породити сама (SQL правлять `declare-function` Д4 і людина): хвіст судить
 * лише різницю діагностик входу й результату.
 */
async function tail(before: Map<string, string>, after: Map<string, string>) {
  const input = await compileInput(before, { repair: true })
  if (!input.ok) throw new Error("the input must be accepted")
  return completeAndCompile(before, after, options(), new Set(), input.accepted)
}

// Інваріант 6: мутація не додає помилки класу.
describe("the before/after rule", () => {
  it("refuses a result that removes one class error and adds another on another function", async () => {
    const before = repairOnly()
    const after = new Map(before)
    after.set(FNS, definer("public.g"))
    // Кількість та сама — різниться лише ключ.
    expect(errors(await compile(after))).toHaveLength(1)
    const result = await tail(before, after)
    expect(result.ok).toBe(false)
    expect(result.written).toBeUndefined()
    expect(keys(result)).toEqual([
      ["sql.definer-caller-unchecked", "public", "g"],
    ])
  })

  it("accepts a result whose class errors were all on the input", async () => {
    const before = repairOnly({ "sql/public/g.sql": definer("public.g") })
    const after = new Map(before)
    after.delete("sql/public/g.sql")
    const result = await tail(before, after)
    expect(result.written).toBe(true)
    expect(keys(result)).toEqual([F_KEY])
  })

  // Ключ ADP — ідентичність одиниці: другий ADP на ту саму схему й роль з
  // іншим отримувачем — нова помилка класу, а не та сама.
  it("refuses a second ADP grant on an existing schema and role", async () => {
    const adp = (to: string) =>
      `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO ${to};\n`
    const before = await acceptDebt(repairOnly({ [ADP]: adp("anon") }))
    const after = await acceptDebt(
      repairOnly({ [ADP]: adp("anon") + adp("authenticated") })
    )
    const result = await tail(before, after)
    expect(result.ok).toBe(false)
    expect(result.written).toBeUndefined()
    expect(
      newRepairErrors(
        repairKeys(errors(await compile(before))),
        errors(result)
      ).map((d) => d.params?.name)
    ).toEqual([expect.stringContaining("authenticated")])
  })
})

// Р7: ключ — кортеж; ідентифікатори в лапках з крапкою не зливаються.
describe("newRepairErrors compares keys as tuples", () => {
  const at = (schema: string, name: string) =>
    diagnostic("sql.definer-caller-unchecked", FNS, "", {
      schema,
      name,
      function: `${schema}.${name}`,
    })

  it('{schema:"a.b",name:"c"} and {schema:"a",name:"b.c"} are different keys', () => {
    expect(
      newRepairErrors(repairKeys([at("a.b", "c")]), [at("a", "b.c")])
    ).toEqual([at("a", "b.c")])
  })

  it("the same tuple is not new, wherever the error points", () => {
    expect(
      newRepairErrors(repairKeys([at("a.b", "c")]), [
        { ...at("a.b", "c"), file: FNS_FUNCTIONS, pointer: "/functions/3" },
      ])
    ).toEqual([])
  })

  it("a different code on the same function is a different key", () => {
    const missing = diagnostic(
      "sql.declaration-check-missing",
      FNS_FUNCTIONS,
      "/functions/0",
      { schema: "public", name: "f" }
    )
    expect(newRepairErrors(repairKeys([at("public", "f")]), [missing])).toEqual(
      [missing]
    )
  })
})
