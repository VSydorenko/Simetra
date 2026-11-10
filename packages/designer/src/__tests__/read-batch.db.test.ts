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
  PROVIDER_API_ROLES,
  catalogIndex,
  readPartToWire,
  type KnownVersions,
  type MetadataRef,
  type ReadPart,
  type ReadQuery,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import { desiredForApply } from "simetra/schema"
import {
  createCommandRuntime,
  createDataHandler,
  fromPgPool,
  readRoleOf,
  type CommandDatabase,
  type CommandRuntime,
} from "simetra/server"
import {
  GAUGE_TABLE,
  GAUGE_WRITER_ID,
  ORG_ADMIN_ID,
  policyDomain,
  readQueryLayer,
} from "../../../simetra/test/support"
import {
  beforeStatement,
  committed,
  heldResource,
  inTarget,
  seedMarker,
  seedRuntimeActor,
  withRuntimeLogin,
} from "./support/db"

/**
 * Пакет читань з `known` (спека П4-B §4.1–§4.2) над тінню рушія. Видимість
 * рядків (RLS), знімок `REPEATABLE READ`, епоху бази й триггер копій носіїв
 * виконує Postgres — порт-фейк unit-тестів T3 цього не доводить. Читання — під
 * справжньою роллю входу, як і в `read-query.db.test.ts`.
 */

const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }
const COMMENT: MetadataRef = { kind: "Catalog", name: "TaskComment" }
const REQUEST_ROLE = readRoleOf("supabase")!
const ANONYMOUS_ROLE = PROVIDER_API_ROLES.supabase.anonymous
const HEX64 = /^[0-9a-f]{64}$/
// Інша епоха: 64 hex, якої база не видає.
const OTHER_EPOCH = "b".repeat(64)

interface Actor {
  org: string
  session: SessionClaims
}

interface Env {
  catalog: RuntimeCatalog
  owner: pg.Client
  pool: pg.Pool
  login: string
  anonymous: boolean
  me: Actor
  other: Actor
  /** Читач усього скоупу (адміністратор організації): бачить коментарі. */
  admin: Actor
}

const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const result = await compile(policyDomain(readQueryLayer()))
    expect(result.diagnostics).toEqual([])
    const model: CompiledModel = result.model!
    const desired = await desiredForApply(model)
    await inTarget(desired.sql, desired.scope, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
        // Рядок епохи пише крок `versions` застосування, якого тінь не проходить.
        await owner.query(
          "INSERT INTO simetra.version_epoch DEFAULT VALUES ON CONFLICT (singleton) DO NOTHING"
        )
        const actor = async (archetypes?: string[]): Promise<Actor> => {
          const { org, user } = await seedRuntimeActor(owner, archetypes)
          return { org, session: { sub: user, role: REQUEST_ROLE } }
        }
        const me = await actor()
        const other = await actor()
        const admin = await actor([GAUGE_WRITER_ID, ORG_ADMIN_ID])
        const anonymous =
          (
            await owner.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
              ANONYMOUS_ROLE,
            ])
          ).rowCount === 1
        await withRuntimeLogin(
          url,
          [
            PLATFORM_ROLES.command,
            REQUEST_ROLE,
            ...(anonymous ? [ANONYMOUS_ROLE] : []),
          ],
          async (login) => {
            const pool = new pg.Pool({ connectionString: login })
            try {
              await use({
                catalog: buildRuntimeCatalog(model),
                owner,
                pool,
                login,
                anonymous,
                me,
                other,
                admin,
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

type Row = Record<string, unknown>

describe("read batch with known over the engine target", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 120_000)
  afterAll(() => target.close(), 60_000)

  const runtime = (
    database: CommandDatabase = fromPgPool(env.pool)
  ): Promise<CommandRuntime> =>
    createCommandRuntime({ database, catalog: env.catalog })

  const part = (query: ReadQuery, known?: KnownVersions): ReadPart =>
    known === undefined
      ? { type: "query", query }
      : { type: "query", query, known }

  /** Рядки засіву власником, повз ядро команд. */
  async function seedGauges(org: string, count: number): Promise<string[]> {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = randomUUID()
      await env.owner.query(
        `INSERT INTO public.${GAUGE_TABLE} (id, org_id) VALUES ($1, $2)`,
        [id, org]
      )
      ids.push(id)
    }
    return ids
  }

  /** Одна частина без `known` — повні рядки, епоха бази. */
  async function full(
    rt: CommandRuntime,
    session: SessionClaims,
    query: ReadQuery
  ): Promise<{ epoch: string; rows: Row[] }> {
    const { epoch, items } = await rt.readParts(session, [part(query)])
    const item = items[0]!
    if (!item.ok || !("rows" in item.value) || epoch === null) {
      throw new Error(`unconditional read failed: ${JSON.stringify(items)}`)
    }
    return { epoch, rows: item.value.rows as Row[] }
  }

  const known = (epoch: string, rows: readonly Row[]): KnownVersions => ({
    epoch,
    keys: rows.map((r) => r.ref as string),
    versions: rows.map((r) => String(r.version)),
  })

  /** Рядки однієї частини умовного читання (успіх — інакше помилка тесту). */
  async function conditional(
    rt: CommandRuntime,
    session: SessionClaims,
    query: ReadQuery,
    heldKnown: KnownVersions
  ): Promise<Row[]> {
    const { items } = await rt.readParts(session, [part(query, heldKnown)])
    const item = items[0]!
    if (!item.ok || !("rows" in item.value)) {
      throw new Error(`conditional read failed: ${JSON.stringify(items)}`)
    }
    return item.value.rows as Row[]
  }

  it("reads the epoch under every request role of the provider", async () => {
    const rt = await runtime()
    const { epoch } = await full(rt, env.me.session, {
      object: GAUGE,
      limit: 1,
    })
    expect(epoch).toMatch(HEX64)
    const roles = [REQUEST_ROLE, ...(env.anonymous ? [ANONYMOUS_ROLE] : [])]
    for (const role of roles) {
      const client = new pg.Client({ connectionString: env.login })
      await client.connect()
      try {
        await client.query("BEGIN")
        await client.query(`SET LOCAL ROLE ${role}`)
        const { rows } = await client.query<{ epoch: string }>(
          "SELECT simetra.row_version_epoch() AS epoch"
        )
        await client.query("COMMIT")
        expect(rows[0]!.epoch, role).toBe(epoch)
      } finally {
        await client.end()
      }
    }
  })

  it("answers a marker only for an equal version and epoch, and hides rows RLS hides", async () => {
    const [a, b, c, z] = await seedGauges(env.me.org, 4)
    const [hidden] = await seedGauges(env.other.org, 1)
    const rt = await runtime()
    const where = {
      attribute: "ref",
      op: "in",
      value: [a!, b!, c!, hidden!],
    } as const
    const query: ReadQuery = {
      object: GAUGE,
      where,
      orderBy: [{ attribute: "ref", direction: "asc" }],
      limit: 200,
    }
    const { epoch, rows } = await full(rt, env.me.session, query)
    // Чужий рядок RLS ховає навіть від безумовного читання.
    expect(rows.map((r) => r.ref).sort()).toEqual([a, b, c].sort())
    const byRef = new Map(rows.map((r) => [r.ref as string, r]))
    const hiddenVersion = (
      await env.owner.query<{ version: string }>(
        `SELECT version::text FROM public.${GAUGE_TABLE} WHERE id = $1`,
        [hidden]
      )
    ).rows[0]!.version
    const zVersion = (
      await env.owner.query<{ version: string }>(
        `SELECT version::text FROM public.${GAUGE_TABLE} WHERE id = $1`,
        [z]
      )
    ).rows[0]!.version

    const held: KnownVersions = {
      epoch,
      // `c` не в `known`; `hidden` невидимий під RLS; `z` поза `where`.
      keys: [a!, b!, hidden!, z!],
      versions: [
        String(byRef.get(a!)!.version),
        // Інша версія, ніж у бази.
        String(Number(byRef.get(b!)!.version) + 1000),
        hiddenVersion,
        zVersion,
      ],
    }
    const conditionalRows = await conditional(rt, env.me.session, query, held)
    const keyOf = (row: Row) =>
      "known" in row ? held.keys[row.known as number]! : (row.ref as string)
    // Склад і порядок рядків — ті самі, що й у безумовного читання.
    expect(conditionalRows.map(keyOf)).toEqual(rows.map((r) => r.ref))
    for (const [i, row] of conditionalRows.entries()) {
      const ref = rows[i]!.ref as string
      if (ref === a) {
        // Рівна версія й епоха.
        expect(row).toEqual({ known: 0 })
      } else {
        // Інша версія й ключ поза `known` — повний рядок поряд із маркером.
        expect(row, ref).toEqual(rows[i])
      }
    }
    expect(conditionalRows.map(keyOf)).not.toContain(hidden)
    expect(conditionalRows.map(keyOf)).not.toContain(z)
    expect(JSON.stringify(conditionalRows)).not.toContain(hidden!)

    // Картка: рівна версія — маркер, інша епоха — повний рядок.
    const card: ReadQuery = { object: GAUGE, id: a! }
    // Картка несе й ліниві колонки, яких немає в списку.
    const cardRow = (await full(rt, env.me.session, card)).rows[0]!
    expect(
      await conditional(rt, env.me.session, card, known(epoch, [cardRow]))
    ).toEqual([{ known: 0 }])
    expect(
      await conditional(rt, env.me.session, card, known(OTHER_EPOCH, [cardRow]))
    ).toEqual([cardRow])
    // Картка рядка, який ховає RLS, з його версією в `known`: ні рядка, ні
    // маркера — маркер підтвердив би існування невидимого рядка.
    expect(
      await conditional(
        rt,
        env.me.session,
        { object: GAUGE, id: hidden! },
        known(epoch, [{ ref: hidden, version: hiddenVersion }])
      )
    ).toEqual([])
  })

  it("conditional list matches the unconditional one for limit and offset", async () => {
    const ids = await seedGauges(env.me.org, 6)
    const rt = await runtime()
    const base: ReadQuery = {
      object: GAUGE,
      where: { attribute: "ref", op: "in", value: ids },
      orderBy: [{ attribute: "ref", direction: "asc" }],
      limit: 200,
    }
    const all = await full(rt, env.me.session, base)
    expect(all.rows).toHaveLength(6)
    // Чергові рядки відомі клієнтові, решта — ні.
    const held = known(
      all.epoch,
      all.rows.filter((_, i) => i % 2 === 0)
    )
    for (const [offset, limit] of [
      [0, 6],
      [1, 3],
      [2, 2],
      [5, 10],
    ] as const) {
      const query: ReadQuery = { ...base, offset, limit }
      const plain = await full(rt, env.me.session, query)
      const conditionalRows = await conditional(rt, env.me.session, query, held)
      expect(conditionalRows.length, `${offset}/${limit}`).toBe(
        plain.rows.length
      )
      expect(
        conditionalRows.map((row) =>
          "known" in row ? held.keys[row.known as number] : row.ref
        )
      ).toEqual(plain.rows.map((r) => r.ref))
    }
  })

  it("a known of another epoch gets full rows", async () => {
    const ids = await seedGauges(env.me.org, 2)
    const rt = await runtime()
    const query: ReadQuery = {
      object: GAUGE,
      where: { attribute: "ref", op: "in", value: ids },
      orderBy: [{ attribute: "ref", direction: "asc" }],
      limit: 200,
    }
    const { epoch, rows } = await full(rt, env.me.session, query)
    expect(
      await conditional(rt, env.me.session, query, known(OTHER_EPOCH, rows))
    ).toEqual(rows)
    // Контроль: з епохою бази ті самі ключі й версії дали б маркери.
    expect(
      await conditional(rt, env.me.session, query, known(epoch, rows))
    ).toEqual([{ known: 0 }, { known: 1 }])
  })

  it("a base without the epoch row answers epoch null and full rows", async () => {
    const ids = await seedGauges(env.me.org, 2)
    const rt = await runtime()
    const query: ReadQuery = {
      object: GAUGE,
      where: { attribute: "ref", op: "in", value: ids },
      orderBy: [{ attribute: "ref", direction: "asc" }],
      limit: 200,
    }
    const { epoch, rows } = await full(rt, env.me.session, query)
    // Тінь — лише цього файла; рядок повертається в `finally`, а епоха
    // відновленого рядка — нова, тож далі кейси беруть її заново.
    await env.owner.query("DELETE FROM simetra.version_epoch")
    try {
      const result = await rt.readParts(env.me.session, [
        part(query, known(epoch, rows)),
      ])
      expect(result.epoch).toBeNull()
      expect(result.items).toEqual([{ ok: true, value: { rows } }])
    } finally {
      await env.owner.query(
        "INSERT INTO simetra.version_epoch DEFAULT VALUES ON CONFLICT (singleton) DO NOTHING"
      )
    }
  })

  it("a copy of a carrier moves without a version and the partial marker carries it current", async () => {
    const { org, session } = env.admin
    const [oldAssignee, newAssignee] = [randomUUID(), randomUUID()]
    for (const member of [oldAssignee, newAssignee]) {
      await env.owner.query(
        "INSERT INTO public.org_member (id, org_id) VALUES ($1, $2)",
        [member, org]
      )
    }
    const task = randomUUID()
    const comment = randomUUID()
    await env.owner.query(
      "INSERT INTO public.task (id, org_id, date, assignee_id) VALUES ($1, $2, now(), $3)",
      [task, org, oldAssignee]
    )
    await env.owner.query(
      "INSERT INTO public.task_comment (id, org_id, task_id) VALUES ($1, $2, $3)",
      [comment, org, task]
    )
    const rt = await runtime()
    const card: ReadQuery = { object: COMMENT, id: comment }
    const before = await full(rt, session, card)
    const row = before.rows[0]!
    expect(row.task_id_assignee_id).toBe(oldAssignee)

    // Копію переписує платформа зі зміною джерела, версія рядка не рухається.
    await env.owner.query(
      "UPDATE public.task SET assignee_id = $1 WHERE id = $2",
      [newAssignee, task]
    )
    const after = await full(rt, session, card)
    const moved = after.rows[0]!
    expect(moved.version).toBe(row.version)
    expect(moved.task_id_assignee_id).toBe(newAssignee)

    const [marker] = await conditional(
      rt,
      session,
      card,
      known(before.epoch, [row])
    )
    // Частковий маркер: значення копії — те саме, що в повному рядку.
    expect(marker).toEqual({
      known: 0,
      copies: { task_id_assignee_id: newAssignee },
    })
    expect((marker as { copies: Row }).copies.task_id_assignee_id).toBe(
      moved.task_id_assignee_id
    )
  })

  it("two parts read one snapshot under a concurrent commit between them", async () => {
    const [existing] = await seedGauges(env.me.org, 1)
    const added = randomUUID()
    const query: ReadQuery = {
      object: GAUGE,
      where: { attribute: "ref", op: "in", value: [existing!, added] },
      orderBy: [{ attribute: "ref", direction: "asc" }],
      limit: 200,
    }
    const plain = await runtime()
    const { epoch, rows } = await full(plain, env.me.session, query)
    expect(rows.map((r) => r.ref)).toEqual([existing])
    const held = known(epoch, rows)

    // Оператори: 0 BEGIN, 1 налаштування, 2 епоха, 3 перша частина, 4 друга.
    let armed = false
    let committedAt = -1
    const hooked = await runtime(
      beforeStatement(fromPgPool(env.pool), async (index) => {
        // Створення рантайму теж ходить у базу: хук діє лише на читання.
        if (!armed || index !== 4) return
        committedAt = index
        // Коміт іншого з'єднання: новий рядок і нова версія наявного.
        await committed(env.owner, async () => {
          await env.owner.query(
            `INSERT INTO public.${GAUGE_TABLE} (id, org_id) VALUES ($1, $2)`,
            [added, env.me.org]
          )
          await env.owner.query(
            `UPDATE public.${GAUGE_TABLE} SET reading = 1 WHERE id = $1`,
            [existing]
          )
        })
      })
    )
    armed = true
    const result = await hooked.readParts(env.me.session, [
      part(query),
      part(query, held),
    ])
    expect(committedAt).toBe(4)
    expect(result.epoch).toBe(epoch)
    // Обидві частини бачать стан до коміту: той самий рядок і та сама версія,
    // тож друга частина відповідає маркером, а не новим рядком.
    expect(result.items).toEqual([
      { ok: true, value: { rows } },
      { ok: true, value: { rows: [{ known: 0 }] } },
    ])

    // Контроль: після коміту читання бачить обидва рядки й нову версію.
    const fresh = await full(plain, env.me.session, query)
    expect(fresh.rows.map((r) => r.ref).sort()).toEqual(
      [existing, added].sort()
    )
    expect(fresh.rows.find((r) => r.ref === existing)!.version).not.toBe(
      rows[0]!.version
    )
  })

  it("the wire form of a read part answers markers and a 64 hex epoch", async () => {
    const [id] = await seedGauges(env.me.org, 1)
    const rt = await runtime()
    const { epoch, rows } = await full(rt, env.me.session, {
      object: GAUGE,
      id: id!,
    })
    const index = catalogIndex(env.catalog.objects)
    const wire = readPartToWire(
      index,
      part({ object: GAUGE, id: id! }, known(epoch, rows))
    )
    if (!wire.ok) throw new Error(`unmapped: ${JSON.stringify(wire)}`)
    const handler = createDataHandler(rt)
    const response = await handler(
      env.me.session,
      {
        subject: env.me.session.sub,
        request: { type: "read", items: [wire.value] },
      },
      { inProcess: true }
    )
    expect(response.ok, JSON.stringify(response)).toBe(true)
    const value = (response as { value: { epoch: string; items: unknown[] } })
      .value
    expect(value.epoch).toMatch(HEX64)
    expect(value.epoch).toBe(epoch)
    expect(value.items).toEqual([{ ok: true, value: { rows: [0] } }])
  })
})
