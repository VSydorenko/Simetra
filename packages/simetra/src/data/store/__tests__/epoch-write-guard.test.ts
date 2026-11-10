import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const STORE = join(import.meta.dirname, "..")

// Виробничі джерела сховищ; `__tests__` не входить (фікстури будують рядки
// будь-якої епохи напряму).
const files = readdirSync(STORE, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".ts"))
  .map((e) => join(e.parentPath, e.name))
  .filter((path) => !path.includes("__tests__"))

/**
 * A form of writing an epoch into store state. Every form is pinned by a
 * negative self-test below, so the guard's own coverage cannot shrink.
 */
type Form =
  /** `versionEpoch: v` in an object literal. */
  | "epoch-property"
  /** `{ versionEpoch }`. */
  | "epoch-shorthand"
  /** `x.versionEpoch = v` (any assignment operator). */
  | "epoch-assignment"
  /** `x["versionEpoch"]`, `x["lazyEpochs"]`, `x["row"]` — forbidden outright. */
  | "element-access"
  /** `x.lazyEpochs.set(field, v)`. */
  | "lazy-set"
  /** Any other use of `lazyEpochs` (an alias, an argument) — forbidden. */
  | "lazy-alias"
  /** `lazyEpochs: <anything but new Map()>`. */
  | "lazy-initializer"
  /** `Object.assign` — forbidden outright in store sources. */
  | "object-assign"
  /** An epoch-carrying value (a row, an entry) put into a slot or a map. */
  | "row-value"
  /** `...row` not followed by `versionEpoch: effectiveEpoch(…)`. */
  | "row-spread"

// Місце, де запис епохи поза `effectiveEpoch` правильний, — з причиною.
const ALLOWED: Record<string, string> = {
  // Вхідний рядок з відповіді джерела — ще не стан: епоху несе відповідь,
  // а правило застосовує запис у сховище.
  "source.ts serverRow epoch-shorthand": "builds the incoming row",
  // Маркер підтверджує збережений рядок як є: сервер шле його лише в епосі,
  // рівній епосі `known`, тож епоха збереженого рядка — епоха відповіді.
  "source.ts rowFromMarker row-spread": "a marker confirms the held row",
  // Копія запису з власною епохою без змін — лише `complete` скидається.
  "section-store.ts resetCompleteness row-spread": "copies its own epoch",
  "section-store.ts resetCompleteness row-value": "copies its own epoch",
  // Локальна мапа рядків відповіді, не стан: у сховище вони йдуть через `put`.
  "writer.ts readFullAgain row-value": "a local map of answer rows",
}

const BASE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
}

function stripped(n: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n)
  )
    n = n.expression
  return n
}

function callOf(n: ts.Expression | undefined, name: string): boolean {
  if (n === undefined) return false
  const c = stripped(n)
  return (
    ts.isCallExpression(c) &&
    ts.isIdentifier(c.expression) &&
    c.expression.text === name
  )
}

const isEffectiveEpoch = (n: ts.Expression | undefined) =>
  callOf(n, "effectiveEpoch")

const propName = (n: ts.ObjectLiteralElementLike) =>
  n.name !== undefined && ts.isIdentifier(n.name) ? n.name.text : undefined

const setsEpoch = (p: ts.ObjectLiteralElementLike) =>
  ts.isPropertyAssignment(p) &&
  propName(p) === "versionEpoch" &&
  isEffectiveEpoch(p.initializer)

function enclosingFunction(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (
      (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) &&
      p.name !== undefined &&
      ts.isIdentifier(p.name)
    )
      return p.name.text
    if (
      ts.isVariableDeclaration(p) &&
      ts.isIdentifier(p.name) &&
      p.initializer !== undefined &&
      (ts.isArrowFunction(p.initializer) ||
        ts.isFunctionExpression(p.initializer))
    )
      return p.name.text
  }
  return ""
}

interface Scan {
  /** Writes outside the rule: `file:line form`. */
  violations: string[]
  /** Epoch-carrying writes recognised by type that follow the rule. */
  ruled: number
}

/**
 * Epoch writes of one file. AST plus the type checker, not regex: comments
 * and type declarations do not count, and a row is recognised by its type
 * (it carries `versionEpoch`), not by a variable name.
 */
function scan(program: ts.Program, sf: ts.SourceFile, label: string): Scan {
  const checker = program.getTypeChecker()
  const result: Scan = { violations: [], ruled: 0 }

  const carries = (t: ts.Type | undefined): boolean => {
    if (t === undefined) return false
    const parts = t.isUnion() ? t.types : [t]
    return parts.some(
      (p) => checker.getPropertyOfType(p, "versionEpoch") !== undefined
    )
  }
  const epochCarrying = (value: ts.Expression) =>
    carries(checker.getTypeAtLocation(value)) ||
    carries(checker.getContextualType(value))

  // Значення, що несе епоху, безпечне, коли його епоху вже поставило
  // правило: `mergeVersioned`, літерал з `versionEpoch: effectiveEpoch(…)`,
  // `undefined`, гілки `??`/`||`/`?:` з таких, або `const` з таким значенням.
  function ruledValue(value: ts.Expression, depth = 0): boolean {
    const n = stripped(value)
    if (depth > 8) return false
    if (ts.isIdentifier(n) && n.text === "undefined") return true
    if (callOf(n, "mergeVersioned")) return true
    if (ts.isObjectLiteralExpression(n)) return n.properties.some(setsEpoch)
    if (
      ts.isBinaryExpression(n) &&
      (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        n.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    )
      return ruledValue(n.left, depth + 1) && ruledValue(n.right, depth + 1)
    if (ts.isConditionalExpression(n))
      return (
        ruledValue(n.whenTrue, depth + 1) && ruledValue(n.whenFalse, depth + 1)
      )
    if (ts.isIdentifier(n)) {
      const decl = checker.getSymbolAtLocation(n)?.valueDeclaration
      return (
        decl !== undefined &&
        ts.isVariableDeclaration(decl) &&
        (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0 &&
        decl.initializer !== undefined &&
        ruledValue(decl.initializer, depth + 1)
      )
    }
    return false
  }

  const flag = (n: ts.Node, form: Form) => {
    if (ALLOWED[`${label} ${enclosingFunction(n)} ${form}`] !== undefined)
      return
    const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
    result.violations.push(`${label}:${line} ${form}`)
  }
  const sink = (n: ts.Node, value: ts.Expression) => {
    if (!epochCarrying(value)) return
    if (ruledValue(value)) result.ruled++
    else flag(n, "row-value")
  }

  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n)) {
      if (propName(n) === "versionEpoch" && !isEffectiveEpoch(n.initializer))
        flag(n, "epoch-property")
      if (propName(n) === "lazyEpochs") {
        const init = stripped(n.initializer)
        if (
          !ts.isNewExpression(init) ||
          !ts.isIdentifier(init.expression) ||
          init.expression.text !== "Map" ||
          (init.arguments?.length ?? 0) > 0
        )
          flag(n, "lazy-initializer")
      }
      sink(n, n.initializer)
    }
    if (ts.isShorthandPropertyAssignment(n)) {
      if (n.name.text === "versionEpoch") flag(n, "epoch-shorthand")
      sink(n, n.name)
    }
    if (ts.isSpreadAssignment(n) && epochCarrying(n.expression)) {
      const props = n.parent.properties
      if (!props.slice(props.indexOf(n) + 1).some(setsEpoch))
        flag(n, "row-spread")
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      if (
        ts.isPropertyAccessExpression(n.left) &&
        n.left.name.text === "versionEpoch" &&
        !isEffectiveEpoch(n.right)
      )
        flag(n, "epoch-assignment")
      sink(n, n.right)
    }
    if (
      ts.isElementAccessExpression(n) &&
      ts.isStringLiteralLike(n.argumentExpression) &&
      ["versionEpoch", "lazyEpochs", "row"].includes(n.argumentExpression.text)
    )
      flag(n, "element-access")
    if (ts.isPropertyAccessExpression(n) && n.name.text === "lazyEpochs") {
      // Дозволено лише `x.lazyEpochs.get(…)`, `.clear()` і
      // `.set(f, effectiveEpoch(…))`: псевдонім мапи синтаксисом не
      // простежити, тож будь-яке інше вживання заборонено.
      const member = n.parent
      const call = member.parent
      const method =
        ts.isPropertyAccessExpression(member) &&
        member.expression === n &&
        ts.isCallExpression(call) &&
        call.expression === member
          ? member.name.text
          : undefined
      if (method === "set" && ts.isCallExpression(call)) {
        if (!isEffectiveEpoch(call.arguments[1])) flag(n, "lazy-set")
      } else if (method !== "get" && method !== "clear") flag(n, "lazy-alias")
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "set" &&
      n.arguments.length === 2 &&
      !(
        ts.isPropertyAccessExpression(n.expression.expression) &&
        n.expression.expression.name.text === "lazyEpochs"
      )
    )
      sink(n, n.arguments[1]!)
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "Object" &&
      n.expression.name.text === "assign"
    )
      flag(n, "object-assign")
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return result
}

// Самотест: кожна форма на вбудованому джерелі — погана червоніє, добра ні.
// Без lib: типи прелюдії самодостатні, а програма будується швидко.
const PRELUDE = `
interface Map<K, V> { set(k: K, v: V): this; get(k: K): V | undefined; clear(): void }
declare var Map: new <K, V>(entries?: [K, V][]) => Map<K, V>
interface Row { key: string; version: number; versionEpoch?: string | null; values: { [k: string]: unknown } }
interface Entry { row: Row | undefined; versionEpoch: string | null; lazyEpochs: Map<string, string | null> }
declare function effectiveEpoch(a: string | null | undefined, b: string | null | undefined): string | null
declare function mergeVersioned(a: Row | undefined, b: Row): Row | undefined
declare const e: Entry
declare const row: Row
declare const f: string
declare const rows: Map<string, Row>
declare const Object: { assign(a: object, b: object): object }
`

function inlineScan(body: string): Scan {
  const name = "/virtual/case.ts"
  const text = `${PRELUDE}\nexport function write() {\n${body}\n}\n`
  const options = { ...BASE_OPTIONS, noLib: true }
  const host = ts.createCompilerHost(options, true)
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true)
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, ...rest) =>
    file === name ? sf : original(file, ...rest)
  host.fileExists = (file) => file === name
  host.readFile = (file) => (file === name ? text : undefined)
  const program = ts.createProgram([name], options, host)
  return scan(program, program.getSourceFile(name)!, "case.ts")
}

const forms = (s: Scan) => s.violations.map((v) => v.split(" ")[1])

const GOOD_ROW = "e.row = mergeVersioned(e.row, row)"
const ENTRY = (row: string, lazy: string) =>
  `const x: Entry = { row: ${row}, versionEpoch: effectiveEpoch(null, null), lazyEpochs: ${lazy} }; rows.get(x.row?.key ?? f)`

const CASES: { form: Form; bad: string; good: string }[] = [
  {
    form: "epoch-property",
    bad: `e.row = { key: "k", version: 1, versionEpoch: "x", values: {} }`,
    good: `e.row = { key: "k", version: 1, versionEpoch: effectiveEpoch("x", null), values: {} }`,
  },
  {
    form: "epoch-shorthand",
    bad: `const versionEpoch = "x"; e.row = { key: "k", version: 1, versionEpoch, values: {} }`,
    good: GOOD_ROW,
  },
  {
    form: "epoch-assignment",
    bad: `e.versionEpoch = row.versionEpoch ?? null`,
    good: `e.versionEpoch = effectiveEpoch(row.versionEpoch, e.versionEpoch)`,
  },
  {
    form: "element-access",
    bad: `e["versionEpoch"] = effectiveEpoch(null, null)`,
    good: `e.versionEpoch = effectiveEpoch(null, e.versionEpoch)`,
  },
  {
    form: "lazy-set",
    bad: `e.lazyEpochs.set(f, row.versionEpoch ?? null)`,
    good: `e.lazyEpochs.set(f, effectiveEpoch(row.versionEpoch, e.versionEpoch))`,
  },
  {
    form: "lazy-alias",
    bad: `const m = e.lazyEpochs; m.set(f, effectiveEpoch(null, null))`,
    good: `e.lazyEpochs.clear(); e.lazyEpochs.get(f)`,
  },
  {
    form: "lazy-initializer",
    bad: ENTRY("undefined", `new Map([[f, "x"]])`),
    good: ENTRY("undefined", "new Map()"),
  },
  { form: "object-assign", bad: `Object.assign(e, { row })`, good: GOOD_ROW },
  { form: "row-value", bad: `e.row = row`, good: GOOD_ROW },
  {
    form: "row-value",
    bad: `const r = row; e.row = r`,
    good: `const r = mergeVersioned(e.row, row); e.row = r`,
  },
  {
    form: "row-value",
    bad: ENTRY("row", "new Map()"),
    good: ENTRY("mergeVersioned(e.row, row)", "new Map()"),
  },
  {
    form: "row-value",
    bad: `rows.set(f, row)`,
    good: `rows.set(f, { ...row, versionEpoch: effectiveEpoch(row.versionEpoch, null) })`,
  },
  {
    form: "row-spread",
    bad: `e.row = { ...row, values: {} }`,
    good: `e.row = { ...row, versionEpoch: effectiveEpoch(row.versionEpoch, e.versionEpoch), values: {} }`,
  },
  {
    form: "row-spread",
    bad: `e.row = { versionEpoch: effectiveEpoch(null, e.versionEpoch), ...row }`,
    good: `e.row = { ...row, versionEpoch: effectiveEpoch(null, e.versionEpoch) }`,
  },
]

describe("epoch write guard self-test", () => {
  it.each(CASES)("$form: flags `$bad`", ({ form, bad }) => {
    expect(forms(inlineScan(bad))).toContain(form)
  })

  it.each(CASES)("$form: passes `$good`", ({ good }) => {
    expect(inlineScan(good).violations).toEqual([])
  })
})

describe("epoch writes in src/data/store (B1c Р5, Р6)", () => {
  // Один шлях запису: `null`-відповідь (репліка) не стирає відомої епохи,
  // а нова непорожня її заміняє. Прямий запис поза `effectiveEpoch` уже
  // тричі давав порівняння версій різних епох.
  it("writes an epoch into store state only through effectiveEpoch", () => {
    const labels = files.map((f) => relative(STORE, f))
    expect(labels).toContain("object-store.ts")
    expect(labels).toContain("section-store.ts")
    const program = ts.createProgram(files, {
      ...BASE_OPTIONS,
      lib: ["lib.es2022.d.ts"],
    })
    const scans = new Map(
      files.map((f) => [
        relative(STORE, f),
        scan(program, program.getSourceFile(f)!, relative(STORE, f)),
      ])
    )
    // Записи, визнані за типом рядка, мають знайтись в обох сховищах: інакше
    // типи не розв'язались і гард нічого не доводить.
    expect(scans.get("object-store.ts")!.ruled).toBeGreaterThan(0)
    expect(scans.get("section-store.ts")!.ruled).toBeGreaterThan(0)
    expect([...scans.values()].flatMap((s) => s.violations)).toEqual([])
  }, 60_000)
})
