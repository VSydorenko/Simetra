import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { policyDomain, promotableTaskNote } from "./fixtures/rights"
import { acceptDebt } from "./helpers"

/*
 * Дозвільний перелік викликів одиниць-виразів (Р2c1-55): подання й вирази
 * дослівних політик кличуть лише вбудовані з переліку, функції моделі й
 * поіменні функції провайдера — у будь-якому файлі, борг включно.
 */

const SHARED = "sql/public/extra.sql"
const DEBT_MODULE = "custom-tables/TaskNote/TaskNote.sql"
const MODEL_FUNCTION =
  "CREATE FUNCTION public.can_read(uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT true $$;\n"

const policy = (expression: string) =>
  `CREATE POLICY p ON public.task_notes FOR SELECT TO authenticated USING (${expression});\n`
const view = (expression: string) =>
  `CREATE VIEW public.v AS SELECT ${expression} AS x;\n`

/** Виклики поза переліком у діагностиках `sql.expression-call-not-allowed`. */
async function refusedCalls(file: string, sql: string) {
  const files = policyDomain(promotableTaskNote())
  files.set(file, sql)
  const result = await compile(await acceptDebt(files))
  return {
    calls: result.diagnostics
      .filter((d) => d.code === "sql.expression-call-not-allowed")
      .map((d) => d.params?.call),
    ok: result.ok,
  }
}

describe("expression units call only allowlisted functions (Р2c1-55)", () => {
  const SET_CLAIMS = "pg_catalog.set_config('request.jwt.claims', '{}', false)"
  it.each([
    {
      name: "policy setting the claims",
      sql: policy(`${SET_CLAIMS} IS NOT NULL`),
      expected: ["pg_catalog.set_config"],
    },
    {
      name: "view setting the claims",
      sql: view(SET_CLAIMS),
      expected: ["pg_catalog.set_config"],
    },
    {
      name: "view executing SQL text",
      sql: view("query_to_xml('select 1', true, true, '')"),
      expected: ["query_to_xml"],
    },
    {
      name: "view calling an unknown provider function",
      sql: view("extensions.whatever()"),
      expected: ["extensions.whatever"],
    },
    {
      name: "policy advancing a sequence",
      sql: policy("nextval('public.s') > 0"),
      expected: ["nextval"],
    },
    {
      name: "policy calling an unqualified non-builtin",
      sql: MODEL_FUNCTION + policy("can_read(id)"),
      expected: ["can_read"],
    },
    {
      name: "policy comparing with auth.uid()",
      sql: policy("auth.uid() = id"),
      expected: [],
    },
    {
      name: "policy calling a model function",
      sql: MODEL_FUNCTION + policy("public.can_read(id)"),
      expected: [],
    },
    {
      name: "view calling builtins",
      sql: view("pg_catalog.lower('X') || gen_random_uuid()::text"),
      expected: [],
    },
  ])("$name", async ({ sql, expected }) => {
    // Спільний файл і модуль боргу прийнятої таблиці — борг: правило те саме.
    for (const file of [SHARED, DEBT_MODULE]) {
      const { calls, ok } = await refusedCalls(file, sql)
      expect(calls, file).toEqual(expected)
      // Дозволений вираз компілюється без помилок.
      if (expected.length === 0) expect(ok, file).toBe(true)
    }
  })
})
