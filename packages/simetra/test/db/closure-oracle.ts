import { readFileSync } from "node:fs"
import { expect } from "vitest"
import type pg from "pg"
import { queryAs } from "./connection"

/**
 * Еквівалентність замикання прав (Р2d2-22): нове тіло `rights_mine` і
 * `rights_role_grants` мусить давати рівно ті рядки, що й тіло до
 * переписування `closurePass`. Оракул — заморожені тіла з
 * `fixtures/closure-oracle/` під іменами `*_before`: `rights_mine` — своє для
 * кожної моделі (`<модель>.rights_mine.sql`), `rights_role_grants` від моделі
 * не залежить; варіант
 * `*_unclosed` (те саме тіло, але результат — рядки до замикання) показує,
 * скільки рядків замикання зняло: без знятих рядків порівняння не перевіряло б
 * замикання взагалі. Порівняння — `EXCEPT` в обидва боки: `NULL` у колонках
 * рівні, як у множинах рядків.
 */

const FIXTURES = new URL("./fixtures/closure-oracle/", import.meta.url)

/** Рядок-результат: замикання бере з тіла результат `closure_2`. */
const CLOSED = "FROM closure_2"

/** Те саме тіло з результатом до замикання — рядки `role_rows`. */
function unclosed(sql: string, fn: string): string {
  // Рівно одне входження: інакше заміна зачепила б прохід замикання, а не
  // результат, і лічильник знятих рядків брехав би.
  expect(sql.split(CLOSED), `${fn}: one ${CLOSED}`).toHaveLength(2)
  return sql
    .replace(CLOSED, "FROM role_rows")
    .replaceAll(`${fn}_before`, `${fn}_unclosed`)
}

/**
 * Створює в транзакції клієнта функції оракула (`rights_mine` моделі `model`
 * і `rights_role_grants`) і варіанти без замикання; `EXECUTE` варіантів
 * `rights_mine` — ролі `authenticated`, бо `rights_mine` читається під claims
 * користувача.
 */
export async function installClosureOracle(
  client: pg.Client,
  model: string
): Promise<void> {
  for (const [file, fn] of [
    [`${model}.rights_mine.sql`, "rights_mine"],
    ["rights_role_grants.sql", "rights_role_grants"],
  ] as const) {
    const sql = readFileSync(new URL(file, FIXTURES), "utf8")
    await client.query(sql)
    await client.query(unclosed(sql, fn))
  }
  await client.query(
    "GRANT EXECUTE ON FUNCTION simetra.rights_mine_before(), simetra.rights_mine_unclosed() TO authenticated"
  )
}

/** Розбіжність і обсяг одного порівняння. */
export interface Equivalence {
  extra: number
  missing: number
  rows: number
  dropped: number
}

const compare = (current: string, before: string, open: string) =>
  `SELECT
     (SELECT count(*) FROM (SELECT * FROM ${current} EXCEPT SELECT * FROM ${before}) x)::int AS extra,
     (SELECT count(*) FROM (SELECT * FROM ${before} EXCEPT SELECT * FROM ${current}) x)::int AS missing,
     (SELECT count(*) FROM (SELECT DISTINCT * FROM ${current}) x)::int AS rows,
     (SELECT count(*) FROM (SELECT * FROM ${open} EXCEPT SELECT * FROM ${before}) x)::int AS dropped`

/** `rights_mine()` проти оракула від імені кожного користувача. */
export async function mineEquivalence(
  client: pg.Client,
  users: Record<string, string>
): Promise<Record<string, Equivalence>> {
  const out: Record<string, Equivalence> = {}
  for (const [key, sub] of Object.entries(users)) {
    const result = await queryAs<Equivalence>(
      client,
      "authenticated",
      { sub, role: "authenticated" },
      compare(
        "simetra.rights_mine()",
        "simetra.rights_mine_before()",
        "simetra.rights_mine_unclosed()"
      )
    )
    if (!("rows" in result)) throw new Error(`${key}: ${result.code}`)
    out[key] = result.rows[0]!
  }
  return out
}

/** Аргументи `rights_role_grants`: рівень ролі, архетип і дельта. */
export interface RoleGrantsArgs {
  level: string
  levelId: string | null
  archetype: string
  delta: unknown[]
}

/**
 * `rights_role_grants(...)` проти оракула для кожного набору аргументів — від
 * власника: функцію кличуть запобіжники, а не роль запиту, і claims вона не
 * читає.
 */
export async function roleGrantsEquivalence(
  client: pg.Client,
  cases: Record<string, RoleGrantsArgs>
): Promise<Record<string, Equivalence>> {
  const out: Record<string, Equivalence> = {}
  for (const [key, a] of Object.entries(cases)) {
    const args = [
      `'${a.level}'`,
      a.levelId === null ? "NULL::uuid" : `'${a.levelId}'::uuid`,
      `'${a.archetype}'::uuid`,
      `'${JSON.stringify(a.delta)}'::jsonb`,
    ].join(", ")
    const { rows } = await client.query<Equivalence>(
      compare(
        `simetra.rights_role_grants(${args})`,
        `simetra.rights_role_grants_before(${args})`,
        `simetra.rights_role_grants_unclosed(${args})`
      )
    )
    out[key] = rows[0]!
  }
  return out
}

/**
 * Перевірка порівнянь: жодної розбіжності, а замикання хоч раз зняло рядок —
 * інакше порівняння не доводить нічого про замикання. `drops: false` — для
 * моделі, де порівняння тримає інше (ідентичність рядків джерела), а ланцюгів
 * вимог, які замикання знімало б, засів не має.
 */
export function expectEquivalent(
  label: string,
  results: Record<string, Equivalence>,
  { drops = true }: { drops?: boolean } = {}
): void {
  for (const [key, r] of Object.entries(results)) {
    expect.soft(r.extra, `${label} ${key}: rows only in the new body`).toBe(0)
    expect.soft(r.missing, `${label} ${key}: rows only in the old body`).toBe(0)
  }
  const dropped = Object.values(results).reduce((n, r) => n + r.dropped, 0)
  if (drops)
    expect(dropped, `${label}: the closure drops rows`).toBeGreaterThan(0)
  console.info(
    `${label}: ${Object.entries(results)
      .map(([k, r]) => `${k} ${r.rows}/${r.dropped}`)
      .join(", ")} (rows/dropped)`
  )
}
