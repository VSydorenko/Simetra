import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/*
 * Відповідь приймача пишеться лише через `Writer.apply` — після шлюзу епохи
 * (P4-B план B1c, Р7, Р12). Внутрішні `patchRows` / `removeKeys` модуля
 * `writer.ts` поза ним не викликає ніхто: виклик в обхід `apply` записав би
 * `removed` чи рядок з відповіді покинутої епохи. Перевірка — за символом
 * (type checker), а не за іменем: псевдонім імпорту не обходить її.
 */

const DATA = join(import.meta.dirname, "..", "..")
const WRITER = "store/writer.ts"
const INTERNAL = new Set(["patchRows", "removeKeys"])

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

/** Uses of the internal writer functions outside `writerFile`: `file:line name`. */
function outsideUses(
  program: ts.Program,
  files: readonly string[],
  writerFile: string,
  label: (file: string) => string
): string[] {
  const checker = program.getTypeChecker()
  const out: string[] = []
  for (const file of files) {
    if (file === writerFile) continue
    const sf = program.getSourceFile(file)!
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = ts.isPropertyAccessExpression(n.expression)
          ? n.expression.name
          : n.expression
        let symbol = checker.getSymbolAtLocation(callee)
        if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
          symbol = checker.getAliasedSymbol(symbol)
        const decl = symbol?.valueDeclaration
        if (
          decl !== undefined &&
          decl.getSourceFile().fileName === writerFile &&
          INTERNAL.has(symbol!.name)
        ) {
          const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1
          out.push(`${label(file)}:${line} ${symbol!.name}`)
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return out
}

/** Members of the public `Writer` type (types.ts) by name. */
function writerMembers(program: ts.Program, typesFile: string): string[] {
  const sf = program.getSourceFile(typesFile)!
  const decl = sf.statements.find(
    (s): s is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(s) && s.name.text === "Writer"
  )
  return (decl?.members ?? []).flatMap((m) =>
    m.name !== undefined && ts.isIdentifier(m.name) ? [m.name.text] : []
  )
}

function inline(sources: Record<string, string>) {
  const options = { ...BASE_OPTIONS, noLib: true }
  const host = ts.createCompilerHost(options, true)
  const files = new Map(
    Object.entries(sources).map(([name, text]) => [
      name,
      ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true),
    ])
  )
  const original = host.getSourceFile.bind(host)
  host.getSourceFile = (file, ...rest) =>
    files.get(file) ?? original(file, ...rest)
  host.fileExists = (file) => files.has(file)
  host.readFile = (file) => sources[file]
  host.directoryExists = (dir) => dir === "/v" || dir === "/"
  host.realpath = (path) => path
  const program = ts.createProgram([...files.keys()], options, host)
  return outsideUses(program, [...files.keys()], "/v/writer.ts", (f) => f)
}

describe("writer gate guard self-test", () => {
  const writer = `export function patchRows() {}\nexport function removeKeys() {}\nexport function apply() { patchRows(); removeKeys() }\n`

  it("flags a call from another file, also through an alias", () => {
    expect(
      inline({
        "/v/writer.ts": writer,
        "/v/core.ts": `import { patchRows as p, removeKeys } from "./writer.ts"\np()\nremoveKeys()\n`,
      })
    ).toEqual(["/v/core.ts:2 patchRows", "/v/core.ts:3 removeKeys"])
  })

  it("passes calls inside writer.ts and calls of apply", () => {
    expect(
      inline({
        "/v/writer.ts": writer,
        "/v/core.ts": `import { apply } from "./writer.ts"\napply()\n`,
      })
    ).toEqual([])
  })
})

describe("receiver writes go through Writer.apply (B1c Р7, Р12)", () => {
  it("no file of src/data uses the internal patch/remove of writer.ts", () => {
    const files = readdirSync(DATA, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => join(e.parentPath, e.name))
    const writerFile = join(DATA, WRITER)
    expect(files).toContain(writerFile)
    const program = ts.createProgram(files, {
      ...BASE_OPTIONS,
      lib: ["lib.es2022.d.ts"],
    })
    // Внутрішні функції існують у writer.ts: інакше гард нічого не доводить.
    const own = program
      .getSourceFile(writerFile)!
      .statements.filter(
        (s): s is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(s) &&
          s.name !== undefined &&
          INTERNAL.has(s.name.text)
      )
    expect(own).toHaveLength(INTERNAL.size)
    // Без експорту внутрішніх: інакше посилання-значення (`const f =
    // removeKeys`) в іншому файлі обійшло б перевірку викликів нижче.
    for (const s of own)
      expect(ts.getCombinedModifierFlags(s) & ts.ModifierFlags.Export).toBe(0)
    const reexported = program
      .getSourceFile(writerFile)!
      .statements.flatMap((s) =>
        ts.isExportDeclaration(s) &&
        s.exportClause !== undefined &&
        ts.isNamedExports(s.exportClause)
          ? s.exportClause.elements.map((e) => (e.propertyName ?? e.name).text)
          : []
      )
      .filter((name) => INTERNAL.has(name))
    expect(reexported).toEqual([])
    expect(
      outsideUses(program, files, writerFile, (f) => relative(DATA, f))
    ).toEqual([])
    const members = writerMembers(program, join(DATA, "store/types.ts"))
    expect(members).toContain("apply")
    expect(members).not.toContain("patch")
    expect(members).not.toContain("remove")
  }, 60_000)
})
