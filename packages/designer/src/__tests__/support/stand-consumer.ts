import { randomBytes } from "node:crypto"
import { expect } from "vitest"
import { quoteIdent } from "simetra/model"
import {
  loginUrl,
  superuserClient,
  testRoleName,
} from "../../../../simetra/test/support"
import { grantStandConsumer } from "../../../../simetra/test/db/signal-stand"
import { loginSettingSql } from "../../../../simetra/src/schema/apply/platform-roles"
import { heldResource } from "./db"

/**
 * Роль входу споживача прогону тієї самої форми, що `simetra_signals`, над
 * групою з грантами outbox з генератора (`grantStandConsumer`); тримає DSN
 * входу. `label` розводить імена ролей двох наборів кейсів. Гранти й
 * політики групи — у базі цілі, тож прибираються разом із ролями.
 */
export const heldStandConsumer = (url: () => string, label: string) =>
  heldResource<string>(async (use) => {
    const group = testRoleName(`${label}_grp`)
    const name = testRoleName(`${label}_signals`)
    const password = randomBytes(12).toString("hex")
    const database = decodeURIComponent(new URL(url()).pathname.slice(1))
    const su = await superuserClient(database)
    let created = 0
    try {
      await su.query(`CREATE ROLE ${quoteIdent(group)} NOLOGIN NOINHERIT`)
      created = 1
      await su.query(
        `CREATE ROLE ${quoteIdent(name)} LOGIN NOINHERIT PASSWORD '${password}'`
      )
      created = 2
      await su.query(
        `GRANT ${quoteIdent(group)} TO ${quoteIdent(name)} WITH INHERIT FALSE, SET TRUE`
      )
      await su.query(
        `GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO ${quoteIdent(name)}`
      )
      for (const sql of loginSettingSql({
        name,
        memberOf: [],
        settings: { role: group },
      }))
        await su.query(sql)
      expect(await grantStandConsumer(su, group)).toBeGreaterThanOrEqual(5)
      await use(loginUrl(url(), name, password))
    } finally {
      try {
        await su.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1",
          [name]
        )
        // Гранти й політики групи — у базі цілі: без них роль видаляється
        if (created >= 1) await su.query(`DROP OWNED BY ${quoteIdent(group)}`)
        if (created >= 2) {
          await su.query(
            `REVOKE CONNECT ON DATABASE ${quoteIdent(database)} FROM ${quoteIdent(name)}`
          )
          await su.query(`DROP ROLE IF EXISTS ${quoteIdent(name)}`)
        }
        if (created >= 1)
          await su.query(`DROP ROLE IF EXISTS ${quoteIdent(group)}`)
      } finally {
        await su.end()
      }
    }
  })
