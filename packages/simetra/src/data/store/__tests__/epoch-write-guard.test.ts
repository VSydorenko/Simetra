import { readdirSync, readFileSync } from "node:fs"
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
  .map((path) => relative(STORE, path))

// Побудова вхідного рядка з відповіді джерела — ще не стан сховища: епоху
// тут несе сама відповідь, а правило `effectiveEpoch` застосовує запис.
const ALLOWED = new Set(["source.ts serverRow"])

const isEffectiveEpoch = (n: ts.Node | undefined) =>
  n !== undefined &&
  ts.isCallExpression(n) &&
  ts.isIdentifier(n.expression) &&
  n.expression.text === "effectiveEpoch"

function enclosingFunction(n: ts.Node): string {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text
  }
  return ""
}

// AST, а не regex: оголошення типів і коментарі не плутаються із записом.
// Запис епохи в стан — властивість `versionEpoch` в об'єктному літералі,
// присвоєння `.versionEpoch` і `lazyEpochs.set(поле, епоха)`.
function epochWrites(file: string): { at: string; ok: boolean }[] {
  const sf = ts.createSourceFile(
    file,
    readFileSync(join(STORE, file), "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
  const writes: { at: string; ok: boolean }[] = []
  const record = (n: ts.Node, value: ts.Node | undefined) => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
    const allowed = ALLOWED.has(`${file} ${enclosingFunction(n)}`)
    writes.push({
      at: `${file}:${line}`,
      ok: allowed || isEffectiveEpoch(value),
    })
  }
  const visit = (n: ts.Node): void => {
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === "versionEpoch"
    )
      record(n, n.initializer)
    else if (
      ts.isShorthandPropertyAssignment(n) &&
      n.name.text === "versionEpoch"
    )
      record(n, undefined)
    else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      n.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isPropertyAccessExpression(n.left) &&
      n.left.name.text === "versionEpoch"
    )
      record(n, n.right)
    else if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "set" &&
      ts.isPropertyAccessExpression(n.expression.expression) &&
      n.expression.expression.name.text === "lazyEpochs"
    )
      record(n, n.arguments[1])
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return writes
}

describe("epoch writes in src/data/store (B1c Р5, Р6)", () => {
  // Один шлях запису: `null`-відповідь (репліка) не стирає відомої епохи,
  // а нова непорожня її заміняє. Прямий запис поза `effectiveEpoch` уже двічі
  // давав порівняння версій різних епох.
  it("writes an epoch field of state only through effectiveEpoch", () => {
    expect(files).toContain("object-store.ts")
    expect(files).toContain("section-store.ts")
    const writes = files.flatMap(epochWrites)
    // Гард, що не знайшов жодного запису, не доводить нічого.
    expect(writes.filter((w) => w.ok).length).toBeGreaterThan(0)
    expect(writes.filter((w) => !w.ok).map((w) => w.at)).toEqual([])
  })
})
