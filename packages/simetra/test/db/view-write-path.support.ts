import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import { claimsFor, queryAs, testRoleFor, withRollback } from "./connection"
import { testProvider } from "./profile"

/**
 * Спільний випадок інваріанта І14 (спека прав §6.1, шлях «запис крізь
 * подання») для обох стеків: `view-write-path.db.test.ts` і
 * `view-write-path.supabase.db.test.ts`. Розгортання й подання живуть у
 * транзакції `withRollback`, тож ні бази, ні ролей тест не створює й не
 * лишає: роль запиту — роль API профілю прогону.
 */

/**
 * Подання над таблицею виду в `public`, автооновлюване за правилами
 * Postgres. Опція — предмет кейсу; виконавець запису — власник подання.
 */
const VIEW = "item_write"

const CASES = [
  {
    name: "without security_invoker the write bypasses RLS of the kind table",
    options: "",
    expected: "inserted",
  },
  {
    name: "with security_invoker RLS of the kind table refuses the write",
    options: " WITH (security_invoker = true)",
    expected: "refused",
  },
] as const

/** Розгортає таблицю виду `item` (RLS, без політик для ролі API) з поданням. */
async function deployView(client: pg.Client, options: string, role: string) {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({ database: { provider: testProvider() } }),
      "catalogs/Item/Item.meta.json": catalog("Item"),
    })
  )
  expect(result.diagnostics).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
  await client.query(
    `CREATE VIEW public.${VIEW}${options} AS SELECT id, description FROM public.item`
  )
  // Права подання й таблиці дає тест: бар'єром лишається саме RLS таблиці,
  // а не відсутність гранта (інакше `security_invoker` падав би на гранті
  // й кейс не доводив би нічого про RLS).
  await client.query(`GRANT INSERT, SELECT ON public.${VIEW} TO ${role}`)
  await client.query(`GRANT INSERT, SELECT ON public.item TO ${role}`)
}

/**
 * Причина DB-рівня: чи виконає Postgres запис крізь подання в обхід RLS,
 * компілятор не вирішує — він судить лише текст подання.
 */
export function describeViewWritePath(): void {
  describe("write through a view of a kind table (І14)", () => {
    const role = testRoleFor("user")!

    it.each(CASES)("$name", async ({ options, expected }) => {
      await withRollback(async (client) => {
        await deployView(client, options, role)
        const claims = claimsFor("user")
        const write = await queryAs(
          client,
          "user",
          claims,
          `INSERT INTO public.${VIEW} (id, description) VALUES (gen_random_uuid(), 'x') RETURNING id`
        )
        // Прийнятий запис повертає рядок; `queryAs` відкочує його точкою
        // збереження, тож стан таблиці далі не міняється
        expect(write).toEqual(
          expected === "inserted"
            ? { rows: [{ id: expect.any(String) }] }
            : { code: "42501" }
        )
      })
    })
  })
}
