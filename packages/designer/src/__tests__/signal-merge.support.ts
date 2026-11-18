import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  PLATFORM_ROLES,
  SIGNAL_MERGE_MODE,
  SIGNAL_MODE_SETTING,
  SIGNAL_OUTBOX,
  channelTopic,
  quoteIdent,
  type Operation,
} from "simetra/model"
import {
  createCommandRuntime,
  fromPgPool,
  type CommandDatabase,
} from "simetra/server"
import {
  MEMBER_CREATOR_ID,
  ORG_KIND_ID,
  TICKET_WRITER_ID,
  policyDomain,
  profileLayer,
  signUp,
  superuserClient,
  tenantSelfService,
} from "../../../simetra/test/support"
import { buildRuntimeCatalog, compile } from "simetra/compiler"
import { SIGNAL_FUNCTIONS } from "../../../simetra/src/compiler/signal/names"
import {
  committed,
  heldResource,
  seedMarker,
  sessionOf,
  withModelTarget,
  withRuntimeLogin,
} from "./support/db"
import {
  MEMBERS,
  REQUEST_ROLE,
  TICKET,
  type Env,
  type Org,
  heldEnv,
  seedOrg,
} from "./rights-admin-commands.support"

/**
 * Режим злиття сигналів (спека П4-B §8.2) через `runtime.run` над ціллю,
 * розгорнутою справжніми `plan` + `apply`: чи гасить ядро сигнал після
 * перемикання, чи пропускає політика outbox `invalidate` пари і чи не
 * гасить режиму значення ролі входу, вирішує Postgres — порт-фейк unit-тестів
 * T3 цього не доводить. Поріг — малий і явний, щоб пакет лишався коротким.
 */

const THRESHOLD = 3
const OUTBOX = `${quoteIdent(SIGNAL_OUTBOX.schema)}.${quoteIdent(SIGNAL_OUTBOX.name)}`

interface Signal {
  channel: string
  data: Record<string, unknown>
}

/**
 * Рантайм над роллю входу форми `simetra_runtime` і порт `wrap` над її пулом;
 * роль — тегована, видаляється разом із пулом. `prepare` отримує ім'я ролі
 * до першого з'єднання пулу: налаштування ролі діють з входу.
 */
async function withRuntime<T>(
  env: Env,
  fn: (run: (operations: Operation[]) => Promise<unknown>) => Promise<T>,
  options: {
    prepare?: (role: string) => Promise<void>
    wrap?: (database: CommandDatabase) => CommandDatabase
    session: Org["people"][string]["session"]
  }
): Promise<T> {
  return withRuntimeLogin(
    env.url,
    [PLATFORM_ROLES.command, REQUEST_ROLE],
    async (login) => {
      await options.prepare?.(decodeURIComponent(new URL(login).username))
      const pool = new pg.Pool({ connectionString: login })
      try {
        const port = fromPgPool(pool)
        const runtime = await createCommandRuntime({
          database: options.wrap?.(port) ?? port,
          catalog: env.catalog,
          signalMergeThreshold: THRESHOLD,
        })
        return await fn((operations) =>
          runtime.run(options.session, operations)
        )
      } finally {
        await pool.end()
      }
    },
    "sig_merge"
  )
}

/**
 * Порт, що одразу за оператором claims команди (він скидає режим, Р14)
 * ставить режиму `value`: так у транзакції команди стоїть значення, яке не
 * є точним значенням злиття.
 */
const withMode =
  (value: string) =>
  (inner: CommandDatabase): CommandDatabase => ({
    async connect() {
      const client = await inner.connect()
      return {
        async query(text, params) {
          const result = await client.query(text, params)
          if (text.includes(SIGNAL_MODE_SETTING)) {
            await client.query(
              "SELECT set_config('simetra.signal_mode', $1, true)",
              [value]
            )
          }
          return result
        },
        release: (destroy) => client.release(destroy),
      }
    },
  })

export function describeSignalMerge(): void {
  describe("signal merge mode over a planned and applied target", () => {
    const target = heldEnv()
    let env: Env
    let org: Org

    beforeAll(async () => {
      env = await target.open()
      org = await seedOrg(env.owner, {
        writer: [TICKET_WRITER_ID, MEMBER_CREATOR_ID],
      })
    }, 180_000)
    afterAll(() => target.close(), 60_000)

    const writer = () => org.people.writer!
    const objectId = (name: string) =>
      env.catalog.objects.find((o) => o.name === name)!.id
    const ticketId = () => objectId(TICKET.name)
    const channel = () =>
      channelTopic({
        kind: "changes",
        scopeKindId: ORG_KIND_ID,
        scope: org.id,
        object: ticketId(),
      })
    const creates = (n: number): Operation[] =>
      Array.from({ length: n }, () => ({
        action: "create",
        object: TICKET,
        id: randomUUID(),
        values: { org: org.id },
      }))

    /** Сигнали, які дописала команда `work`, у порядку вставки — читає власник. */
    const signalsOf = async (work: () => Promise<unknown>) => {
      const { rows } = await env.owner.query<{ id: string }>(
        `SELECT coalesce(max(id), 0)::text AS id FROM ${OUTBOX}`
      )
      await work()
      return (
        await env.owner.query<{ payload: Signal }>(
          `SELECT payload FROM ${OUTBOX} WHERE id > $1::bigint ORDER BY id`,
          [rows[0]!.id]
        )
      ).rows.map(({ payload }) => ({
        channel: payload.channel,
        op: payload.data.op,
      }))
    }
    const change = () => ({ channel: channel(), op: "create" })
    const invalidate = () => ({ channel: channel(), op: "invalidate" })

    it("Ticket is a signal object of the catalog", () => {
      expect(
        env.catalog.objects.find((o) => o.name === TICKET.name)?.signal
      ).toBe(true)
    })

    it("a signal per phase up to the threshold, none after, one invalidate per pair", async () => {
      const signals = await signalsOf(() =>
        withRuntime(env, (run) => run(creates(THRESHOLD + 2)), {
          session: writer().session,
        })
      )
      expect(signals).toEqual([
        ...Array.from({ length: THRESHOLD }, change),
        invalidate(),
      ])
    })

    it("no invalidate at the threshold itself", async () => {
      const signals = await signalsOf(() =>
        withRuntime(env, (run) => run(creates(THRESHOLD)), {
          session: writer().session,
        })
      )
      expect(signals).toEqual(Array.from({ length: THRESHOLD }, change))
    })

    // Пізніша фаза над членством писаря: вона — сама нова пара в режимі
    // злиття зі своїм `invalidate`, а вже надісланий `invalidate` Ticket
    // лишається. Вивести писаря зі скоупу в межах транзакції команда не
    // може: множина скоупів під знімком актора зафіксована на транзакцію
    // (спека прав §7), команди членства не мають `delete`, а користувача
    // рядка членства не змінюють. Проба перед `COMMIT` це й показує: канал
    // Ticket і далі дозволено для відправки. Порядок «на фазі, а не перед
    // `COMMIT`» тримає unit-тест T3 (`signal-merge.test.ts`).
    it("a later phase on the writer's membership is its own pair and loses no sent invalidate", async () => {
      const { rows } = await env.owner.query<{ version: number }>(
        "SELECT version::int AS version FROM public.org_member WHERE id = $1",
        [writer().member]
      )
      let allowedBeforeCommit: unknown
      const probe = (inner: CommandDatabase): CommandDatabase => ({
        async connect() {
          const client = await inner.connect()
          return {
            async query(text, params) {
              if (text === "COMMIT") {
                const { rows: probed } = await client.query(
                  `SELECT ${quoteIdent(SIGNAL_FUNCTIONS.topicAllowed.schema)}.${quoteIdent(SIGNAL_FUNCTIONS.topicAllowed.name)}($1, true)::text AS ok`,
                  [channel()]
                )
                allowedBeforeCommit = probed[0]?.ok
              }
              return client.query(text, params)
            },
            release: (destroy) => client.release(destroy),
          }
        },
      })
      const signals = await signalsOf(() =>
        withRuntime(
          env,
          (run) =>
            run([
              ...creates(THRESHOLD + 1),
              {
                action: "markDeletion",
                object: MEMBERS,
                id: writer().member,
                expectedVersion: rows[0]!.version,
                mark: true,
              },
            ]),
          { session: writer().session, wrap: probe }
        )
      )
      // Порт рантайму віддає значення текстом Postgres.
      expect(allowedBeforeCommit).toBe("true")
      // Фаза членства — сама нова пара в режимі злиття: свій `invalidate`.
      expect(signals).toEqual([
        ...Array.from({ length: THRESHOLD }, change),
        invalidate(),
        {
          channel: channelTopic({
            kind: "changes",
            scopeKindId: ORG_KIND_ID,
            scope: org.id,
            object: objectId(MEMBERS.name),
          }),
          op: "invalidate",
        },
      ])
      const marked = await env.owner.query<{ marked: boolean }>(
        "SELECT deletion_mark AS marked FROM public.org_member WHERE id = $1",
        [writer().member]
      )
      expect(marked.rows).toEqual([{ marked: true }])
      // Позначку знято: наступні кейси пишуть від того самого учасника.
      await env.owner.query(
        "UPDATE public.org_member SET deletion_mark = false WHERE id = $1",
        [writer().member]
      )
    })

    it.each([
      ["another case", "MERGE"],
      ["a trailing space", "merge "],
    ])("a mode value with %s mutes no signal", async (_, value) => {
      const signals = await signalsOf(() =>
        withRuntime(env, (run) => run(creates(2)), {
          session: writer().session,
          wrap: withMode(value),
        })
      )
      expect(signals).toEqual([change(), change()])
    })

    // Р14: режим скидає оператор claims команди, тож значення з
    // `ALTER ROLE … SET` ролі входу сигналу на фазу не гасить.
    it("ALTER ROLE … SET of the merge mode on the login role mutes no signal", async () => {
      let seen: string | undefined
      const signals = await signalsOf(() =>
        withRuntime(
          env,
          async (run) => {
            await run(creates(2))
          },
          {
            session: writer().session,
            prepare: async (role) => {
              const admin = await superuserClient()
              try {
                const [prefix, name] = SIGNAL_MODE_SETTING.split(".")
                await admin.query(
                  `ALTER ROLE ${quoteIdent(role)} SET ${quoteIdent(prefix!)}.${quoteIdent(name!)} = '${SIGNAL_MERGE_MODE}'`
                )
              } finally {
                await admin.end()
              }
            },
            wrap: (inner) => ({
              async connect() {
                const client = await inner.connect()
                // Передумова: вхід справді несе режим злиття з ролі.
                const { rows } = await client.query(
                  `SELECT current_setting('${SIGNAL_MODE_SETTING}', true) AS mode`
                )
                seen = rows[0]?.mode as string | undefined
                return client
              },
            }),
          }
        )
      )
      expect(seen).toBe("merge")
      expect(signals).toEqual([change(), change()])
    })
  })
}

/**
 * Створення кореня виду скоупу в режимі злиття (Р9: пара кореня — його
 * власний id): ядро сигналу кореня не шле, T3 дає один `invalidate` у канал
 * нового кореня, і політика outbox його пропускає — творець бачить новий
 * скоуп у тій самій транзакції (модель з `rootCreator`).
 */
export function describeRootMerge(): void {
  describe("signal merge mode on a scope root creation", () => {
    const target = heldResource<{ url: string; owner: pg.Client; env: Env }>(
      async (use) => {
        const result = await compile(
          policyDomain(
            tenantSelfService({ requiredMember: true }),
            profileLayer()
          )
        )
        expect(result.diagnostics).toEqual([])
        const model = result.model!
        await withModelTarget(model, async (url) => {
          const owner = new pg.Client({ connectionString: url })
          await owner.connect()
          try {
            await seedMarker(owner, model.hash)
            await use({
              url,
              owner,
              env: {
                dir: "",
                url,
                model,
                catalog: buildRuntimeCatalog(model),
                owner,
              },
            })
          } finally {
            await owner.end()
          }
        })
      }
    )
    let held: { url: string; owner: pg.Client; env: Env }

    beforeAll(async () => {
      held = await target.open()
    }, 180_000)
    afterAll(() => target.close(), 60_000)

    it("a root create after the switch: one invalidate into the root's own channel, no row signal", async () => {
      const { env, owner } = held
      let creator = ""
      await committed(owner, async () => {
        creator = await signUp(owner)
      })
      const organization = env.catalog.objects.find(
        (o) => o.name === "Organization"
      )!
      expect(organization.signal).toBe(true)
      const before = (
        await owner.query<{ id: string }>(
          `SELECT coalesce(max(id), 0)::text AS id FROM ${OUTBOX}`
        )
      ).rows[0]!.id
      // Поріг 1: перший корінь шле свій сигнал і вмикає режим, другий —
      // уже в режимі злиття.
      const created = await withRuntimeLogin(
        env.url,
        [PLATFORM_ROLES.command, REQUEST_ROLE],
        async (login) => {
          const pool = new pg.Pool({ connectionString: login })
          try {
            const runtime = await createCommandRuntime({
              database: fromPgPool(pool),
              catalog: env.catalog,
              signalMergeThreshold: 1,
            })
            const create = (title: string): Operation => ({
              action: "create",
              object: { kind: "Catalog", name: "Organization" },
              creatorMember: { title },
            })
            return await runtime.run(sessionOf(creator), [
              create("first"),
              create("second"),
            ])
          } finally {
            await pool.end()
          }
        },
        "sig_root"
      )
      const [first, second] = created.rows.map(
        (row) => row[organization.keyName] as string
      )
      const { rows } = await owner.query<{ payload: Signal }>(
        `SELECT payload FROM ${OUTBOX} WHERE id > $1::bigint ORDER BY id`,
        [before]
      )
      const rootChannel = (root: string) =>
        channelTopic({
          kind: "changes",
          scopeKindId: ORG_KIND_ID,
          scope: root,
          object: organization.id,
        })
      expect(
        rows.map(({ payload }) => ({
          channel: payload.channel,
          op: payload.data.op,
        }))
      ).toEqual([
        { channel: rootChannel(first!), op: "create" },
        { channel: rootChannel(second!), op: "invalidate" },
      ])
    })
  })
}
