import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildRuntimeCatalog, compile } from "simetra/compiler"
import {
  loginRoleParentNames,
  PLATFORM_ROLES,
  quoteIdent,
  type RuntimeCatalog,
} from "simetra/model"
import {
  ensurePlatformRoles,
  platformRoleSet,
  readPlatformRoles,
  type PlatformRoleSet,
} from "simetra/schema"
import { createCommandRuntime, fromPgPool, readRoleOf } from "simetra/server"
import {
  policyDomain,
  profileLayer,
  runtimeValuesLayer,
  superuserClient,
  testProvider,
} from "../../../simetra/test/support"
import { createApplyDatabase } from "../schema-engine"
import { refusal } from "./command-runtime.support"
import {
  asSuperuser,
  heldResource,
  seedMarker,
  withModelTarget,
  withRuntimeLogin,
} from "./support/db"

/**
 * `roles` над базою, створеною до нового батька профілю: наявна роль входу
 * без членства в ролі гостя. DB-рівень, бо право `GRANT` (ADMIN на ролі
 * запиту), рядки `pg_auth_members` і членство, яке перевіряє рантайм на
 * створенні, вирішує Postgres. Роль входу — тегована (`withRuntimeLogin`),
 * справжня `simetra_runtime` стека лише звіряється. Спільне тіло для
 * профілів `postgres` і `supabase`; файл профілю лише його кличе.
 */

interface Env {
  /** Ціль з моделлю й `simetra.marker` — від власника профілю. */
  url: string
  catalog: RuntimeCatalog
}

const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const result = await compile(
      policyDomain(runtimeValuesLayer(), profileLayer())
    )
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    await withModelTarget(model, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
      } finally {
        await owner.end()
      }
      await use({ url, catalog: buildRuntimeCatalog(model) })
    })
  })

const provider = testProvider()
const USER = readRoleOf(provider)!
const ANON = readRoleOf(provider, undefined, undefined, "anonymous")!

/**
 * Набір `roles` для тегованої ролі входу з батьками профілю. Справжня роль
 * входу стека — лише звірка (`checkOnly`): її членства цей тест не чіпає, а
 * без її рядка гейт не пропустив би пари з роллю команд.
 */
const rolesFor = (login: string): PlatformRoleSet => ({
  names: [PLATFORM_ROLES.command],
  login: [{ name: login, memberOf: loginRoleParentNames("runtime", provider) }],
  checkLogin: platformRoleSet(provider).login.map((l) => ({
    ...l,
    checkOnly: true as const,
  })),
})

/** Один оператор від суперкористувача стека; імена — лише кваліфіковані. */
async function asStack(sql: string): Promise<void> {
  const su = await superuserClient()
  try {
    await su.query(sql)
  } finally {
    await su.end()
  }
}

const roleOf = (loginUrl: string) =>
  decodeURIComponent(new URL(loginUrl).username)

export function describeRolesUpgrade() {
  describe("roles on a login role created before a new parent of its profile", () => {
    const target = heldEnv()
    let env: Env

    beforeAll(async () => {
      env = await target.open()
    }, 120_000)
    afterAll(() => target.close(), 60_000)

    const run = (login: string) =>
      ensurePlatformRoles(
        createApplyDatabase({ readOnly: false }),
        [{ server: "target", db: { url: asSuperuser(env.url) } }],
        rolesFor(login)
      )

    const memberships = async (login: string) => {
      const [row] = await createApplyDatabase({ readOnly: true }).transaction(
        { url: asSuperuser(env.url) },
        "rollback",
        (tx) => readPlatformRoles(tx, [login])
      )
      return (row?.memberOf ?? [])
        .map((m) => [m.role, m.admin, m.inherit, m.set])
        .sort()
    }

    const start = async (loginUrl: string) => {
      const pool = new pg.Pool({ connectionString: loginUrl })
      try {
        return await createCommandRuntime({
          database: fromPgPool(pool),
          catalog: env.catalog,
        })
      } finally {
        await pool.end()
      }
    }

    it("adds the missing pair, the runtime then starts, and a second run adds nothing", async () => {
      await withRuntimeLogin(
        env.url,
        [PLATFORM_ROLES.command],
        async (loginUrl) => {
          const login = roleOf(loginUrl)
          // База до нового батька: пари з роллю команд і роллю користувача
          await asStack(
            `GRANT ${quoteIdent(USER)} TO ${quoteIdent(login)} WITH INHERIT FALSE, SET TRUE`
          )
          expect(await refusal(start(loginUrl))).toEqual({
            code: "command.read-role-missing",
            role: ANON,
          })
          expect(await run(login)).toEqual({
            created: [
              {
                server: "target",
                name: PLATFORM_ROLES.command,
                outcome: "present",
              },
              {
                server: "target",
                name: login,
                outcome: "present",
                added: [ANON],
              },
            ],
          })
          expect(await memberships(login)).toEqual(
            [PLATFORM_ROLES.command, USER, ANON]
              .map((role) => [role, false, false, true])
              .sort()
          )
          await expect(start(loginUrl)).resolves.toBeDefined()
          expect(await run(login)).toEqual({
            created: [
              {
                server: "target",
                name: PLATFORM_ROLES.command,
                outcome: "present",
              },
              { server: "target", name: login, outcome: "present" },
            ],
          })
        },
        "upgrade"
      )
    })

    it("refuses an existing membership of an unsafe form and adds nothing", async () => {
      await withRuntimeLogin(
        env.url,
        [PLATFORM_ROLES.command],
        async (loginUrl) => {
          const login = roleOf(loginUrl)
          // Роль користувача відсутня, роль гостя — з INHERIT: не виправляється
          await asStack(
            `GRANT ${quoteIdent(ANON)} TO ${quoteIdent(login)} WITH INHERIT TRUE, SET TRUE`
          )
          const before = await memberships(login)
          const outcome = await run(login)
          expect(outcome.created).toEqual([])
          expect(
            (outcome.refusal ?? []).map((d) => [
              d.code,
              d.params?.role,
              d.params?.violation,
            ])
          ).toEqual([
            ["plan.platform-role-shape", login, `membership-option:${ANON}`],
          ])
          expect(await memberships(login)).toEqual(before)
        },
        "upgrade_bad"
      )
    })
  })
}
