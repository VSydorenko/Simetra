import { describe, expect, it } from "vitest"
import { BUILTIN_EXCLUSIONS, excludedBuiltin } from "../sql/builtin-exclusions"
import { BUILTIN_FUNCTIONS, REGCLASS_BUILTINS } from "../sql/builtin-functions"

const REGCLASS = new Set(REGCLASS_BUILTINS)

// Перелік генерують над живим каталогом, а виключення правлять руками: тест
// ловить зміну виключень без регенерації переліку (Р2c1-20).
describe("builtin function allowlist", () => {
  it.each(BUILTIN_EXCLUSIONS.map((e) => [e.reason, e] as const))(
    "lists no name of the %s class",
    (_reason, exclusion) => {
      expect(
        BUILTIN_FUNCTIONS.filter(
          (name) =>
            exclusion.names.includes(name) ||
            exclusion.prefixes.some((prefix) => name.startsWith(prefix)) ||
            (exclusion.derived === "regclassParameter" && REGCLASS.has(name))
        )
      ).toEqual([])
    }
  )

  it("lists no name that excludedBuiltin refuses", () => {
    expect(
      BUILTIN_FUNCTIONS.filter((name) => excludedBuiltin(name, REGCLASS))
    ).toEqual([])
  })

  it("keeps ordinary builtins and drops excluded ones", () => {
    expect(BUILTIN_FUNCTIONS).toEqual(
      expect.arrayContaining(["count", "lower", "now"])
    )
    // `dblink` — функція розширення, а не initdb: у перелік вона не входить.
    for (const name of [
      "set_config",
      "query_to_xml",
      "pg_sleep",
      "lo_import",
      "dblink",
      // Аргумент `regclass` називає відношення текстом (Р2c1-56).
      "pg_relation_size",
    ]) {
      expect(BUILTIN_FUNCTIONS, name).not.toContain(name)
    }
  })
})
