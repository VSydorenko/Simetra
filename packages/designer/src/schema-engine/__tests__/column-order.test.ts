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
