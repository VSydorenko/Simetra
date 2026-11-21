import type pg from "pg"
import { expect } from "vitest"
import { PLATFORM_ROLES, PROVIDER_API_ROLES } from "simetra/model"
import { RIGHTS_FUNCTIONS } from "../../src/compiler/rights/functions"
import { uuid } from "../../src/compiler/__tests__/helpers"

/**
 * Задекларовані definer-функції з `check` обох цілей: рядок (`f`) і скоуп
 * (`g`), кожна з запобіжником першим оператором — тож генеруються обидві
 * функції запобіжника (`rights_require` і `rights_require_scope`).
 */
export const GUARDED_FILES = {
  "sql/public/fns.sql":
    "CREATE FUNCTION public.f(p_row uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$BEGIN PERFORM simetra.rights_require('read', 'task', p_row); END$$;\n" +
    "CREATE FUNCTION public.g(p_scope uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$BEGIN PERFORM simetra.rights_require_scope('create', 'task', p_scope); END$$;\n",
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
      {
        id: uuid(9503),
        function: { name: "g" },
        callers: ["user"],
        check: {
          action: "create",
          object: { kind: "Document", name: "Task" },
          scope: "p_scope",
        },
      },
    ],
  }),
}

/** Кожен отримувач `EXECUTE` на функціях запобіжника: ролі API, платформні ролі й `PUBLIC`. */
export const GUARD_RECIPIENTS = (provider: "postgres" | "supabase") => [
  ...Object.values(PROVIDER_API_ROLES[provider]).filter(
    (role): role is string => role !== null
  ),
  PLATFORM_ROLES.command,
  PLATFORM_ROLES.signalConsumer,
  "public",
]

/** Обидві функції запобіжника створено, і жоден отримувач не має на них `EXECUTE`. */
export async function expectNoGuardExecute(
  client: pg.Client,
  provider: "postgres" | "supabase"
): Promise<void> {
  const recipients = GUARD_RECIPIENTS(provider)
  const names = [
    RIGHTS_FUNCTIONS.require.name,
    RIGHTS_FUNCTIONS.requireScope.name,
  ]
  const { rows } = await client.query<{
    fn: string
    role: string
    granted: boolean
  }>(
    `SELECT p.oid::regprocedure::text AS fn, r AS role, has_function_privilege(r, p.oid, 'EXECUTE') AS granted
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, unnest($1::text[]) r
      WHERE n.nspname = 'simetra' AND p.proname = ANY($2::text[])`,
    [recipients, names]
  )
  // Функції справді створені: без цього «жодного права» нічого б не довело
  expect(rows).toHaveLength(recipients.length * names.length)
  expect(rows.filter((row) => row.granted)).toEqual([])
}
