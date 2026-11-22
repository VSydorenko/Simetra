import { randomUUID } from "node:crypto"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { PROVIDER_API_ROLES, type ApiRolePurpose } from "simetra/model"
import {
  acceptDebt,
  catalog,
  customTable,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
import { pinnedSettingsClause } from "../../src/compiler/sql/head-settings"
import { signUp } from "./auth"
import { claimsFor, queryAs, withRollback } from "./connection"
import { testProvider } from "./profile"
import { deploy, insert } from "./rights-seed"

/**
 * Прямий виклик функції політики роллю запиту (спека декларацій функцій
 * §5.8, інваріант І1 плану Д5) — спільне тіло файлів профілів
 * (`policy-functions.db.test.ts`, `policy-functions.supabase.db.test.ts`): функція — `SECURITY DEFINER`, тож RLS T її не
 * обмежує, і RPC віддав би все, що вона вибирає. Тому вона мусить віддавати
 * лише ключі T, які актору дають політика-викликач і межі `RESTRICTIVE` T.
 * Оракул — сам Postgres: ключі, які актор бачить у T під RLS, проти ключів
 * прямого виклику. Варіант, який компілятор не приймає, не розгортається;
 * прийнятий — мусить дати підмножину. Модель розгортається в транзакції
 * тесту, тож відкат прибирає все, що вона створила.
 */

const provider = testProvider()
const USER_ROLE = PROVIDER_API_ROLES[provider].user

/** Явна функція ідентичності провайдера чи платформи (Р6). */
const ACTOR =
  provider === "supabase"
    ? "(SELECT auth.uid())"
    : "(SELECT simetra.current_user_id())"

export const BOUND = "status = 'open'"

const column = (n: number, physicalName: string, type = "UUID") => ({
  id: uuid(n),
  name: physicalName.replace(/_(.)/g, (_, c: string) => c.toUpperCase()),
  physicalName,
  type,
  notNull: true,
})

/** Функція політики `public.f`; `where` — кон'юнкти після прив'язки до актора. */
const policyFunction = (where: readonly string[]) =>
  `CREATE FUNCTION public.f() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' ${pinnedSettingsClause()} AS $$ SELECT d.id FROM public.docs d JOIN public.members m ON m.team_id = d.team_id WHERE ${[`m.user_id = ${ACTOR}`, ...where].join(" AND ")} $$;\n`

/** Політика-викликач `docs_read`: `FOR SELECT` ролі запиту користувача. */
const READ_CALLER = `CREATE POLICY docs_read ON public.docs FOR SELECT TO ${USER_ROLE} USING (id IN (SELECT public.f()));\n`

/**
 * Прийняті `docs` (T, під RLS) і `members` (членства, без RLS), дослівний борг:
 * функція, політики-викликачі `callers`, межа `RESTRICTIVE` і `SELECT` на T
 * ролям `readers`. «Користувачі» дають функцію поточного користувача на обох
 * профілях (`hasSessionUser`).
 */
export const files = ({
  where,
  callers = READ_CALLER,
  readers = [USER_ROLE],
}: {
  where: readonly string[]
  callers?: string
  readers?: readonly string[]
}) =>
  acceptDebt(
    metaFiles({
      "project.meta.json": project({ database: { provider } }),
      "catalogs/Users/Users.meta.json": catalog("Users", {
        role: "users",
        scope: "none",
      }),
      "custom-tables/Docs/Docs.meta.json": customTable("Docs", {
        physicalName: "docs",
        rowLevelSecurity: "enabled",
        columns: [
          column(7101, "id"),
          column(7102, "team_id"),
          column(7103, "status", "Text"),
        ],
        primaryKey: { name: "docs_pkey", columns: ["id"] },
      }),
      "custom-tables/Members/Members.meta.json": customTable("Members", {
        physicalName: "members",
        columns: [
          column(7111, "id"),
          column(7112, "team_id"),
          column(7113, "user_id"),
        ],
        primaryKey: { name: "members_pkey", columns: ["id"] },
      }),
      "sql/public/policies.sql":
        policyFunction(where) +
        callers +
        `CREATE POLICY docs_open ON public.docs AS RESTRICTIVE FOR SELECT TO ${USER_ROLE} USING (${BOUND});\n` +
        readers
          .map((role) => `GRANT SELECT ON TABLE public.docs TO ${role};\n`)
          .join(""),
    })
  )

/** Ключі `sql` від ролі API `purpose` з `sub` актора, або код відмови. */
async function keysAs(
  client: pg.Client,
  purpose: ApiRolePurpose,
  actor: string | undefined,
  sql: string
): Promise<string[] | string> {
  const result = await queryAs(client, purpose, claimsFor(purpose, actor), sql)
  if ("code" in result) return result.code
  return (result.rows as { id: string }[]).map((r) => r.id).sort()
}

/**
 * Команди A і B; `member` — у A, `outsider` — ні в якій. У A — відкритий і
 * архівний документ, у B — відкритий: архівний поза межею, документ B — поза
 * політикою-викликачем.
 */
export async function seed(client: pg.Client) {
  const [teamA, teamB] = [randomUUID(), randomUUID()]
  const ids = {
    member: await signUp(client),
    outsider: await signUp(client),
    openA: randomUUID(),
    archivedA: randomUUID(),
    openB: randomUUID(),
  }
  await insert(client, "members", {
    id: randomUUID(),
    team_id: teamA,
    user_id: ids.member,
  })
  for (const [id, team, status] of [
    [ids.openA, teamA, "open"],
    [ids.archivedA, teamA, "archived"],
    [ids.openB, teamB, "open"],
  ] as const)
    await insert(client, "docs", { id, team_id: team, status })
  return ids
}

/** Тіло І1 на профілі прогону: реєструє файл профілю. */
export function describePolicyFunctionCalls(): void {
  describe("a direct call of a policy function in Postgres (І1)", () => {
    // Варіант без межі в `WHERE` компілятор відмовляє (`restrictiveBound`).
    // Мутація: прибрати перевірку `restrictiveBound` — варіант компілюється,
    // розгортається, і прямий виклик віддає архівний документ, якого актор у T
    // не бачить: рядок «without the bound» червоніє на підмножині.
    // Єдиний викликач `FOR UPDATE` — відмова `policyRoles`. Мутація: брати
    // призначення з ролей усіх політик-викликачів, а не лише читачів, — роль
    // отримує `EXECUTE`, а в T під RLS не бачить нічого: рядок «only an UPDATE
    // caller» червоніє на підмножині.
    it.each([
      { name: "the bound in WHERE", where: [`d.${BOUND}`] },
      { name: "without the bound", where: [] },
      {
        name: "only an UPDATE caller",
        where: [`d.${BOUND}`],
        callers: `CREATE POLICY docs_edit ON public.docs FOR UPDATE TO ${USER_ROLE} USING (id IN (SELECT public.f()));\n`,
      },
    ])(
      "$name: accepted only if the call returns a subset of what T shows",
      async ({ where, callers }) => {
        const result = await compile(await files({ where, callers }))
        const errors = result.diagnostics.filter((d) => d.severity === "error")
        if (errors.length > 0) {
          // Відмова — саме форма функції політики, а не зламана фікстура
          expect(
            errors.map((d) => [d.code, d.params?.schema, d.params?.name])
          ).toEqual([["sql.policy-helper-correlated", "public", "f"]])
          return
        }
        await withRollback(async (client) => {
          await deploy(client, result.model!)
          const ids = await seed(client)
          for (const who of ["member", "outsider"] as const) {
            const shown = await keysAs(
              client,
              "user",
              ids[who],
              "SELECT id FROM public.docs"
            )
            const called = await keysAs(
              client,
              "user",
              ids[who],
              "SELECT id FROM public.f() AS id"
            )
            expect(Array.isArray(shown)).toBe(true)
            expect(Array.isArray(called)).toBe(true)
            expect([
              who,
              (called as string[]).filter((k) => !shown.includes(k)),
            ]).toEqual([who, []])
          }
        })
      }
    )

    // Без цього рядка підмножина була б порожньою істиною: прийнятий варіант
    // справді дає актору його ключ, похідний `EXECUTE` має лише роль
    // політики-викликача, а аноніма відмовлено.
    it("the accepted function returns the actor's open key; anon gets 42501", async () => {
      const result = await compile(await files({ where: [`d.${BOUND}`] }))
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
        []
      )
      await withRollback(async (client) => {
        await deploy(client, result.model!)
        const ids = await seed(client)
        const call = "SELECT id FROM public.f() AS id"
        expect({
          member: await keysAs(client, "user", ids.member, call),
          outsider: await keysAs(client, "user", ids.outsider, call),
          anonymous: await keysAs(client, "anonymous", undefined, call),
        }).toEqual({ member: [ids.openA], outsider: [], anonymous: "42501" })
      })
    })
  })
}
