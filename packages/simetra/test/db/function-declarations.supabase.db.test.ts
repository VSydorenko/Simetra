import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import { claimsFor, queryAs, withRollback } from "./connection"

/**
 * Функція модуля виду на стеку Supabase (спека декларацій функцій §5.1,
 * інваріант 3 плану Д1): типові привілеї схеми `public` дають `EXECUTE`
 * кожній новій функції `anon` і `authenticated`, тож без похідного `REVOKE`
 * функція модуля, якої ніхто не декларував, була б RPC для кожного.
 * Тут же — кейси сервісної ролі, яка є лише на цьому стеку; решта —
 * `function-declarations.db.test.ts`.
 */

describe("EXECUTE of an undeclared module function on Supabase", () => {
  it("anon, authenticated and service_role get 42501 on a module function with a parameter", async () => {
    await withRollback(async (client) => {
      const result = await compile(
        metaFiles({
          "project.meta.json": project({ database: { provider: "supabase" } }),
          "catalogs/Item/Item.meta.json": catalog("Item", { scope: "none" }),
          "catalogs/Item/Item.sql":
            "CREATE FUNCTION public.item_total(p_id uuid) RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT 1 $$;\n",
        })
      )
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
        []
      )
      await client.query(renderDesiredState(result.model!).sql)
      for (const purpose of ["anonymous", "user", "service"] as const) {
        const call = await queryAs(
          client,
          purpose,
          claimsFor(
            purpose,
            purpose === "anonymous" ? undefined : randomUUID()
          ),
          "SELECT public.item_total(gen_random_uuid())"
        )
        expect([purpose, call]).toEqual([purpose, { code: "42501" }])
      }
    })
  })
})
