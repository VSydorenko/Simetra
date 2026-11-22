import pg from "pg"
import { describe, expect, it } from "vitest"
import { buildRuntimeCatalog } from "simetra/compiler"
import { CommandFailure, PLATFORM_ROLES } from "simetra/model"
import { createCommandRuntime, fromPgPool, readRoleOf } from "simetra/server"
import {
  restoreOwnerRole,
  superuserClient,
  testProvider,
} from "../../../simetra/test/support"
import {
  applyOn,
  planOn,
  seedMarker,
  seedRuntimeActor,
  sessionOf,
  withModelTarget,
  withRuntimeLogin,
} from "./support/db"
import {
  ATTACHMENT_WRITER_ID,
  bareModel,
  blobLayer,
  storageModel,
} from "./storage-sql.support"

/**
 * Прив'язка бази до бакета (Р12 ПГ-5, І21) і членство рантайму в ролі
 * сховища (Р17, І20) на справжньому Postgres: що переживає видалення об'єкта й
 * повторне застосування, які плани відмовляє база з живою таблицею, і чи
 * стартує рантайм без ролі `simetra_files`.
 */

const ATTACHMENT = { kind: "Catalog" as const, name: "Attachment" }

const database = (url: string) => new URL(url).pathname.slice(1)

const uuidOf = (binding: string) => binding.split(":")[0]

/** Відбиток прив'язки (`uuid:sysid:oid:timeline`) від ролі сховища: рядок створює `storage_instance_ensure()` (так робить рантайм при старті) і комітить. */
async function instanceId(client: pg.Client): Promise<string> {
  await client.query("BEGIN")
  try {
    await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.files}`)
    await client.query("SELECT simetra.storage_instance_ensure()")
    const { rows } = await client.query<{ id: string }>(
      "SELECT simetra.storage_instance_id() AS id"
    )
    await restoreOwnerRole(client)
    await client.query("COMMIT")
    return rows[0]!.id
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  }
}

describe("І21: the binding of the database to the bucket", () => {
  it("the marker survives the removal of the last object with storage and a re-apply", async () => {
    const withBlob = await bareModel(blobLayer(true))
    const without = await bareModel()
    await withModelTarget(withBlob, async (url) => {
      const client = await superuserClient(database(url))
      try {
        const first = await instanceId(client)
        expect(await instanceId(client)).toBe(first)
        // Об'єкт зі `storage` зник разом з таблицею: функції сховища й таблиці
        // обліку пішли, прив'язка лишилась
        expect((await applyOn(url, without)).status).toBe("committed")
        const gone = await client.query(
          "SELECT to_regprocedure('simetra.storage_instance_id()') AS fn, to_regclass('simetra.storage_usage') AS usage"
        )
        expect(gone.rows).toEqual([{ fn: null, usage: null }])
        const kept = await client.query<{ id: string }>(
          "SELECT id FROM simetra.storage_instance"
        )
        expect(kept.rows).toEqual([{ id: uuidOf(first) }])
        // Повторне застосування: той самий uuid
        expect((await applyOn(url, withBlob)).status).toBe("committed")
        expect(await instanceId(client)).toBe(first)
        // Те саме застосування ще раз — плану немає, прив'язка та сама
        expect((await planOn(url, withBlob)).status).toBe("unchanged")
        expect(await instanceId(client)).toBe(first)
      } finally {
        await client.end()
      }
    })
  })

  it("removing storage from an object with a live table is plan.storage-removed", async () => {
    await withModelTarget(await bareModel(blobLayer(true)), async (url) => {
      const outcome = await planOn(url, await bareModel(blobLayer(false)))
      expect(outcome.status).toBe("refused")
      expect(outcome.diagnostics.filter((d) => d.severity === "error")).toEqual(
        [
          expect.objectContaining({
            code: "plan.storage-removed",
            params: { table: "public.blob" },
          }),
        ]
      )
    })
  })

  it("adding storage to an object with a live table is plan.storage-added", async () => {
    await withModelTarget(await bareModel(blobLayer(false)), async (url) => {
      const outcome = await planOn(url, await bareModel(blobLayer(true)))
      expect(outcome.status).toBe("refused")
      expect(outcome.diagnostics.filter((d) => d.severity === "error")).toEqual(
        [
          expect.objectContaining({
            code: "plan.storage-added",
            params: { table: "public.blob" },
          }),
        ]
      )
    })
  })
})

describe("the marker row is created by the runtime at start", () => {
  it("two runtimes starting at once leave one row and read the same fingerprint", async () => {
    const model = await storageModel()
    await withModelTarget(model, async (url) => {
      const owner = await superuserClient(database(url))
      try {
        await seedMarker(owner, model.hash)
        const writer = await seedRuntimeActor(owner, [ATTACHMENT_WRITER_ID])
        expect(
          (await owner.query("SELECT 1 FROM simetra.storage_instance")).rows
        ).toEqual([])
        const roles = [PLATFORM_ROLES.command, readRoleOf(testProvider())!]
        await withRuntimeLogin(url, roles, async (login) => {
          const pools = [1, 2].map(
            () => new pg.Pool({ connectionString: login })
          )
          try {
            const runtimes = await Promise.all(
              pools.map((pool) =>
                createCommandRuntime({
                  database: fromPgPool(pool),
                  catalog: buildRuntimeCatalog(model),
                  log: () => undefined,
                })
              )
            )
            const rows = await owner.query(
              "SELECT 1 FROM simetra.storage_instance"
            )
            expect(rows.rowCount).toBe(1)
            const seen = await Promise.all(
              runtimes.map((rt) =>
                rt.checkUpload(sessionOf(writer.user), {
                  object: ATTACHMENT,
                  scope: writer.org,
                })
              )
            )
            expect(seen[0]?.instance).toBeDefined()
            expect(seen[0]?.instance).toBe(seen[1]?.instance)
          } finally {
            await Promise.all(pools.map((pool) => pool.end()))
          }
        })
      } finally {
        await owner.end()
      }
    })
  })
})

describe("І20: the runtime starts only with the membership of simetra_files", () => {
  it("a login role without it is refused at the creation of the runtime, one with it passes", async () => {
    const model = await storageModel()
    await withModelTarget(model, async (url) => {
      const owner = await superuserClient(database(url))
      try {
        await seedMarker(owner, model.hash)
      } finally {
        await owner.end()
      }
      const roles = [PLATFORM_ROLES.command, readRoleOf(testProvider())!]
      const start = (login: string) => {
        const pool = new pg.Pool({ connectionString: login })
        return createCommandRuntime({
          database: fromPgPool(pool),
          catalog: buildRuntimeCatalog(model),
          log: () => undefined,
        }).finally(() => pool.end())
      }
      let failure: unknown
      await withRuntimeLogin(
        url,
        roles,
        async (login) => {
          await start(login).catch((error: unknown) => (failure = error))
        },
        "nofiles",
        { withoutFiles: true }
      )
      expect(failure).toBeInstanceOf(CommandFailure)
      expect((failure as CommandFailure).error).toEqual({
        code: "command.read-role-missing",
        role: PLATFORM_ROLES.files,
      })
      await withRuntimeLogin(url, roles, async (login) => {
        await expect(start(login)).resolves.toBeDefined()
      })
    })
  })
})
