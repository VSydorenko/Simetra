import {
  encodeId,
  FactBase,
  plan,
  type DependencyEdge,
  type Diagnostic,
  type Fact,
  type StableId,
} from "@supabase/pg-delta"
import { describe, expect, it } from "vitest"
import { withColumnOrder } from "../pg-delta/column-order"

const app: StableId = { kind: "schema", name: "app" }
const table: StableId = { kind: "table", schema: "app", name: "t" }
const col = (name: string): StableId => ({
  kind: "column",
  schema: "app",
  table: "t",
  name,
})
const f: StableId = { kind: "function", schema: "app", name: "f", args: [] }

const fact = (id: StableId, parent?: StableId): Fact => ({
  id,
  ...(parent === undefined ? {} : { parent }),
  payload: {},
})
const column = (name: string, position: number, generatedExpr?: string) => ({
  id: col(name),
  parent: table,
  payload: {
    type: "integer",
    notNull: false,
    _position: position,
    // Поля нижче потрібні рендерингу двигуна в контрольному плані
    identity: null,
    collation: null,
    generatedExpr: generatedExpr ?? null,
  },
})
const depends = (from: StableId, to: StableId): DependencyEdge => ({
  from,
  to,
  kind: "depends",
})

const key = (e: DependencyEdge) =>
  `${encodeId(e.from)} -[${e.kind}]-> ${encodeId(e.to)}`
const edgeKeys = (edges: readonly DependencyEdge[]) => edges.map(key).sort()
/** Ребра результату, яких не було в цілі. */
const newEdges = (target: FactBase, result: FactBase) => {
  const old = new Set(target.edges.map(key))
  return edgeKeys(result.edges.filter((e) => !old.has(key(e))))
}

/** Колонки першого тесту — навмисне не в порядку `attnum`. */
const generatedColumns = () => [
  column("note", 4),
  column("p", 3, "d * 2"),
  column("id", 1),
  column("d", 2),
]

describe("withColumnOrder", () => {
  it("chains the columns of a new table in attnum order", () => {
    const source = new FactBase([fact(app)], [])
    const target = new FactBase(
      [fact(app), fact(table, app), ...generatedColumns()],
      [depends(table, app), depends(col("p"), col("d"))]
    )
    const result = withColumnOrder(source, target)
    expect(newEdges(target, result)).toEqual(
      edgeKeys([depends(col("d"), col("id")), depends(col("note"), col("p"))])
    )
    // Наявне ребро `p → d` лишається одним, не дублюється
    expect(edgeKeys(result.edges)).toEqual(
      edgeKeys([
        depends(table, app),
        depends(col("p"), col("d")),
        depends(col("d"), col("id")),
        depends(col("note"), col("p")),
      ])
    )
    expect(result.facts()).toEqual(target.facts())
  })

  it("follows attnum, not names, across dropped-column holes", () => {
    const source = new FactBase([fact(app)], [])
    const target = new FactBase(
      [
        fact(app),
        fact(table, app),
        column("m", 9),
        column("a", 4),
        column("z", 1),
      ],
      []
    )
    expect(newEdges(target, withColumnOrder(source, target))).toEqual(
      edgeKeys([depends(col("a"), col("z")), depends(col("m"), col("a"))])
    )
  })

  it("leaves a table of the source untouched", () => {
    const facts = [fact(app), fact(table, app), column("a", 1), column("b", 2)]
    const source = new FactBase(facts, [])
    const target = new FactBase(facts, [])
    expect(newEdges(target, withColumnOrder(source, target))).toEqual([])
  })

  it("adds no edges to a table whose column depends on a later one", () => {
    // `g` посилається вперед на `b`: ланцюг `b → g` дав би цикл
    const source = new FactBase([fact(app)], [])
    const target = new FactBase(
      [fact(app), fact(table, app), column("g", 1, "b * 2"), column("b", 2)],
      [depends(col("g"), col("b"))]
    )
    expect(newEdges(target, withColumnOrder(source, target))).toEqual([])
  })

  it("adds no edges when the dependency on a later column is transitive", () => {
    const source = new FactBase([fact(app)], [])
    const target = new FactBase(
      [
        fact(app),
        fact(f, app),
        fact(table, app),
        column("c1", 1, "app.f()"),
        column("c2", 2),
        column("c3", 3),
      ],
      [depends(col("c1"), f), depends(f, col("c3"))]
    )
    expect(newEdges(target, withColumnOrder(source, target))).toEqual([])
  })

  it("keeps the diagnostics of the target", () => {
    // `plan()` читає діагностики бажаного стану й відмовляє на них
    const source = new FactBase([fact(app)], [])
    const target = new FactBase(
      [fact(app), fact(table, app), column("a", 1), column("b", 2)],
      []
    )
    const unkeyed: Diagnostic = {
      code: "intent-unkeyed",
      severity: "warning",
      message: "unnamed job",
    }
    target.diagnostics.push(unkeyed)
    expect(withColumnOrder(source, target).diagnostics).toEqual([unkeyed])
  })

  it("keeps the source tag and reference-only facts", () => {
    const auth: StableId = { kind: "schema", name: "auth" }
    const source = new FactBase([fact(app)], [])
    const target = new FactBase(
      [fact(app), fact(auth), fact(table, app), column("a", 1), column("b", 2)],
      [],
      "liveDb",
      new Set([encodeId(auth)])
    )
    const result = withColumnOrder(source, target)
    expect(result.source).toBe("liveDb")
    expect(result.isReferenceOnly(auth)).toBe(true)
    expect(result.isReferenceOnly(app)).toBe(false)
  })
})

/**
 * Контроль на самому двигуні, без бази: порядок створення колонок `app.t`
 * у плані. Компакція дописує згорнуті колонки в `produces` дії
 * `CREATE TABLE` у порядку згортання, тож послідовність `produces` виду
 * `column` по діях і є порядком колонок створеної таблиці.
 */
describe("engine plan of a new table with a generated column", () => {
  // Рендеринг `CREATE TABLE` двигуна вимагає повного payload схеми й таблиці
  const schemaFact: Fact = { id: app, payload: { owner: "postgres" } }
  const tableFact: Fact = {
    id: table,
    parent: app,
    payload: {
      persistence: "p",
      rowSecurity: false,
      forceRowSecurity: false,
      replicaIdentity: "d",
      replicaIdentityIndex: null,
      partitionKey: null,
      partitionBound: null,
      parentTable: null,
      reloptions: null,
    },
  }
  const source = new FactBase([schemaFact], [])
  const target = new FactBase(
    [schemaFact, tableFact, ...generatedColumns()],
    [depends(table, app), depends(col("p"), col("d"))]
  )
  const columnSequence = (desired: FactBase) =>
    plan(source, desired).actions.flatMap((a) =>
      a.produces.flatMap((id) =>
        id.kind === "column" && id.table === "t" ? [id.name] : []
      )
    )

  it("the engine alone puts the generated column last", () => {
    // Документує дефект двигуна: почервоніє, коли upstream його виправить
    expect(columnSequence(target)).toEqual(["id", "d", "note", "p"])
  })

  it("the ordered target keeps attnum order", () => {
    expect(columnSequence(withColumnOrder(source, target))).toEqual([
      "id",
      "d",
      "p",
      "note",
    ])
  })
})

/**
 * Запобіжник проти циклу на рівні дій двигуна: дія створює факт разом із
 * нащадками (`ADD COLUMN … DEFAULT` — і `default`, `CREATE DOMAIN` — і його
 * обмеження) і впорядковується за ребрами їх усіх; синтетичні ребра однієї
 * нової таблиці можуть замкнути цикл через іншу. Кожен сценарій перевіряє,
 * що ребер для таблиці немає, і що двигун над результатом будує план.
 */
describe("withColumnOrder against engine action cycles", () => {
  const schemaFact: Fact = { id: app, payload: { owner: "postgres" } }
  const tbl = (name: string): StableId => ({
    kind: "table",
    schema: "app",
    name,
  })
  const tableFact = (name: string): Fact => ({
    id: tbl(name),
    parent: app,
    payload: {
      persistence: "p",
      rowSecurity: false,
      forceRowSecurity: false,
      replicaIdentity: "d",
      replicaIdentityIndex: null,
      partitionKey: null,
      partitionBound: null,
      parentTable: null,
      reloptions: null,
    },
  })
  const colOf = (t: string, name: string): StableId => ({
    kind: "column",
    schema: "app",
    table: t,
    name,
  })
  const columnOf = (
    t: string,
    name: string,
    position: number,
    opts: { type?: string; generatedExpr?: string } = {}
  ): Fact => ({
    id: colOf(t, name),
    parent: tbl(t),
    payload: {
      type: opts.type ?? "integer",
      notNull: false,
      _position: position,
      identity: null,
      collation: null,
      generatedExpr: opts.generatedExpr ?? null,
    },
  })
  const fn = (name: string): StableId => ({
    kind: "function",
    schema: "app",
    name,
    args: [],
  })
  const fnFact = (name: string, body: string): Fact => ({
    id: fn(name),
    parent: app,
    payload: {
      def: `CREATE FUNCTION app.${name}() RETURNS int IMMUTABLE LANGUAGE sql BEGIN ATOMIC ${body}; END`,
    },
  })
  const source = new FactBase([schemaFact], [])
  const planSql = (desired: FactBase) =>
    plan(source, desired).actions.map((a) => a.sql)

  it("sees the default of a column reading a later column", () => {
    // `a DEFAULT app.f()`, а `f` читає пізнішу `b`: ребро `default → f`
    // висить на нащадку колонки, не на ній самій
    const dflt: StableId = {
      kind: "default",
      schema: "app",
      table: "t",
      name: "a",
    }
    const target = new FactBase(
      [
        schemaFact,
        tableFact("t"),
        columnOf("t", "a", 1),
        columnOf("t", "b", 2),
        { id: dflt, parent: colOf("t", "a"), payload: { expr: "app.f()" } },
        fnFact("f", "SELECT max(b) FROM app.t"),
      ],
      [
        depends(tbl("t"), app),
        depends(fn("f"), app),
        depends(fn("f"), colOf("t", "b")),
        depends(fn("f"), tbl("t")),
        depends(dflt, fn("f")),
        depends(dflt, colOf("t", "a")),
      ]
    )
    const result = withColumnOrder(source, target)
    expect(newEdges(target, result)).toEqual([])
    expect(() => planSql(result)).not.toThrow()
  })

  it("sees the check of a domain whose function reads a later column", () => {
    // Обмеження домену — нащадок домену, вбудований у `CREATE DOMAIN`
    const dom: StableId = { kind: "domain", schema: "app", name: "dom" }
    const con: StableId = {
      kind: "constraint",
      schema: "app",
      table: "dom",
      name: "c",
    }
    const target = new FactBase(
      [
        schemaFact,
        tableFact("t"),
        columnOf("t", "a", 1, { type: "app.dom" }),
        columnOf("t", "b", 2),
        fnFact("f", "SELECT max(b) FROM app.t"),
        {
          id: dom,
          parent: app,
          payload: {
            baseType: "integer",
            collation: null,
            default: null,
            notNull: false,
          },
        },
        {
          id: con,
          parent: dom,
          payload: {
            def: "CHECK (VALUE IS NULL OR app.f() IS NOT NULL)",
            type: "c",
            validated: true,
          },
        },
      ],
      [
        depends(tbl("t"), app),
        depends(fn("f"), app),
        depends(dom, app),
        depends(fn("f"), colOf("t", "b")),
        depends(fn("f"), tbl("t")),
        depends(colOf("t", "a"), dom),
        depends(con, dom),
        depends(con, fn("f")),
      ]
    )
    const result = withColumnOrder(source, target)
    expect(newEdges(target, result)).toEqual([])
    expect(() => planSql(result)).not.toThrow()
  })

  // `a.a1` читає `b.b2` через `f`, `b.b1` читає `a.a2` через `g`: кожна
  // таблиця окремо проходить запобіжник, разом ланцюги замикають цикл
  const crossFacts = () => [
    schemaFact,
    tableFact("a"),
    tableFact("b"),
    columnOf("a", "a1", 1, { generatedExpr: "app.f()" }),
    columnOf("a", "a2", 2),
    columnOf("b", "b1", 1, { generatedExpr: "app.g()" }),
    columnOf("b", "b2", 2),
    fnFact("f", "SELECT max(b2) FROM app.b"),
    fnFact("g", "SELECT max(a2) FROM app.a"),
  ]
  const crossEdges = [
    depends(tbl("a"), app),
    depends(tbl("b"), app),
    depends(fn("f"), app),
    depends(fn("g"), app),
    depends(colOf("a", "a1"), fn("f")),
    depends(fn("f"), colOf("b", "b2")),
    depends(colOf("b", "b1"), fn("g")),
    depends(fn("g"), colOf("a", "a2")),
  ]

  it("leaves the later of two cross-dependent new tables without edges", () => {
    const target = new FactBase(crossFacts(), crossEdges)
    const result = withColumnOrder(source, target)
    // Таблиці отримують ребра за порядком ідентичності: `a` раніше за `b`
    expect(newEdges(target, result)).toEqual(
      edgeKeys([depends(colOf("a", "a2"), colOf("a", "a1"))])
    )
    expect(() => planSql(result)).not.toThrow()
  })

  it("does not depend on the order the facts arrive in", () => {
    const forward = new FactBase(crossFacts(), crossEdges)
    const backward = new FactBase(
      [...crossFacts()].reverse(),
      [...crossEdges].reverse()
    )
    expect(newEdges(backward, withColumnOrder(source, backward))).toEqual(
      newEdges(forward, withColumnOrder(source, forward))
    )
  })

  it("checks every column, not only the first one", () => {
    // `c1` нікуди не посилається, а `c2` — уперед на `c3`
    const target = new FactBase(
      [
        schemaFact,
        tableFact("t"),
        columnOf("t", "c1", 1),
        columnOf("t", "c2", 2, { generatedExpr: "c3 * 2" }),
        columnOf("t", "c3", 3),
      ],
      [depends(tbl("t"), app), depends(colOf("t", "c2"), colOf("t", "c3"))]
    )
    expect(newEdges(target, withColumnOrder(source, target))).toEqual([])
  })

  it("does not descend from another schema into its children", () => {
    // Схема не вбудовує нащадків у свою дію: функція `pub.f`, що читає
    // пізню `b`, не стосується дій колонок `t`, хоча `a` має тип зі схеми
    // `pub`. Спуск зі схеми хибно позбавив би таблицю ребер
    const pub: StableId = { kind: "schema", name: "pub" }
    const mood: StableId = { kind: "type", schema: "pub", name: "mood" }
    const pubF: StableId = {
      kind: "function",
      schema: "pub",
      name: "f",
      args: [],
    }
    const pubFact: Fact = { id: pub, payload: { owner: "postgres" } }
    const target = new FactBase(
      [
        schemaFact,
        pubFact,
        tableFact("t"),
        columnOf("t", "id", 1),
        columnOf("t", "g", 2, { generatedExpr: "id * 2" }),
        columnOf("t", "a", 3, { type: "pub.mood" }),
        columnOf("t", "b", 4),
        { id: mood, parent: pub, payload: { variant: "enum", values: ["x"] } },
        {
          id: pubF,
          parent: pub,
          payload: {
            def: "CREATE FUNCTION pub.f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT max(b) FROM app.t; END",
          },
        },
      ],
      [
        depends(tbl("t"), app),
        depends(mood, pub),
        depends(pubF, pub),
        depends(colOf("t", "g"), colOf("t", "id")),
        depends(colOf("t", "a"), mood),
        depends(pubF, colOf("t", "b")),
        depends(pubF, tbl("t")),
      ]
    )
    const result = withColumnOrder(source, target)
    expect(newEdges(target, result)).toEqual(
      // `g → id` уже є в цілі (вираз), ланцюг її не дублює
      edgeKeys([
        depends(colOf("t", "a"), colOf("t", "g")),
        depends(colOf("t", "b"), colOf("t", "a")),
      ])
    )
    const withPub = new FactBase([schemaFact, pubFact], [])
    const sequence = plan(withPub, result).actions.flatMap((a) =>
      a.produces.flatMap((id) =>
        id.kind === "column" && id.table === "t" ? [id.name] : []
      )
    )
    expect(sequence).toEqual(["id", "g", "a", "b"])
  })

  it("keeps checking tables after one with a forward reference", () => {
    const target = new FactBase(
      [
        schemaFact,
        tableFact("a"),
        tableFact("b"),
        columnOf("a", "g", 1, { generatedExpr: "h * 2" }),
        columnOf("a", "h", 2),
        columnOf("b", "x", 1),
        columnOf("b", "y", 2),
      ],
      [
        depends(tbl("a"), app),
        depends(tbl("b"), app),
        depends(colOf("a", "g"), colOf("a", "h")),
      ]
    )
    expect(newEdges(target, withColumnOrder(source, target))).toEqual(
      edgeKeys([depends(colOf("b", "y"), colOf("b", "x"))])
    )
  })
})
