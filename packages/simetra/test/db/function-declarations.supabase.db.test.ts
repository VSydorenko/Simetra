import { randomUUID } from "node:crypto"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  type ApiRolePurpose,
} from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
import { compiledPolicyDomain } from "../../src/compiler/__tests__/fixtures/rights"
import { profileLayer } from "./rights-seed"
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

/** Задекларована definer-функція з `check` і запобіжником першим оператором. */
const GUARDED_FILES = {
  "sql/public/fns.sql":
    "CREATE FUNCTION public.f(p_row uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$BEGIN PERFORM simetra.rights_require('read', 'task', p_row); END$$;\n",
  "sql/public/fns.functions.json": JSON.stringify({
    functions: [
      {
        id: uuid(9502),
        function: { name: "f" },
        callers: ["user"],
        check: {
          action: "read",
          object: { kind: "Document", name: "Task" },
          row: "p_row",
        },
      },
    ],
  }),
}

/** Кожен отримувач `EXECUTE` на функції запобіжника: ролі API, роль команд і `PUBLIC`. */
const GUARD_RECIPIENTS = (provider: "postgres" | "supabase") => [
  ...Object.values(PROVIDER_API_ROLES[provider]).filter(
    (role): role is string => role !== null
  ),
  PLATFORM_ROLES.command,
  "public",
]

describe("EXECUTE of the call guard functions on Supabase", () => {
  it("no application role holds EXECUTE on them", async () => {
    await withRollback(async (client) => {
      const result = await compiledPolicyDomain(GUARDED_FILES, [profileLayer()])
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
        []
      )
      await client.query(renderDesiredState(result.model!).sql)
      const recipients = GUARD_RECIPIENTS("supabase")
      const { rows } = await client.query<{
        fn: string
        role: string
        granted: boolean
      }>(
        `SELECT p.oid::regprocedure::text AS fn, r AS role, has_function_privilege(r, p.oid, 'EXECUTE') AS granted
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, unnest($1::text[]) r
          WHERE n.nspname = 'simetra' AND p.proname = 'rights_require'`,
        [recipients]
      )
      // Функція справді створена: без цього «жодного права» нічого б не довело
      expect(rows).toHaveLength(recipients.length)
      expect(rows.filter((row) => row.granted)).toEqual([])
    })
  })
})
