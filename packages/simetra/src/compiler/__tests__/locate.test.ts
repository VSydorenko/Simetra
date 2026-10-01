import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { diagnostic } from "../diagnostics"
import { withRanges } from "../locate"
import { metaFiles, project } from "./helpers"

const FILE = "catalogs/Item/Item.meta.json"

function locateIn(
  text: string,
  pointer: string,
  params: Record<string, string | number> = {}
) {
  const d = diagnostic("file.schema", FILE, pointer, { detail: "x", ...params })
  return withRanges([d], new Map([[FILE, text]]))[0]!.range
}

describe("diagnostic range", () => {
  const json = [
    "{",
    '  "name": "Item",',
    '  "attributes": [',
    '    { "name": "a", "length": 5 },',
    '    { "name": "b", "length": 10 }',
    "  ]",
    "}",
  ].join("\n")

  it("pointer to a value gives its line and column", () => {
    expect(locateIn(json, "/attributes/1/length")).toEqual({
      start: { line: 4, character: 29 },
      end: { line: 4, character: 31 },
    })
  })

  it("missing key falls back to the parent", () => {
    // Ключа `scale` немає: діапазон — об'єкт елемента масиву.
    expect(locateIn(json, "/attributes/0/scale")).toEqual({
      start: { line: 3, character: 4 },
      end: { line: 3, character: 32 },
    })
  })

  it("pointer segments are unescaped", () => {
    const text = '{ "a/b": { "c~d": 1 } }'
    expect(locateIn(text, "/a~1b/c~0d")?.start).toEqual({
      line: 0,
      character: 18,
    })
  })

  it("file-level diagnostic points at the start of the file", () => {
    expect(locateIn(json, "")).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    })
  })

  it("expression offset with escapes points at the escaped character", () => {
    // Декодоване значення: row.qty + "x"; помилка на першій `"` (індекс 10).
    const text = String.raw`{ "expr": "row.qty + \"x\"" }`
    const rawQuote = text.indexOf(String.raw`\"`)
    const range = locateIn(text, "/expr", { offset: 10 })
    expect(range?.start).toEqual({ line: 0, character: rawQuote })
    expect(range?.end).toEqual({ line: 0, character: rawQuote + 2 })
    // Символ після екранованої пари — зсув на 2 сирі символи за 1 декодований.
    expect(locateIn(text, "/expr", { offset: 11 })?.start.character).toBe(
      rawQuote + 2
    )
  })

  it("expression offset counts \\u and \\\\ escapes as one character", () => {
    const text = String.raw`{ "expr": "A\\z" }`
    // Декодовано: A\z; індекс 2 — `z`.
    const z = text.indexOf("z")
    expect(locateIn(text, "/expr", { offset: 2 })?.start.character).toBe(z)
  })

  it("an invalid JSON file still gets a file-start range", () => {
    expect(locateIn("{ not json", "")?.start).toEqual({ line: 0, character: 0 })
  })

  it("a file outside the map gets no range", () => {
    const d = diagnostic("project.missing", "project.meta.json", "")
    expect(withRanges([d], new Map())[0]!.range).toBeUndefined()
  })

  it("sql diagnostics use line and column", () => {
    const d = diagnostic("sql.unit-duplicate", "sql/public/a.sql", "", {
      identity: "f",
      first: "g",
      line: 3,
    })
    const text = "-- a\n\nCREATE FUNCTION f();\nSELECT 1;"
    expect(
      withRanges([d], new Map([["sql/public/a.sql", text]]))[0]!.range
    ).toEqual({
      start: { line: 2, character: 0 },
      end: { line: 2, character: 20 },
    })
  })

  it("sql syntax error column is UTF-16 after Cyrillic and a non-BMP character", () => {
    // Рядок перед помилкою мусить розвести байти (UTF-8), кодові точки й
    // кодові одиниці UTF-16: кирилиця — 2 байти й 1 одиниця, 😀 — 4 байти,
    // 1 кодова точка й 2 одиниці. Хибне переведення дає іншу колонку.
    const prefix = "SELECT 'жук😀', 1 +"
    const text = `-- коментар 😀\n${prefix};\n`
    return compile(
      metaFiles({
        "project.meta.json": project(),
        "sql/public/a.sql": text,
      })
    ).then((result) => {
      const d = result.diagnostics.find((x) => x.code === "sql.parse")
      expect(d).toBeDefined()
      const column = text.split("\n")[1]!.indexOf(";")
      expect(prefix.length).toBe(column)
      expect(d!.params).toMatchObject({ line: 2, column: column + 1 })
      expect(d!.range).toEqual({
        start: { line: 1, character: column },
        end: { line: 1, character: column },
      })
      // Хибні рахунки відрізнялися б: кодові точки, байти.
      expect([...prefix].length).not.toBe(column)
      expect(new TextEncoder().encode(prefix).length).not.toBe(column)
    })
  })

  it("compile fills range for diagnostics in files of the map", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Item/Item.meta.json": { kind: "Catalog", name: "Item" },
      })
    )
    expect(result.ok).toBe(false)
    const missingId = result.diagnostics.find(
      (d) => d.code === "identity.id-missing"
    )
    expect(missingId?.range).toBeDefined()
  })
})
