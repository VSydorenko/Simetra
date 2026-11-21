import { describe, expect, it } from "vitest"
import { declareSection } from "../sql/rewrite/lex"

// Таблиця лексики для `sql.declaration-check-not-applied` / `declareSection`.
// Кожен рядок «true» — обхід, який перша наївна реалізація (пошук слова
// `declare` чи `begin` у тексті) пропустила б.
describe("declareSection", () => {
  const withoutSection: [string, string][] = [
    ["plain BEGIN", "BEGIN PERFORM 1; END"],
    ["lowercase begin", "begin perform 1; end"],
    ["mixed case", "BeGiN perform 1; end"],
    ["leading whitespace", "\n  \tBEGIN\n"],
    ["leading line comment", "-- DECLARE x int;\nBEGIN"],
    ["leading block comment", "/* DECLARE x int; */ BEGIN"],
    ["nested block comment", "/* a /* DECLARE */ b */ BEGIN"],
    ["label", "<<outer>> BEGIN"],
    ["label with spaces", "<< outer >>\nBEGIN"],
    ["label with comments", "/* c */ << -- x\n outer /* y */ >> /* z */ BEGIN"],
    ["quoted label", '<<"My Label">> BEGIN'],
    ["quoted label with >>", '<<"a>>b">> BEGIN'],
    ["quoted label with escaped quote", '<<"a""b">> BEGIN'],
  ]
  const withSection: [string, string][] = [
    ["DECLARE", "DECLARE x int; BEGIN END"],
    ["lowercase declare", "declare\n x int;\nbegin end"],
    ["DECLARE after label", "<<a>> DECLARE x int; BEGIN END"],
    ["DECLARE after /* BEGIN */", "/* BEGIN */ DECLARE x int; BEGIN END"],
    ["DECLARE after -- BEGIN", "-- BEGIN\nDECLARE x int; BEGIN END"],
    [
      "DECLARE after quoted label containing >>",
      '<<"a>> BEGIN">> DECLARE x int; BEGIN END',
    ],
    ["label never closed", "<<a BEGIN"],
    ["label without name", "<<>> BEGIN"],
    ["label closed by two foreign characters", "<<a XX BEGIN"],
    ["label with two names", "<<a b>> BEGIN"],
    ["label with a dotted name", "<<a.b>> BEGIN"],
    ["unicode-escaped label", '<<U&"a">> BEGIN'],
    ["quoted begin is not the keyword", '"begin" x'],
    ["longer word", "BEGINNING"],
    ["BEGIN with suffix", "BEGIN$ x"],
    ["something else first", "SELECT 1; BEGIN"],
    ["empty text", ""],
    ["only comments", "/* BEGIN */ -- BEGIN"],
  ]

  it.each(withoutSection)("no section: %s", (_name, body) => {
    expect(declareSection(body)).toBe(false)
  })

  it.each(withSection)("section or unproven: %s", (_name, body) => {
    expect(declareSection(body)).toBe(true)
  })
})
