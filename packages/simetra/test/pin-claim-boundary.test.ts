import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const DATA = join(dirname(fileURLToPath(import.meta.url)), "../src/data")

// T4 claim закріплення не читає (П4-F §3, F1a): звуження клієнт бачить лише
// через знімок прав сервера й сигнали. Тести теки теж входять — тест, що
// підставляє `pin` у claims, уже був би читачем.
function collect(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return collect(path)
    return /\.tsx?$/.test(e.name) ? [path] : []
  })
}

// AST, а не regex: коментарі й слова на кшталт «pinned» у збіг не потрапляють,
// а ідентифікатор, ключ і рядок `"pin"` — потрапляють.
function pinMentions(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const visit = (n: ts.Node): void => {
    if (
      (ts.isIdentifier(n) ||
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n)) &&
      n.text === "pin"
    )
      hits.push(
        `${file}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`
      )
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

describe("scope pin claim boundary", () => {
  // Без цієї перевірки зламаний детектор дав би зелений тест меж.
  it("the detector finds a pin read in every form", () => {
    const forms = [
      "claims.pin",
      'claims["pin"]',
      "const { pin } = claims",
      "const c = { pin: id }",
    ]
    for (const code of forms)
      expect(pinMentions("probe.ts", code), code).toHaveLength(1)
    expect(pinMentions("probe.ts", "// pin\nconst pinned = 1")).toEqual([])
  })

  it("src/data never mentions the pin claim", () => {
    const files = collect(DATA)
    expect(files.length).toBeGreaterThan(0)
    const hits = files.flatMap((f) => pinMentions(f, readFileSync(f, "utf8")))
    expect(hits).toEqual([])
  })
})
