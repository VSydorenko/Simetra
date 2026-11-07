import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildRuntimeCatalog, compile } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  defineObjectModule,
  type MetadataRef,
  type ObjectModule,
  type Operation,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import { desiredForApply } from "simetra/schema"
import {
  createCommandRuntime,
  fromPgPool,
  readRoleOf,
  type CommandDatabase,
  type CommandRuntime,
  type CommandRuntimeOptions,
} from "simetra/server"
import {
  GAUGE_TABLE,
  gaugeLineCheckLayer,
  policyDomain,
} from "../../../simetra/test/support"
import {
  asSuperuser,
  beforeStatement,
  commandRefusal,
  heldResource,
  inTarget,
  query,
  seedMarker,
  seedRuntimeActor,
  withRuntimeLogin,
} from "./support/db"

/**
 * Бюджет часу, коди замків і тайм-аутів, обрив з'єднання й сувора перевірка
 * масивів ТЧ рантайму команд над тінню рушія. Замки, `FATAL` простоюючого
 * з'єднання, поведінку драйвера `pg` і видимість рядків під функціями прав
 * вирішує Postgres — порт-фейк unit-тестів цього не доводить. Кейси чутливі
 * до часу й чужих сесій, тож послідовні; ціль одна на файл.
 */

const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }
const MODULE_KEY = "Catalog.Gauge"
const REQUEST_ROLE = readRoleOf("supabase")!

interface Env {
  catalog: RuntimeCatalog
  /** Тінь від ролі власника таблиць. */
  url: string
  owner: pg.Client
  /** Роль входу з членствами в ролі команд і ролі запиту. */
  login: string
  pool: pg.Pool
  org: string
  session: SessionClaims
}

const heldEnv = () =>
  heldResource<Env>(async (use) => {
    // `lines.qty` з `nonNegative` — для кейсу CHECK реквізиту ТЧ; решта кейсів
    // пише в `qty` додатні числа.
    const result = await compile(policyDomain(gaugeLineCheckLayer()))
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    const desired = await desiredForApply(model)
    await inTarget(desired.sql, desired.scope, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
        const { org, user } = await seedRuntimeActor(owner)
        await withRuntimeLogin(
          url,
          [PLATFORM_ROLES.command, REQUEST_ROLE],
          async (login) => {
            const pool = new pg.Pool({ connectionString: login })
            try {
              await use({
                catalog: buildRuntimeCatalog(model),
                url,
                owner,
                login,
                pool,
                org,
                session: { sub: user, role: REQUEST_ROLE },
              })
            } finally {
              await pool.end()
            }
          },
          "runtime_time"
        )
      } finally {
        await owner.end()
      }
    })
  })

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Модуль `Gauge`, чий `beforeWrite` чекає `ms` до повернення чернетки. */
const waitingModule = (ms: number) => ({
  [MODULE_KEY]: defineObjectModule({
    beforeWrite: async ({ draft }) => {
      await sleep(ms)
      return draft
    },
  }) as ObjectModule<object>,
})

describe("command time limits, codes and tabular arrays over the engine target", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 120_000)
  afterAll(() => target.close(), 60_000)

  const runtime = (
    options: Partial<CommandRuntimeOptions> = {},
    database: CommandDatabase = fromPgPool(env.pool)
  ): Promise<CommandRuntime> =>
    createCommandRuntime({ database, catalog: env.catalog, ...options })

  const createGauge = (id: string, lines: string[] = []): Operation => ({
    action: "create",
    object: GAUGE,
    id,
    values: { org: env.org },
    ...(lines.length === 0
      ? {}
      : {
          tabularSections: { lines: lines.map((ref) => ({ ref, qty: "1" })) },
        }),
  })

  const update = (
    id: string,
    expectedVersion: number,
    lines?: string[],
    deleteIds?: string[]
  ): Operation => ({
    action: "update",
    object: GAUGE,
    id,
    expectedVersion,
    values: { reading: expectedVersion },
    ...(lines === undefined
      ? {}
      : {
          tabularSections: { lines: lines.map((ref) => ({ ref, qty: "1" })) },
        }),
    ...(deleteIds === undefined ? {} : { deleteIds: { lines: deleteIds } }),
  })

  /** Новий рядок `Gauge` з рядками ТЧ; повертає його версію. */
  const seedGauge = async (id: string, lines: string[] = []) => {
    const rt = await runtime()
    const { rows } = await rt.run(env.session, createGauge(id, lines))
    return rows[0]!.version as number
  }

  const exists = async (id: string): Promise<boolean> =>
    (
      await env.owner.query(
        `SELECT 1 FROM public.${GAUGE_TABLE} WHERE id = $1`,
        [id]
      )
    ).rowCount === 1

  /** Ключі рядків ТЧ `lines` у базі — читанням власника, повз рантайм. */
  const linesOf = async (id: string): Promise<string[]> =>
    (
      await env.owner.query<{ id: string }>(
        "SELECT id FROM public.gauge_lines WHERE parent_id = $1 ORDER BY id",
        [id]
      )
    ).rows.map((r) => r.id)

  /** `fn` при замку рядка `Gauge`, який тримає інша сесія. */
  const whileRowLocked = async (id: string, fn: () => Promise<void>) => {
    const holder = new pg.Client({ connectionString: env.url })
    await holder.connect()
    try {
      await holder.query("BEGIN")
      await holder.query(
        `SELECT id FROM public.${GAUGE_TABLE} WHERE id = $1 FOR UPDATE`,
        [id]
      )
      await fn()
      await holder.query("ROLLBACK")
    } finally {
      await holder.end()
    }
  }

  it("lock_timeout is command.busy", async () => {
    const id = randomUUID()
    const version = await seedGauge(id)
    const rt = await runtime({ lockTimeoutMs: 300 })
    await whileRowLocked(id, async () => {
      expect(
        await commandRefusal(rt.run(env.session, update(id, version)))
      ).toEqual({
        code: "command.busy",
      })
    })
  })

  // Стеля оператора — залишок бюджету (Ф6): замок чекає довше, ніж дозволяє
  // `statement_timeout`, і `lock_timeout` не встигає спрацювати.
  it("statement_timeout is command.timeout", async () => {
    const id = randomUUID()
    const version = await seedGauge(id)
    const rt = await runtime({ commandBudgetMs: 2000, lockTimeoutMs: 10_000 })
    await whileRowLocked(id, async () => {
      expect(
        await commandRefusal(rt.run(env.session, update(id, version)))
      ).toEqual({
        code: "command.timeout",
      })
    })
  })

  it("budget runs out between statements: command.timeout, nothing written", async () => {
    const rt = await runtime({
      commandBudgetMs: 1000,
      objectModules: waitingModule(1300),
    })
    const id = randomUUID()
    expect(await commandRefusal(rt.run(env.session, createGauge(id)))).toEqual({
      code: "command.timeout",
    })
    expect(await exists(id)).toBe(false)
  })

  // Межа простою — бюджет + 1 с (Ф4): сервер закриває сесію `FATAL 25P03`,
  // поки хук чекає, а клієнт видано з пулу. Без слухача порту ця подія
  // `error` стала б необробленою і валила б процес.
  it("idle FATAL through the pg driver keeps the process alive", async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => uncaught.push(error)
    process.on("uncaughtException", onUncaught)
    const pool = new pg.Pool({ connectionString: env.login, max: 1 })
    try {
      const rt = await runtime(
        { commandBudgetMs: 1000, objectModules: waitingModule(3000) },
        fromPgPool(pool)
      )
      const id = randomUUID()
      expect(
        await commandRefusal(rt.run(env.session, createGauge(id)))
      ).toEqual({
        code: "command.timeout",
      })
      // Мертве з'єднання знищено, а не повернуто в пул
      expect(pool.totalCount).toBe(0)
      expect(await exists(id)).toBe(false)
      const next = await runtime({}, fromPgPool(pool))
      const again = randomUUID()
      await next.run(env.session, createGauge(again))
      expect(await exists(again)).toBe(true)
      expect(uncaught).toEqual([])
    } finally {
      process.off("uncaughtException", onUncaught)
      await pool.end()
    }
  })

  // Обрив до надсилання `COMMIT` — відкат, але з'єднання вже немає. Межу
  // `COMMIT` (обрив після надсилання) доводить unit транзакції.
  it("backend terminated before COMMIT is command.unavailable", async () => {
    const login = decodeURIComponent(new URL(env.login).username)
    const terminate = async () => {
      const su = asSuperuser(env.url)
      const idle =
        "FROM pg_stat_activity WHERE usename = $1 AND state = 'idle in transaction'"
      await query(su, `SELECT pg_terminate_backend(pid) ${idle}`, [login])
      for (let waited = 0; ; waited += 50) {
        const rows = await query(su, `SELECT 1 ${idle}`, [login])
        if (rows.length === 0) return
        if (waited > 10_000) throw new Error("the backend never ended")
        await sleep(50)
      }
    }
    // Транзакція створення рантайму теж закінчується `COMMIT`: обрив — лише
    // в команді
    let armed = false
    const rt = await runtime(
      {},
      beforeStatement(fromPgPool(env.pool), async (_, text) => {
        if (armed && text === "COMMIT") await terminate()
      })
    )
    armed = true
    const id = randomUUID()
    expect(await commandRefusal(rt.run(env.session, createGauge(id)))).toEqual({
      code: "command.unavailable",
    })
    expect(await exists(id)).toBe(false)
  })

  // Перевірка й ядро мусять бачити рядки ТЧ однаково під функціями прав, і на
  // першій фазі пакета теж: інакше «порожній успіх» тихо видалив би рядки,
  // яких викликач не назвав. Паралельну вставку між перевіркою й ядром
  // (перевірка без замка) ловить версія власника.
  it("deleteIds sees what the core sees, a concurrent insert is command.conflict", async () => {
    const gauge = randomUUID()
    const [l1, l2, l3] = [randomUUID(), randomUUID(), randomUUID()]
    let version = await seedGauge(gauge, [l1, l2])
    const rt = await runtime()
    const missing = {
      code: "command.invalid",
      reason: "tabular-rows-missing",
      path: "lines",
    }
    const other = randomUUID()
    expect(
      await commandRefusal(rt.run(env.session, update(gauge, version, [l1])))
    ).toEqual(missing)
    // Перша й друга фаза пакета
    expect(
      await commandRefusal(
        rt.run(env.session, [update(gauge, version, [l1]), createGauge(other)])
      )
    ).toEqual(missing)
    expect(
      await commandRefusal(
        rt.run(env.session, [createGauge(other), update(gauge, version, [l1])])
      )
    ).toEqual(missing)
    expect(await exists(other)).toBe(false)
    expect(await linesOf(gauge)).toEqual([l1, l2].sort())

    const { rows } = await rt.run(
      env.session,
      update(gauge, version, [l1], [l2])
    )
    version = rows[0]!.version as number
    expect(await linesOf(gauge)).toEqual([l1])

    // Інша команда комітить рядок `l3` рівно між одиницею перевірки й
    // одиницею ядра. `then` — з контексту тесту, не команди: інакше її
    // `run` був би вкладеним.
    let fire!: () => void
    const fired = new Promise<void>((resolve) => (fire = resolve))
    const concurrent = fired.then(() =>
      rt.run(env.session, update(gauge, version, [l1, l3]))
    )
    let checked = false
    let interleaved = false
    const racing = await runtime(
      {},
      beforeStatement(fromPgPool(env.pool), async (_, text) => {
        if (text.includes("AS missing")) {
          checked = true
        } else if (checked && !interleaved) {
          interleaved = true
          fire()
          await concurrent.catch(() => undefined)
        }
      })
    )
    expect(
      await commandRefusal(
        racing.run(env.session, update(gauge, version, [l1]))
      )
    ).toMatchObject({ code: "command.conflict", reason: "version" })
    expect(interleaved).toBe(true)
    await concurrent
    expect(await linesOf(gauge)).toEqual([l1, l3].sort())
    // Застаріла версія з неповним масивом — вердикт ядра, не перевірки
    expect(
      await commandRefusal(rt.run(env.session, update(gauge, version, [l1])))
    ).toMatchObject({ code: "command.conflict", reason: "version" })
  })

  // `23514` CHECK колонки ТЧ стає шляхом `<ТЧ>.<реквізит>` за каталогом.
  it("a tabular CHECK is command.constraint check on <section>.<attribute>", async () => {
    const rt = await runtime()
    const id = randomUUID()
    expect(
      await commandRefusal(
        rt.run(env.session, {
          action: "create",
          object: GAUGE,
          id,
          values: { org: env.org },
          tabularSections: { lines: [{ ref: randomUUID(), qty: "-1" }] },
        })
      )
    ).toEqual({
      code: "command.constraint",
      kind: "check",
      attributes: ["lines.qty"],
    })
    expect(await exists(id)).toBe(false)
  })
})
