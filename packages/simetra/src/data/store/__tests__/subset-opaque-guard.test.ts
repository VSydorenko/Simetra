import { existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/*
 * Тест-страж (план SK-0, Р-SK0-8): у модельних тестах `Subset` і `ReaderTarget`
 * непрозорі. Поля свіжості (вимоги, польоти, строк, видимість) — стан цілі,
 * який спека ядра синхронізації (§5.6) віддає `sync()`; оракул, що читає їх
 * з об'єкта ядра, судить за тим самим станом, який перевіряє, і зеленіє
 * разом із дефектом. Тож значення цих типів у модельних тестах можна лише
 * брати ключем контейнера, порівнювати за тотожністю й читати поля з
 * дозвільного переліку. Перевірка — за типами (program + checker), а не
 * регексом: псевдонім чи помічник не обходять її.
 */

const STORE = join(import.meta.dirname, "..")
const ENTRY = ["model.test.ts", "receiver-model.test.ts"].map((f) =>
  join(import.meta.dirname, f)
)

/** Властивості за власником: дозволені (не свіжість) і заборонені (стан цілі). */
const FIELDS = {
  ReaderTarget: {
    allowed: [
      "form",
      "owned",
      "included",
      "layout",
      "layoutSet",
      "strategy",
      "truncated",
      "atEnd",
      "window",
      "headerState",
    ],
    forbidden: ["paging", "sectionRead", "unconfirmedSince", "answerRejected"],
  },
  Subset: {
    allowed: [
      "targetId",
      "preloads",
      "preloadTimers",
      "releaseTimer",
      "alive",
      "settled",
      "loaded",
      "status",
      "error",
      "hasNewRows",
      "waiters",
      "snapshot",
      "refViews",
      "purged",
    ],
    forbidden: [
      "listeners",
      "gen",
      "flight",
      "flightEpoch",
      "flightCause",
      "rereadEpochs",
      "trailing",
      "refreshedAt",
      "okReadEpoch",
      "rereads",
      "failures",
      "failedAt",
      "rereadTail",
      "rereadWaiters",
      "needsRefresh",
      "dirty",
      "readRevision",
      "readStart",
      "checkQueued",
      "checkHeld",
      "recheck",
      "visible",
      "hydrated",
    ],
  },
} as const

type Owner = keyof typeof FIELDS

const ALLOWED: ReadonlySet<string> = new Set(
  Object.values(FIELDS).flatMap((f) => f.allowed)
)

/** Контейнери, що беруть значення лише ключем чи елементом і не читають його. */
const CONTAINERS = new Set([
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ReadonlyMap",
  "ReadonlySet",
  "Array",
  "ReadonlyArray",
])
/** Методи масиву, що порівнюють за тотожністю; решта методів масиву — зворотні виклики. */
const CONTAINER_METHODS = new Set([
  "get",
  "set",
  "has",
  "add",
  "delete",
  "includes",
  "indexOf",
  "push",
])
/** Типи, що лише несуть значення: `Map<Subset, …>`, `Subset[]`, `Promise<Subset>`. */
const CARRIER_TYPES = new Set([...CONTAINERS, "Promise", "Iterable"])

const BASE_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ["lib.es2022.d.ts"],
}

/** Файли тестів, досяжні з входів відносними імпортами `./…` (помічники). */
function reachableHelpers(program: ts.Program, entry: readonly string[]) {
  const seen = new Set<string>()
  const queue = [...entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    const sf = program.getSourceFile(file)
    if (sf === undefined) continue
    for (const s of sf.statements) {
      if (
        !ts.isImportDeclaration(s) ||
        !ts.isStringLiteral(s.moduleSpecifier) ||
        !s.moduleSpecifier.text.startsWith("./")
      )
        continue
      const base = join(dirname(file), s.moduleSpecifier.text)
      const target = [`${base}.ts`, join(base, "index.ts")].find(
        (c) => program.getSourceFile(c) !== undefined
      )
      if (target !== undefined) queue.push(target)
    }
  }
  return [...seen]
}

interface Guard {
  readonly program: ts.Program
  /** Файли, що перевіряються (вони ж — «оголошено в `__tests__`»). */
  readonly files: readonly string[]
  readonly label: (file: string) => string
  /** Каталог оголошень `Subset` / `ReaderTarget`. */
  readonly owners: Record<Owner, string>
}

const WRAPPERS = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.SatisfiesExpression,
])

function ownerOf(guard: Guard, type: ts.Type): Owner | undefined {
  const symbol = type.getSymbol() ?? type.aliasSymbol
  if (symbol === undefined) return undefined
  for (const owner of Object.keys(FIELDS) as Owner[]) {
    if (
      symbol.name === owner &&
      (symbol.declarations ?? []).some(
        (d) => d.getSourceFile().fileName === guard.owners[owner]
      )
    )
      return owner
  }
  return undefined
}

/** Тип без `undefined`/`null` і чи він (чи кожен член об'єднання) — Subset/ReaderTarget. */
function opaqueOnly(guard: Guard, type: ts.Type | undefined): boolean {
  if (type === undefined) return true
  if (type.isUnion()) return type.types.every((t) => opaqueOnly(guard, t))
  if (
    type.flags &
    (ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void)
  )
    return true
  if (type.flags & ts.TypeFlags.TypeParameter) return true
  return ownerOf(guard, type) !== undefined
}

function containsOpaque(guard: Guard, type: ts.Type): boolean {
  const apparent = type.isUnion() ? type.types : [type]
  return apparent.some((t) => ownerOf(guard, t) !== undefined)
}

/** Читання з порушеннями: `file:line форма`. */
function violations(guard: Guard): string[] {
  const checker = guard.program.getTypeChecker()
  const fileSet = new Set(guard.files)
  const out: string[] = []

  for (const file of guard.files) {
    const sf = guard.program.getSourceFile(file)!
    const report = (n: ts.Node, what: string) => {
      const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
      out.push(`${guard.label(file)}:${line} ${what}`)
    }

    /** Чи значення `c` у позиції батька `p` лишається непрозорим. */
    const judge = (c: ts.Node, what: string): void => {
      let node = c
      let p = node.parent
      while (WRAPPERS.has(p.kind)) {
        node = p
        p = p.parent
      }
      const carrier = (): void => {
        if (
          !opaqueOnly(guard, checker.getContextualType(node as ts.Expression))
        )
          report(c, `${what} widened`)
      }
      // Значення потрапляє далі як результат батька: суджу батька.
      const through = (): void => judge(p, what)

      if (ts.isPropertyAccessExpression(p) && p.expression === node) {
        if (!ALLOWED.has(p.name.text)) report(c, `${what}.${p.name.text}`)
        return
      }
      if (ts.isElementAccessExpression(p) && p.expression === node) {
        const arg = p.argumentExpression
        if (!ts.isStringLiteralLike(arg)) report(c, `${what}[non-literal]`)
        else if (!ALLOWED.has(arg.text)) report(c, `${what}["${arg.text}"]`)
        return
      }
      if (ts.isBinaryExpression(p)) {
        const op = p.operatorToken.kind
        if (
          op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          op === ts.SyntaxKind.EqualsEqualsToken ||
          op === ts.SyntaxKind.ExclamationEqualsToken
        )
          return
        if (op === ts.SyntaxKind.AmpersandAmpersandToken && p.left === node)
          return
        if (
          op === ts.SyntaxKind.AmpersandAmpersandToken ||
          op === ts.SyntaxKind.BarBarToken ||
          op === ts.SyntaxKind.QuestionQuestionToken
        )
          return through()
        if (op === ts.SyntaxKind.EqualsToken && p.right === node)
          return carrier()
        report(c, `${what} in operator`)
        return
      }
      if (ts.isConditionalExpression(p)) {
        if (p.condition === node) return
        return through()
      }
      if (
        ts.isPrefixUnaryExpression(p) &&
        p.operator === ts.SyntaxKind.ExclamationToken
      )
        return
      if (ts.isTypeOfExpression(p)) return
      if (
        (ts.isIfStatement(p) ||
          ts.isWhileStatement(p) ||
          ts.isDoStatement(p)) &&
        p.expression === node
      )
        return
      if (ts.isExpressionStatement(p)) return
      if (ts.isAwaitExpression(p)) return through()
      if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
        if (p.expression === node) return
        const callee = ts.isCallExpression(p)
          ? ts.isPropertyAccessExpression(p.expression)
            ? p.expression.name
            : p.expression
          : p.expression
        const symbol = checker.getSymbolAtLocation(callee)
        const decls = symbol?.declarations ?? []
        const own =
          decls.length > 0 &&
          decls.every((d) => fileSet.has(d.getSourceFile().fileName))
        const container = ts.isNewExpression(p)
          ? CONTAINERS.has(symbol?.name ?? "")
          : CONTAINER_METHODS.has(symbol?.name ?? "") &&
            decls.some(
              (d) =>
                (ts.isInterfaceDeclaration(d.parent) ||
                  ts.isClassDeclaration(d.parent)) &&
                d.parent.name !== undefined &&
                CONTAINERS.has(d.parent.name.text)
            )
        if (!own && !container) {
          report(
            c,
            `${what} passed to ${symbol?.name ?? "an unresolved callee"} declared outside the tests`
          )
          return
        }
        const idx = p.arguments?.indexOf(node as ts.Expression) ?? -1
        const sig = checker.getResolvedSignature(p)
        const param = sig?.parameters[Math.min(idx, sig.parameters.length - 1)]
        if (own && param !== undefined) {
          const t = checker.getTypeOfSymbolAtLocation(param, p)
          const spread =
            param.valueDeclaration !== undefined &&
            ts.isParameter(param.valueDeclaration) &&
            param.valueDeclaration.dotDotDotToken !== undefined
          if (!spread && !opaqueOnly(guard, t))
            report(c, `${what} widened by a parameter`)
        }
        return
      }
      if (ts.isVariableDeclaration(p) && p.initializer === node) {
        if (ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) {
            const name = (el.propertyName ?? el.name) as ts.Identifier
            if (el.dotDotDotToken !== undefined || !ALLOWED.has(name.text))
              report(el, `${what} destructured ${name.text ?? "rest"}`)
          }
          return
        }
        const declared = checker.getTypeAtLocation(p.name)
        if (!opaqueOnly(guard, declared))
          report(c, `${what} widened by a declaration`)
        return
      }
      if (ts.isSpreadAssignment(p) || ts.isSpreadElement(p)) {
        report(c, `${what} spread`)
        return
      }
      if (
        ts.isArrayLiteralExpression(p) ||
        ts.isPropertyAssignment(p) ||
        ts.isShorthandPropertyAssignment(p) ||
        ts.isReturnStatement(p) ||
        ts.isArrowFunction(p)
      )
        return carrier()
      if (ts.isAsExpression(p) || ts.isTypeAssertionExpression(p)) {
        const target = checker.getTypeFromTypeNode(p.type)
        if (!opaqueOnly(guard, target)) report(c, `${what} cast`)
        else return through()
        return
      }
      if (ts.isSwitchStatement(p) || ts.isCaseClause(p)) return
      report(c, `${what} used as ${ts.SyntaxKind[p.kind]}`)
    }

    const visit = (n: ts.Node): void => {
      // Тип-вузол: `Pick<Subset, …>`, `keyof Subset` і подібне розширюють непрозорий тип.
      if (ts.isTypeReferenceNode(n)) {
        const type = checker.getTypeFromTypeNode(n)
        if (ownerOf(guard, type) !== undefined) {
          const p = n.parent
          const ok =
            ts.isParameter(p) ||
            ts.isVariableDeclaration(p) ||
            ts.isPropertySignature(p) ||
            ts.isPropertyDeclaration(p) ||
            ts.isTypeAliasDeclaration(p) ||
            ts.isUnionTypeNode(p) ||
            ts.isArrayTypeNode(p) ||
            ts.isTupleTypeNode(p) ||
            ts.isNamedTupleMember(p) ||
            ts.isParenthesizedTypeNode(p) ||
            ts.isAsExpression(p) ||
            ts.isTypeAssertionExpression(p) ||
            (ts.isFunctionLike(p) && p.type === n) ||
            (ts.isTypeReferenceNode(p) &&
              CARRIER_TYPES.has(
                ts.isIdentifier(p.typeName) ? p.typeName.text : ""
              )) ||
            (ts.isNewExpression(p) &&
              ts.isIdentifier(p.expression) &&
              CONTAINERS.has(p.expression.text))
          if (!ok) report(n, "Subset type used as a type argument or operator")
        }
      }
      if (ts.isIndexedAccessTypeNode(n)) {
        const obj = checker.getTypeFromTypeNode(n.objectType)
        if (ownerOf(guard, obj) !== undefined) {
          const idx = n.indexType
          if (
            !ts.isLiteralTypeNode(idx) ||
            !ts.isStringLiteral(idx.literal) ||
            !ALLOWED.has(idx.literal.text)
          )
            report(n, "Subset indexed type outside the allowed fields")
        }
      }
      if (
        ts.isTypeOperatorNode(n) &&
        n.operator === ts.SyntaxKind.KeyOfKeyword
      ) {
        if (ownerOf(guard, checker.getTypeFromTypeNode(n.type)) !== undefined)
          report(n, "keyof Subset")
      }
      const isValue =
        ts.isIdentifier(n) ||
        ts.isPropertyAccessExpression(n) ||
        ts.isElementAccessExpression(n) ||
        ts.isCallExpression(n) ||
        ts.isNewExpression(n)
      if (isValue && !WRAPPERS.has(n.parent.kind)) {
        const parent = n.parent
        const nameSlot =
          (ts.isIdentifier(n) &&
            ((ts.isPropertyAccessExpression(parent) && parent.name === n) ||
              (ts.isQualifiedName(parent) && parent.right === n) ||
              ts.isTypeReferenceNode(parent) ||
              ts.isTypeQueryNode(parent) ||
              ts.isImportSpecifier(parent) ||
              ts.isExportSpecifier(parent) ||
              (ts.isPropertyAssignment(parent) && parent.name === n) ||
              (ts.isBindingElement(parent) && parent.propertyName === n) ||
              (!ts.isShorthandPropertyAssignment(parent) &&
                (parent as { name?: ts.Node }).name === n))) ||
          false
        if (!nameSlot) {
          const type = checker.getTypeAtLocation(n)
          if (containsOpaque(guard, type) && opaqueOnly(guard, type)) {
            const owner = type.isUnion()
              ? type.types
                  .map((t) => ownerOf(guard, t))
                  .find((o) => o !== undefined)
              : ownerOf(guard, type)
            judge(n, owner ?? "Subset")
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return out
}

/** Властивості обох типів, яких немає в жодному переліку, і імена переліків без властивості. */
function classification(guard: Guard) {
  const checker = guard.program.getTypeChecker()
  const unclassified: string[] = []
  const missing: string[] = []
  for (const owner of Object.keys(FIELDS) as Owner[]) {
    const sf = guard.program.getSourceFile(guard.owners[owner])!
    const decl = sf.statements.find(
      (s): s is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(s) && s.name.text === owner
    )!
    const props = checker
      .getPropertiesOfType(checker.getTypeAtLocation(decl))
      .map((s) => s.name)
    const listed = [
      ...FIELDS[owner].allowed,
      ...FIELDS[owner].forbidden,
    ] as string[]
    // `Subset extends ReaderTarget`: успадковані поля стоять у переліку власника.
    const inherited =
      owner === "Subset"
        ? ([
            ...FIELDS.ReaderTarget.allowed,
            ...FIELDS.ReaderTarget.forbidden,
          ] as string[])
        : []
    for (const name of props)
      if (!listed.includes(name) && !inherited.includes(name))
        unclassified.push(`${owner}.${name}`)
    for (const name of listed)
      if (!props.includes(name)) missing.push(`${owner}.${name}`)
    const twice = listed.filter((n, i) => listed.indexOf(n) !== i)
    for (const name of twice) unclassified.push(`${owner}.${name} twice`)
  }
  return { unclassified, missing }
}

function inlineGuard(
  sources: Record<string, string>,
  checked: readonly string[]
): Guard {
  const options = { ...BASE_OPTIONS }
  const host = ts.createCompilerHost(options, true)
  const files = new Map(
    Object.entries(sources).map(([name, text]) => [
      name,
      ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true),
    ])
  )
  const original = {
    getSourceFile: host.getSourceFile.bind(host),
    fileExists: host.fileExists.bind(host),
    readFile: host.readFile.bind(host),
  }
  host.getSourceFile = (file, ...rest) =>
    files.get(file) ?? original.getSourceFile(file, ...rest)
  host.fileExists = (file) => files.has(file) || original.fileExists(file)
  host.readFile = (file) => sources[file] ?? original.readFile(file)
  const dirExists = host.directoryExists?.bind(host)
  host.directoryExists = (dir) => dir === "/v" || (dirExists?.(dir) ?? false)
  const program = ts.createProgram([...files.keys()], options, host)
  return {
    program,
    files: checked,
    label: (f) => f,
    owners: { ReaderTarget: "/v/readers.ts", Subset: "/v/subsets.ts" },
  }
}

describe("subset opaque guard self-test", () => {
  const all = (names: readonly string[]) =>
    names.map((n) => `  ${n}: number`).join("\n")
  const readers = `export interface ReaderTarget {\n${all([...FIELDS.ReaderTarget.allowed, ...FIELDS.ReaderTarget.forbidden])}\n}\n`
  const subsets = (extra = "") =>
    `import type { ReaderTarget } from "./readers.ts"\nexport interface Subset extends ReaderTarget {\n${all([...FIELDS.Subset.allowed, ...FIELDS.Subset.forbidden])}\n${extra}\n}\n`
  const helper = `import type { Subset } from "./subsets.ts"\nexport function outside(s: unknown): void {}\nexport function keep(s: Subset): Subset { return s }\n`
  const make = (body: string, extra = "") =>
    inlineGuard(
      {
        "/v/readers.ts": readers,
        "/v/subsets.ts": subsets(extra),
        "/v/outside.ts": helper,
        "/v/t.ts": `import type { Subset } from "./subsets.ts"\nimport { outside, keep } from "./outside.ts"\nexport function t(sub: Subset, subs: Subset[], key: string) {\n${body}\n}\n`,
      },
      ["/v/t.ts"]
    )
  const red = (body: string) => violations(make(body))

  it("passes the opaque uses: map key, identity, allowed fields", () => {
    expect(
      red(
        `const m = new Map<Subset, number>()\nm.set(sub, 1)\nm.get(sub)\nconst w = new WeakMap<Subset, number>()\nw.has(sub)\nconst set = new Set(subs)\nif (set.has(sub) && sub === subs[0]) sub.status\nconst copy = sub\ncopy.preloads\nsubs.includes(sub)\nsub["status"]`
      )
    ).toEqual([])
  })

  it("flags a forbidden field read, also through a destructuring", () => {
    expect(red(`sub.rereads`)).toHaveLength(1)
    expect(red(`const { failures } = sub`)).toHaveLength(1)
    expect(red(`const { status, ...rest } = sub`)).toHaveLength(1)
    expect(red(`sub["flight"]`)).toHaveLength(1)
  })

  it("flags a structural alias", () => {
    expect(red(`const a: { readonly status: number } = sub`)).toHaveLength(1)
    expect(red(`const a: Pick<Subset, "status"> = sub`).length).toBeGreaterThan(
      0
    )
    expect(red(`const a = sub as unknown as { rereads: number }`)).toHaveLength(
      1
    )
  })

  it("flags a call of a helper declared outside the tests", () => {
    expect(red(`outside(sub)`)).toHaveLength(1)
    expect(red(`JSON.stringify(sub)`)).toHaveLength(1)
    expect(red(`Object.entries(sub)`)).toHaveLength(1)
  })

  it("flags a spread and a non-literal index", () => {
    expect(red(`const a = { ...sub }`)).toHaveLength(1)
    expect(red(`const k: "status" | "gen" = "status"\nsub[k]`)).toEqual([
      "/v/t.ts:5 Subset[non-literal]",
    ])
    expect(red(`sub[key as keyof Subset]`).length).toBeGreaterThan(0)
    expect(
      red("const a = (sub as Record<string, unknown>)[key]").length
    ).toBeGreaterThan(0)
  })

  it("flags a helper parameter typed as a structural alias", () => {
    const guard = inlineGuard(
      {
        "/v/readers.ts": readers,
        "/v/subsets.ts": subsets(),
        "/v/t.ts": `import type { Subset } from "./subsets.ts"\nfunction due(s: { readonly failures: number }): number { return s.failures }\nexport function t(sub: Subset) { due(sub) }\n`,
      },
      ["/v/t.ts"]
    )
    expect(violations(guard)).toHaveLength(1)
  })

  it("flags a new property that is in neither list", () => {
    const guard = make(`sub.fresh`, `  fresh: number`)
    expect(classification(guard).unclassified).toEqual(["Subset.fresh"])
    expect(violations(guard)).toHaveLength(1)
  })

  it("a list name that is no longer a property is reported", () => {
    const guard = inlineGuard(
      {
        "/v/readers.ts": readers,
        "/v/subsets.ts": subsets().replace("  rereads: number\n", ""),
        "/v/t.ts": `export const x = 1\n`,
      },
      ["/v/t.ts"]
    )
    expect(classification(guard).missing).toEqual(["Subset.rereads"])
  })

  it("the synthetic program itself is classified fully", () => {
    expect(classification(make(``))).toEqual({ unclassified: [], missing: [] })
  })
})

describe("model tests treat Subset and ReaderTarget as opaque", () => {
  const files = ts.createProgram(ENTRY, BASE_OPTIONS)
  const helpers = reachableHelpers(files, ENTRY).filter((f) =>
    f.startsWith(join(STORE, "__tests__"))
  )
  const guard: Guard = {
    program: files,
    files: helpers,
    label: (f) => relative(STORE, f),
    owners: {
      ReaderTarget: join(STORE, "readers.ts"),
      Subset: join(STORE, "subsets.ts"),
    },
  }

  it("the entries and their helpers are found", () => {
    for (const e of ENTRY) expect(existsSync(e)).toBe(true)
    expect(helpers).toEqual(expect.arrayContaining(ENTRY))
    expect(helpers.some((f) => f.endsWith("core-support.ts"))).toBe(true)
  })

  it("every property of Subset and ReaderTarget is classified, every listed name exists", () => {
    expect(classification(guard)).toEqual({ unclassified: [], missing: [] })
  })
})
