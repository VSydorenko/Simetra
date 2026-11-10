import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile } from "simetra/compiler"
import { PLATFORM_ROLES, PROVIDER_API_ROLES } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import { RAISE_SYNCHRONOUS_COMMIT_SQL } from "../../src/schema/apply/settings"
import { withRollback } from "./connection"

/**
 * Механіка рядка на справжньому Postgres (спека промоції §9.2): `version` і
 * `updated_at` тримає тригер, а не клієнт; версію видає послідовність
 * `simetra.row_version`, права на яку не має жодна роль. Під `postgres`: гранти таблиць
 * виду закривають DML ролям API, а механіці роль байдужа —
 * тригер спрацьовує в будь-якій ролі, що пише.
 */

async function deploy(client: pg.Client): Promise<void> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project(),
      "catalogs/Item/Item.meta.json": catalog("Item"),
    })
  )
  expect(result.diagnostics).toEqual([])
  await client.query(renderDesiredState(result.model!).sql)
}

interface Row {
  version: string
  touched: boolean
}

// `now()` у межах транзакції сталий, тож рівність з ним — це «дав тригер».
const ROW = "version, updated_at = now() AS touched"

const SEQUENCE = "simetra.row_version"

async function insertItem(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.item (id, description) VALUES (gen_random_uuid(), 'a') RETURNING id`
  )
  return rows[0]!.id
}

async function versionOf(client: pg.Client, id: string): Promise<bigint> {
  const { rows } = await client.query<{ version: string }>(
    "SELECT version FROM public.item WHERE id = $1",
    [id]
  )
  return BigInt(rows[0]!.version)
}

/** Код відмови Postgres у точці збереження: транзакція тесту лишається живою. */
async function failureCode(
  client: pg.Client,
  sql: string
): Promise<string | undefined> {
  await client.query("SAVEPOINT probe")
  try {
    await client.query(sql)
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT probe")
  }
}

describe("row mechanics in Postgres", () => {
  it("a client cannot write version or updated_at: the trigger does", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const inserted = await client.query<Row & { id: string }>(
        `INSERT INTO public.item (id, description) VALUES (gen_random_uuid(), 'a') RETURNING id, ${ROW}`
      )
      const id = inserted.rows[0]!.id
      expect(inserted.rows[0]!.touched).toBe(true)
      const v0 = BigInt(inserted.rows[0]!.version)

      const first = await client.query<Row>(
        `UPDATE public.item SET description = 'x', version = 100000000, updated_at = '2000-01-01' WHERE id = $1 RETURNING ${ROW}`,
        [id]
      )
      expect(first.rows[0]!.touched).toBe(true)
      const v1 = BigInt(first.rows[0]!.version)
      expect(v1).toBeGreaterThan(v0)

      const second = await client.query<Row>(
        `UPDATE public.item SET description = 'y' WHERE id = $1 RETURNING ${ROW}`,
        [id]
      )
      const v2 = BigInt(second.rows[0]!.version)
      expect(v2).toBeGreaterThan(v1)

      // Спроба скинути версію — та сама механіка: версія лише росте
      const reset = await client.query<Row>(
        `UPDATE public.item SET version = 0 WHERE id = $1 RETURNING ${ROW}`,
        [id]
      )
      expect(BigInt(reset.rows[0]!.version)).toBeGreaterThan(v2)
      expect(reset.rows[0]!.touched).toBe(true)
    })
  })

  it("an insert takes the sequence version whatever the client writes", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const inserted = await client.query<Row>(
        `INSERT INTO public.item (id, description, version, updated_at) VALUES (gen_random_uuid(), 'a', 999999999, '2000-01-01') RETURNING ${ROW}`
      )
      expect(inserted.rows[0]!.touched).toBe(true)
      expect(BigInt(inserted.rows[0]!.version)).toBeLessThan(999999999n)
    })
  })

  it("a deleted and re-created key gets a version above every one seen", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const id = await insertItem(client)
      await client.query(
        "UPDATE public.item SET description = 'x' WHERE id = $1",
        [id]
      )
      const seen = await versionOf(client, id)
      await client.query("DELETE FROM public.item WHERE id = $1", [id])
      const { rows } = await client.query<{ version: string }>(
        "INSERT INTO public.item (id, description) VALUES ($1, 'again') RETURNING version",
        [id]
      )
      expect(BigInt(rows[0]!.version)).toBeGreaterThan(seen)
    })
  })

  it("an update below the row version gives OLD.version + 1", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const id = await insertItem(client)
      // Версія рядка тут — з послідовності; піднімаємо рядок поза тригером
      await client.query("ALTER TABLE public.item DISABLE TRIGGER USER")
      await client.query(
        "UPDATE public.item SET version = 1000000 WHERE id = $1",
        [id]
      )
      await client.query("ALTER TABLE public.item ENABLE TRIGGER USER")
      await client.query("SELECT setval($1, 5)", [SEQUENCE])
      const { rows } = await client.query<{ version: string }>(
        "UPDATE public.item SET description = 'z' WHERE id = $1 RETURNING version",
        [id]
      )
      expect(rows[0]!.version).toBe("1000001")
    })
  })

  it("the issued version stays in the transaction setting of the table", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const id = await insertItem(client)
      const { rows } = await client.query<{ setting: string; oid: string }>(
        `SELECT current_setting('simetra.row_version_' || 'public.item'::regclass::oid::text) AS setting`
      )
      expect(BigInt(rows[0]!.setting)).toBe(await versionOf(client, id))
    })
  })

  const WRITERS = [
    ["the command role", PLATFORM_ROLES.command],
    ["the API user role", PROVIDER_API_ROLES.supabase.user],
  ] as const

  it.each(WRITERS)(
    "%s writes through the trigger without any right on the sequence",
    async (_label, role) => {
      await withRollback(async (client) => {
        await deploy(client)
        // Права на таблицю дає вид; тут перевіряється лише послідовність, тож
        // таблицю відкриваємо вручну, а RLS обходить власник таблиці.
        await client.query(
          "ALTER TABLE public.item NO FORCE ROW LEVEL SECURITY"
        )
        await client.query("ALTER TABLE public.item DISABLE ROW LEVEL SECURITY")
        await client.query(
          `GRANT SELECT, INSERT, UPDATE ON public.item TO ${role}`
        )
        // USAGE на схему дано, щоб 42501 нижче виходив з ACL послідовності,
        // а не з відсутності права на схему `simetra`.
        await client.query(`GRANT USAGE ON SCHEMA simetra TO ${role}`)
        await client.query(`GRANT ${role} TO CURRENT_USER WITH SET TRUE`)
        await client.query(`SET LOCAL ROLE ${role}`)
        const { rows } = await client.query<{ id: string; version: string }>(
          "INSERT INTO public.item (id, description) VALUES (gen_random_uuid(), 'a') RETURNING id, version"
        )
        const updated = await client.query<{ version: string }>(
          "UPDATE public.item SET description = 'b' WHERE id = $1 RETURNING version",
          [rows[0]!.id]
        )
        expect(BigInt(updated.rows[0]!.version)).toBeGreaterThan(
          BigInt(rows[0]!.version)
        )
        // Пряма видача версії ролі заборонена: 42501
        expect(await failureCode(client, `SELECT nextval('${SEQUENCE}')`)).toBe(
          "42501"
        )
        await client.query("RESET ROLE")
        // USAGE — nextval/currval, SELECT — currval, UPDATE — setval
        for (const privilege of ["USAGE", "SELECT", "UPDATE"]) {
          const { rows: has } = await client.query<{ has: boolean }>(
            "SELECT has_sequence_privilege($1, $2, $3) AS has",
            [role, SEQUENCE, privilege]
          )
          expect(has[0]!.has, privilege).toBe(false)
        }
      })
    }
  )
})

// Правило підвищення синхронного коміту раннера те саме, що в `touch`: лише
// з `off` і `local`; сильніші значення не знижуються
// `touch` підвищує синхронний коміт на кожному записі — і вставці, і
// оновленні: інакше асинхронний коміт губив би видані версії після збою
describe("touch synchronous commit raise", () => {
  it.each([
    ["off", "on"],
    ["local", "on"],
    ["remote_apply", "remote_apply"],
  ])("%s becomes %s on insert and on update", async (from, to) => {
    await withRollback(async (client) => {
      await deploy(client)
      const setting = async () =>
        (
          await client.query<{ v: string }>(
            "SELECT current_setting('synchronous_commit') AS v"
          )
        ).rows[0]!.v
      await client.query(`SET LOCAL synchronous_commit = ${from}`)
      const id = await insertItem(client)
      expect(await setting()).toBe(to)
      await client.query(`SET LOCAL synchronous_commit = ${from}`)
      await client.query(
        "UPDATE public.item SET description = 'b' WHERE id = $1",
        [id]
      )
      expect(await setting()).toBe(to)
    })
  })
})

describe("runner synchronous commit raise", () => {
  it.each([
    ["off", "on"],
    ["local", "on"],
    ["on", "on"],
    ["remote_write", "remote_write"],
    ["remote_apply", "remote_apply"],
  ])("%s becomes %s", async (from, to) => {
    await withRollback(async (client) => {
      await client.query(`SET LOCAL synchronous_commit = ${from}`)
      await client.query(RAISE_SYNCHRONOUS_COMMIT_SQL)
      const { rows } = await client.query<{ v: string }>(
        "SELECT current_setting('synchronous_commit') AS v"
      )
      expect(rows[0]!.v).toBe(to)
    })
  })
})
