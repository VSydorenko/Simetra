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

// Production-код T3 — плоска тека; `__tests__` не входить (фікстури можуть
// називати провайдера).
const files = readdirSync(SERVER).filter((f) => f.endsWith(".ts"))

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
})
