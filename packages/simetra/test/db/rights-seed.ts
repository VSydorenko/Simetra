import { randomUUID } from "node:crypto"
import pg from "pg"
import type { CompiledModel } from "simetra/compiler"
import { RIGHTS_MAINTENANCE_SETTING } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import { testDatabaseUrl } from "./connection"

/**
 * Спільний засів DB-сценаріїв прав (`rights-functions`, `rights-policies`):
 * рядки довідників прав і транзакція опису. Засів іде від власника таблиць —
 * RLS його не обмежує.
 */

/** Ключі засіяних рядків → їхні id. */
export type Seed = Record<string, string>

/**
 * Таблиці прав розгорнутої моделі за клієнтом: `insert` вмикає для них режим
 * обслуговування (Р2d2-14). Перелік — з контрактів прав моделі, а не з імені
 * таблиці: регулярка за іменем мовчки пропустила б довідники прав нового виду
 * скоупу (`team_*`), і засів упав би на `rights-context`.
 */
const rightsTables = new WeakMap<pg.Client, ReadonlySet<string>>()

/** Розгортання моделі в транзакції клієнта і перелік її таблиць прав для `insert`. */
export async function deploy(
  client: pg.Client,
  model: CompiledModel
): Promise<void> {
  await client.query(renderDesiredState(model).sql)
  rightsTables.set(
    client,
    new Set(
      model.contracts.rightsCatalogs.flatMap((c) =>
        [c.roles.table, c.roles.delta, c.assignments.table].map(
          (t) => `${t.schema}.${t.name}`
        )
      )
    )
  )
}

/** Рядок у таблицю `public` від власника: RLS його не обмежує. */
export async function insert(
  client: pg.Client,
  table: string,
  values: Record<string, unknown>
): Promise<void> {
  const tables = rightsTables.get(client)
  // Без `deploy` перелік невідомий: мовчазне «не таблиця прав» дало б
  // відмову `rights-context` замість ясної причини.
  if (tables === undefined)
    throw new Error("insert: deploy the model on this client first")
  const columns = Object.keys(values)
  const rightsTable = tables.has(`public.${table}`)
  if (rightsTable)
    await client.query("SELECT set_config($1, 'on', true)", [
      RIGHTS_MAINTENANCE_SETTING,
    ])
  await client.query(
    `INSERT INTO public.${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(values)
  )
  if (rightsTable)
    await client.query("SELECT set_config($1, 'off', true)", [
      RIGHTS_MAINTENANCE_SETTING,
    ])
}

export interface Assignment {
  archetype?: string
  customRole?: string
  container?: string | null
  deletionMark?: boolean
}

/** Рядок довідника «Призначення ролей» без колонки скоупу рівня. */
export const assignmentRow = (subject: string, a: Assignment) => ({
  id: randomUUID(),
  subject,
  archetype: a.archetype ?? null,
  custom_role: a.customRole ?? null,
  container: a.container ?? null,
  deletion_mark: a.deletionMark ?? false,
})

export type Delta = [
  effect: "allow" | "deny",
  object: string,
  action: string,
  extent: "any" | "own" | "dimension",
  dimensionId?: string,
]

/** Рядок ТЧ дельт кастомної ролі рівня `org`. */
export const orgDeltaRow = (
  orgId: string,
  roleId: string,
  lineNumber: number,
  [effect, object, action, extent, dimensionId]: Delta
) => ({
  id: randomUUID(),
  org_id: orgId,
  parent_id: roleId,
  line_number: lineNumber,
  object,
  action,
  extent,
  dimension: dimensionId ?? null,
  effect,
})

/** Множина як масив тексту: порядок вирівнює тест, не колація бази. */
export const set = (call: string) =>
  `SELECT coalesce(array_agg(s::text), '{}') AS v FROM ${call} AS s`

/** Значення `v` єдиного рядка; масив — відсортований. */
export function outcome(result: { rows: { v: unknown }[] } | { code: string }) {
  if (!("rows" in result)) return result
  const v = result.rows[0]?.v
  return Array.isArray(v) ? [...(v as string[])].sort() : v
}

/** Транзакція опису: відкривається в `beforeAll`, відкочується в `afterAll`. */
export function describeTransaction(): {
  client: () => pg.Client
  open: () => Promise<pg.Client>
  close: () => Promise<void>
} {
  let current: pg.Client | undefined
  return {
    client: () => current!,
    open: async () => {
      const client = new pg.Client({ connectionString: testDatabaseUrl() })
      await client.connect()
      // `current` лише після успішного з'єднання: `close` не закриває клієнта, що не підключився
      current = client
      await client.query("BEGIN")
      return client
    },
    close: async () => {
      if (current === undefined) return
      // Відкат після збою засіву може сам впасти — першопричину це не затирає
      await current.query("ROLLBACK").catch(() => undefined)
      await current.end()
    },
  }
}
