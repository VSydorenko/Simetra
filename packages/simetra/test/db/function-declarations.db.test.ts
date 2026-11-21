import { randomUUID } from "node:crypto"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  type ApiRolePurpose,
} from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  DIMENSION_SQL,
  compiledPolicyDomain,
  dimensionFunction,
} from "../../src/compiler/__tests__/fixtures/rights"
import {
  catalog,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
import {
  asStackSuperuser,
  claimsFor,
  queryAs,
  testRoleName,
  withRollback,
} from "./connection"
import { testProvider } from "./profile"
import { profileLayer } from "./rights-seed"

/**
 * `EXECUTE` задекларованих функцій, функцій значень виміру й функцій модуля
 * виду на справжньому Postgres (спека декларацій функцій §5.1, інваріанти
 * 1–3 плану Д1): чи виконує роль функцію, вирішує ACL бази після
 * застосування, а не текст грантів. Модель розгортається в транзакції тесту,
 * тож відкат прибирає все, що вона створила.
 */

const closedFn = (name: string, args = "") =>
  `CREATE FUNCTION ${name}(${args}) RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT 1 $$;\n`

async function deployed(
  client: pg.Client,
  result: CompileResult
): Promise<void> {
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
}

/** Проєкт з каталогом `Item` і файлами `entries` під провайдера стека. */
const compiled = (entries: Record<string, unknown>) =>
  compile(
    metaFiles({
      "project.meta.json": project({ database: { provider: testProvider() } }),
      "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
      ...entries,
    })
  )

const declaredF = (callers: string[]) =>
  compiled({
    "sql/public/fns.sql": closedFn("public.f"),
    "sql/public/fns.functions.json": JSON.stringify({
      functions: [{ id: uuid(9501), function: { name: "f" }, callers }],
    }),
  })

/**
 * Ролі API, які є на кожному стеку. Сервісна є лише на `supabase`: її кейси —
 * у `function-declarations.supabase.db.test.ts`, а не пропуск за профілем тут.
 */
const API_PURPOSES = ["user", "anonymous"] as const

/** Код відмови чи `ok` виклику `sql` від ролі API призначення `purpose`. */
async function callAs(
  client: pg.Client,
  purpose: ApiRolePurpose,
  sql: string
): Promise<string> {
  const result = await queryAs(
    client,
    purpose,
    claimsFor(purpose, purpose === "anonymous" ? undefined : randomUUID()),
    sql
  )
  return "code" in result ? result.code : "ok"
}

describe("EXECUTE of a declared function in Postgres", () => {
  it("callers user: the user role executes, anon and a role without a grant get 42501", async () => {
    await withRollback(async (client) => {
      await deployed(client, await declaredF(["user"]))
      expect(await callAs(client, "user", "SELECT public.f()")).toBe("ok")
      expect(await callAs(client, "anonymous", "SELECT public.f()")).toBe(
        "42501"
      )
      const role = testRoleName("nodecl")
      // Роль створює суперкористувач стека: власник профілю ролей не створює.
      // Роль створено в транзакції тесту: відкат прибирає її на будь-якому шляху.
      await asStackSuperuser(client, () => client.query(`CREATE ROLE ${role}`))
      await client.query("SAVEPOINT probe")
      try {
        await client.query(`SET LOCAL ROLE ${role}`)
        await expect(client.query("SELECT public.f()")).rejects.toMatchObject({
          code: "42501",
        })
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT probe")
      }
    })
  })

  it("no callers: no API role executes it", async () => {
    await withRollback(async (client) => {
      await deployed(client, await declaredF([]))
      for (const purpose of API_PURPOSES)
        expect([
          purpose,
          await callAs(client, purpose, "SELECT public.f()"),
        ]).toEqual([purpose, "42501"])
    })
  })
})

describe("EXECUTE of a dimension value function in Postgres", () => {
  it("the user role gets 42501 on a direct call", async () => {
    await withRollback(async (client) => {
      await deployed(
        client,
        await compiledPolicyDomain({ "sql/public/region.sql": DIMENSION_SQL }, [
          dimensionFunction(),
          profileLayer(),
        ])
      )
      expect(
        await callAs(client, "user", "SELECT * FROM public.region_ids()")
      ).toBe("42501")
    })
  })
})

describe("EXECUTE of an undeclared module function in Postgres", () => {
  it("a module function with a parameter is executable by no API role", async () => {
    await withRollback(async (client) => {
      await deployed(
        client,
        await compiled({
          "catalogs/Item/Item.sql": closedFn("public.item_total", "p_id uuid"),
        })
      )
      for (const purpose of API_PURPOSES)
        expect([
          purpose,
          await callAs(
            client,
            purpose,
            "SELECT public.item_total(gen_random_uuid())"
          ),
        ]).toEqual([purpose, "42501"])
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

describe("EXECUTE of the call guard functions in Postgres", () => {
  it("no application role holds EXECUTE on them", async () => {
    await withRollback(async (client) => {
      await deployed(
        client,
        await compiledPolicyDomain(GUARDED_FILES, [profileLayer()])
      )
      const recipients = GUARD_RECIPIENTS(testProvider())
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
