import { describe, expect, it } from "vitest"
import { BUILTIN_EXCLUSIONS, excludedBuiltin } from "../sql/builtin-exclusions"
import { BUILTIN_FUNCTIONS } from "../sql/builtin-functions"

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
            exclusion.prefixes.some((prefix) => name.startsWith(prefix))
        )
      ).toEqual([])
    }
  )

  it("lists no name that excludedBuiltin refuses", () => {
    expect(BUILTIN_FUNCTIONS.filter(excludedBuiltin)).toEqual([])
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
    ]) {
      expect(BUILTIN_FUNCTIONS, name).not.toContain(name)
    }
  })
})
