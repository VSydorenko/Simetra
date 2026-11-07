import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildRuntimeCatalog,
  compile,
  type CompiledModel,
} from "simetra/compiler"
import {
  PLATFORM_ROLES,
  SESSION_CLAIMS_SETTING,
  defineObjectModule,
  type CommandError,
  type Filter,
  type MetadataRef,
  type ObjectModule,
  type Operation,
  type OrderBy,
  type RuntimeCatalog,
  type SessionClaims,
  CommandFailure,
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
  policyDomain,
  runtimeValuesLayer,
} from "../../../simetra/test/support"
import {
  heldResource,
  inTarget,
  seedMarker,
  seedRuntimeActor,
  throughPoolerAs,
  withRuntimeLogin,
} from "./support/db"

/**
 * Рантайм команд (`simetra/server`) над тінню рушія: справжній `pg.Pool`
 * тегованої ролі входу (форма `simetra_runtime`: членства лише з `SET`) і
 * пулер Supavisor у режимі транзакцій. Видимість рядків (RLS), замки, права
 * ядра й стан сесії між транзакціями вирішує Postgres — порт-фейк unit-тестів
 * T3 цього не доводить. Засів закомічений: кожна команда — окрема транзакція
 * окремого з'єднання пулу. Ціль — одна на файл (одне розгортання), кейси йдуть
 * послідовно й беруть свіжі рядки.
 */

const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }
const GAUGE_LOG: MetadataRef = { kind: "Catalog", name: "GaugeLog" }
const MODULE_KEY = "Catalog.Gauge"
const REQUEST_ROLE = readRoleOf("supabase")!

/** Більше за 2^53: `number` такого цілого не втримав би. */
const BIG = 2n ** 53n + 1n
/** 20 цифр цілої частини й 10 дробової — межа `Numeric(30,10)`. */
const AMOUNT = "12345678901234567890.0123456789"

interface Actor {
  org: string
  user: string
  session: SessionClaims
}

interface Env {
  model: CompiledModel
  catalog: RuntimeCatalog
  owner: pg.Client
  /** Роль входу з членствами в ролі команд і ролі запиту. */
  login: string
  /** Роль входу лише з членством у ролі команд. */
  commandOnly: string
  direct: pg.Pool
  pooled: pg.Pool
  me: Actor
  other: Actor
  region: string
  /** Рядок `Gauge` чужого тенанта. */
  foreign: string
}

const sessionOf = (user: string): SessionClaims => ({
  sub: user,
  role: REQUEST_ROLE,
})

/** Актор фікстури з сесією запиту від його користувача. */
async function seedActor(owner: pg.Client): Promise<Actor> {
  const actor = await seedRuntimeActor(owner)
  return { ...actor, session: sessionOf(actor.user) }
}

async function seedRow(
  owner: pg.Client,
  table: string,
  org: string
): Promise<string> {
  const id = randomUUID()
  await owner.query(
    `INSERT INTO public.${table} (id, org_id) VALUES ($1, $2)`,
    [id, org]
  )
  return id
}

/**
 * Тінь з бажаним станом застосування (модель і `simetra.marker`), засів і дві
 * ролі входу; тримається, доки `close` не відпустить колбек `inTarget`.
 */
const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const result = await compile(policyDomain(runtimeValuesLayer()))
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    const desired = await desiredForApply(model)
    await inTarget(desired.sql, desired.scope, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
        const me = await seedActor(owner)
        const other = await seedActor(owner)
        const region = await seedRow(owner, "region", me.org)
        const foreign = await seedRow(owner, GAUGE_TABLE, other.org)
        await withRuntimeLogin(
          url,
          [PLATFORM_ROLES.command, REQUEST_ROLE],
          (login) =>
            withRuntimeLogin(
              url,
              [PLATFORM_ROLES.command],
              async (commandOnly) => {
                const direct = new pg.Pool({ connectionString: login })
                const pooled = new pg.Pool({
                  connectionString: throughPoolerAs(login),
                })
                try {
                  await use({
                    model,
                    catalog: buildRuntimeCatalog(model),
                    owner,
                    login,
                    commandOnly,
                    direct,
                    pooled,
                    me,
                    other,
                    region,
                    foreign,
                  })
                } finally {
                  await direct.end()
                  await pooled.end()
                }
              },
              "runtime_cmd"
            )
        )
      } finally {
        await owner.end()
      }
    })
  })

/** Відмова команди як `CommandError`; успіх — помилка тесту. */
async function refusal(work: Promise<unknown>): Promise<CommandError> {
  try {
    await work
  } catch (error) {
    if (error instanceof CommandFailure) return error.error
    throw error
  }
  throw new Error("the command succeeded")
}

/** Реквізити шапки результату: читання ТЧ не повертає. */
function header(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([k]) => k !== "lines"))
}

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
  ): Promise<CommandRuntime> =>
    createCommandRuntime({ database, catalog: env.catalog, ...options })

  const exists = async (table: string, id: string): Promise<boolean> =>
    (await env.owner.query(`SELECT 1 FROM public.${table} WHERE id = $1`, [id]))
      .rowCount === 1

  /** Рядки ТЧ `lines` у базі — читанням власника, повз рантайм. */
  const linesOf = async (id: string) =>
    (
      await env.owner.query(
        "SELECT id, line_number, qty::text AS qty, note FROM public.gauge_lines WHERE parent_id = $1 ORDER BY line_number",
        [id]
      )
    ).rows

  const createGauge = (id: string, extra: Record<string, unknown> = {}) =>
    ({
      action: "create",
      object: GAUGE,
      id,
      values: { org: env.me.org, ...extra },
    }) satisfies Operation

  // Рядок ядра й рядок читання — з бази, через той самий `decodeRow`; збіг
  // значень без втрат (Numeric на 20 цифр, BigInt понад 2^53, Json, Bytes,
  // мітка перерахування, пара) доводить лише Postgres (інваріант 13).
  it("create → update → markDeletion: values without loss, equal to runtime.read", async () => {
    const rt = await runtime(fromPgPool(env.direct))
    const id = randomUUID()
    const line = randomUUID()
    const second = randomUUID()
    const payload = { a: [1, "x", null, { b: true }] }
    const created = await rt.run(env.me.session, {
      ...createGauge(id, {
        amount: AMOUNT,
        counter: BIG,
        payload,
        blob: "\\x00ff",
        level: "High",
        subject: { type: "Catalog.Region", id: env.region },
        marks: [1n, BIG],
      }),
      tabularSections: { lines: [{ ref: line, qty: "1.5", note: "first" }] },
    })
    const [row] = created.rows
    expect(row).toMatchObject({
      ref: id,
      org: env.me.org,
      amount: AMOUNT,
      counter: BIG,
      payload,
      blob: "\\x00ff",
      level: "High",
      subject: { type: "Catalog.Region", id: env.region },
      marks: [1n, BIG],
      deletionMark: false,
      version: expect.any(Number),
    })
    // Рядки ТЧ — точно, за іменами каталогу: ключ рядка під `keyName` ТЧ,
    // власник і номер рядка — як у типі рядка кодогену, `Numeric` з повним
    // масштабом колонки.
    expect(row!.lines).toEqual([
      {
        ref: line,
        parent: id,
        lineNumber: 1,
        org: env.me.org,
        qty: "1.5000000000",
        note: "first",
      },
    ])
    const read = async () => rt.read(env.me.session, { object: GAUGE, id })
    expect(await read()).toEqual({ rows: [header(row!)] })
    // Серверне читання повертає лише шапку (§6.11: `to_jsonb` рядка таблиці
    // об'єкта), тож ТЧ у базі звіряє незалежний `SELECT` власника.
    expect(await linesOf(id)).toEqual([
      { id: line, line_number: 1, qty: "1.5000000000", note: "first" },
    ])
    expect(created.changes).toEqual([
      {
        object: GAUGE,
        scopeKind: env.catalog.objects.find((o) => o.name === "Gauge")!
          .scopeKindId,
        scope: env.me.org,
        id,
        version: row!.version,
        operation: "create",
      },
    ])

    const updated = await rt.run(env.me.session, {
      action: "update",
      object: GAUGE,
      id,
      expectedVersion: row!.version as number,
      values: { amount: "-0.5", counter: -BIG, level: "Low", marks: [] },
      tabularSections: {
        lines: [
          { ref: second, qty: AMOUNT, note: "second" },
          { ref: line, qty: "-2.25", note: "edited" },
        ],
      },
    })
    const [next] = updated.rows
    expect(next!.lines).toEqual([
      {
        ref: second,
        parent: id,
        lineNumber: 1,
        org: env.me.org,
        qty: AMOUNT,
        note: "second",
      },
      {
        ref: line,
        parent: id,
        lineNumber: 2,
        org: env.me.org,
        qty: "-2.2500000000",
        note: "edited",
      },
    ])
    expect(await linesOf(id)).toEqual([
      { id: second, line_number: 1, qty: AMOUNT, note: "second" },
      { id: line, line_number: 2, qty: "-2.2500000000", note: "edited" },
    ])
    expect(next).toMatchObject({
      amount: "-0.5000000000",
      counter: -BIG,
      level: "Low",
      marks: [],
    })
    expect(next!.version).toBeGreaterThan(row!.version as number)
    expect(await read()).toEqual({ rows: [header(next!)] })

    const marked = await rt.run(env.me.session, {
      action: "markDeletion",
      object: GAUGE,
      id,
      expectedVersion: next!.version as number,
      mark: true,
    })
    const [last] = marked.rows
    expect(last).toMatchObject({ deletionMark: true })
    expect(await read()).toEqual({ rows: [header(last!)] })
  })

  // Чужий рядок RLS ховає так само, як відсутній: відмова не має розкрити,
  // що рядок існує (інваріант 4).
  it("update of a foreign and of a missing row is the same no-right refusal", async () => {
    const rt = await runtime(fromPgPool(env.direct))
    const update = (id: string): Operation => ({
      action: "update",
      object: GAUGE,
      id,
      expectedVersion: 1,
      values: { amount: "1" },
    })
    const foreign = await refusal(rt.run(env.me.session, update(env.foreign)))
    expect(foreign).toMatchObject({
      code: "command.forbidden",
      reason: "no-right",
    })
    expect(await refusal(rt.run(env.me.session, update(randomUUID())))).toEqual(
      foreign
    )
  })

  // Контекст кожної фази ставиться окремим оператором безпосередньо перед її
  // ядром: зовнішня фаза під контекстом фази `ctx.run` дістала б відмову ядра
  // (інваріант 3).
  it("beforeWrite with ctx.run writes both rows, each under its own phase context", async () => {
    const log = randomUUID()
    const module = defineObjectModule({
      beforeWrite: async ({ ctx, draft }) => {
        await ctx.run({
          action: "create",
          object: GAUGE_LOG,
          id: log,
          values: { org: env.me.org, note: "from hook" },
        })
        return draft
      },
    })
    const rt = await runtime(fromPgPool(env.direct), {
      objectModules: { [MODULE_KEY]: module as ObjectModule<object> },
    })
    const id = randomUUID()
    const result = await rt.run(env.me.session, createGauge(id))
    expect(
      result.changes.map((c) => [c.object.name, c.id, c.operation])
    ).toEqual([
      ["GaugeLog", log, "create"],
      ["Gauge", id, "create"],
    ])
    expect(await exists(GAUGE_TABLE, id)).toBe(true)
    expect(await exists("gauge_log", log)).toBe(true)
  })

  // Відмову ядра фази `ctx.run` дає Postgres; перехоплена хуком, вона однаково
  // завершує команду відкатом (спека П4 §7.2).
  it("a hook that catches the ctx.run refusal: the command fails with it, no afterCommit, nothing written", async () => {
    let afterCommit = false
    let caught: unknown
    const module = defineObjectModule({
      beforeWrite: async ({ ctx, draft }) => {
        ctx.afterCommit(() => {
          afterCommit = true
        })
        try {
          await ctx.run({
            action: "update",
            object: GAUGE_LOG,
            id: randomUUID(),
            expectedVersion: 1,
            values: { note: "missing" },
          })
        } catch (error) {
          caught = error
        }
        return draft
      },
    })
    const rt = await runtime(fromPgPool(env.direct), {
      objectModules: { [MODULE_KEY]: module as ObjectModule<object> },
    })
    const id = randomUUID()
    const error = await refusal(rt.run(env.me.session, createGauge(id)))
    expect(error).toMatchObject({
      code: "command.forbidden",
      reason: "no-right",
    })
    expect((caught as CommandFailure).error).toEqual(error)
    expect(afterCommit).toBe(false)
    expect(await exists(GAUGE_TABLE, id)).toBe(false)
  })

  // Пакет — одна транзакція: друга фаза під контекстом першої дістала б
  // відмову ядра, а відмова другої відкочує й першу (Postgres).
  it("a batch of two phases on different rows commits both", async () => {
    const rt = await runtime(fromPgPool(env.direct))
    const [a, b] = [randomUUID(), randomUUID()]
    const result = await rt.run(env.me.session, [
      createGauge(a),
      createGauge(b),
    ])
    expect(result.rows.map((r) => r.ref)).toEqual([a, b])
    expect(await exists(GAUGE_TABLE, a)).toBe(true)
    expect(await exists(GAUGE_TABLE, b)).toBe(true)
  })

  it("a batch whose second phase is forbidden fails with command.forbidden and writes nothing", async () => {
    const rt = await runtime(fromPgPool(env.direct))
    const a = randomUUID()
    const error = await refusal(
      rt.run(env.me.session, [
        createGauge(a),
        {
          action: "update",
          object: GAUGE,
          id: env.foreign,
          expectedVersion: 1,
          values: { amount: "1" },
        },
      ])
    )
    expect(error).toMatchObject({
      code: "command.forbidden",
      reason: "no-right",
    })
    expect(await exists(GAUGE_TABLE, a)).toBe(false)
  })

  // Межу `nonNegative` тримає лише CHECK бази: `23514` з іменем обмеження
  // стає реквізитом за колонкою CHECK каталогу (Р-A3-21, спека П4 §6.10).
  it("a value outside nonNegative is command.constraint check on the attribute", async () => {
    const rt = await runtime(fromPgPool(env.direct))
    const id = randomUUID()
    const error = await refusal(
      rt.run(env.me.session, createGauge(id, { reading: -1 }))
    )
    expect(error).toEqual({
      code: "command.constraint",
      kind: "check",
      object: GAUGE,
      attributes: ["reading"],
    })
    expect(await exists(GAUGE_TABLE, id)).toBe(false)
  })

  // Користувача claims без ідентичності знає лише `current_user_id()` бази:
  // `NULL` — жодної фази й жодного хука (інваріант 5).
  it("claims without a user: command.unauthenticated, no phase, no hook", async () => {
    let hooks = 0
    const module = defineObjectModule({
      beforeWrite: ({ draft }) => {
        hooks++
        return draft
      },
    })
    const rt = await runtime(fromPgPool(env.direct), {
      objectModules: { [MODULE_KEY]: module as ObjectModule<object> },
    })
    const id = randomUUID()
    expect(
      await refusal(rt.run(sessionOf(randomUUID()), createGauge(id)))
    ).toEqual({ code: "command.unauthenticated" })
    expect(hooks).toBe(0)
    expect(await exists(GAUGE_TABLE, id)).toBe(false)
  })

  // Видимість рядків вирішують політики RLS під роллю запиту (інваріант 10):
  // серверне читання бачить рівно те, що `SELECT` PostgREST з тими самими
  // claims; запасний шлях (`readFallback`) — те саме.
  it("runtime.read sees what a SELECT under the request role sees, the fallback too", async () => {
    const rt = await runtime(fromPgPool(env.direct))
    await rt.run(env.me.session, createGauge(randomUUID()))
    await rt.run(env.me.session, createGauge(randomUUID(), { reading: 5 }))
    await rt.run(env.me.session, createGauge(randomUUID(), { reading: 1 }))
    // Друга форма: дерево з `or`/`not`, сортування й лічильник — та сама
    // множина, що `WHERE` того самого змісту під роллю запиту.
    const where: Filter = {
      or: [
        { attribute: "reading", op: "isNull" },
        { not: { attribute: "reading", op: "gte", value: 3 } },
      ],
    }
    const client = new pg.Client({ connectionString: env.login })
    await client.connect()
    let visible: string[]
    let filtered: string[]
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config($1, $2, true)", [
        SESSION_CLAIMS_SETTING,
        JSON.stringify(env.me.session),
      ])
      await client.query(`SET LOCAL ROLE ${REQUEST_ROLE}`)
      const ids = async (condition: string) =>
        (
          await client.query<{ id: string }>(
            `SELECT id FROM public.${GAUGE_TABLE}${condition} ORDER BY id`
          )
        ).rows.map((r) => r.id)
      visible = await ids("")
      filtered = await ids(" WHERE reading IS NULL OR NOT (reading >= 3)")
      await client.query("COMMIT")
    } finally {
      await client.end()
    }
    expect(visible.length).toBeGreaterThan(0)
    expect(visible).not.toContain(env.foreign)
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.length).toBeLessThan(visible.length)
    const page = { object: GAUGE, limit: 200 }
    const sortedPage = {
      object: GAUGE,
      where,
      orderBy: [
        { attribute: "reading", direction: "desc", nulls: "last" },
      ] satisfies OrderBy,
      limit: 200,
    }
    const counted = { object: GAUGE, where, count: true } as const
    const reads = async (rt: CommandRuntime) => ({
      page: await rt.read(env.me.session, page),
      sorted: await rt.read(env.me.session, sortedPage),
      count: await rt.read(env.me.session, counted),
    })
    const read = await reads(rt)
    expect(read.page.rows.map((r) => r.ref)).toEqual(visible)
    expect(read.sorted.rows.map((r) => r.ref as string).sort()).toEqual(
      filtered
    )
    expect(read.count).toEqual({ count: filtered.length })

    const fallbackPool = new pg.Pool({ connectionString: env.commandOnly })
    try {
      const fallback = await runtime(fromPgPool(fallbackPool), {
        readFallback: true,
      })
      expect(await reads(fallback)).toEqual(read)
    } finally {
      await fallbackPool.end()
    }
  })

  // Хеш застосованого знімка й членство ролі входу знає лише база.
  it("createCommandRuntime: another applied hash is command.model-mismatch", async () => {
    const other = "0".repeat(64)
    await seedMarker(env.owner, other)
    try {
      expect(await refusal(runtime(fromPgPool(env.direct)))).toEqual({
        code: "command.model-mismatch",
        hashes: { catalog: env.model.hash, applied: other },
      })
    } finally {
      await seedMarker(env.owner, env.model.hash)
    }
  })

  it("createCommandRuntime: a login role outside the request role is command.read-role-missing", async () => {
    const pool = new pg.Pool({ connectionString: env.commandOnly })
    try {
      expect(await refusal(runtime(fromPgPool(pool)))).toEqual({
        code: "command.read-role-missing",
        role: REQUEST_ROLE,
      })
    } finally {
      await pool.end()
    }
  })

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
