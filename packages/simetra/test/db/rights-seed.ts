import { randomUUID } from "node:crypto"
import pg from "pg"
import { testDatabaseUrl } from "./connection"

/**
 * Спільний засів DB-сценаріїв прав (`rights-functions`, `rights-policies`):
 * рядки довідників прав і транзакція опису. Засів іде від власника таблиць —
 * RLS його не обмежує.
 */

/** Ключі засіяних рядків → їхні id. */
export type Seed = Record<string, string>

/** Рядок у таблицю `public` від власника: RLS його не обмежує. */
export async function insert(
  client: pg.Client,
  table: string,
  values: Record<string, unknown>
): Promise<void> {
  const columns = Object.keys(values)
  await client.query(
    `INSERT INTO public.${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(values)
  )
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
  extent: "any" | "own",
]

/** Рядок ТЧ дельт кастомної ролі рівня `org`. */
export const orgDeltaRow = (
  orgId: string,
  roleId: string,
  lineNumber: number,
  [effect, object, action, extent]: Delta
) => ({
  id: randomUUID(),
  org_id: orgId,
  parent_id: roleId,
  line_number: lineNumber,
  object,
  action,
  extent,
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
