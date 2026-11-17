import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildRuntimeCatalog, compile } from "simetra/compiler"
import {
  CommandFailure,
  PLATFORM_ROLES,
  PROVIDER_IDENTITY_SOURCES,
  type MetadataRef,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import {
  createCommandRuntime,
  fromPgPool,
  readRoleOf,
  type CommandDatabase,
  type CommandRuntime,
} from "simetra/server"
import {
  policyDomain,
  profileLayer,
  readQueryLayer,
  testProvider,
  uuid,
  type Layer,
} from "../../../simetra/test/support"
import {
  commandRefusal,
  heldResource,
  seedMarker,
  seedRuntimeActor,
  sessionOf,
  withModelTarget,
  withRuntimeLogin,
} from "./support/db"

/**
 * Роль читання за claim аноніма над справжньою базою профілю: які рядки
 * бачить роль гостя, а які — роль користувача, вирішують гранти й політики
 * `publicRead` у Postgres, а порт-фейк unit-тестів T3 цього не доводить.
 * Спільне тіло кейсів; файл профілю дає лише claims запиту без сесії.
 */

const OPEN: MetadataRef = { kind: "Catalog", name: "OpenNotice" }
const MEMBERS: MetadataRef = { kind: "Catalog", name: "MemberNotice" }
const OPEN_TABLE = "open_notice"
const MEMBERS_TABLE = "member_notice"

/** Два довідники без скоупу: читання гостя й читання лише користувача. */
function noticeLayer(): Layer {
  const notice = (
    n: number,
    name: string,
    physicalName: string,
    publicRead: string
  ) => ({
    id: uuid(n),
    kind: "Catalog",
    name,
    physicalName,
    kindLabel: physicalName,
    scope: "none",
    publicRead,
  })
  return {
    "catalogs/OpenNotice/OpenNotice.meta.json": notice(
      9601,
      "OpenNotice",
      OPEN_TABLE,
      "anon"
    ),
    "catalogs/MemberNotice/MemberNotice.meta.json": notice(
      9602,
      "MemberNotice",
      MEMBERS_TABLE,
      "authenticated"
    ),
  }
}

interface Env {
  catalog: RuntimeCatalog
  pool: pg.Pool
  user: string
  open: string
  members: string
}

const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const result = await compile(
      policyDomain(readQueryLayer(), profileLayer(), noticeLayer())
    )
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    await withModelTarget(model, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
        const { user } = await seedRuntimeActor(owner)
        // Рядки пише власник таблиць: RLS його не обмежує.
        const open = randomUUID()
        const members = randomUUID()
        await owner.query(`INSERT INTO public.${OPEN_TABLE} (id) VALUES ($1)`, [
          open,
        ])
        await owner.query(
          `INSERT INTO public.${MEMBERS_TABLE} (id) VALUES ($1)`,
          [members]
        )
        await withRuntimeLogin(
          url,
          [PLATFORM_ROLES.command, readRoleOf(testProvider())!],
          async (login) => {
            const pool = new pg.Pool({ connectionString: login })
            try {
              await use({
                catalog: buildRuntimeCatalog(model),
                pool,
                user,
                open,
                members,
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

/**
 * Кейси читання гостя для профілю прогону. `noSubject` — claims справжнього
 * запиту без сесії в цьому профілі.
 */
export function describeAnonymousRead(noSubject: Record<string, unknown>) {
  describe("anonymous read over the engine target", () => {
    const target = heldEnv()
    let env: Env

    beforeAll(async () => {
      env = await target.open()
    }, 120_000)
    afterAll(() => target.close(), 60_000)

    // Порт, що лічить з'єднання: відмова «до будь-якого запиту в базу» —
    // жодного з'єднання після створення рантайму.
    async function counted(): Promise<{
      runtime: CommandRuntime
      connects: () => number
    }> {
      const base = fromPgPool(env.pool)
      let connects = 0
      const database: CommandDatabase = {
        connect: () => {
          connects++
          return base.connect()
        },
      }
      const runtime = await createCommandRuntime({
        database,
        catalog: env.catalog,
      })
      const created = connects
      return { runtime, connects: () => connects - created }
    }

    const claim = PROVIDER_IDENTITY_SOURCES[testProvider()].anonymousClaim!
    // Гість — сесія із суб'єктом і claim аноніма: обліковий запис гостя не
    // провізується, тож `sub` — будь-який.
    const guest = (value: unknown): SessionClaims => ({
      ...sessionOf(randomUUID()),
      [claim]: value,
    })
    const ids = async (
      runtime: CommandRuntime,
      session: SessionClaims,
      object: MetadataRef
    ): Promise<unknown> => {
      try {
        const { rows } = await runtime.read(session, { object, limit: 10 })
        return rows.map((row) => row.ref)
      } catch (error) {
        if (error instanceof CommandFailure) return { refused: error.error }
        throw error
      }
    }

    it.each([true, "true"])(
      "an anonymous session (claim %j) reads only the object open to guests and is refused the other",
      async (value) => {
        const { runtime } = await counted()
        expect({
          open: await ids(runtime, guest(value), OPEN),
          members: await ids(runtime, guest(value), MEMBERS),
        }).toEqual({
          open: [env.open],
          // Роль гостя не має гранту таблиці, відкритої лише користувачам:
          // під роллю користувача читання повернуло б її рядок.
          members: {
            refused: {
              code: "command.forbidden",
              reason: "rls",
              object: MEMBERS,
            },
          },
        })
      }
    )

    it("a user session reads both objects", async () => {
      const { runtime } = await counted()
      const session = sessionOf(env.user)
      expect({
        open: await ids(runtime, session, OPEN),
        members: await ids(runtime, session, MEMBERS),
      }).toEqual({ open: [env.open], members: [env.members] })
    })

    it.each<[string, () => Record<string, unknown>]>([
      [
        "with a subject but without the anonymous claim",
        () => {
          const rest: Record<string, unknown> = { ...sessionOf(env.user) }
          delete rest[claim]
          return rest
        },
      ],
      ["without a subject (a request without a session)", () => noSubject],
    ])(
      "refuses a session %s as command.unauthenticated before the database",
      async (_, claims) => {
        const { runtime, connects } = await counted()
        expect(
          await commandRefusal(
            runtime.read(claims() as SessionClaims, { object: OPEN, limit: 10 })
          )
        ).toEqual({ code: "command.unauthenticated" })
        expect(connects()).toBe(0)
      }
    )
  })
}
