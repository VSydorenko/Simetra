import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  PLATFORM_ROLES,
  PLATFORM_SCHEMA,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
  SESSION_CLAIMS_SETTING,
  defineObjectModule,
  quoteIdent,
  type Filter,
  type ObjectModule,
  type Operation,
  type OrderBy,
  CommandFailure,
} from "simetra/model"
import {
  fromPgPool,
  type CommandDatabase,
  type CommandRuntime,
  type CommandRuntimeOptions,
} from "simetra/server"
import {
  GAUGE_TABLE,
  setLocalSetting,
  superuserClient,
  testProvider,
} from "../../../simetra/test/support"
import {
  ownerLoginOf,
  seedMarker,
  sessionOf,
  withCopy,
  withGroupRole,
  withRuntimeLogin,
} from "./support/db"

import {
  AMOUNT,
  BIG,
  type Env,
  GAUGE,
  GAUGE_LOG,
  gaugeCreate,
  header,
  heldEnv,
  MODULE_KEY,
  refusal,
  REQUEST_ROLE,
  runtimeOver,
} from "./command-runtime.support"
/**
 * Рантайм команд (`simetra/server`) над тінню рушія: справжній `pg.Pool`
 * тегованої ролі входу (форма `simetra_runtime`: членства лише з `SET`) і
 * пулер Supavisor у режимі транзакцій. Видимість рядків (RLS), замки, права
 * ядра й стан сесії між транзакціями вирішує Postgres — порт-фейк unit-тестів
 * T3 цього не доводить. Засів закомічений: кожна команда — окрема транзакція
 * окремого з'єднання пулу. Ціль — одна на файл (одне розгортання), кейси йдуть
 * послідовно й беруть свіжі рядки. Спільна підготовка —
 * `command-runtime.support.ts`; кейси пулера Supavisor —
 * `command-runtime.supabase.db.test.ts`.
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
    gaugeCreate(env, id, extra)

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
    expect(row!.tabularSections).toEqual({
      lines: [
        {
          ref: line,
          parent: id,
          lineNumber: 1,
          org: env.me.org,
          qty: "1.5000000000",
          note: "first",
        },
      ],
    })
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
    expect(next!.tabularSections).toEqual({
      lines: [
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
      ],
    })
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

  // CAS за полями й хук `beforeWrite` (спека П4 §6.9, І3): хук виконується до
  // замка рядка, тож для його об'єкта рантайм не передає ядру базу полів і
  // ядро звіряє версію. Та сама зміна з тією самою базою після чужої правки
  // іншого поля без модуля проходить — різницю дає лише модуль.
  it("expectedValues on an object with beforeWrite: a concurrent change of another field is conflict version", async () => {
    const plain = await runtime(fromPgPool(env.direct))
    const hooked = await runtime(fromPgPool(env.direct), {
      objectModules: {
        [MODULE_KEY]: defineObjectModule({
          beforeWrite: ({ draft }) => draft,
        }) as ObjectModule<object>,
      },
    })
    const id = randomUUID()
    const created = (
      await plain.run(env.me.session, createGauge(id, { amount: "1" }))
    ).rows[0]!
    const stale = created.version as number
    const other = (
      await plain.run(env.me.session, {
        action: "update",
        object: GAUGE,
        id,
        expectedVersion: stale,
        values: { reading: 7 },
      })
    ).rows[0]!
    const change: Operation = {
      action: "update",
      object: GAUGE,
      id,
      expectedVersion: stale,
      values: { amount: "2" },
      expectedValues: { amount: "1" },
    }
    expect(await refusal(hooked.run(env.me.session, change))).toEqual({
      code: "command.conflict",
      reason: "version",
      currentVersion: other.version,
    })
    expect((await plain.run(env.me.session, change)).rows[0]).toMatchObject({
      amount: "2.0000000000",
      reading: 7,
    })
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
  // стає реквізитом за колонкою CHECK каталогу (спека П4 §6.10).
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
      await setLocalSetting(
        client,
        SESSION_CLAIMS_SETTING,
        JSON.stringify(env.me.session)
      )
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

  // Гейт ролі входу судить `session_user` пулу, тож кожен кейс — окремий пул
  // на DSN своєї ролі входу, а не спільна сесія тестів (там `session_user` —
  // суперкористувач стека).
  const gate = async (url: string) => {
    const pool = new pg.Pool({ connectionString: url })
    try {
      return await refusal(runtime(fromPgPool(pool)))
    } finally {
      await pool.end()
    }
  }
  const privileged = (reason: string) => ({
    code: "command.privileged-login",
    reason,
  })
  const owner = PROVIDER_OWNER_ROLES[testProvider()]
  // Членства ролі входу рантайму поруч із привілеєм: без гейта такий вхід
  // створив би рантайм, тож відмову дає саме гейт.
  const RUNTIME_ROLES = [PLATFORM_ROLES.command, REQUEST_ROLE]

  it("login gate: the owner login of the profile is privileged-login owner", async () => {
    expect(await gate(ownerLoginOf(env.login))).toEqual(privileged("owner"))
  })

  // Власник схеми платформи з будь-яким іменем: гейт бачить `nspowner`, а не
  // ім'я ролі власника профілю.
  it("login gate: the owner of the platform schema under another name is privileged-login owner", async () => {
    await withCopy("", (copy, database) =>
      withRuntimeLogin(
        copy,
        [],
        async (login) => {
          const role = decodeURIComponent(new URL(login).username)
          expect(role).not.toBe(owner)
          const su = await superuserClient(database)
          try {
            await su.query(
              `create schema ${quoteIdent(PLATFORM_SCHEMA)} authorization ${quoteIdent(role)}`
            )
            try {
              expect(await gate(login)).toEqual(privileged("owner"))
            } finally {
              // Схема тримала б роль від `DROP ROLE`
              await su.query(`drop schema ${quoteIdent(PLATFORM_SCHEMA)}`)
            }
          } finally {
            await su.end()
          }
        },
        "gate_own"
      )
    )
  })

  it("login gate: a member of the owner through a middle role is privileged-login owner", async () => {
    await withGroupRole("gate_mid", { memberOf: [owner] }, (middle) =>
      withRuntimeLogin(
        env.login,
        [...RUNTIME_ROLES, middle],
        async (login) => {
          expect(await gate(login)).toEqual(privileged("owner"))
        },
        "gate_via"
      )
    )
  })

  it.each([
    ["INHERIT TRUE, SET TRUE", true],
    ["INHERIT FALSE, SET TRUE", false],
  ])(
    "login gate: a member of a BYPASSRLS role (%s) is privileged-login bypassrls",
    async (_, inherit) => {
      await withGroupRole("gate_rls", { bypassRls: true }, (bypass) =>
        withRuntimeLogin(
          env.login,
          [...RUNTIME_ROLES, bypass],
          async (login) => {
            expect(await gate(login)).toEqual(privileged("bypassrls"))
          },
          "gate_rls_in",
          { inherit }
        )
      )
    }
  )

  it.each([
    // Роль входу провайдера стека — за фіксованим ім'ям профілю: теговану
    // роль `auth` гейт не бачить.
    ["provider-login", PROVIDER_LOGIN_ROLES[testProvider()][0]!],
    ["server-files", "pg_read_server_files"],
    ["read-all-data", "pg_read_all_data"],
    ["write-all-data", "pg_write_all_data"],
  ])(
    "login gate: a member of %s role %s is refused with that reason",
    async (reason, role) => {
      await withRuntimeLogin(
        env.login,
        [...RUNTIME_ROLES, role],
        async (login) => {
          expect(await gate(login)).toEqual(privileged(reason))
        },
        "gate_role"
      )
    }
  )

  // Власник бази — член `pg_database_owner` лише неявно, у своїй базі: тож
  // окрема копія, якою володіє тегована роль входу, і вхід саме в неї.
  it("login gate: the owner of the current database is privileged-login database-owner", async () => {
    await withCopy("", (copy, database) =>
      withRuntimeLogin(
        copy,
        [],
        async (login) => {
          const role = decodeURIComponent(new URL(login).username)
          const su = await superuserClient(database)
          try {
            await su.query(
              `alter database ${quoteIdent(database)} owner to ${quoteIdent(role)}`
            )
            try {
              expect(await gate(login)).toEqual(privileged("database-owner"))
            } finally {
              // Володіння базою тримало б роль від `DROP ROLE`
              await su.query(
                `alter database ${quoteIdent(database)} owner to ${quoteIdent(owner)}`
              )
            }
          } finally {
            await su.end()
          }
        },
        "gate_dbo"
      )
    )
  })

  it("login gate: the simetra_runtime form of the login role creates the runtime", async () => {
    await expect(runtime(fromPgPool(env.direct))).resolves.toHaveProperty("run")
  })
})
