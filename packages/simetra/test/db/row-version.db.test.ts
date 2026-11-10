import { describe, expect, it } from "vitest"
import type pg from "pg"
import { compile } from "simetra/compiler"
import { PLATFORM_ROLES, PROVIDER_API_ROLES } from "simetra/model"
import { renderApplyState, renderDesiredState } from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import { testRoleName, withRollback } from "./connection"
import { testProvider } from "./profile"

/**
 * Епоха версій бази й скидання після відновлення даних (спека П4-B §4.1).
 * Чому DB: `pg_control_*`, WAL і привілеї виконує сам Postgres. Розгортання —
 * `renderDesiredState` + `renderApplyState`, без двигуна.
 */

const SEQUENCE = "simetra.row_version"
const EPOCH = "SELECT simetra.row_version_epoch() AS epoch"
const RESET = "SELECT simetra.reset_row_version_epoch()"
const provider = testProvider()
const api = PROVIDER_API_ROLES[provider]

async function deploy(client: pg.Client): Promise<void> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({ database: { provider } }),
      "catalogs/Item/Item.meta.json": catalog("Item"),
    })
  )
  expect(result.diagnostics).toEqual([])
  const model = result.model!
  await client.query(renderDesiredState(model).sql)
  await client.query(renderApplyState(model))
}

const epochOf = async (client: pg.Client): Promise<string | null> =>
  (await client.query<{ epoch: string | null }>(EPOCH)).rows[0]!.epoch

const nextValue = async (client: pg.Client): Promise<bigint> =>
  BigInt(
    (await client.query<{ n: string }>(`SELECT nextval('${SEQUENCE}') AS n`))
      .rows[0]!.n
  )

const maxVersion = async (client: pg.Client): Promise<bigint> =>
  BigInt(
    (
      await client.query<{ v: string }>(
        "SELECT coalesce(max(version), 0) AS v FROM public.item"
      )
    ).rows[0]!.v
  )

async function insertItems(client: pg.Client, count: number): Promise<void> {
  for (let i = 0; i < count; i++)
    await client.query(
      "INSERT INTO public.item (id, description) VALUES (gen_random_uuid(), 'a')"
    )
}

/** Код відмови Postgres у точці збереження: транзакція тесту лишається живою. */
async function failureCode(
  client: pg.Client,
  role: string,
  sql: string
): Promise<string | undefined> {
  await client.query("SAVEPOINT probe")
  try {
    await client.query(`SET LOCAL ROLE ${role}`)
    await client.query(sql)
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT probe")
  }
}

/** `SET ROLE` доступний лише тій, чия роль входу є учасником цільової. */
const letSetRole = (client: pg.Client, role: string) =>
  client.query(`GRANT ${role} TO CURRENT_USER WITH SET TRUE`)

const READERS: readonly [string, string | undefined][] = [
  ["the command role", PLATFORM_ROLES.command],
  ["the API user role", api.user],
  ["the API anonymous role", api.anonymous],
]

describe("epoch of row versions in Postgres", () => {
  it("is NULL until the epoch row is written", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      expect(await epochOf(client)).toBeNull()
    })
  })

  it("is a 64-character hex hash once the row exists, and stable between calls", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      await client.query("INSERT INTO simetra.version_epoch DEFAULT VALUES")
      const epoch = await epochOf(client)
      expect(epoch).toMatch(/^[0-9a-f]{64}$/)
      expect(await epochOf(client)).toBe(epoch)
    })
  })

  it("changes with the UUID of the epoch row", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      await client.query("INSERT INTO simetra.version_epoch DEFAULT VALUES")
      const before = await epochOf(client)
      await client.query(
        "UPDATE simetra.version_epoch SET epoch = gen_random_uuid()"
      )
      expect(await epochOf(client)).not.toBe(before)
    })
  })

  // Роль, якої в провайдера немає, не має чого читати: кейс пропускається
  for (const [label, role] of READERS)
    it.skipIf(role === undefined)(`${label} can read it`, async () => {
      await withRollback(async (client) => {
        await deploy(client)
        await client.query("INSERT INTO simetra.version_epoch DEFAULT VALUES")
        const expected = await epochOf(client)
        await letSetRole(client, role!)
        await client.query(`SET LOCAL ROLE ${role}`)
        expect(await epochOf(client)).toBe(expected)
      })
    })

  it("a role without the grant gets 42501", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      const role = testRoleName("noepoch")
      await client.query(`CREATE ROLE ${role}`)
      // USAGE на схему дано, щоб 42501 виходив з ACL функції, а не схеми
      await client.query(`GRANT USAGE ON SCHEMA simetra TO ${role}`)
      await letSetRole(client, role)
      expect(await failureCode(client, role, EPOCH)).toBe("42501")
      // Роль створено в транзакції тесту: відкат прибирає її на будь-якому шляху
    })
  })
})

describe("reset_row_version_epoch in Postgres", () => {
  it("after a data-only restore the epoch is unchanged until the reset", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      await client.query("INSERT INTO simetra.version_epoch DEFAULT VALUES")
      await insertItems(client, 3)
      const epoch = await epochOf(client)
      // Дамп даних повертає рядки з версіями й `setval`, а UUID епохи й OID
      // лишаються: відкочуємо послідовність нижче за версії рядків
      await client.query("ALTER TABLE public.item DISABLE TRIGGER USER")
      await client.query("UPDATE public.item SET version = 1000")
      await client.query("ALTER TABLE public.item ENABLE TRIGGER USER")
      await client.query(`SELECT setval('${SEQUENCE}', 1, false)`)
      expect(await epochOf(client)).toBe(epoch)
      expect(await nextValue(client)).toBeLessThanOrEqual(1000n)
      await client.query(`SELECT setval('${SEQUENCE}', 1, false)`)
    })
  })

  it("changes the epoch and seeds the sequence above the largest row version", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      await client.query("INSERT INTO simetra.version_epoch DEFAULT VALUES")
      await insertItems(client, 3)
      const epoch = await epochOf(client)
      await client.query("ALTER TABLE public.item DISABLE TRIGGER USER")
      await client.query("UPDATE public.item SET version = 1000")
      await client.query("ALTER TABLE public.item ENABLE TRIGGER USER")
      await client.query(`SELECT setval('${SEQUENCE}', 1, false)`)

      await client.query(RESET)

      const after = await epochOf(client)
      expect(after).toMatch(/^[0-9a-f]{64}$/)
      expect(after).not.toBe(epoch)
      expect(await nextValue(client)).toBeGreaterThan(await maxVersion(client))
    })
  })

  it("never lowers the sequence when it is already above every row version", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      await insertItems(client, 2)
      await client.query(`SELECT setval('${SEQUENCE}', 5000, true)`)
      await client.query(RESET)
      expect(await nextValue(client)).toBe(5001n)
    })
  })

  it("keeps the sequence when it is exactly one above the largest version", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      await insertItems(client, 2)
      const max = await maxVersion(client)
      await client.query(`SELECT setval('${SEQUENCE}', $1, true)`, [
        max.toString(),
      ])
      await client.query(RESET)
      expect(await nextValue(client)).toBe(max + 1n)
    })
  })

  it("writes the epoch row when there is none, and a second call draws another epoch", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      expect(await epochOf(client)).toBeNull()
      await client.query(RESET)
      const first = await epochOf(client)
      expect(first).toMatch(/^[0-9a-f]{64}$/)
      await client.query(RESET)
      expect(await epochOf(client)).not.toBe(first)
    })
  })

  it("seeds a database whose mechanics tables are all empty without touching the sequence", async () => {
    await withRollback(async (client) => {
      await deploy(client)
      await client.query(`SELECT setval('${SEQUENCE}', 40, true)`)
      await client.query(RESET)
      expect(await nextValue(client)).toBe(41n)
    })
  })

  // Ручний виклик пише послідовність і UUID епохи: асинхронний коміт губив би
  // їх після збою, тож правило те саме, що в раннера й `touch`
  it.each([
    ["off", "on"],
    ["local", "on"],
    ["on", "on"],
    ["remote_write", "remote_write"],
    ["remote_apply", "remote_apply"],
  ])("raises synchronous_commit %s to %s", async (from, to) => {
    await withRollback(async (client) => {
      await deploy(client)
      await client.query(`SET LOCAL synchronous_commit = ${from}`)
      await client.query(RESET)
      const { rows } = await client.query<{ v: string }>(
        "SELECT current_setting('synchronous_commit') AS v"
      )
      expect(rows[0]!.v).toBe(to)
    })
  })

  for (const [label, role] of READERS)
    it.skipIf(role === undefined)(`${label} cannot run it: 42501`, async () => {
      await withRollback(async (client) => {
        await deploy(client)
        await letSetRole(client, role!)
        expect(await failureCode(client, role!, RESET)).toBe("42501")
      })
    })
})
