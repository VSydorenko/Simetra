import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

// PR лише з документацією ганяє в `Checks` тільки формат і тести з суфіксом
// `.docs.test.ts` (`pnpm -r --if-present test:docs`, #265). Тест, що читає
// `docs/` без позначки, на такому PR не біжить — і зміна спеки, яку він
// звіряє з кодом, пройшла б зеленою. Цей тест не дає позначці загубитися.
const ROOT = resolve(__dirname, "../../..")
const PACKAGES = join(ROOT, "packages")
const SKIP = new Set(["node_modules", "dist", ".output", ".nitro", ".tanstack"])

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return testFiles(path)
    return /\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** Чи файл читає щось під `docs/` кореня репо: читання й шлях `docs/`. */
function readsDocs(source: string): boolean {
  return (
    /\breadFile(Sync)?\s*\(/.test(source) &&
    /["'`][^"'`\n]*(\.\.\/)+docs\/[^"'`\n]*["'`]/.test(source)
  )
}

describe("tests that read docs/", () => {
  it("recognises a relative read of docs/ and nothing else", () => {
    const read = `readFileSync(resolve(__dirname, "../../docs/x.md"), "utf8")`
    expect(readsDocs(read)).toBe(true)
    expect(readsDocs(`const p = "docs/x.md"`)).toBe(false)
    expect(readsDocs(`readFileSync("skills/a/SKILL.md")`)).toBe(false)
  })

  it("carry the .docs.test.ts suffix, and their package has test:docs", () => {
    const unmarked: string[] = []
    const noScript: string[] = []
    for (const pkg of readdirSync(PACKAGES)) {
      const dir = join(PACKAGES, pkg)
      const manifest = join(dir, "package.json")
      // Тека без package.json — не пакет (напр. залишок збірки), її тести не біжать
      if (!existsSync(manifest)) continue
      const scripts: Record<string, string> =
        JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {}
      for (const file of testFiles(dir)) {
        // Самоперевірка вище містить приклад шляху `docs/` — не читання.
        if (file === __filename) continue
        if (!readsDocs(readFileSync(file, "utf8"))) continue
        const rel = relative(ROOT, file)
        if (!file.endsWith(".docs.test.ts")) unmarked.push(rel)
        else if (scripts["test:docs"] === undefined) noScript.push(rel)
      }
    }
    expect(unmarked).toEqual([])
    expect(noScript).toEqual([])
  })
})
