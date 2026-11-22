import { describe, expect, it } from "vitest"
import { BUILTIN_EXCLUSIONS, excludedBuiltin } from "../sql/builtin-exclusions"
import { BUILTIN_FUNCTIONS, REGCLASS_BUILTINS } from "../sql/builtin-functions"
import { HEAD_BUILTINS, HEAD_REVIEWED_BUILTINS } from "../sql/head-builtins"

const REGCLASS = new Set(REGCLASS_BUILTINS)

// Перелік генерують над живим каталогом, а виключення правлять руками: тест
// ловить зміну виключень без регенерації переліку (спека прав §5.3).
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
      // Аргумент `regclass` називає відношення текстом.
      "pg_relation_size",
    ]) {
      expect(BUILTIN_FUNCTIONS, name).not.toContain(name)
    }
  })
})

// Перелік голови — позитивний і ручний (спека прав §5.8): лише назви
// загального переліку, кожна раз, без класів стану сесії й відношень текстом.
describe("head builtin allowlist", () => {
  it("is a subset of BUILTIN_FUNCTIONS without duplicates", () => {
    const all = new Set(BUILTIN_FUNCTIONS)
    expect(HEAD_BUILTINS.filter((name) => !all.has(name))).toEqual([])
    expect(new Set(HEAD_BUILTINS).size).toBe(HEAD_BUILTINS.length)
    expect(HEAD_BUILTINS).toEqual(
      expect.arrayContaining([...HEAD_REVIEWED_BUILTINS])
    )
  })

  it("keeps pure builtins and drops session, connection and text-named relation state", () => {
    expect(HEAD_BUILTINS).toEqual(
      expect.arrayContaining([
        "count",
        "lower",
        "now",
        "jsonb_build_object",
        "current_setting",
        "timezone",
      ])
    )
    for (const name of [
      "pg_show_all_settings",
      "current_query",
      "inet_client_addr",
      "pg_try_advisory_xact_lock",
      "pg_advisory_xact_lock",
      "pg_cursor",
      "pg_prepared_statement",
      "pg_listening_channels",
      "pg_my_temp_schema",
      "current_user",
      "session_user",
      "to_regclass",
      "regclass",
      "has_table_privilege",
      "pg_get_viewdef",
      "pg_get_serial_sequence",
      "timeofday",
      "random",
      "setseed",
    ]) {
      expect(HEAD_BUILTINS, name).not.toContain(name)
    }
  })
})
