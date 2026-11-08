import { describe, expect, it } from "vitest"
import { checkSuite, parseTap, type TapResult } from "./pgtap"

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
  ])("rejects %s", (_, sql) => {
    expect(() => checkSuite(sql)).toThrow(/transaction control|alter system/)
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
