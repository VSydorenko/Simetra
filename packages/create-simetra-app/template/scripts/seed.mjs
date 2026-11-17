// Дані розробника: `Country` і `Client` у заданій кількості (Д-9; типово 250 —
// дві повні сторінки по 100 і неповна). Пише від `simetra_owner` напряму в
// таблиці виду, повз рантайм: сід — інструмент бази розробника, а не команда.
// Запуск: `node scripts/seed.mjs [кількість] [owner-uuid]`; без власника рядки
// `Client` без `owner`, і роль з обсягом `own` їх не бачить.
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import pg from "pg"

/** Рядки `Country` і `Client`; `code` — унікальний `varchar(9)`. */
export async function seed(client, { count, owner }) {
  const countries = []
  for (let i = 0; i < count; i++) {
    const id = randomUUID()
    countries.push(id)
    await client.query(
      "INSERT INTO app.country (id, code, description) VALUES ($1, $2, $3)",
      [id, `K${String(i).padStart(8, "0")}`, `Country ${i}`]
    )
  }
  for (let i = 0; i < count; i++)
    await client.query(
      "INSERT INTO app.client (id, code, description, country_id, owner_id) VALUES ($1, $2, $3, $4, $5)",
      [
        randomUUID(),
        `C${String(i).padStart(8, "0")}`,
        `Client ${i}`,
        countries[i % countries.length],
        owner ?? null,
      ]
    )
}

function invokedAsCommand() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return (
      realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

if (invokedAsCommand()) {
  const count = Number(process.argv[2] ?? 250)
  const owner = process.argv[3]
  const dsn = process.env.SIMETRA_OWNER_DATABASE_URL
  if (!Number.isInteger(count) || count < 1) {
    console.error("seed: the count must be a positive integer")
    process.exit(1)
  }
  if (dsn === undefined || dsn === "") {
    console.error("seed: SIMETRA_OWNER_DATABASE_URL is not set")
    process.exit(1)
  }
  const client = new pg.Client({ connectionString: dsn })
  await client.connect()
  try {
    await client.query("BEGIN")
    await seed(client, { count, owner })
    await client.query("COMMIT")
    console.log(`seeded ${count} Country and ${count} Client rows`)
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {})
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  } finally {
    await client.end()
  }
}
