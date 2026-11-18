import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildRuntimeCatalog, compile } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  type MetadataRef,
  type RuntimeCatalog,
} from "simetra/model"
import { createCommandRuntime, fromPgPool, readRoleOf } from "simetra/server"
import {
  catalog,
  grant,
  objects,
  refAttribute,
  role,
  singleTenantRights,
  USERS_FILE,
} from "../../../simetra/src/compiler/__tests__/fixtures/rights"
import {
  ROLE_FILE,
  signUp,
  testProvider,
  uuid,
} from "../../../simetra/test/support"
import {
  heldResource,
  seedUnderMaintenance,
  sessionOf,
  withModelTarget,
  withRuntimeLogin,
} from "./support/db"

/**
 * Роль з обсягом `own` над об'єктом з носієм `owner` для користувачів Better
 * Auth через справжній рантайм (шаблон застосунку): `sub` сесії дає
 * `current_user_id()`, носій `owner` звужує читання до власних рядків. DB-рівень,
 * бо функцію сесії, RLS і гранти ролі читання вирішує сервер.
 */

const CLIENT: MetadataRef = { kind: "Catalog", name: "Client" }
const CLIENT_FILE = "catalogs/Client/Client.meta.json"
const CLIENT_OWNER_ID = uuid(7901)

/** `ownership` носія — параметр, щоб мутація «носій не звужує» була одним рядком. */
function ownRightsFiles(ownership: unknown[] = ["owner"]): Map<string, string> {
  return singleTenantRights(
    {
      [CLIENT_FILE]: catalog(uuid(7900), "Client", "client", {
        scope: "none",
        ownership,
        attributes: [
          refAttribute(7902, "owner", "owner_id", {
            kind: "Catalog",
            name: "Users",
          }),
        ],
      }),
      [ROLE_FILE("ClientOwner")]: role(
        CLIENT_OWNER_ID,
        "ClientOwner",
        "global",
        { grants: [grant(objects(["Catalog", "Client"]), ["read"], "own")] }
      ),
      [USERS_FILE]: {},
    },
    testProvider()
  )
}

interface Env {
  catalog: RuntimeCatalog
  pool: pg.Pool
  users: [string, string]
  /** Рядки `Client` кожного користувача: id → власник. */
  rows: Map<string, string>
}

const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const result = await compile(ownRightsFiles())
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    await withModelTarget(model, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        const users: string[] = []
        const rows = new Map<string, string>()
        await seedUnderMaintenance(owner, async () => {
          for (let i = 0; i < 2; i++) {
            const user = await signUp(owner)
            users.push(user)
            await owner.query(
              "INSERT INTO public.global_role_assignments (id, subject, archetype) VALUES ($1, $2, $3)",
              [randomUUID(), user, CLIENT_OWNER_ID]
            )
            // Два рядки кожному: «власні» — не один збіг
            for (let n = 0; n < 2; n++) {
              const id = randomUUID()
              rows.set(id, user)
              await owner.query(
                "INSERT INTO public.client (id, owner_id) VALUES ($1, $2)",
                [id, user]
              )
            }
          }
        })
        await withRuntimeLogin(
          url,
          [PLATFORM_ROLES.command, readRoleOf(testProvider())!],
          async (login) => {
            const pool = new pg.Pool({ connectionString: login })
            try {
              await use({
                catalog: buildRuntimeCatalog(model),
                pool,
                users: [users[0]!, users[1]!],
                rows,
              })
            } finally {
              await pool.end()
            }
          }
        )
      } finally {
        await owner.end()
      }
    })
  })

describe("own extent with an owner carrier and Better Auth subjects", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 120_000)
  afterAll(() => target.close(), 60_000)

  it("each user reads only the rows that carry their own id", async () => {
    const runtime = await createCommandRuntime({
      database: fromPgPool(env.pool),
      catalog: env.catalog,
    })
    const seen = async (user: string) =>
      (await runtime.read(sessionOf(user), { object: CLIENT, limit: 50 })).rows
        .map((r) => r.ref as string)
        .sort()
    const ownedBy = (user: string) =>
      [...env.rows]
        .filter(([, o]) => o === user)
        .map(([id]) => id)
        .sort()
    const [a, b] = env.users
    expect({ a: await seen(a), b: await seen(b) }).toEqual({
      a: ownedBy(a),
      b: ownedBy(b),
    })
    expect(ownedBy(a)).toHaveLength(2)
  })
})
