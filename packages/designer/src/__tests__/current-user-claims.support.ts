import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildRuntimeCatalog, compile } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  type MetadataRef,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import { createCommandRuntime, fromPgPool, readRoleOf } from "simetra/server"
import {
  GAUGE_FILE,
  GAUGE_TABLE,
  policyDomain,
  profileLayer,
  runtimeValuesLayer,
  testProvider,
} from "../../../simetra/test/support"
import {
  heldResource,
  seedMarker,
  seedRuntimeActor,
  withModelTarget,
  withRuntimeLogin,
} from "./support/db"

/**
 * `current_user_id()` під claims сесії Better Auth через справжній рантайм:
 * команда пише автора функцією бази, а читання бачить рядок через членство
 * користувача в організації — обидва шляхи судить та сама функція. Спільне
 * тіло кейсу: профілі `postgres` і `supabase` дають той самий id
 * «Користувачів» на тих самих claims. DB-рівень, бо функцію сесії, RLS і
 * тригер авторства виконує сервер.
 */

const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }

interface Env {
  catalog: RuntimeCatalog
  pool: pg.Pool
  org: string
  user: string
  /** Рядок `Gauge` іншої організації: читання від `user` його не бачить. */
  foreign: string
}

const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const result = await compile(
      policyDomain(runtimeValuesLayer(), profileLayer(), {
        [GAUGE_FILE]: { trackAuthor: true },
      })
    )
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    await withModelTarget(model, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
        const { org, user } = await seedRuntimeActor(owner)
        const other = await seedRuntimeActor(owner)
        const foreign = randomUUID()
        await owner.query(
          `INSERT INTO public.${GAUGE_TABLE} (id, org_id) VALUES ($1, $2)`,
          [foreign, other.org]
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
                org,
                user,
                foreign,
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

/** Кейс паритету профілів; файл профілю лише його кличе. */
export function describeBetterAuthClaims() {
  describe("Better Auth claims through the command runtime", () => {
    const target = heldEnv()
    let env: Env

    beforeAll(async () => {
      env = await target.open()
    }, 120_000)
    afterAll(() => target.close(), 60_000)

    it("runCommand and runtime.read resolve current_user_id to the users row id", async () => {
      // Claims у формі сесії Better Auth — ті самі в обох профілях: без
      // claim `role`, з явним claim аноніма
      const claims = { sub: env.user, is_anonymous: false } satisfies SessionClaims
      const runtime = await createCommandRuntime({
        database: fromPgPool(env.pool),
        catalog: env.catalog,
      })
      const id = randomUUID()
      const created = await runtime.run(claims, {
        action: "create",
        object: GAUGE,
        id,
        values: { org: env.org },
      })
      const { rows } = await runtime.read(claims, { object: GAUGE, limit: 10 })
      expect({
        created: created.rows.map((r) => [r.ref, r.createdBy]),
        read: rows.map((r) => [r.ref, r.createdBy]),
      }).toEqual({
        created: [[id, env.user]],
        // Рядок чужої організації не видно: членство читає той самий id
        read: [[id, env.user]],
      })
    })
  })
}
