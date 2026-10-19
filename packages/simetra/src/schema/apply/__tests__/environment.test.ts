import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import {
  environmentMismatch,
  environmentSteps,
  renderGlobalDefaultPrivileges,
  type EngineAction,
  type EngineObjectRef,
  type GlobalDefaultPrivilege,
} from "simetra/schema"

/**
 * Кроки середовища (рішення 5 плану П3-2b-0): засів глобальних типових
 * привілеїв ролі на копії, звірка засіву й допуск залишку двигуна лише як
 * гранти на об'єктах, які створює сам план.
 */

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const action = (sql: string): EngineAction => ({
  sql,
  verb: "alter",
  produces: [],
  consumes: [],
  destroys: [],
  produced: [],
  destroyed: [],
  consumed: [],
  transactionality: "transactional",
  newSegmentBefore: false,
  lockedTables: [],
  lockClass: "none",
  dataLoss: false,
  rewriteRisk: false,
})

const privilege = (
  over: Partial<GlobalDefaultPrivilege> = {}
): GlobalDefaultPrivilege => ({
  objtype: "f",
  grantee: "postgres",
  privilege: "EXECUTE",
  grantable: false,
  ...over,
})

describe("renderGlobalDefaultPrivileges", () => {
  it("revokes everything of the kind, then grants each row", () => {
    expect(renderGlobalDefaultPrivileges("postgres", [privilege()])).toEqual([
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE ALL ON FUNCTIONS FROM PUBLIC, postgres",
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres GRANT EXECUTE ON FUNCTIONS TO postgres",
    ])
  })

  it("leaves PUBLIC unquoted, quotes role names and keeps the grant option", () => {
    expect(
      renderGlobalDefaultPrivileges("App Role", [
        privilege({ objtype: "r", grantee: "PUBLIC", privilege: "SELECT" }),
        privilege({
          objtype: "r",
          grantee: "Reader",
          privilege: "SELECT",
          grantable: true,
        }),
      ])
    ).toEqual([
      'ALTER DEFAULT PRIVILEGES FOR ROLE "App Role" REVOKE ALL ON TABLES FROM PUBLIC, "App Role"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "App Role" GRANT SELECT ON TABLES TO PUBLIC',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "App Role" GRANT SELECT ON TABLES TO "Reader" WITH GRANT OPTION',
    ])
  })

  it("names every kind and renders nothing for an empty list", () => {
    const kinds = (["r", "S", "f", "T", "n"] as const).map(
      (objtype) =>
        renderGlobalDefaultPrivileges("postgres", [
          privilege({ objtype, privilege: "USAGE" }),
        ])[0]
    )
    expect(kinds.map((sql) => sql?.split(" ON ")[1]?.split(" ")[0])).toEqual([
      "TABLES",
      "SEQUENCES",
      "FUNCTIONS",
      "TYPES",
      "SCHEMAS",
    ])
    expect(renderGlobalDefaultPrivileges("postgres", [])).toEqual([])
  })
})

describe("environmentMismatch", () => {
  it("compares the lists as rows", () => {
    expect(environmentMismatch([privilege()], [privilege()])).toBe(false)
    expect(
      environmentMismatch([privilege()], [privilege({ grantable: true })])
    ).toBe(true)
    expect(environmentMismatch([privilege()], [])).toBe(true)
  })
})

describe("environmentSteps", () => {
  const f: EngineObjectRef = { kind: "function", schema: "app", name: "f" }
  const t: EngineObjectRef = { kind: "table", schema: "app", name: "t" }

  const refused = (sql: string, produced: EngineObjectRef[] = [t]) => {
    const result = environmentSteps([action(sql)], produced, parse)
    if (!("refusal" in result)) throw new Error("expected a refusal")
    return result.refusal
  }

  it("keeps a revoke and a grant on a function the plan creates, as they are", () => {
    const residual = [
      action('REVOKE ALL ON FUNCTION "app"."f"() FROM PUBLIC'),
      action('GRANT EXECUTE ON FUNCTION "app"."f"() TO PUBLIC'),
    ]
    expect(environmentSteps(residual, [f], parse)).toEqual({
      steps: residual,
    })
  })

  it("keeps a revoke on a table the plan creates", () => {
    const residual = [action('REVOKE ALL ON TABLE "app"."t" FROM "anon"')]
    expect(environmentSteps(residual, [t], parse)).toEqual({ steps: residual })
  })

  it("keeps nothing when nothing remains", () => {
    expect(environmentSteps([], [t], parse)).toEqual({ steps: [] })
  })

  it("refuses a grant on a table the plan does not create", () => {
    expect(refused("GRANT SELECT ON TABLE app.other TO anon")).toMatchObject({
      code: "plan.proof-not-empty",
      severity: "error",
      params: { count: 1, first: "GRANT SELECT ON TABLE app.other TO anon" },
    })
  })

  it("names the first foreign action and counts the whole residual", () => {
    const result = environmentSteps(
      [
        action('REVOKE ALL ON TABLE "app"."t" FROM "anon"'),
        action("ALTER TABLE app.t ADD COLUMN x int"),
      ],
      [t],
      parse
    )
    expect(result).toMatchObject({
      refusal: {
        code: "plan.proof-not-empty",
        params: { count: 2, first: "ALTER TABLE app.t ADD COLUMN x int" },
      },
    })
  })

  it("refuses anything but a grant or a revoke", () => {
    expect(refused("ALTER TABLE app.t ADD COLUMN x int").code).toBe(
      "plan.proof-not-empty"
    )
  })

  it("refuses a cascading revoke", () => {
    expect(
      refused('REVOKE ALL ON TABLE "app"."t" FROM anon CASCADE').code
    ).toBe("plan.proof-not-empty")
  })

  it("refuses a grant on all objects of a schema", () => {
    expect(
      refused("GRANT SELECT ON ALL TABLES IN SCHEMA app TO anon").code
    ).toBe("plan.proof-not-empty")
  })

  it("refuses a column grant", () => {
    expect(refused("GRANT SELECT (id) ON app.t TO anon").code).toBe(
      "plan.proof-not-empty"
    )
  })

  it("refuses a grant on a schema: schemas are never among the created objects", () => {
    expect(refused("GRANT USAGE ON SCHEMA app2 TO anon").code).toBe(
      "plan.proof-not-empty"
    )
  })

  it("refuses an object of another kind under the same name", () => {
    expect(refused('GRANT USAGE ON SEQUENCE "app"."t" TO anon', [t]).code).toBe(
      "plan.proof-not-empty"
    )
    expect(refused('GRANT SELECT ON TABLE "app"."f" TO anon', [f]).code).toBe(
      "plan.proof-not-empty"
    )
  })

  it("refuses an unqualified name and an action of several statements", () => {
    expect(refused("GRANT SELECT ON TABLE t TO anon").code).toBe(
      "plan.proof-not-empty"
    )
    expect(
      refused(
        'REVOKE ALL ON TABLE "app"."t" FROM anon; GRANT SELECT ON TABLE "app"."t" TO anon'
      ).code
    ).toBe("plan.proof-not-empty")
  })

  it("matches types, domains, sequences and routines by their kinds", () => {
    const produced: EngineObjectRef[] = [
      { kind: "type", schema: "app", name: "e" },
      { kind: "domain", schema: "app", name: "d" },
      { kind: "sequence", schema: "app", name: "s" },
      { kind: "procedure", schema: "app", name: "p" },
      { kind: "view", schema: "app", name: "v" },
    ]
    const residual = [
      action('REVOKE ALL ON TYPE "app"."e" FROM PUBLIC'),
      action('REVOKE ALL ON DOMAIN "app"."d" FROM PUBLIC'),
      action('REVOKE ALL ON SEQUENCE "app"."s" FROM anon'),
      action('REVOKE ALL ON PROCEDURE "app"."p"() FROM PUBLIC'),
      action('REVOKE ALL ON TABLE "app"."v" FROM anon'),
    ]
    expect(environmentSteps(residual, produced, parse)).toEqual({
      steps: residual,
    })
  })
})
