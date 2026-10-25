/**
 * Генерує дозвільний перелік вбудованих функцій для судження голів (Р2c1-20):
 * імена `pg_catalog` з initdb без класів `BUILTIN_EXCLUSIONS`. Позитивний
 * перелік скінченний: нова вбудована нового мажора Postgres не стає
 * дозволеною, доки перелік не перегенерують і diff не переглянуть.
 *
 * Запуск над локальним стеком (`pnpm db:start`):
 *   pnpm --filter simetra builtin-functions
 * Адресу бази можна задати `SIMETRA_TEST_DATABASE_URL`. Дрейф версії Postgres
 * ловить DB-тест `test/db/builtin-functions.db.test.ts`.
 */
import { writeFileSync } from "node:fs"
import pg from "pg"
import { excludedBuiltin } from "../src/compiler/sql/builtin-exclusions.ts"

const OUTPUT = new URL(
  "../src/compiler/sql/builtin-functions.ts",
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
  // Колація — на стовпці: `ORDER BY 1 COLLATE "C"` застосував би її до літерала.
  const { rows } = await client.query<{ name: string }>(`
    SELECT proname AS name
    FROM pg_proc
    WHERE pronamespace = 'pg_catalog'::regnamespace AND oid < 16384
    GROUP BY proname
    ORDER BY proname COLLATE "C"
  `)
  const names = rows.map((row) => row.name).filter((n) => !excludedBuiltin(n))
  const text = `// Згенеровано \`pnpm --filter simetra builtin-functions\` над PostgreSQL ${version.rows[0]!.server_version}.
// Не правити вручну: генератор — packages/simetra/scripts/builtin-functions.ts,
// виключення — packages/simetra/src/compiler/sql/builtin-exclusions.ts.

/**
 * Імена вбудованих функцій \`pg_catalog\`, які може кликати SQL голови
 * (Р2c1-20): решта вбудованих — поза дозвільною межею.
 */
export const BUILTIN_FUNCTIONS: readonly string[] = [
${names.map((name) => `  ${JSON.stringify(name)},`).join("\n")}
]
`
  writeFileSync(OUTPUT, text)
  console.log(
    `${names.length} of ${rows.length} functions written to ${OUTPUT.pathname}`
  )
} finally {
  await client.end()
}
