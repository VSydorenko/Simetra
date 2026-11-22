/**
 * Генерує дозвільний перелік вбудованих функцій для судження голів (спека прав §5.3):
 * імена `pg_catalog` з initdb без класів `BUILTIN_EXCLUSIONS`. Позитивний
 * перелік скінченний: нова вбудована нового мажора Postgres не стає
 * дозволеною, доки перелік не перегенерують і diff не переглянуть.
 *
 * Запуск над локальним стеком (`pnpm db:start`):
 *   pnpm --filter simetra builtin-functions
 * Адресу бази можна задати `SIMETRA_TEST_DATABASE_URL`. Дрейф версії Postgres
 * ловить DB-тест `test/db/builtin-functions.db.test.ts`.
 *
 * Тим самим запуском пише перелік імен типів `pg_catalog`
 * (`pg-catalog-types.ts`): тимчасова таблиця тіла з таким ім'ям затіняла б
 * тип до кінця транзакції (спека прав §6.1).
 */
import { writeFileSync } from "node:fs"
import pg from "pg"
import {
  REGCLASS_PARAMETER_QUERY,
  excludedBuiltin,
} from "../src/compiler/sql/builtin-exclusions.ts"

const OUTPUT = new URL(
  "../src/compiler/sql/builtin-functions.ts",
  import.meta.url
)
const TYPES_OUTPUT = new URL(
  "../src/compiler/sql/pg-catalog-types.ts",
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
  // Клас «аргумент `regclass`» виводиться з каталогу, а не перелічується.
  const derived = await client.query<{ name: string }>(
    `${REGCLASS_PARAMETER_QUERY} ORDER BY proname COLLATE "C"`
  )
  const regclass = derived.rows.map((row) => row.name)
  const regclassSet = new Set(regclass)
  const names = rows
    .map((row) => row.name)
    .filter((n) => !excludedBuiltin(n, regclassSet))
  const text = `// Згенеровано \`pnpm --filter simetra builtin-functions\` над PostgreSQL ${version.rows[0]!.server_version}.
// Не правити вручну: генератор — packages/simetra/scripts/builtin-functions.ts,
// виключення — packages/simetra/src/compiler/sql/builtin-exclusions.ts.

/**
 * Імена вбудованих функцій \`pg_catalog\`, які може кликати SQL голови
 * (спека прав §5.3): решта вбудованих — поза дозвільною межею.
 */
export const BUILTIN_FUNCTIONS: readonly string[] = [
${names.map((name) => `  ${JSON.stringify(name)},`).join("\n")}
]

/**
 * Імена вбудованих з аргументом \`regclass\` — клас виключень, який генератор
 * виводить із каталогу (\`REGCLASS_PARAMETER_QUERY\`), а не перелічує рука.
 */
export const REGCLASS_BUILTINS: readonly string[] = [
${regclass.map((name) => `  ${JSON.stringify(name)},`).join("\n")}
]
`
  writeFileSync(OUTPUT, text)
  console.log(
    `${names.length} of ${rows.length} functions written to ${OUTPUT.pathname}`
  )
  // Усі типи схеми, не лише initdb: тип розширення в `pg_catalog` затіняється так само.
  const types = await client.query<{ name: string }>(`
    SELECT typname AS name
    FROM pg_type
    WHERE typnamespace = 'pg_catalog'::regnamespace
    ORDER BY typname COLLATE "C"
  `)
  writeFileSync(
    TYPES_OUTPUT,
    `// Згенеровано \`pnpm --filter simetra builtin-functions\` над PostgreSQL ${version.rows[0]!.server_version}.
// Не правити вручну: генератор — packages/simetra/scripts/builtin-functions.ts.

/**
 * Імена типів схеми \`pg_catalog\`. Тимчасова таблиця тіла функції з таким
 * ім'ям створює однойменний тип у \`pg_temp\`, який Postgres шукає раніше за
 * \`pg_catalog\`, тож до кінця транзакції він затіняв би вбудований тип
 * (спека прав §6.1).
 */
export const PG_CATALOG_TYPES: readonly string[] = [
${types.rows.map((row) => `  ${JSON.stringify(row.name)},`).join("\n")}
]
`
  )
  console.log(`${types.rows.length} types written to ${TYPES_OUTPUT.pathname}`)
} finally {
  await client.end()
}
