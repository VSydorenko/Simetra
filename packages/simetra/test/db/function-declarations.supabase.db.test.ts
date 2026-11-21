import { randomUUID } from "node:crypto"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { type ApiRolePurpose } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
import { compiledPolicyDomain } from "../../src/compiler/__tests__/fixtures/rights"
import { profileLayer } from "./rights-seed"
import {
  GUARDED_FILES,
  expectNoGuardExecute,
} from "./function-declarations.support"
import { claimsFor, queryAs, withRollback } from "./connection"

/**
 * `EXECUTE` на стеку Supabase (спека декларацій функцій §5.1, інваріанти 1–3
 * плану Д1): типові привілеї схеми `public` дають `EXECUTE` кожній новій
 * функції `anon`, `authenticated` і `service_role`, тож без похідного
 * `REVOKE` функція, якої ролі API не задекларовано, була б RPC для кожного.
 * Тут же — кейси сервісної ролі, яка є лише на цьому стеку; решта —
 * `function-declarations.db.test.ts`.
 */

const API_PURPOSES = ["anonymous", "user", "service"] as const

const closedFn = (name: string, args = "") =>
  `CREATE FUNCTION ${name}(${args}) RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT 1 $$;\n`

/** Розгортає в транзакції тесту проєкт з каталогом `Item` і файлами `entries`. */
async function deployed(
  client: pg.Client,
  entries: Record<string, string>
): Promise<void> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({ database: { provider: "supabase" } }),
      "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
      ...entries,
    })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
}

/** Пара призначення й `ok` чи код відмови виклику `sql` від його ролі API. */
async function callAs(
  client: pg.Client,
  purpose: ApiRolePurpose,
  sql: string
): Promise<[ApiRolePurpose, string]> {
  const result = await queryAs(
    client,
    purpose,
    claimsFor(purpose, purpose === "anonymous" ? undefined : randomUUID()),
    sql
  )
  return [purpose, "code" in result ? result.code : "ok"]
}

const declaredF = (callers: string[]) => ({
  "sql/public/fns.sql": closedFn("public.f"),
  "sql/public/fns.functions.json": JSON.stringify({
    functions: [{ id: uuid(9501), function: { name: "f" }, callers }],
  }),
})

describe("EXECUTE of a declared function on Supabase", () => {
  it("no callers: anon, authenticated and service_role get 42501", async () => {
    await withRollback(async (client) => {
      await deployed(client, declaredF([]))
      for (const purpose of API_PURPOSES)
        expect(await callAs(client, purpose, "SELECT public.f()")).toEqual([
          purpose,
          "42501",
        ])
    })
  })

  it("callers service: service_role executes, anon and authenticated get 42501", async () => {
    await withRollback(async (client) => {
      await deployed(client, declaredF(["service"]))
      const calls = []
      for (const purpose of API_PURPOSES)
        calls.push(await callAs(client, purpose, "SELECT public.f()"))
      expect(calls).toEqual([
        ["anonymous", "42501"],
        ["user", "42501"],
        ["service", "ok"],
      ])
    })
  })
})

describe("EXECUTE of an undeclared module function on Supabase", () => {
  it("anon, authenticated and service_role get 42501 on a module function with a parameter", async () => {
    await withRollback(async (client) => {
      await deployed(client, {
        "catalogs/Item/Item.sql": closedFn("public.item_total", "p_id uuid"),
      })
      for (const purpose of API_PURPOSES)
        expect(
          await callAs(
            client,
            purpose,
            "SELECT public.item_total(gen_random_uuid())"
          )
        ).toEqual([purpose, "42501"])
    })
  })
})

describe("EXECUTE of the call guard functions on Supabase", () => {
  it("no application role holds EXECUTE on them", async () => {
    await withRollback(async (client) => {
      const result = await compiledPolicyDomain(GUARDED_FILES, [profileLayer()])
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
        []
      )
      await client.query(renderDesiredState(result.model!).sql)
      await expectNoGuardExecute(client, "supabase")
    })
  })
})
