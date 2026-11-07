import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { afterEach, describe, expect, it } from "vitest"

const DATA = join(dirname(fileURLToPath(import.meta.url)), "../src/data")

// Статичний ESLint не бачить динамічний `import()` і обчислені ключі, тому
// обхід фасаду, який він пропустить, ловить цей гард (спека П4-B §3).
const SYNC_WRITES = new Set([
  "writeInsert",
  "writeUpdate",
  "writeDelete",
  "writeUpsert",
  "writeBatch",
  "refetch",
])
const TX_FACTORIES = new Set(["createTransaction", "createOptimisticAction"])
const QUERY_MODULES = new Set([
  "@tanstack/query-core",
  "@tanstack/query-db-collection",
])

function isStringLiteral(n: ts.Node): boolean {
  return ts.isStringLiteralLike(n)
}

function propName(n: ts.PropertyName | ts.BindingName): string | undefined {
  return ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : undefined
}

const WRAPPERS = (n: ts.Node): boolean =>
  ts.isParenthesizedExpression(n) ||
  ts.isAsExpression(n) ||
  ts.isSatisfiesExpression(n) ||
  ts.isNonNullExpression(n)

function stripDown(e: ts.Expression): ts.Expression {
  while (WRAPPERS(e)) e = (e as ts.ParenthesizedExpression).expression
  return e
}

function outermost(n: ts.Node): ts.Node {
  while (n.parent && WRAPPERS(n.parent)) n = n.parent
  return n
}

/**
 * Знаходить обходи фасаду, невидимі статичному лінту. Чому саме так: значення
 * `.utils` колекції несе sync-методи (`writeInsert`, `refetch`, …), тож поза
 * фасадом його дозволено лише як об'єкт доступу до літерального імені, що не
 * є забороненим (`c.utils.isReady`). Будь-яке інше використання (аліас,
 * присвоєння, аргумент, spread, деструктуризація, обчислений ключ) ховає
 * подальший доступ від лінту, тому є знахідкою. Дужки, `as`, `satisfies` і `!`
 * пропускаємо — вони не змінюють значення.
 *  - голий `utils[expr]` з нелітеральним ключем — знахідка;
 *  - деструктуризація (декларація чи присвоєння) шести sync-імен і
 *    `createTransaction|createOptimisticAction`;
 *  - доступ до фабрик транзакцій, літеральний ключ до заборонених імен;
 *  - будь-який динамічний `import()` пакета `@tanstack/db` (статичні імпорти
 *    тримає лінт, а динамічний імпорт поза фасадом не потрібен), а також
 *    `@tanstack/query-core` і `@tanstack/query-db-collection`.
 * Загальний `arr[i]` не чіпаємо: правило звужене до значення `utils`.
 */
function findFacadeBypasses(source: string, file: string): string[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const found: string[] = []
  const report = (n: ts.Node, what: string) => {
    const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf))
    found.push(`${file}:${line + 1} ${what}`)
  }
  const banned = (name: string) =>
    SYNC_WRITES.has(name) || TX_FACTORIES.has(name)
  const visit = (n: ts.Node): void => {
    if (ts.isObjectBindingPattern(n)) {
      for (const el of n.elements) {
        const name = propName(el.propertyName ?? el.name)
        if (name && banned(name)) report(el, `destructuring of ${name}`)
      }
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(stripDown(n.left))
    ) {
      for (const p of (stripDown(n.left) as ts.ObjectLiteralExpression)
        .properties) {
        const name = p.name ? propName(p.name as ts.PropertyName) : undefined
        if (name && banned(name)) report(p, `destructuring of ${name}`)
      }
    } else if (ts.isPropertyAccessExpression(n)) {
      if (TX_FACTORIES.has(n.name.text)) report(n, `access to ${n.name.text}`)
      if (n.name.text === "utils") {
        const out = outermost(n)
        const p = out.parent
        const ok =
          (ts.isPropertyAccessExpression(p) &&
            p.expression === out &&
            !banned(p.name.text)) ||
          (ts.isElementAccessExpression(p) &&
            p.expression === out &&
            isStringLiteral(p.argumentExpression) &&
            !banned((p.argumentExpression as ts.StringLiteralLike).text))
        if (!ok) report(n, "utils used other than as c.utils.<allowed name>")
      }
    } else if (ts.isElementAccessExpression(n)) {
      const arg = n.argumentExpression
      const obj = stripDown(n.expression)
      if (isStringLiteral(arg)) {
        const name = (arg as ts.StringLiteralLike).text
        if (banned(name)) report(n, `element access to ${name}`)
      } else if (ts.isIdentifier(obj) && obj.text === "utils") {
        report(n, "computed non-literal key on utils")
      }
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = n.arguments[0]
      if (arg && isStringLiteral(arg)) {
        const m = (arg as ts.StringLiteral).text
        if (QUERY_MODULES.has(m) || m === "@tanstack/db")
          report(n, `dynamic import of ${m}`)
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

// Обхід приймає корінь параметром, щоб тест на тимчасовій теці і тест на
// реальному дереві ділили один код.
function scanDataTree(root: string): string[] {
  const out: string[] = []
  const walkDir = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (e.name === "__tests__" || r === "facade") continue
        walkDir(join(dir, e.name), r)
      } else if (/\.tsx?$/.test(e.name)) {
        out.push(
          ...findFacadeBypasses(readFileSync(join(dir, e.name), "utf8"), r)
        )
      }
    }
  }
  walkDir(root, "")
  return out
}

describe("data-facade guard: findFacadeBypasses", () => {
  const bad: [string, string, string][] = [
    ["destructuring writeInsert", "const { writeInsert } = c.utils", "x.ts"],
    ["destructuring refetch", "const { refetch } = c.utils", "x.ts"],
    ["computed key", 'c.utils["write" + kind](row)', "x.ts"],
    ["literal key", 'c.utils["refetch"]()', "x.ts"],
    ["dynamic query-core", 'await import("@tanstack/query-core")', "x.ts"],
    [
      "dynamic query-db-collection",
      'await import("@tanstack/query-db-collection")',
      "x.ts",
    ],
    [
      "dynamic db createTransaction",
      'const t = (await import("@tanstack/db")).createTransaction',
      "x.ts",
    ],
    ["alias", "const u = c.utils\nu[k]()", "x.ts"],
    ["assignment alias", "let u\nu = c.utils", "x.ts"],
    ["bare utils computed", "utils[k]()", "x.ts"],
    ["as-cast computed", "(c.utils as X)[k]()", "x.ts"],
    ["non-null computed", "c.utils![k]()", "x.ts"],
    ["utils as argument", "f(c.utils)", "x.ts"],
    ["utils spread", "const o = { ...c.utils }", "x.ts"],
    [
      "destructuring assignment",
      "let refetch\n;({ refetch } = c.utils)",
      "x.ts",
    ],
    ["banned property", "c.utils.refetch()", "x.ts"],
    [
      "dynamic db then",
      'import("@tanstack/db").then((m) => m["create" + "Transaction"])',
      "x.ts",
    ],
    ["tsx file", 'void import("@tanstack/query-core")', "x.tsx"],
  ]
  it.each(bad)("flags %s", (_n, src, file) => {
    expect(findFacadeBypasses(src, file).length).toBeGreaterThan(0)
  })

  it("passes clean source", () => {
    const src =
      'const a = arr[i]\nconst b = record[key]\nconst { x } = y\nawait import("./z")\nc.utils.isReady()\nc.utils["isReady"]\nutils.foo'
    expect(findFacadeBypasses(src, "x.ts")).toEqual([])
  })

  it("real src/data tree has no bypasses", () => {
    expect(scanDataTree(DATA)).toEqual([])
  })

  describe("tree walk", () => {
    let tmp: string | undefined
    afterEach(() => {
      if (tmp) rmSync(tmp, { recursive: true, force: true })
      tmp = undefined
    })

    it("sees .tsx files and skips facade/ and __tests__", () => {
      tmp = mkdtempSync(join(tmpdir(), "facade-guard-"))
      writeFileSync(join(tmp, "x.tsx"), 'void import("@tanstack/query-core")')
      for (const d of ["facade", "__tests__"]) {
        mkdirSync(join(tmp, d))
        writeFileSync(
          join(tmp, d, "y.ts"),
          'void import("@tanstack/query-core")'
        )
      }
      expect(scanDataTree(tmp)).toHaveLength(1)
    })
  })
})
