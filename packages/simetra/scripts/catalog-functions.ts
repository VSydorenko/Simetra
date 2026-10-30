/**
 * Генерує знімок доведено детермінованих функцій каталогу для кроків `fill`
 * промоції: ім'я потрапляє в знімок, лише
 * якщо кожне його перевантаження в `pg_catalog` — IMMUTABLE і не повертає
 * множину. Значення — `prokind`: агрегат і віконна функція вимагають `OVER`.
 *
 * Запуск над локальним стеком (`pnpm db:start`):
 *   pnpm --filter simetra catalog-functions
 * Адресу бази можна задати `SIMETRA_TEST_DATABASE_URL`. Дрейф версії Postgres
 * ловить DB-тест `test/db/catalog-functions.db.test.ts`.
 */
import { writeFileSync } from "node:fs"
import pg from "pg"

const OUTPUT = new URL(
  "../src/compiler/operations/promote/catalog-functions.ts",
  import.meta.url
)
const url =
  process.env.SIMETRA_TEST_DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  const version = await client.query<{ server_version: string }>(
    "SHOW server_version"
  )
  // `oid < 16384` — вбудовані функції initdb, а не створені розширеннями.
  const { rows } = await client.query<{ name: string; kinds: string[] }>(`
    SELECT proname AS name, array_agg(DISTINCT prokind::text) AS kinds
    FROM pg_proc
    WHERE pronamespace = 'pg_catalog'::regnamespace AND oid < 16384
    GROUP BY proname
    HAVING bool_and(provolatile = 'i' AND NOT proretset)
    ORDER BY proname COLLATE "C"
  `)
  // Ранжувальні функції мають і віконну, і гіпотетичну агрегатну форму:
  // обидві вимагають `OVER` чи `WITHIN GROUP`, тож віконна форма веде.
  const byKind: Record<"f" | "a" | "w", string[]> = { f: [], a: [], w: [] }
  for (const { name, kinds } of rows) {
    const kind = kinds.includes("w") ? "w" : kinds.includes("a") ? "a" : "f"
    byKind[kind].push(name)
  }
  const list = (names: string[]) =>
    names.map((name) => `    ${JSON.stringify(name)},`).join("\n")
  const text = `// Згенеровано \`pnpm --filter simetra catalog-functions\` над PostgreSQL ${version.rows[0]!.server_version}.
// Не правити вручну: генератор — packages/simetra/scripts/catalog-functions.ts.

/**
 * Функції \`pg_catalog\`, усі перевантаження яких IMMUTABLE і не повертають
 * множину, за \`prokind\`: \`f\` — звичайна, \`a\` — агрегат, \`w\` — віконна
 * (спека промоції §4). Чого тут немає, крок \`fill\` не викликає.
 */
export const CATALOG_FUNCTIONS = {
  f: [
${list(byKind.f)}
  ],
  a: [
${list(byKind.a)}
  ],
  w: [
${list(byKind.w)}
  ],
} as const
`
  writeFileSync(OUTPUT, text)
  console.log(`${rows.length} functions written to ${OUTPUT.pathname}`)
} finally {
  await client.end()
}
