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

/**
 * Знаходить обходи фасаду, невидимі статичному лінту:
 *  - деструктуризація `writeInsert|…|refetch` та `createTransaction|…`;
 *  - доступ `x.createTransaction` / `x.createOptimisticAction` (отже й
 *    `(await import("@tanstack/db")).createTransaction`);
 *  - доступ до sync-методів літеральним ключем `c.utils["refetch"]`;
 *  - обчислений не-літеральний ключ лише на `….utils[expr]` — саме там живуть
 *    sync-методи; ширше правило ловило б кожен `arr[i]` у коді;
 *  - динамічний `import()` пакетів `@tanstack/query-core` і
 *    `@tanstack/query-db-collection`.
 */
export function findFacadeBypasses(source: string, file: string): string[] {
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
  const visit = (n: ts.Node): void => {
    if (ts.isObjectBindingPattern(n)) {
      for (const el of n.elements) {
        const name = propName(el.propertyName ?? el.name)
        if (name && (SYNC_WRITES.has(name) || TX_FACTORIES.has(name)))
          report(el, `destructuring of ${name}`)
      }
    } else if (ts.isPropertyAccessExpression(n)) {
      if (TX_FACTORIES.has(n.name.text)) report(n, `access to ${n.name.text}`)
    } else if (ts.isElementAccessExpression(n)) {
      const arg = n.argumentExpression
      const onUtils =
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "utils"
      if (isStringLiteral(arg)) {
        const name = (arg as ts.StringLiteralLike).text
        if (SYNC_WRITES.has(name) || TX_FACTORIES.has(name))
          report(n, `element access to ${name}`)
      } else if (onUtils) {
        report(n, "computed non-literal key on utils")
      }
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const arg = n.arguments[0]
      if (
        arg &&
        isStringLiteral(arg) &&
        QUERY_MODULES.has((arg as ts.StringLiteral).text)
      )
        report(n, `dynamic import of ${(arg as ts.StringLiteral).text}`)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found
}

// Обхід приймає корінь параметром, щоб тест на тимчасовій теці і тест на
// реальному дереві ділили один код.
export function scanDataTree(root: string): string[] {
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
    ["tsx file", 'void import("@tanstack/query-core")', "x.tsx"],
  ]
  it.each(bad)("flags %s", (_n, src, file) => {
    expect(findFacadeBypasses(src, file).length).toBeGreaterThan(0)
  })

  it("passes clean source", () => {
    const src =
      'const a = arr[i]\nconst { x } = y\nawait import("./z")\nutils.foo'
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
