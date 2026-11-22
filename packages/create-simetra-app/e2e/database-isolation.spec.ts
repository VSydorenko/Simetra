// База застосунку не відкрита через `PUBLIC`: роль іншого застосунку на
// спільному стеку до неї не підключається (#306). Позитивний контроль — логін
// рантайму, якому `prepareDatabase` дає `CONNECT` явно.
import { randomBytes } from "node:crypto"
import pg from "pg"
import {
  runObjectPatterns,
  runTag,
  testRoleName,
} from "../../simetra/test/db/connection"
import { withDatabase } from "../scripts/lib/app-database.mts"
import { test, expect } from "./fixtures"

test("a login of another application does not connect to the application database", async ({
  app,
}) => {
  const role = testRoleName("other")
  if (!runObjectPatterns(runTag()).roles.test(role))
    throw new Error(`Refusing to create the role "${role}": not tagged`)
  // Пароль лише в пам'яті; літерал без лапок, бо `CREATE ROLE` не бере параметрів
  const password = randomBytes(16).toString("hex")
  await app.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`)
  try {
    const url = new URL(app.adminUrl)
    url.username = role
    url.password = password
    const client = new pg.Client({ connectionString: url.toString() })
    try {
      await expect(client.connect()).rejects.toMatchObject({ code: "42501" })
    } finally {
      // І коли мутація пустила роль: сесія не лишається відкритою
      await client.end().catch(() => undefined)
    }

    // Контроль: логін рантайму входить у ту саму базу
    const runtime = new pg.Client({
      connectionString: withDatabase(
        app.serverEnv.SIMETRA_RUNTIME_DATABASE_URL!,
        new URL(app.adminUrl).pathname.slice(1)
      ),
    })
    await runtime.connect()
    await runtime.end()
  } finally {
    await app.query(`DROP ROLE IF EXISTS "${role}"`)
  }
})
