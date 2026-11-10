import { PROVIDER_API_ROLES, SESSION_CLAIMS_SETTING } from "simetra/model"
import { describe, expect, it } from "vitest"
import {
  checkSuite,
  inTemplateCopy,
  parseTap,
  runSuite,
  suiteOptions,
  type AdminClient,
  type SuiteClient,
  type TapResult,
} from "./pgtap"

describe("parseTap", () => {
  it.each<{ name: string; lines: string[]; expected: TapResult }>([
    {
      name: "a plan with every test passing",
      lines: ["1..3", "ok 1 - a", "ok 2 - b", "ok 3 - c"],
      expected: { planned: 3, passed: [1, 2, 3], failed: [], bailOut: null },
    },
    {
      name: "a failed test with its diagnostics",
      lines: [
        "1..2",
        "ok 1 - a",
        "not ok 2 - x",
        '# Failed test 2: "x"',
        "#         have: 16",
        "#         want: 17",
      ],
      expected: {
        planned: 2,
        passed: [1],
        failed: [
          {
            n: 2,
            line: "not ok 2 - x",
            diag: ['Failed test 2: "x"', "have: 16", "want: 17"],
          },
        ],
        bailOut: null,
      },
    },
    {
      name: "fewer tests than planned",
      lines: ["1..3", "ok 1 - a", "ok 2 - b"],
      expected: { planned: 3, passed: [1, 2], failed: [], bailOut: null },
    },
    {
      name: "a bail out",
      lines: ["1..3", "ok 1 - a", "Bail out! the stack is gone"],
      expected: {
        planned: 3,
        passed: [1],
        failed: [],
        bailOut: "the stack is gone",
      },
    },
    {
      name: "no plan line",
      lines: ["ok 1 - a"],
      expected: { planned: null, passed: [1], failed: [], bailOut: null },
    },
  ])("$name", ({ lines, expected }) => {
    expect(parseTap(lines)).toEqual(expected)
  })
})

describe("checkSuite", () => {
  it.each([
    ["commit;", "select plan(1);\nselect ok(true);\ncommit;"],
    [
      "rollback in the middle",
      "select plan(2);\nselect ok(true);\nrollback;\nselect ok(true);",
    ],
    ["alter system", "alter system set work_mem = '64MB';\nselect plan(0);"],
    ["begin;", "begin;\nselect plan(1);\nselect ok(true);"],
    ["start transaction", "START TRANSACTION;"],
    ["savepoint", "select plan(1);\nsavepoint s1;"],
    ["prepare transaction", "prepare transaction 'x';"],
    [
      "commit after an E-string with an escaped quote",
      "select E'\\''; commit; select 'x';",
    ],
    [
      "commit after identifiers ending in a dollar tag",
      "select 1 as x$y$; commit; select 1 as z$y$;",
    ],
    [
      "end after a begin atomic body",
      "create function f() returns int language sql begin atomic select 1; end;\nend;",
    ],
    [
      "commit after a begin atomic body with an identifier starting with case",
      "create function f() returns int language sql begin atomic select 1 as case1; end; commit; select plan(0);",
    ],
    [
      "commit after columns named begin and atomic",
      "select begin atomic from (select 1 as begin) t; commit; select plan(0);",
    ],
    [
      "commit after an E-string right after a dollar quote",
      "select $$a$$E'\\''; commit; select 'x';",
    ],
    [
      "commit after an E-string right after a string",
      "select 'a'E'\\''; commit; select 'x';",
    ],
    [
      "a begin atomic body without its end",
      "create function f() returns int language sql begin atomic select 1; commit;",
    ],
  ])("rejects %s", (_, sql) => {
    expect(() => checkSuite(sql)).toThrow(
      /transaction control|alter system|begin atomic/
    )
  })

  it.each([
    ["a DO block", "do $$ begin perform 1; end $$;\nselect plan(0);"],
    ["a tagged DO block", "do $body$ begin commit; end $body$;"],
    ["commit in a line comment", "-- commit\nselect plan(0);"],
    ["rollback in a block comment", "/* x; rollback; */ select plan(0);"],
    ["commit in a string", "select ok(true, 'a; commit');"],
    ["an identifier named end", 'select 1 as "x; end";'],
    ["an E-string ending in an escaped quote", "select E'a\\'; commit; b';"],
    ["a plain string ending in a backslash", "select 'a\\'; select plan(0);"],
    ["a typed string literal", "select date'2026-01-01'; select plan(0);"],
    [
      "a begin atomic body",
      "create function f() returns int language sql begin atomic select 1; end;",
    ],
    [
      "a begin atomic body with case … end",
      "create function f(x int) returns int language sql\nBEGIN ATOMIC\n  select case when x > 0 then 1 else 0 end;\n  select 2;\nEND;\nselect plan(0);",
    ],
  ])("accepts %s", (_, sql) => {
    expect(() => checkSuite(sql)).not.toThrow()
  })
})

describe("checkSuite under a request role", () => {
  it.each([
    ["reset role", "select plan(0);\nreset role;"],
    ["set role", "SET ROLE postgres;\nselect plan(0);"],
    ["set local role", "set local role simetra_owner;"],
    ["set session role", "set session role to simetra_owner;"],
    ["set session authorization", "set session authorization postgres;"],
    [
      "set local session authorization",
      "SET LOCAL SESSION AUTHORIZATION DEFAULT;",
    ],
    ["reset session authorization", "reset session authorization;"],
    ["set a quoted role", 'set "role" to postgres;'],
    ["set local a quoted role", 'set local "role" = postgres;'],
    [
      "set a quoted session_authorization",
      'set "session_authorization" to postgres;',
    ],
    ["set session_authorization", "set session_authorization = postgres;"],
  ])("rejects %s", (_, sql) => {
    expect(() => checkSuite(sql, { role: true })).toThrow(/role switch/)
  })

  it("accepts the same forms without a role, and a role in a string", () => {
    expect(() => checkSuite("set role simetra_user;")).not.toThrow()
    expect(() =>
      checkSuite("select is(current_user::text, 'set role x');", {
        role: true,
      })
    ).not.toThrow()
  })
})

describe("suiteOptions", () => {
  const roleFor = (purpose: keyof typeof PROVIDER_API_ROLES.postgres) =>
    PROVIDER_API_ROLES.postgres[purpose]

  it("reads the role purpose and the claims of the header", () => {
    expect(
      suiteOptions(
        '-- pgtap: role=user claims={"sub": "a b"}\nselect plan(0);',
        roleFor
      )
    ).toEqual({ role: "simetra_user", claims: { sub: "a b" } })
  })

  it("a suite without a header runs as is", () => {
    expect(suiteOptions("-- base state\nselect plan(0);", roleFor)).toBe(
      undefined
    )
  })

  it.each([
    [
      "an unknown purpose",
      "-- pgtap: role=admin claims={}",
      /unknown role purpose "admin"/,
    ],
    [
      "a purpose the profile has no role for",
      "-- pgtap: role=service claims={}",
      /no service role/,
    ],
    ["no claims", "-- pgtap: role=user", /malformed pgtap header/],
    [
      "claims that are not an object",
      "-- pgtap: role=user claims=[1]",
      /JSON object/,
    ],
    [
      "claims that are not JSON",
      "-- pgtap: role=user claims={sub}",
      /JSON object/,
    ],
  ])("refuses %s", (_, header, error) => {
    expect(() => suiteOptions(`${header}\nselect plan(0);`, roleFor)).toThrow(
      error
    )
  })
})

/**
 * Підставний клієнт раннера: записує оператори з параметрами; позначку
 * раннера повертає такою, як її поставлено, а `current_user` — `role`.
 */
function fakeClient(role: string): SuiteClient & { sql: string[] } {
  const sql: string[] = []
  const settings = new Map<string, unknown>()
  return {
    sql,
    query: async (text: string, params?: unknown[]) => {
      sql.push(
        params === undefined ? text : `${text} ${JSON.stringify(params)}`
      )
      if (text.startsWith("select set_config"))
        settings.set(String(params?.[0]), params?.[1])
      if (text.includes("current_user"))
        return {
          rows: [{ value: settings.get(String(params?.[0])), role }],
        }
      return { rows: [{ result: "1..0" }] }
    },
  }
}

describe("runSuite", () => {
  const suite = "select plan(0);"

  it("under a role: pgtap, the claims, SET LOCAL ROLE, the suite, the current_user check", async () => {
    const client = fakeClient("simetra_user")
    await runSuite(client, suite, {
      role: "simetra_user",
      claims: { sub: "s" },
    })
    // Позначка раннера — випадкова, тож рядок з нею звіряється за формою
    expect(
      client.sql.map((s) => s.replace(/"[0-9a-f-]{36}"/, '"<marker>"'))
    ).toEqual([
      "BEGIN",
      'select set_config($1, $2, true) ["simetra.pgtap_runner","<marker>"]',
      "create extension if not exists pgtap",
      `select set_config($1, $2, true) ${JSON.stringify([SESSION_CLAIMS_SETTING, JSON.stringify({ sub: "s" })])}`,
      "SET LOCAL ROLE simetra_user",
      suite,
      'select current_setting($1, true) as value, current_user::text as role ["simetra.pgtap_runner"]',
      "ROLLBACK",
    ])
  })

  it("with claims only: pgtap, the claims, the suite, no role", async () => {
    const client = fakeClient("postgres")
    await runSuite(client, suite, { claims: { sub: "s" } })
    expect(
      client.sql.map((s) => s.replace(/"[0-9a-f-]{36}"/, '"<marker>"'))
    ).toEqual([
      "BEGIN",
      'select set_config($1, $2, true) ["simetra.pgtap_runner","<marker>"]',
      "create extension if not exists pgtap",
      `select set_config($1, $2, true) ${JSON.stringify([SESSION_CLAIMS_SETTING, JSON.stringify({ sub: "s" })])}`,
      suite,
      'select current_setting($1, true) as value, current_user::text as role ["simetra.pgtap_runner"]',
      "ROLLBACK",
    ])
  })

  it("without options: only the marker and the suite", async () => {
    const client = fakeClient("postgres")
    await runSuite(client, suite)
    expect(
      client.sql.map((s) => s.replace(/"[0-9a-f-]{36}"/, '"<marker>"'))
    ).toEqual([
      "BEGIN",
      'select set_config($1, $2, true) ["simetra.pgtap_runner","<marker>"]',
      suite,
      'select current_setting($1, true) as value, current_user::text as role ["simetra.pgtap_runner"]',
      "ROLLBACK",
    ])
  })

  it("fails when the suite left another current_user", async () => {
    const client = fakeClient("postgres")
    await expect(
      runSuite(client, suite, { role: "simetra_user", claims: {} })
    ).rejects.toThrow(/ended as postgres, not simetra_user/)
    expect(client.sql.at(-1)).toBe("ROLLBACK")
  })

  it("refuses a role switch in the suite before it opens the transaction", async () => {
    const client = fakeClient("simetra_user")
    await expect(
      runSuite(client, "reset role;", { role: "simetra_user", claims: {} })
    ).rejects.toThrow(/role switch/)
    expect(client.sql).toEqual([])
  })
})

/** Підставний суперкористувач: записує оператори; `failDrop` — збій `DROP`. */
function fakeAdmin(failDrop: boolean): AdminClient & {
  sql: string[]
  ended: boolean
} {
  const admin = {
    sql: [] as string[],
    ended: false,
    query: async (text: string) => {
      admin.sql.push(text)
      if (failDrop && text.startsWith("DROP")) throw new Error("drop failed")
    },
    end: async () => {
      admin.ended = true
    },
  }
  return admin
}

describe("inTemplateCopy", () => {
  it("creates the copy, runs fn, drops the copy and ends the admin", async () => {
    const admin = fakeAdmin(false)
    await expect(inTemplateCopy(admin, "c", async () => 1)).resolves.toBe(1)
    expect(admin.sql).toEqual([
      "CREATE DATABASE c TEMPLATE simetra_template",
      "DROP DATABASE IF EXISTS c WITH (FORCE)",
    ])
    expect(admin.ended).toBe(true)
  })

  it("a failed drop keeps the error of fn and still ends the admin", async () => {
    const admin = fakeAdmin(true)
    await expect(
      inTemplateCopy(admin, "c", async () => {
        throw new Error("suite failed")
      })
    ).rejects.toThrow("suite failed")
    expect(admin.ended).toBe(true)
  })

  it("a failed drop after a passing fn rejects and still ends the admin", async () => {
    const admin = fakeAdmin(true)
    await expect(inTemplateCopy(admin, "c", async () => 1)).rejects.toThrow(
      "drop failed"
    )
    expect(admin.ended).toBe(true)
  })
})
