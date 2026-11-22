import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"
import {
  DATABASE_PROVIDERS,
  PROVIDER_API_ROLES,
  PROVIDER_LOGIN_ROLES,
} from "simetra/model"

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "../src/server")

// Production-код T3 — уся тека `src/server` рекурсивно (`signals/` уже є);
// `__tests__` не входить (фікстури можуть називати провайдера). Шляхи —
// відносні до SERVER.
function collect(dir: string): string[] {
  return readdirSync(join(SERVER, dir), { withFileTypes: true }).flatMap(
    (e) => {
      const rel = dir === "" ? e.name : join(dir, e.name)
      if (e.isDirectory()) return e.name === "__tests__" ? [] : collect(rel)
      return e.name.endsWith(".ts") ? [rel] : []
    }
  )
}
const files = collect("")

// Заборонені значення виводяться з T0, а не переписуються: нове значення
// провайдера потрапляє під заборону без правки тесту.
const FORBIDDEN = new Set<string>([
  ...DATABASE_PROVIDERS,
  ...Object.values(PROVIDER_API_ROLES).flatMap((r) => Object.values(r)),
  ...Object.values(PROVIDER_LOGIN_ROLES).flat(),
])

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(join(SERVER, file), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
}

// AST, а не regex: коментарі в аналіз не потрапляють.
function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (c) => walk(c, visit))
}

describe("src/server sources", () => {
  it("finds the production files", () => {
    expect(files).toContain("runtime.ts")
    expect(files).toContain(join("signals", "grant.ts"))
    expect(files.some((f) => f.includes("__tests__"))).toBe(false)
    expect(FORBIDDEN.size).toBeGreaterThan(0)
  })

  // Ідентифікатор — теж назва: `.supabase`, ключ `{ supabase: … }`; перелік
  // провайдерів T3 не читає взагалі — гілка за провайдером належить T2.
  it("names no provider or provider role in literals or identifiers", () => {
    const hits: string[] = []
    for (const f of files) {
      const sf = parse(f)
      walk(sf, (n) => {
        if (
          (ts.isStringLiteral(n) ||
            ts.isNoSubstitutionTemplateLiteral(n) ||
            ts.isIdentifier(n)) &&
          FORBIDDEN.has(n.text)
        )
          hits.push(`${f}: ${n.text}`)
        if (ts.isIdentifier(n) && n.text === "DATABASE_PROVIDERS")
          hits.push(`${f}: DATABASE_PROVIDERS`)
      })
    }
    expect(hits).toEqual([])
  })

  it("does not read process.env", () => {
    const hits: string[] = []
    for (const f of files) {
      const sf = parse(f)
      walk(sf, (n) => {
        if (
          ts.isPropertyAccessExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === "process" &&
          n.name.text === "env"
        )
          hits.push(f)
      })
    }
    expect(hits).toEqual([])
  })

  // Функції сесії — лише `pg_catalog.<fn>`: з `search_path` пулера (його
  // міняє роль чи пулер) безкваліфіковане ім'я могло б розв'язатись у чужий
  // об'єкт. Перевірка — над текстом кожного літерала й шматка шаблону.
  it("qualifies session functions with pg_catalog in SQL text", () => {
    const UNQUALIFIED =
      /(?<!pg_catalog\.)\b(?:set_config|current_setting|pg_has_role)\b/
    const hits: string[] = []
    for (const f of files) {
      walk(parse(f), (n) => {
        if (
          (ts.isStringLiteral(n) ||
            ts.isNoSubstitutionTemplateLiteral(n) ||
            ts.isTemplateHead(n) ||
            ts.isTemplateMiddle(n) ||
            ts.isTemplateTail(n)) &&
          UNQUALIFIED.test(n.text)
        )
          hits.push(`${f}: ${n.text.slice(0, 60)}`)
      })
    }
    expect(hits).toEqual([])
  })

  // Модуль T3 імпортується без побічних ефектів: з'єднання, мережа й таймери
  // стартують лише з виклику. Правило допуску мінімальне: виклик чи `new` на
  // верхньому рівні дозволений, лише коли корінь ланцюга — (1) чиста
  // вбудована конструкція з переліку нижче, (2) функція, оголошена в цьому ж
  // модулі, (3) імпорт із проєкту (відносний шлях, `simetra/…`) чи `zod`,
  // (4) літерал; усе інше (`fetch`, таймери, `process`, імпорт із `node:*`
  // чи стороннього пакета, невідомий глобал) і будь-яке `await` — ввід-вивід. Тіла функцій і
  // класів не перевіряються: вони виконуються лише з виклику.
  it("does no I/O at module top level", () => {
    const PURE_BUILTINS = new Set([
      "Object",
      "Set",
      "Map",
      "WeakSet",
      "WeakMap",
      "Symbol",
      "RegExp",
      "String",
      "TextEncoder",
      "AsyncLocalStorage",
    ])
    const isProjectModule = (spec: string): boolean =>
      spec.startsWith(".") || spec === "zod" || spec.startsWith("simetra")
    const allowedRoots = (sf: ts.SourceFile): Set<string> => {
      const names = new Set<string>(PURE_BUILTINS)
      for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name) names.add(st.name.text)
        if (ts.isVariableStatement(st))
          for (const d of st.declarationList.declarations)
            if (ts.isIdentifier(d.name)) names.add(d.name.text)
        if (
          ts.isImportDeclaration(st) &&
          ts.isStringLiteral(st.moduleSpecifier) &&
          isProjectModule(st.moduleSpecifier.text)
        ) {
          const c = st.importClause
          if (c?.name) names.add(c.name.text)
          const nb = c?.namedBindings
          if (nb && ts.isNamespaceImport(nb)) names.add(nb.name.text)
          if (nb && ts.isNamedImports(nb))
            for (const e of nb.elements) names.add(e.name.text)
        }
      }
      return names
    }
    const rootOf = (e: ts.Expression): string | undefined => {
      let cur: ts.Expression = e
      for (;;) {
        if (ts.isIdentifier(cur)) return cur.text
        if (
          ts.isStringLiteralLike(cur) ||
          ts.isTemplateExpression(cur) ||
          ts.isArrayLiteralExpression(cur)
        )
          return ""
        if (
          ts.isCallExpression(cur) ||
          ts.isPropertyAccessExpression(cur) ||
          ts.isElementAccessExpression(cur) ||
          ts.isNonNullExpression(cur)
        )
          cur = cur.expression
        else return undefined
      }
    }
    const hits: string[] = []
    const visitTop = (f: string, n: ts.Node, ok: Set<string>): void => {
      if (
        ts.isFunctionLike(n) ||
        ts.isClassLike(n) ||
        ts.isInterfaceDeclaration(n) ||
        ts.isTypeAliasDeclaration(n)
      )
        return
      // Будь-яке `await` верхнього рівня чекає зовнішнього: голий
      // `await <ідентифікатор>` виклику не має, але імпорт модуля чекав би
      // проміса, що вже стартував.
      if (ts.isAwaitExpression(n)) hits.push(`${f}: ${n.getText()}`)
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const root = rootOf(n.expression)
        if (root === undefined || (root !== "" && !ok.has(root)))
          hits.push(`${f}: ${n.expression.getText()}`)
      }
      ts.forEachChild(n, (c) => visitTop(f, c, ok))
    }
    for (const f of files) {
      const sf = parse(f)
      const ok = allowedRoots(sf)
      for (const st of sf.statements) visitTop(f, st, ok)
    }
    expect(hits).toEqual([])
  })
})
