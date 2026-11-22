import type pg from "pg"
import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { PROVIDER_API_ROLES } from "simetra/model"
import { withRollback } from "./connection"
import { deploy } from "./rights-seed"
import {
  BOUND,
  describePolicyFunctionCalls,
  files,
} from "./policy-functions.support"

describePolicyFunctionCalls()

const { user, anonymous, service } = PROVIDER_API_ROLES.supabase
const ROLES = [anonymous, user, service!] as const

/** Чи має кожна роль API `EXECUTE` на `public.f()` і `SELECT` на T. */
async function privileges(client: pg.Client) {
  const { rows } = await client.query<{
    role: string
    execute: boolean
    select: boolean
  }>(
    `SELECT r AS role,
            has_function_privilege(r, 'public.f()', 'EXECUTE') AS execute,
            has_table_privilege(r, 'public.docs', 'SELECT') AS select
       FROM unnest($1::text[]) AS r`,
    [ROLES]
  )
  return Object.fromEntries(rows.map((r) => [r.role, r]))
}

/**
 * `EXECUTE` функції політики на профілі Supabase (спека декларацій функцій
 * §5.8, інваріант І3 плану Д5): пресет дає функціям `public` `EXECUTE`
 * анонімній і сервісній ролям типовими привілеями, тож відкликання —
 * обов'язок платформи. `service_role` обходить RLS, тож без `SELECT` на T
 * прямий виклик віддав би їй ключі таблиці, якої вона не читає.
 */
describe("EXECUTE of a policy function on Supabase (І3)", () => {
  const callers = `CREATE POLICY docs_read ON public.docs FOR SELECT TO ${user}, ${service} USING (id IN (SELECT public.f()));\n`

  // Без цього рядка відмова нижче могла б бути відмовою будь-якої фікстури:
  // з `SELECT` на T сервісна роль справді отримує `EXECUTE`, анонім — ні
  it("a reading service_role with SELECT on T gets EXECUTE; anon never", async () => {
    const result = await compile(
      await files({
        where: [`d.${BOUND}`],
        callers,
        readers: [user, service!],
      })
    )
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    await withRollback(async (client) => {
      await deploy(client, result.model!)
      const granted = await privileges(client)
      expect(
        Object.fromEntries(ROLES.map((r) => [r, granted[r]!.execute]))
      ).toEqual({ [anonymous]: false, [user]: true, [service!]: true })
    })
  })

  // Типові привілеї пресета дають `service_role` `SELECT` на кожну нову
  // таблицю `public`, тож без `SELECT` на T вона лишається лише після
  // явного відкликання — і в моделі, і в базі.
  // Мутація: прибрати перевірку `SELECT` на T у призначеннях — варіант
  // компілюється, і `service_role` отримує `EXECUTE` без `SELECT`
  it("a reading service_role without SELECT on T: accepted only without its EXECUTE", async () => {
    const result = await compile(
      await files({
        where: [`d.${BOUND}`],
        callers: `${callers}REVOKE SELECT ON TABLE public.docs FROM ${service};\n`,
        readers: [user],
      })
    )
    const errors = result.diagnostics.filter((d) => d.severity === "error")
    if (errors.length > 0) {
      // Відмова — саме роль без `SELECT` на T, а не зламана фікстура
      expect(
        errors.map((d) => [
          d.code,
          d.params?.schema,
          d.params?.name,
          d.params?.reason,
        ])
      ).toEqual([
        ["sql.policy-helper-correlated", "public", "f", "policyRoles"],
      ])
      return
    }
    await withRollback(async (client) => {
      await deploy(client, result.model!)
      const granted = await privileges(client)
      for (const role of ROLES)
        expect([
          role,
          granted[role]!.execute && !granted[role]!.select,
        ]).toEqual([role, false])
      expect(granted[anonymous]!.execute).toBe(false)
    })
  })
})
