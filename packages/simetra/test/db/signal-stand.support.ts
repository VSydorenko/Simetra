import { randomBytes, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { networkInterfaces } from "node:os"
import { Socket } from "node:net"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  LOGIN_ROLE_SETTINGS,
  loginRoleParentNames,
  PLATFORM_ROLES,
  SIGNAL_OUTBOX,
  ZERO_UUID,
  channelTopic,
  quoteIdent,
} from "simetra/model"
import { compile } from "simetra/compiler"
import { loginSettingSql } from "../../src/schema/apply/platform-roles"
import { renderDesiredState } from "simetra/schema"
import {
  expectClean,
  metaFiles,
  project,
} from "../../src/compiler/__tests__/helpers"
import {
  loginUrl,
  runTag,
  testDatabaseName,
  testRoleName,
  testSuperuserUrl,
} from "./connection"
import { nodeExec, runContainers } from "./external"
import { testProvider } from "./profile"
import {
  downAllStands,
  grantStandConsumer,
  startSignalStand,
  type SignalStand,
} from "./signal-stand"

/**
 * Спільне тіло DB-тестів стенду сигналів обох стеків (спека профілю §5.3,
 * §10.4): справжній споживач Centrifugo над теговою базою з outbox, логін
 * `simetra_signals` з грантами лише з outbox. Вставки — від власника таблиці:
 * політики `INSERT` для ролі команд ще немає.
 */

const OUTBOX = `${quoteIdent(SIGNAL_OUTBOX.schema)}.${quoteIdent(SIGNAL_OUTBOX.name)}`
const WARMUP = 20
const MEASURED = 200
const STEP_MS = 2

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const percentile = (sorted: number[], p: number) =>
  sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!

export function defineSignalStandCases(): void {
  const database = testDatabaseName("signal")
  const password = randomBytes(12).toString("hex")
  let admin: pg.Client | undefined
  let owner: pg.Client | undefined
  let created = false
  let rolesCreated = 0
  // Роль входу прогону тієї самої форми, що `simetra_signals` (T0): спільну
  // кластерну роль тест не змінює
  const LOGIN = testRoleName("signals")
  // Група споживача прогону: спільну `simetra_signal_consumer` членом не
  // доповнюють — гейт ролей побачив би чужого члена
  const GROUP = testRoleName("signals_grp")
  // Той самий вхід без налаштування `role`: сесія лишається голою роллю входу
  const BARE = testRoleName("signals_bare")
  const ROLE_SETTING = LOGIN_ROLE_SETTINGS.signals!.role

  const urlOf = (user?: { name: string; password: string }) => {
    const url = new URL(testSuperuserUrl())
    url.pathname = `/${database}`
    return user === undefined
      ? url.toString()
      : loginUrl(url.toString(), user.name, user.password)
  }
  const consumerUrl = () => urlOf({ name: LOGIN, password })

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: testSuperuserUrl() })
    await admin.connect()
    const result = await compile(
      metaFiles({
        "project.meta.json": project({
          database: { provider: testProvider() },
        }),
      })
    )
    expectClean(result)
    await admin.query(`CREATE DATABASE ${quoteIdent(database)}`)
    created = true
    owner = new pg.Client({ connectionString: urlOf() })
    await owner.connect()
    await owner.query(renderDesiredState(result.model!).sql)
    await admin.query(`CREATE ROLE ${quoteIdent(GROUP)} NOLOGIN NOINHERIT`)
    rolesCreated = 1
    // Гранти групи — ті самі одиниці outbox, що дає генератор
    expect(await grantStandConsumer(owner, GROUP)).toBeGreaterThanOrEqual(5)
    await admin.query(
      `CREATE ROLE ${quoteIdent(LOGIN)} LOGIN NOINHERIT PASSWORD '${password}'`
    )
    rolesCreated = 2
    await admin.query(
      `GRANT ${quoteIdent(GROUP)} TO ${quoteIdent(LOGIN)} WITH INHERIT FALSE, SET TRUE`
    )
    // Налаштування — тим самим SQL, що ставить `roles` справжній ролі входу
    await admin.query(
      `CREATE ROLE ${quoteIdent(BARE)} LOGIN NOINHERIT PASSWORD '${password}'`
    )
    rolesCreated = 3
    await admin.query(
      `GRANT ${quoteIdent(GROUP)} TO ${quoteIdent(BARE)} WITH INHERIT FALSE, SET TRUE`
    )
    for (const sql of loginSettingSql({
      name: LOGIN,
      memberOf: [],
      settings: { role: GROUP },
    }))
      await admin.query(sql)
  }, 120_000)

  afterAll(async () => {
    // Спершу контейнери, потім база й пароль ролі
    try {
      await downAllStands()
    } finally {
      await owner?.end().catch(() => undefined)
      try {
        if (created)
          await admin?.query(
            `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`
          )
        if (rolesCreated >= 3)
          await admin?.query(`DROP ROLE IF EXISTS ${quoteIdent(BARE)}`)
        if (rolesCreated >= 2)
          await admin?.query(`DROP ROLE IF EXISTS ${quoteIdent(LOGIN)}`)
        if (rolesCreated >= 1)
          await admin?.query(`DROP ROLE IF EXISTS ${quoteIdent(GROUP)}`)
      } finally {
        await admin?.end().catch(() => undefined)
      }
    }
  }, 60_000)

  /** Вставка одним комітом: id рядка й мітка після повернення `COMMIT`. */
  async function publish(): Promise<{
    id: string
    channel: string
    committed: number
  }> {
    const channel = channelTopic({
      kind: "changes",
      scopeKindId: ZERO_UUID,
      scope: ZERO_UUID,
      object: randomUUID(),
    })
    const payload = {
      channel,
      data: { object: randomUUID(), op: "update" },
      idempotency_key: "0",
    }
    await owner!.query("BEGIN")
    const { rows } = await owner!.query<{ id: string }>(
      `INSERT INTO ${OUTBOX} (method, payload) VALUES ('publish', $1) RETURNING id::text AS id`,
      [JSON.stringify(payload)]
    )
    await owner!.query("COMMIT")
    return { id: rows[0]!.id, channel, committed: performance.now() }
  }

  async function arrived(
    stand: SignalStand,
    channel: string,
    id: string,
    timeoutMs = 10_000
  ): Promise<number> {
    const until = Date.now() + timeoutMs
    for (;;) {
      const found = (await stand.history(channel)).some((p) => p.data.id === id)
      const at = performance.now()
      if (found) return at
      if (Date.now() > until)
        throw new Error(`signal ${id} did not reach ${channel}`)
      await sleep(STEP_MS)
    }
  }

  const outboxIds = async () =>
    (
      await owner!.query<{ id: string }>(`SELECT id::text AS id FROM ${OUTBOX}`)
    ).rows.map((r) => r.id)

  async function waitEmpty(timeoutMs = 10_000): Promise<void> {
    const until = Date.now() + timeoutMs
    while ((await outboxIds()).length > 0) {
      if (Date.now() > until) throw new Error("outbox rows were not deleted")
      await sleep(20)
    }
  }

  const start = (listen: boolean) =>
    startSignalStand({
      databaseUrl: consumerUrl(),
      ...(listen ? { notifyUrl: consumerUrl() } : {}),
    })

  async function latencies(stand: SignalStand): Promise<number[]> {
    const out: number[] = []
    for (let i = 0; i < WARMUP + MEASURED; i++) {
      const row = await publish()
      const at = await arrived(stand, row.channel, row.id)
      if (i >= WARMUP) out.push(at - row.committed)
    }
    return out.sort((a, b) => a - b)
  }

  describe("signal stand", () => {
    it("delivers a publication, deletes the row, stamps data.id with the row id", async () => {
      const stand = await start(true)
      try {
        const row = await publish()
        await arrived(stand, row.channel, row.id)
        const [pub] = await stand.history(row.channel)
        expect(pub?.data.id).toBe(row.id)
        expect(pub?.data.op).toBe("update")
        await waitEmpty()
      } finally {
        await stand.down()
      }
    }, 60_000)

    it("with LISTEN the p95 commit-to-history is at most 50 ms", async () => {
      const stand = await start(true)
      try {
        const sorted = await latencies(stand)
        expect(percentile(sorted, 0.95)).toBeLessThanOrEqual(50)
      } finally {
        await stand.down()
      }
    }, 180_000)

    it("without LISTEN the p95 is at most 600 ms and the p50 above 100 ms", async () => {
      const stand = await start(false)
      try {
        const sorted = await latencies(stand)
        expect(percentile(sorted, 0.95)).toBeLessThanOrEqual(600)
        // Доказ, що `LISTEN` вимкнено: лише опитування дає медіану вище такту
        expect(percentile(sorted, 0.5)).toBeGreaterThan(100)
      } finally {
        await stand.down()
      }
    }, 240_000)

    it("the run login has the shape T0 prescribes for simetra_signals", async () => {
      const { rows } = await admin!.query<{
        login: boolean
        inherit: boolean
        settings: string[] | null
        parents: string[]
        pair: boolean[]
      }>(
        `SELECT r.rolcanlogin AS login, r.rolinherit AS inherit,
                (SELECT s.setconfig::text[] FROM pg_db_role_setting s
                  WHERE s.setrole = r.oid AND s.setdatabase = 0) AS settings,
                coalesce(array_agg(p.rolname::text) FILTER (WHERE p.rolname IS NOT NULL), '{}'::text[]) AS parents,
                coalesce(array_agg(m.inherit_option = false AND m.set_option) FILTER (WHERE p.rolname IS NOT NULL), '{}') AS pair
           FROM pg_roles r
           LEFT JOIN pg_auth_members m ON m.member = r.oid
           LEFT JOIN pg_roles p ON p.oid = m.roleid
          WHERE r.rolname = $1
          GROUP BY r.oid, r.rolcanlogin, r.rolinherit`,
        [LOGIN]
      )
      const row = rows[0]!
      expect(row.login).toBe(true)
      expect(row.inherit).toBe(false)
      // Група прогону стоїть на місці спільної `simetra_signal_consumer`
      expect(
        row.parents.map((p) =>
          p === GROUP ? PLATFORM_ROLES.signalConsumer : p
        )
      ).toEqual([...loginRoleParentNames("signals", testProvider())])
      expect(row.pair.every(Boolean)).toBe(true)
      expect(row.settings).toEqual([`role=${GROUP}`])
      expect(ROLE_SETTING).toBe(PLATFORM_ROLES.signalConsumer)
    })

    it("the run login only reads and deletes the outbox", async () => {
      const client = new pg.Client({ connectionString: consumerUrl() })
      await client.connect()
      try {
        const who = await client.query<{ u: string }>(
          "SELECT current_user AS u"
        )
        expect(who.rows[0]?.u).toBe(GROUP)
        await client.query(`SELECT id FROM ${OUTBOX}`)
        const payload = JSON.stringify({
          channel: `simetra:${ZERO_UUID}:${ZERO_UUID}:${randomUUID()}`,
          data: {},
          idempotency_key: "0",
        })
        const refused = async (sql: string, params: unknown[] = []) =>
          client.query(sql, params).then(
            () => "allowed",
            (error: { code?: string }) => error.code
          )
        expect(
          await refused(
            `INSERT INTO ${OUTBOX} (method, payload) VALUES ('publish', $1)`,
            [payload]
          )
        ).toBe("42501")
        expect(await refused(`UPDATE ${OUTBOX} SET partition = 0`)).toBe(
          "42501"
        )
        expect(await refused(`DELETE FROM ${OUTBOX}`)).toBe("allowed")
      } finally {
        await client.end()
      }
    })

    it("a login without the role setting has no rights", async () => {
      const client = new pg.Client({
        connectionString: urlOf({ name: BARE, password }),
      })
      await client.connect()
      try {
        const who = await client.query<{ u: string }>(
          "SELECT current_user AS u"
        )
        expect(who.rows[0]?.u).toBe(BARE)
        const refused = await client.query(`SELECT id FROM ${OUTBOX}`).then(
          () => "allowed",
          (error: { code?: string }) => error.code
        )
        expect(refused).toBe("42501")
      } finally {
        await client.end()
      }
    })

    it("two instances with use_try_lock publish every row exactly once", async () => {
      const a = await start(true)
      try {
        const b = await start(true)
        try {
          const rows = []
          for (let i = 0; i < 30; i++) rows.push(await publish())
          await waitEmpty()
          for (const row of rows) {
            const seen =
              (await a.history(row.channel)).filter((p) => p.data.id === row.id)
                .length +
              (await b.history(row.channel)).filter((p) => p.data.id === row.id)
                .length
            expect(seen, row.id).toBe(1)
          }
        } finally {
          await b.down()
        }
      } finally {
        await a.down()
      }
    }, 90_000)

    it("rows inserted while the container is restarting are published", async () => {
      const stand = await start(true)
      try {
        const rows: Awaited<ReturnType<typeof publish>>[] = []
        await stand.restart(async () => {
          for (let i = 0; i < 5; i++) rows.push(await publish())
        })
        for (const row of rows) await arrived(stand, row.channel, row.id)
        await waitEmpty()
      } finally {
        await stand.down()
      }
    }, 90_000)

    it("listens on the loopback only and keeps the DSN password out of the log", async () => {
      const stand = await start(true)
      try {
        const port = Number(new URL(stand.httpUrl).port)
        const listeners = execFileSync("ss", ["-ltnH"], { encoding: "utf8" })
          .split("\n")
          .map((line) => line.trim().split(/\s+/)[3] ?? "")
          .filter((local) => local.endsWith(`:${port}`))
        expect(listeners).toEqual([`127.0.0.1:${port}`])
        for (const nets of Object.values(networkInterfaces()))
          for (const net of nets ?? []) {
            if (net.internal || net.family !== "IPv4") continue
            const open = await new Promise<boolean>((resolve) => {
              const socket = new Socket()
              socket.setTimeout(1000)
              socket.once("connect", () => resolve(true))
              socket.once("timeout", () => resolve(false))
              socket.once("error", () => resolve(false))
              socket.connect(port, net.address)
              socket.once("close", () => socket.destroy())
            })
            expect(open, net.address).toBe(false)
          }
        expect(await stand.logs()).not.toContain(password)
      } finally {
        await stand.down()
      }
    }, 60_000)

    it("leaves no container after down() and after a throw", async () => {
      const left = async () =>
        (await runContainers(testProvider(), nodeExec)).filter(
          (c) => c.tag === runTag()
        )
      const stand = await start(false)
      expect(await left()).not.toEqual([])
      await stand.down()
      expect(await left()).toEqual([])
      await expect(
        (async () => {
          const s = await start(false)
          try {
            throw new Error("boom")
          } finally {
            await s.down()
          }
        })()
      ).rejects.toThrow("boom")
      expect(await left()).toEqual([])
    }, 90_000)
  })
}
