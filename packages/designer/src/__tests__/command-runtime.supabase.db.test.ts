import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  PLATFORM_ROLES,
  SESSION_CLAIMS_SETTING,
  defineObjectModule,
  type ObjectModule,
  type Operation,
} from "simetra/model"
import {
  fromPgPool,
  type CommandDatabase,
  type CommandRuntime,
  type CommandRuntimeOptions,
} from "simetra/server"
import { throughPoolerAs } from "./support/db"

import {
  type Env,
  GAUGE,
  gaugeCreate,
  header,
  heldEnv,
  MODULE_KEY,
  refusal,
  runtimeOver,
  sessionOf,
} from "./command-runtime.support"

/**
 * Рантайм команд через пулер Supavisor у режимі транзакцій: той самий
 * користувач, ті самі відмови й жодного сесійного стану між транзакціями
 * (інваріант 7, спека П4 §7.3). Спільна підготовка —
 * `command-runtime.support.ts`.
 */

describe("command runtime over the engine target", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 120_000)
  afterAll(() => target.close(), 60_000)

  const runtime = (
    database: CommandDatabase,
    options: Partial<CommandRuntimeOptions> = {}
  ): Promise<CommandRuntime> => runtimeOver(env, database, options)

  const createGauge = (id: string, extra: Record<string, unknown> = {}) =>
    gaugeCreate(env, id, extra)

  // Пулер у режимі транзакцій міняє серверне з'єднання між транзакціями:
  // той самий користувач і ті самі відмови доводять, що рантайм не спирається
  // на сесійний стан (інваріант 7, спека П4 §7.3).
  it("through the pooler: the same current user and the same refusals", async () => {
    const users: string[] = []
    const module = defineObjectModule({
      beforeWrite: ({ ctx, draft }) => {
        users.push(ctx.user)
        return draft
      },
    })
    const options = {
      objectModules: { [MODULE_KEY]: module as ObjectModule<object> },
    }
    const direct = await runtime(fromPgPool(env.direct), options)
    const pooled = await runtime(fromPgPool(env.pooled), options)
    const id = randomUUID()
    await direct.run(env.me.session, createGauge(randomUUID()))
    const created = await pooled.run(env.me.session, createGauge(id))
    expect(users).toEqual([env.me.user, env.me.user])
    expect(await pooled.read(env.me.session, { object: GAUGE, id })).toEqual({
      rows: [header(created.rows[0]!)],
    })
    const update: Operation = {
      action: "update",
      object: GAUGE,
      id: env.foreign,
      expectedVersion: 1,
      values: { amount: "1" },
    }
    expect(await refusal(pooled.run(env.me.session, update))).toEqual(
      await refusal(direct.run(env.me.session, update))
    )
    expect(
      await refusal(pooled.run(sessionOf(randomUUID()), createGauge(id)))
    ).toEqual({ code: "command.unauthenticated" })
  })

  // Роль і claims команди — `SET LOCAL` і `set_config(…, true)`: після
  // `COMMIT` серверне з'єднання пулера не несе їх у чужу транзакцію. Бекенд
  // команди записує обгортка порту перед `COMMIT`; наступні транзакції того
  // самого клієнта пулера шукають саме його (інваріант 7).
  it("through the pooler: the next transaction on the same backend sees neither the role nor the claims", async () => {
    const pool = new pg.Pool({
      connectionString: throughPoolerAs(env.login),
      max: 1,
    })
    try {
      const pids: string[] = []
      const rt = await runtime(withBackendPid(fromPgPool(pool), pids))
      pids.length = 0
      await rt.run(env.me.session, createGauge(randomUUID()))
      expect(pids).toHaveLength(1)
      const state = await nextOnBackend(pool, pids[0]!)
      expect(state.user).toBe(new URL(env.login).username)
      // Раз поставлений у сесії GUC лишається визначеним: після `COMMIT` це
      // `''`, а не `NULL` (звіт Задачі 0).
      expect([null, ""]).toContain(state.claims)
      expect(state.currentUserId).toBeNull()
    } finally {
      await pool.end()
    }
  })
})

/** Порт, що перед `COMMIT` записує бекенд транзакції. */
function withBackendPid(
  database: CommandDatabase,
  pids: string[]
): CommandDatabase {
  return {
    async connect() {
      const client = await database.connect()
      return {
        async query(text, params) {
          if (text === "COMMIT") {
            const { rows } = await client.query(
              "SELECT pg_backend_pid()::text AS pid",
              []
            )
            pids.push(rows[0]!.pid as string)
          }
          return client.query(text, params)
        },
        release: (destroy) => client.release(destroy),
      }
    },
  }
}

/**
 * Стан сесії в транзакції, яку пулер дав бекенду `pid`: роль, claims і
 * користувач платформи (функцію виконує роль команд — `SET LOCAL ROLE` не
 * змінює claims).
 */
async function nextOnBackend(
  pool: pg.Pool,
  pid: string
): Promise<{
  user: string
  claims: string | null
  currentUserId: string | null
}> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const { rows } = await client.query<{
        pid: string
        user: string
        claims: string | null
      }>(
        "SELECT pg_backend_pid()::text AS pid, current_user AS user, current_setting($1, true) AS claims",
        [SESSION_CLAIMS_SETTING]
      )
      const [state] = rows
      if (state!.pid !== pid) {
        await client.query("COMMIT")
        continue
      }
      await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      const { rows: users } = await client.query<{ id: string | null }>(
        "SELECT simetra.current_user_id() AS id"
      )
      await client.query("COMMIT")
      return {
        user: state!.user,
        claims: state!.claims,
        currentUserId: users[0]!.id,
      }
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }
  throw new Error(`the pooler never handed out backend ${pid} again`)
}
