import { pinnedSettingsClause } from "../../sql/head-settings"
import { customTable, metaFiles, project, uuid } from "../helpers"

/**
 * Прийняті таблиці під дослівними політиками боргу (спека декларацій функцій
 * §5.8): T — `public.docs` під RLS, `public.members` — членства без RLS.
 * Функція політики `public.f` віддає ключі документів команд актора.
 */
export const POLICY_SQL = "sql/public/policies.sql"
export const SQL_DEBT = "sql-debt.json"

const column = (n: number, physicalName: string) => ({
  id: uuid(n),
  name: physicalName.replace(/_(.)/g, (_, c: string) => c.toUpperCase()),
  physicalName,
  type: "UUID",
  notNull: true,
})

/** Оболонка функції політики: закрита, з налаштуваннями сесії голови. */
export const POLICY_SHELL = `STABLE SECURITY DEFINER SET search_path = '' ${pinnedSettingsClause()}`

/** Функція політики `public.<name>`; `where` — додаткові кон'юнкти тіла. */
export const POLICY_FUNCTION = ({
  name = "f",
  shell = POLICY_SHELL,
  where = [] as readonly string[],
} = {}) =>
  `CREATE FUNCTION public.${name}() RETURNS SETOF uuid LANGUAGE sql ${shell} AS $$ SELECT d.id FROM public.docs d JOIN public.members m ON m.team_id = d.team_id WHERE ${["m.user_id = (SELECT auth.uid())", ...where].join(" AND ")} $$;\n`

export const READ_POLICY = (
  to = "authenticated",
  { name = "docs_read", cmd = "SELECT", fn = "f" } = {}
) =>
  `CREATE POLICY ${name} ON public.docs FOR ${cmd} TO ${to} USING (id IN (SELECT public.${fn}()));\n`

export const DOCS_GRANT = (to = "authenticated") =>
  `GRANT SELECT ON TABLE public.docs TO ${to};\n`

/** Ідентичності боргу фікстури: політика й грант таблиці. */
export const POLICY_DEBT = (
  policies = ["docs_read"],
  grants = ["authenticated"]
) =>
  [
    ...policies.map((p) => `policy:public.docs.${p}`),
    ...grants.map((g) => `grant:grant:table:public.docs:${g}:select`),
  ].sort()

/** Тека проєкту `supabase` з двома прийнятими таблицями й `sql`. */
export function policyFiles(sql: string, debt?: readonly string[]) {
  return metaFiles({
    "project.meta.json": project(),
    "custom-tables/Docs/Docs.meta.json": customTable("Docs", {
      physicalName: "docs",
      rowLevelSecurity: "enabled",
      columns: [column(7001, "id"), column(7002, "team_id")],
      primaryKey: { name: "docs_pkey", columns: ["id"] },
    }),
    "custom-tables/Members/Members.meta.json": customTable("Members", {
      physicalName: "members",
      columns: [
        column(7011, "id"),
        column(7012, "team_id"),
        column(7013, "user_id"),
      ],
      primaryKey: { name: "members_pkey", columns: ["id"] },
    }),
    [POLICY_SQL]: sql,
    ...(debt === undefined ? {} : { [SQL_DEBT]: { units: debt } }),
  })
}
