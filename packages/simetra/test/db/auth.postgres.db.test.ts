// Реєстрація облікового запису на стеку `postgres` (`signUp`, рішення Р1 і
// Р16 плану ПГ-2b): вставка в таблицю Better Auth іде від ролі входу сервісу,
// як у проді, а стан викликача — і власника адреси тестів, і входу власника
// засіву під режимом обслуговування — повертається на обох шляхах. DB-рівень,
// бо `SESSION AUTHORIZATION`, `SET ROLE` і тригер на таблиці вирішує сервер.
import type pg from "pg"
import {
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_OWNER_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { maintenanceSql } from "../../src/compiler/rights/guard-units"
import { authLoginRole, signUp } from "./auth"
import {
  asSessionLogin,
  asStackSuperuser,
  setLocalSetting,
  withRollback,
} from "./connection"

const OWNER = PROVIDER_OWNER_ROLES.postgres
const { schema, name } = PROVIDER_IDENTITY_SOURCES.postgres.table
const TABLE = `${schema}."${name}"`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface Who {
  current: string
  session: string
  path: string
}

async function who(client: pg.Client): Promise<Who> {
  const { rows } = await client.query<Who>(
    "SELECT current_user AS current, session_user AS session, current_setting('search_path') AS path"
  )
  return rows[0]!
}

/**
 * Тригер на таблиці ідентичності в транзакції тесту: повідомляє
 * `current_user` вставки, яку бачить тригер провізії. Функція — у `pg_temp`:
 * відкат прибирає і її, і тригер.
 */
async function insertedAs(client: pg.Client): Promise<string[]> {
  await client.query(
    `CREATE FUNCTION pg_temp.signup_probe() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN RAISE NOTICE 'signup-probe %', current_user; RETURN NEW; END $$`
  )
  await client.query(
    `CREATE TRIGGER signup_probe AFTER INSERT ON ${TABLE}
       FOR EACH ROW EXECUTE FUNCTION pg_temp.signup_probe()`
  )
  const seen: string[] = []
  client.on("notice", (notice) => {
    const match = /^signup-probe (.+)$/.exec(notice.message ?? "")
    if (match !== null) seen.push(match[1]!)
  })
  return seen
}

describe("signUp on the postgres stack", () => {
  it("inserts as the auth login, so the provision trigger sees it, and returns a uuid", async () => {
    await withRollback(async (client) => {
      const seen = await insertedAs(client)
      const before = await who(client)
      const id = await signUp(client)
      expect(id).toMatch(UUID)
      expect(seen).toEqual([authLoginRole()])
      // DML-гранту власнику на `better_auth` немає: рядок читає суперкористувач
      const { rows } = await asStackSuperuser(client, () =>
        client.query(`SELECT id FROM ${TABLE} WHERE id = $1`, [id])
      )
      expect(rows).toHaveLength(1)
      expect(await who(client)).toEqual(before)
      expect(before.current).toBe(OWNER)
    })
  })

  it("restores the owner and search_path after a failed insert (duplicate email)", async () => {
    await withRollback(async (client) => {
      const email = "dup@example.test"
      await signUp(client, { email })
      await client.query("SET LOCAL search_path = public, pg_temp")
      const before = await who(client)
      await expect(signUp(client, { email })).rejects.toMatchObject({
        code: "23505",
      })
      expect(await who(client)).toEqual(before)
      expect(before).toMatchObject({
        current: OWNER,
        path: "public, pg_temp",
      })
    })
  })

  // Засів під режимом обслуговування (Р16): `signUp` усередині входу
  // власника повертає саме цей вхід, тож гард режиму далі його пропускає
  it.each(["success", "failure"] as const)(
    "inside asSessionLogin of the owner returns the owner login on %s, and the seed after it passes the maintenance guard",
    async (path) => {
      await withRollback(async (client) => {
        const email = "seed@example.test"
        if (path === "failure") await signUp(client, { email })
        await asSessionLogin(client, OWNER, async () => {
          await setLocalSetting(client, RIGHTS_MAINTENANCE_SETTING, "on")
          const signed = signUp(client, { email })
          if (path === "failure")
            await expect(signed).rejects.toMatchObject({ code: "23505" })
          else expect(await signed).toMatch(UUID)
          expect(await who(client)).toMatchObject({
            current: OWNER,
            session: OWNER,
          })
          const guard = await client.query(
            `SELECT ${maintenanceSql("postgres")} AS ok`
          )
          expect(guard.rows).toEqual([{ ok: true }])
        })
      })
    }
  )
})
