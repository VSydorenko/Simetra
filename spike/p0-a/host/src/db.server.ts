import { AsyncLocalStorage } from "node:async_hooks"
import { getRequest } from "@tanstack/react-start/server"
import { attachDatabasePool } from "@vercel/functions"
import pg from "pg"
import { defineObjectModule, type SessionClaims } from "simetra/model"
import {
  createCommandRuntime,
  fromPgPool,
  readRoleOf,
  type CommandDatabase,
  type CommandRuntime,
} from "simetra/server"
import catalog from "../runtime-catalog.json"

export interface ProbeInput {
  user: string
  org: string
  /** Пауза в хуку «до» — щоб транзакції паралельних запитів перекрились. */
  delay?: number
  /** Тривалість дії `afterCommit`. */
  after?: number
}

/** Що бачила транзакція команди на своєму з'єднанні перед `COMMIT`. */
interface Observed {
  role?: string
  claimsSub?: string
  pid?: string
  hookUser?: string
  deferPath?: string
}

// Пул на рівні модуля — штатна форма для node-server і Fluid compute (Рт17);
// `attachDatabasePool` на Vercel тримає функцію живою до закриття простою.
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.POOL_MAX ?? 4),
  idleTimeoutMillis: 5_000,
})
attachDatabasePool(pool)

const observed = new AsyncLocalStorage<Observed>()
// Параметри проби для хуків — контекстом запиту, не через рантайм.
const params = new AsyncLocalStorage<{ delay: number; after: number }>()
const AFTER: { id: string; at: number; instance: string }[] = []
const INSTANCE = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`

const PROBE_SQL =
  "SELECT current_user AS role, current_setting('request.jwt.claims', true) AS claims, pg_backend_pid()::text AS pid"

/** Порт рантайму з пробою: перед `COMMIT` — роль і claims того ж з'єднання. */
function probed(database: CommandDatabase): CommandDatabase {
  return {
    async connect() {
      const client = await database.connect()
      return {
        async query(text, params) {
          const store = observed.getStore()
          if (text === "COMMIT" && store) {
            const { rows } = await client.query(PROBE_SQL, [])
            const row = rows[0] ?? {}
            store.role = String(row.role)
            store.pid = String(row.pid)
            const claims = row.claims ? JSON.parse(String(row.claims)) : null
            store.claimsSub = claims?.sub
          }
          return client.query(text, params)
        },
        release: (destroy) => client.release(destroy),
      }
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Дія після коміту — на платформу: `waitUntil` запиту, який Nitro ставить на
// обох пресетах (`req.waitUntil`).
function defer(work: Promise<unknown>): void {
  const store = observed.getStore()
  const request = getRequest() as Request & {
    waitUntil?: (p: Promise<unknown>) => void
  }
  if (typeof request.waitUntil === "function") {
    if (store) store.deferPath = "request.waitUntil"
    request.waitUntil(work)
  } else {
    if (store) store.deferPath = "none"
    void work
  }
}

let runtime: Promise<CommandRuntime> | undefined
const runtimeOf = () =>
  (runtime ??= createCommandRuntime({
    database: probed(fromPgPool(pool)),
    catalog,
    defer,
    objectModules: {
      "Catalog.Gauge": defineObjectModule({
        async beforeWrite({ draft, ctx }) {
          const delay = params.getStore()?.delay ?? 0
          if (delay) await sleep(delay)
          return draft
        },
        onWrite({ ctx }) {
          const store = observed.getStore()
          if (store) store.hookUser = ctx.user
          const after = params.getStore()?.after ?? 0
          const id = ctx.id
          ctx.afterCommit(async () => {
            await sleep(after)
            const at = Date.now()
            AFTER.push({ id, at, instance: INSTANCE })
            console.log(
              `P0A_AFTER_COMMIT id=${id} at=${at} instance=${INSTANCE}`
            )
          })
        },
      }),
    },
  }).catch((error) => {
    runtime = undefined
    throw error
  }))

export async function runCommandProbe(input: ProbeInput) {
  const store: Observed = {}
  const session: SessionClaims = {
    sub: input.user,
    role: readRoleOf("supabase")!,
  }
  const startedAt = Date.now()
  return observed.run(store, async () => {
    const rt = await runtimeOf()
    const id = crypto.randomUUID()
    const result = await params.run(
      { delay: input.delay ?? 0, after: input.after ?? 0 },
      () =>
        rt.run(session, {
          action: "create",
          object: { kind: "Catalog", name: "Gauge" },
          id,
          values: { org: input.org },
        })
    )
    // Наступна транзакція з пулу: роль і claims не мають перейти.
    const client = await pool.connect()
    let next: Record<string, unknown>
    try {
      next = (await client.query(PROBE_SQL)).rows[0]
    } finally {
      client.release()
    }
    return {
      id,
      user: input.user,
      // Авторство рядка ставить тригер бази з claims транзакції (§6.8).
      author: Object.fromEntries(
        Object.entries(result.rows[0] ?? {})
          .filter(([k]) => /creat/i.test(k))
          .map(([k, v]) => [k, String(v)])
      ),
      inTx: store,
      next: {
        role: String(next.role),
        claims: next.claims ?? null,
        pid: String(next.pid),
      },
      instance: INSTANCE,
      startedAt,
      respondedAt: Date.now(),
    }
  })
}

export function readAfterLog() {
  return { instance: INSTANCE, entries: AFTER }
}
