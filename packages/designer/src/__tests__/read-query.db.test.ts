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
  TABULAR_LINES_MAX,
  type Filter,
  type OrderBy,
  type MetadataRef,
  type ReadQuery,
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
  GAUGE_LOG_TABLE,
  GAUGE_TABLE,
  policyDomain,
  readQueryLayer,
  setLocalSetting,
} from "../../../simetra/test/support"
import {
  beforeStatement,
  commandRefusal,
  heldResource,
  inTarget,
  seedMarker,
  seedRuntimeActor,
  withRuntimeLogin,
} from "./support/db"

/**
 * Серверне читання другої форми (спека П4-B §4.1–§4.2) над тінню рушія.
 * Видимість рядків (RLS), порядок колляції колонки, `ILIKE`, знімок одного
 * оператора під конкурентним комітом і `statement_timeout` вирішує Postgres —
 * порт-фейк unit-тестів T3 цього не доводить. Ціль — одна на файл, засів
 * закомічений власником; кожен кейс бере свої рядки.
 */

const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }
const GAUGE_LOG: MetadataRef = { kind: "Catalog", name: "GaugeLog" }
const REQUEST_ROLE = readRoleOf("supabase")!

interface Actor {
  org: string
  session: SessionClaims
}

interface Env {
  model: CompiledModel
  catalog: RuntimeCatalog
  /** Тінь від ролі власника таблиць. */
  url: string
  owner: pg.Client
  /** Роль входу з членствами в ролі команд і ролі запиту. */
  login: string
  pool: pg.Pool
  me: Actor
  other: Actor
}

async function seedActor(owner: pg.Client): Promise<Actor> {
  const { org, user } = await seedRuntimeActor(owner)
  return { org, session: { sub: user, role: REQUEST_ROLE } }
}

const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const result = await compile(policyDomain(readQueryLayer()))
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
        await withRuntimeLogin(
          url,
          [PLATFORM_ROLES.command, REQUEST_ROLE],
          async (login) => {
            const pool = new pg.Pool({ connectionString: login })
            try {
              await use({
                model,
                catalog: buildRuntimeCatalog(model),
                url,
                owner,
                login,
                pool,
                me,
                other,
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

describe("server read of the second form over the engine target", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 120_000)
  afterAll(() => target.close(), 60_000)

  const runtime = (
    database: CommandDatabase = fromPgPool(env.pool),
    options: Partial<CommandRuntimeOptions> = {}
  ): Promise<CommandRuntime> =>
    createCommandRuntime({ database, catalog: env.catalog, ...options })

  /** Рядки засіву власником, повз ядро команд; id — у порядку `rows`. */
  async function seed(
    table: string,
    rows: readonly Record<string, string | null>[]
  ): Promise<string[]> {
    const ids: string[] = []
    for (const row of rows) {
      const id = randomUUID()
      const columns = ["id", ...Object.keys(row)]
      const params = [id, ...Object.values(row)]
      await env.owner.query(
        `INSERT INTO public.${table} (${columns.join(", ")}) VALUES (${params.map((_, i) => `$${i + 1}`).join(", ")})`,
        params
      )
      ids.push(id)
    }
    return ids
  }

  /** `SELECT` під роллю запиту з claims сесії — те, що бачить PostgREST. */
  async function selectAs<R extends pg.QueryResultRow>(
    session: SessionClaims,
    sql: string,
    params: unknown[] = []
  ): Promise<R[]> {
    const client = new pg.Client({ connectionString: env.login })
    await client.connect()
    try {
      await client.query("BEGIN")
      await setLocalSetting(
        client,
        SESSION_CLAIMS_SETTING,
        JSON.stringify(session)
      )
      await client.query(`SET LOCAL ROLE ${REQUEST_ROLE}`)
      const { rows } = await client.query<R>(sql, params)
      await client.query("COMMIT")
      return rows
    } finally {
      await client.end()
    }
  }

  const notes = (rows: readonly Record<string, unknown>[]) =>
    rows.map((r) => r.note)
  const sorted = (values: readonly unknown[]) => [...values].map(String).sort()

  it("second-form reads under RLS", async () => {
    expect(env.catalog.objects.map((o) => o.name)).toContain("Region")
    const texts = [
      "a,b",
      "NULL",
      '"',
      "\\",
      "a",
      "B",
      "Pre50%_\\tail",
      // Шаблон без екранування (`%50%_\%`) знайшов би й цей рядок.
      "Pre5099%",
    ]
    const mine = await seed(
      GAUGE_LOG_TABLE,
      texts.map((note) => ({ org_id: env.me.org, note }))
    )
    // Ті самі значення в чужому скоупі: RLS ховає їх від кожної форми.
    await seed(
      GAUGE_LOG_TABLE,
      texts.map((note) => ({ org_id: env.other.org, note }))
    )
    const rt = await runtime()
    const read = <Q extends ReadQuery>(query: Q) =>
      rt.read(env.me.session, query)

    const listed = await read({
      object: GAUGE_LOG,
      where: {
        attribute: "note",
        op: "in",
        value: ["a,b", "NULL", '"', "\\"],
      },
      limit: 200,
    })
    expect(sorted(notes(listed.rows))).toEqual(
      sorted(["a,b", "NULL", '"', "\\"])
    )
    expect(listed.rows.every((r) => mine.includes(r.ref as string))).toBe(true)

    const tree: Filter = {
      and: [
        { not: { attribute: "note", op: "isNull" } },
        {
          or: [
            { attribute: "note", op: "startsWith", value: "a" },
            { attribute: "note", op: "eq", value: "B" },
          ],
        },
      ],
    }
    const orderBy: OrderBy = [{ attribute: "note", direction: "asc" }]
    const all = await read({
      object: GAUGE_LOG,
      where: tree,
      orderBy,
      limit: 200,
    })
    expect(sorted(notes(all.rows))).toEqual(sorted(["a,b", "a", "B"]))
    const second = await read({
      object: GAUGE_LOG,
      where: tree,
      orderBy,
      offset: 1,
      limit: 1,
    })
    expect(second.rows).toEqual(all.rows.slice(1, 2))
    expect(await read({ object: GAUGE_LOG, where: tree, count: true })).toEqual(
      { count: 3 }
    )

    // `%`, `_`, `\` — літерали, а регістр не важить.
    for (const [op, value] of [
      ["contains", "50%_\\TAIL"],
      ["startsWith", "pre50%_\\"],
    ] as const) {
      const found = await read({
        object: GAUGE_LOG,
        where: { attribute: "note", op, value },
        limit: 200,
      })
      expect(notes(found.rows)).toEqual(["Pre50%_\\tail"])
    }

    // `Bytes` без `load` — лінивий: список його не несе, картка — несе.
    const gauge = randomUUID()
    await rt.run(env.me.session, {
      action: "create",
      object: GAUGE,
      id: gauge,
      values: { org: env.me.org, blob: "\\x00ff" },
    })
    const page = await read({
      object: GAUGE,
      where: { attribute: "ref", op: "eq", value: gauge },
      limit: 1,
    })
    expect(page.rows).toHaveLength(1)
    expect(page.rows[0]).not.toHaveProperty("blob")
    const card = await read({ object: GAUGE, id: gauge })
    expect(card.rows[0]).toMatchObject({ ref: gauge, blob: "\\x00ff" })
  })

  // Ядро команди відхилило б невидиму ціль, тож посилання засіяне власником.
  it("include of an invisible target keeps the row", async () => {
    const [own] = await seed("region", [{ org_id: env.me.org }])
    const [foreign] = await seed("region", [{ org_id: env.other.org }])
    const gauges = await seed(GAUGE_TABLE, [
      { org_id: env.me.org, site_id: foreign! },
      { org_id: env.me.org, site_id: own! },
    ])
    const rt = await runtime()
    const card = await rt.read(env.me.session, {
      object: GAUGE,
      id: gauges[0]!,
      include: ["site"],
    })
    expect(card.rows).toEqual([
      expect.objectContaining({ ref: gauges[0], site: foreign }),
    ])
    expect(card.included).toEqual({ "Catalog.Region": [] })
    const list = await rt.read(env.me.session, {
      object: GAUGE,
      where: { attribute: "ref", op: "in", value: gauges },
      limit: 200,
      include: ["site"],
    })
    expect(list.rows).toHaveLength(2)
    expect(list.included?.["Catalog.Region"]?.map((r) => r.ref)).toEqual([own])
  })

  // Версія власника й рядки ТЧ мусять бути з одного знімка: коміт між двома
  // операторами дав би пару «стара версія — нові рядки». Коміт вклинюється
  // перед кожним оператором транзакції читання по черзі; кількість
  // операторів заміряє пробний прогін, тож розщеплення додає прогін.
  it("owner tabular section and card read one statement under a concurrent commit", async () => {
    const gauge = randomUUID()
    const line = randomUUID()
    const writer = await runtime()
    const created = await writer.run(env.me.session, {
      action: "create",
      object: GAUGE,
      id: gauge,
      values: { org: env.me.org },
      tabularSections: { lines: [{ ref: line, note: "n0" }] },
    })
    let state = { version: created.rows[0]!.version as number, note: "n0" }

    let hook: (index: number) => Promise<void> = async () => {}
    const rt = await runtime(
      beforeStatement(fromPgPool(env.pool), (index) => hook(index))
    )
    /** Транзакція B: нова примітка рядка ТЧ і нова версія власника. */
    const commitB = async () => {
      const note = `n${state.version + 1}`
      const { rows } = await writer.run(env.me.session, {
        action: "update",
        object: GAUGE,
        id: gauge,
        expectedVersion: state.version,
        values: { reading: state.version },
        tabularSections: { lines: [{ ref: line, note }] },
      })
      state = { version: rows[0]!.version as number, note }
    }
    const forms: [string, () => Promise<[unknown, unknown]>][] = [
      [
        "owner lines",
        async () => {
          const r = await rt.read(env.me.session, {
            object: GAUGE,
            tabularSection: "lines",
            owner: gauge,
          })
          return [r.ownerVersion, r.rows[0]?.note]
        },
      ],
      [
        "card",
        async () => {
          const r = await rt.read(env.me.session, {
            object: GAUGE,
            id: gauge,
            tabularSections: true,
          })
          const row = r.rows[0]!
          const lines = row.tabularSections as Record<
            string,
            { note: string }[]
          >
          return [row.version, lines.lines![0]!.note]
        },
      ],
    ]
    for (const [form, readPair] of forms) {
      let statements = 0
      hook = async () => {
        statements++
      }
      expect(await readPair()).toEqual([state.version, state.note])
      const seen = new Set<string>()
      for (let i = 0; i < statements; i++) {
        const before = state
        hook = async (index) => {
          if (index === i) await commitB()
        }
        const pair = await readPair()
        const after = state
        expect(after.version, `${form} #${i}`).toBeGreaterThan(before.version)
        const old = pair[0] === before.version && pair[1] === before.note
        const fresh = pair[0] === after.version && pair[1] === after.note
        expect(old || fresh, `${form} #${i}: ${JSON.stringify(pair)}`).toBe(
          true
        )
        seen.add(old ? "old" : "new")
      }
      // Інакше коміт не вклинився в транзакцію читання й кейс нічого не довів.
      expect([...seen].sort(), form).toEqual(["new", "old"])
    }
    hook = async () => {}

    const empty = randomUUID()
    const { rows } = await writer.run(env.me.session, {
      action: "create",
      object: GAUGE,
      id: empty,
      values: { org: env.me.org },
    })
    expect(
      await rt.read(env.me.session, {
        object: GAUGE,
        tabularSection: "lines",
        owner: empty,
      })
    ).toEqual({ rows: [], ownerVersion: rows[0]!.version })
    const [foreign] = await seed(GAUGE_TABLE, [{ org_id: env.other.org }])
    expect(
      await rt.read(env.me.session, {
        object: GAUGE,
        tabularSection: "lines",
        owner: foreign!,
      })
    ).toEqual({ rows: [] })
  })

  it("tabular section over the limit is refused", async () => {
    const [big] = await seed(GAUGE_TABLE, [{ org_id: env.me.org }])
    const [foreign] = await seed(GAUGE_TABLE, [{ org_id: env.other.org }])
    const lines = (owner: string, org: string, count: number) =>
      env.owner.query(
        "INSERT INTO public.gauge_lines (id, parent_id, org_id, line_number, note) SELECT gen_random_uuid(), $1, $2, g, 'x' FROM generate_series(1, $3::int) g",
        [owner, org, count]
      )
    await lines(big!, env.me.org, TABULAR_LINES_MAX + 1)
    await lines(foreign!, env.other.org, 3)
    const rt = await runtime()
    const tooLarge = {
      code: "command.invalid",
      reason: "tabular-too-large",
      object: GAUGE,
      path: "lines",
    }
    expect(
      await commandRefusal(
        rt.read(env.me.session, {
          object: GAUGE,
          id: big!,
          tabularSections: true,
        })
      )
    ).toEqual(tooLarge)
    expect(
      await commandRefusal(
        rt.read(env.me.session, {
          object: GAUGE,
          tabularSection: "lines",
          owner: big!,
        })
      )
    ).toEqual(tooLarge)

    const page = (owner: string) =>
      rt.read(env.me.session, {
        object: GAUGE,
        tabularSection: "lines",
        where: { attribute: "parent", op: "eq", value: owner },
        limit: 10,
      })
    const own = await page(big!)
    expect(own.rows).toHaveLength(10)
    expect(own.ownerVersion).toEqual(expect.any(Number))
    expect(await page(foreign!)).toEqual({ rows: [] })
  })

  it("order follows the column collation", async () => {
    const values = ["a", "B", "á", "b"]
    await seed(
      GAUGE_LOG_TABLE,
      values.map((note) => ({ org_id: env.me.org, note: `${note}~` }))
    )
    const rt = await runtime()
    const read = await rt.read(env.me.session, {
      object: GAUGE_LOG,
      where: { attribute: "note", op: "in", value: values.map((v) => `${v}~`) },
      orderBy: [{ attribute: "note", direction: "asc" }],
      limit: 200,
    })
    const expected = await selectAs<{ note: string }>(
      env.me.session,
      `SELECT note FROM public.${GAUGE_LOG_TABLE} WHERE note = ANY($1) ORDER BY note`,
      [values.map((v) => `${v}~`)]
    )
    expect(notes(read.rows)).toEqual(expected.map((r) => r.note))
  })

  it("read statement_timeout is command.timeout", async () => {
    // Одне з'єднання: друге читання доводить, що перше його закрило.
    const pool = new pg.Pool({ connectionString: env.login, max: 1 })
    const holder = new pg.Client({ connectionString: env.url })
    await holder.connect()
    try {
      const rt = await runtime(fromPgPool(pool), {
        readStatementTimeoutMs: 250,
      })
      const query = { object: GAUGE_LOG, limit: 1 } as const
      await holder.query("BEGIN")
      await holder.query(
        `LOCK TABLE public.${GAUGE_LOG_TABLE} IN ACCESS EXCLUSIVE MODE`
      )
      try {
        expect(await commandRefusal(rt.read(env.me.session, query))).toEqual({
          code: "command.timeout",
        })
      } finally {
        await holder.query("ROLLBACK")
      }
      expect(await rt.read(env.me.session, query)).toEqual({
        rows: expect.any(Array),
      })
    } finally {
      await holder.end()
      await pool.end()
    }
  })
})
