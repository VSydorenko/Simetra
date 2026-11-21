import { randomUUID } from "node:crypto"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  SIGNAL_MERGE_MODE,
  SIGNAL_MODE_SETTING,
  SIGNAL_OUTBOX,
  ZERO_UUID,
  channelTopic,
  objectTable,
  type CommandContext,
} from "simetra/model"
import {
  ORG_KIND_ID,
  RIGHTS_ADMIN_ID,
  TASK_VIEWER_ID,
  TENANT_OWNER_ID,
  TICKET_TABLE,
  adminRoles,
  commandCoreLayer,
  compileRights,
  policyDomain,
  tenantSelfService,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import {
  type CommandStep,
  type Refusal,
  claimsFor,
  commandSteps,
  setLocalSetting,
} from "./connection"
import {
  type Seed,
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  profileLayer,
  seedCommandCore,
} from "./rights-seed"

/**
 * Сигнал ядра команд на справжньому Postgres (спека П4-B §8.2; інваріанти
 * 5 і 6 плану B2): чи пропускає політика outbox рядок, який пише
 * `simetra.signal` під роллю команд, що бачить RLS після DML і чи відкат
 * забирає рядок, — вирішує Postgres, компілятор бачить лише текст.
 */

const OUTBOX = `${SIGNAL_OUTBOX.schema}.${SIGNAL_OUTBOX.name}`
const ASSIGNMENTS = "org_role_assignments"
const ORG = "organization"
const SIGNAL_SQL =
  "SELECT simetra.signal($1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::bigint, $6::text)"
const INVALIDATE_SQL =
  "SELECT simetra.signal_invalidate($1::uuid, $2::uuid, $3::uuid)"

interface OutboxRow {
  id: string
  payload: {
    channel: string
    data: Record<string, unknown>
    idempotency_key: string
  }
}

/** Рядки outbox у порядку вставки — читає власник (RLS без `FORCE`). */
const outboxRows = async (client: pg.Client) =>
  (
    await client.query<OutboxRow>(
      `SELECT id::text AS id, payload FROM ${OUTBOX} ORDER BY id`
    )
  ).rows
const readOutbox: CommandStep = { check: outboxRows }

/** Очікуваний рядок outbox сигналу зміни: `data` — рівно п'ять полів. */
const changeRow = (
  channel: { kind: string; scope: string; object: string },
  op: string,
  key: string,
  version: string
) => ({
  id: expect.stringMatching(/^[1-9][0-9]*$/) as unknown as string,
  payload: {
    channel: channelTopic({
      kind: "changes",
      scopeKindId: channel.kind,
      scope: channel.scope,
      object: channel.object,
    }),
    data: {
      id: expect.any(String) as unknown as string,
      object: channel.object,
      op,
      keys: { id: key },
      row_ver: Number(version),
    },
    idempotency_key: expect.any(String) as unknown as string,
  },
})

/**
 * Очікуваний сигнал прав користувача (§8.2): команда, що змінює факт прав
 * (призначення, членство), дає його тригером таблиці фактів — `data` рівно
 * `{ id, op }`.
 */
const userRightsRow = (userId: string) => ({
  id: expect.stringMatching(/^[1-9][0-9]*$/) as unknown as string,
  payload: {
    channel: channelTopic({ kind: "user", userId }),
    data: { id: expect.any(String) as unknown as string, op: "rights" },
    idempotency_key: expect.any(String) as unknown as string,
  },
})

/** `id`, `data.id` і ключ ідемпотентності — той самий id рядка (Р4, Р13). */
const sameIds = (rows: OutboxRow[]) =>
  rows.every(
    (r) => r.payload.data.id === r.id && r.payload.idempotency_key === r.id
  )

const objectIdOf = (model: CompiledModel, table: string) =>
  objectTable(model.physical.tables.find((t) => t.name === table)!).origin
    .objectId

/** Сценарій без відмови: інакше — причина в повідомленні, а не «undefined». */
function succeeded(outcome: { completed: unknown[]; refusal?: Refusal }) {
  expect(outcome.refusal).toBeUndefined()
  return outcome.completed
}

/** Відмова саме політики outbox, а не гранту чи перемикання ролі. */
const BY_POLICY = {
  code: "42501",
  message: `new row violates row-level security policy for table "${SIGNAL_OUTBOX.name}"`,
}

/**
 * `platformRoles` — чи може з'єднання тестів стати роллю команд: на
 * Supabase вхід тестів (`postgres`) цього не може (рішення архітекторки до
 * задачі 7), тож там лишаються гранти функцій і тіло `signal` від власника.
 */
export function defineSignalCoreCases(options: {
  platformRoles: boolean
}): void {
  describe("signal functions", () => {
    const tx = describeTransaction()
    let model: CompiledModel

    beforeAll(async () => {
      const result = await compileRights(
        policyDomain(writeRoles(), profileLayer())
      )
      expect(result.diagnostics).toEqual([])
      model = result.model!
      const client = await tx.open()
      await deploy(client, model)
    }, 120_000)
    afterAll(() => tx.close())

    // Інваріант 6: `EXECUTE` на відправці — лише роль команд; ні `PUBLIC`,
    // ні ролі запиту провайдера, ні споживач. Живу відмову ролей запиту
    // показує `signal-topic-allowed`.
    it("grants EXECUTE on signal and signal_invalidate only to the command role", async () => {
      const { rows } = await tx.client().query<{ fn: string; role: string }>(
        `SELECT p.proname AS fn, coalesce(r.rolname, 'PUBLIC') AS role
           FROM pg_proc p
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           LEFT JOIN pg_roles r ON r.oid = a.grantee
          WHERE p.oid IN ('simetra.signal(uuid, uuid, uuid, jsonb, bigint, text)'::regprocedure,
                          'simetra.signal_invalidate(uuid, uuid, uuid)'::regprocedure)
            AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
          ORDER BY 1, 2`
      )
      expect(rows).toEqual([
        { fn: "signal", role: PLATFORM_ROLES.command },
        { fn: "signal_invalidate", role: PLATFORM_ROLES.command },
      ])
    })

    /**
     * Тіло відправки від власника (політика outbox його не судить): канал і
     * `data` рівно за схемою відправки; режим злиття — лише точне значення.
     */
    const asOwner = async (
      mode: string | undefined,
      sql: string,
      params: unknown[]
    ) => {
      const client = tx.client()
      await client.query("SAVEPOINT signal_body")
      try {
        if (mode !== undefined)
          await setLocalSetting(client, SIGNAL_MODE_SETTING, mode)
        await client.query(sql, params)
        return await outboxRows(client)
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT signal_body")
      }
    }
    const scope = randomUUID()
    const row = randomUUID()
    const signalParams = () => [
      objectIdOf(model, "project"),
      ORG_KIND_ID,
      scope,
      JSON.stringify({ id: row }),
      7,
      "update",
    ]

    it.each([
      ["without the setting", undefined],
      ["an empty mode", ""],
      ["another case", SIGNAL_MERGE_MODE.toUpperCase()],
      ["a trailing space", `${SIGNAL_MERGE_MODE} `],
    ])("signal writes one row %s", async (_, mode) => {
      const rows = await asOwner(mode, SIGNAL_SQL, signalParams())
      expect(rows).toEqual([
        changeRow(
          {
            kind: ORG_KIND_ID,
            scope,
            object: objectIdOf(model, "project"),
          },
          "update",
          row,
          "7"
        ),
      ])
      expect(sameIds(rows)).toBe(true)
    })

    it("signal writes nothing in the exact merge mode", async () => {
      expect(
        await asOwner(SIGNAL_MERGE_MODE, SIGNAL_SQL, signalParams())
      ).toEqual([])
    })

    it("signal_invalidate writes an invalidate even in the merge mode", async () => {
      const object = objectIdOf(model, "project")
      const rows = await asOwner(SIGNAL_MERGE_MODE, INVALIDATE_SQL, [
        object,
        ORG_KIND_ID,
        scope,
      ])
      expect(rows.map((r) => r.payload)).toEqual([
        {
          channel: channelTopic({
            kind: "changes",
            scopeKindId: ORG_KIND_ID,
            scope,
            object,
          }),
          data: { id: rows[0]!.id, object, op: "invalidate" },
          idempotency_key: rows[0]!.id,
        },
      ])
    })
  })

  if (!options.platformRoles) return

  describe("signal of the command core", () => {
    const tx = describeTransaction()
    let ids: Seed = {}
    let model: CompiledModel

    beforeAll(async () => {
      const result = await compileRights(
        policyDomain(
          writeRoles(),
          adminRoles(),
          commandCoreLayer(),
          profileLayer()
        )
      )
      expect(result.diagnostics).toEqual([])
      model = result.model!
      const client = await tx.open()
      await deploy(client, model)
      ids = await seedCommandCore(client)
      // `tw` ще адмініструє права в A; `X` — призначення `rd@A`, яке він
      // видаляє й створює знову.
      await insert(client, ASSIGNMENTS, {
        org_id: ids.A,
        ...assignmentRow(ids["tw@A"]!, { archetype: RIGHTS_ADMIN_ID }),
      })
      ids.X = randomUUID()
      await insert(client, ASSIGNMENTS, {
        org_id: ids.A,
        ...assignmentRow(ids["rd@A"]!, { archetype: TASK_VIEWER_ID }),
        id: ids.X,
      })
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      await client.query("SET CONSTRAINTS ALL DEFERRED")
      // Засів пише факти прав, і їхні тригери кладуть сигнали прав (§8.2):
      // кейси судять рівно рядки своєї команди.
      await client.query(`DELETE FROM ${OUTBOX}`)
    }, 120_000)
    afterAll(() => tx.close())

    const key = (name: string) => {
      const id = ids[name]
      if (id === undefined) throw new Error(`unknown seed key ${name}`)
      return id
    }
    const ticket = () => objectIdOf(model, TICKET_TABLE)
    const inA = (object: string) => ({
      kind: ORG_KIND_ID,
      scope: key("A"),
      object,
    })
    const steps = (user: string, list: readonly CommandStep[]) =>
      commandSteps(tx.client(), claimsFor("user", key(user)), list)
    const context = (
      action: string,
      object: string,
      root: string
    ): CommandContext => ({ action, object, root })
    /** Версія рядка — читає власник у тій самій точці збереження. */
    const version = (table: string, id: () => string): CommandStep => ({
      check: async (client) =>
        (
          await client.query<{ v: string }>(
            `SELECT version::text AS v FROM public.${table} WHERE id = $1`,
            [id()]
          )
        ).rows[0]?.v,
    })
    const save = (
      table: string,
      action: string,
      item: Record<string, unknown>,
      expected: string | null
    ): CommandStep => ({
      context: context(action, table, item.id as string),
      sql: `SELECT public.${table}_save($1::jsonb, $2::bigint) AS r`,
      params: [JSON.stringify(item), expected],
    })
    const currentVersion = async (table: string, id: string) =>
      (
        await tx
          .client()
          .query<{ v: string }>(
            `SELECT version::text AS v FROM public.${table} WHERE id = $1`,
            [id]
          )
      ).rows[0]!.v

    it("save of a change: one outbox row with the channel and exactly the send schema, version after", async () => {
      const before = await currentVersion(TICKET_TABLE, key("K1"))
      const [, after, rows] = succeeded(
        await steps("tw", [
          save(
            TICKET_TABLE,
            "update",
            { id: key("K1"), description: "s" },
            before
          ),
          version(TICKET_TABLE, () => key("K1")),
          readOutbox,
        ])
      ) as [unknown, string, OutboxRow[]]
      expect(BigInt(after)).toBeGreaterThan(BigInt(before))
      expect(rows).toEqual([
        changeRow(inA(ticket()), "update", key("K1"), after),
      ])
      expect(sameIds(rows)).toBe(true)
    })

    it("save of a creation signals create", async () => {
      const id = randomUUID()
      const [, after, rows] = succeeded(
        await steps("tw", [
          save(TICKET_TABLE, "create", { id, org_id: key("A") }, null),
          version(TICKET_TABLE, () => id),
          readOutbox,
        ])
      ) as [unknown, string, OutboxRow[]]
      expect(rows).toEqual([changeRow(inA(ticket()), "create", id, after)])
    })

    it("mark_deletion signals markDeletion with the version after", async () => {
      const before = await currentVersion(TICKET_TABLE, key("K1"))
      const [, after, rows] = succeeded(
        await steps("tw", [
          {
            context: context("markDeletion", TICKET_TABLE, key("K1")),
            sql: `SELECT public.${TICKET_TABLE}_mark_deletion($1::uuid, $2::bigint, true) AS r`,
            params: [key("K1"), before],
          },
          version(TICKET_TABLE, () => key("K1")),
          readOutbox,
        ])
      ) as [unknown, string, OutboxRow[]]
      expect(rows).toEqual([
        changeRow(inA(ticket()), "markDeletion", key("K1"), after),
      ])
    })

    // Відправку судить лише скоуп (§8.3): писар без права каналу (лише
    // контейнер P1) свій сигнал шле, інакше той мовчки зник би для всіх.
    it("a writer with only a container role signals into its scope", async () => {
      const before = await currentVersion(TICKET_TABLE, key("KR"))
      const [, after, rows] = succeeded(
        await steps("tp", [
          save(
            TICKET_TABLE,
            "update",
            { id: key("KR"), description: "c" },
            before
          ),
          version(TICKET_TABLE, () => key("KR")),
          readOutbox,
        ])
      ) as [unknown, string, OutboxRow[]]
      expect(rows).toEqual([
        changeRow(inA(ticket()), "update", key("KR"), after),
      ])
    })

    it("delete signals with the version and the scope of the row before", async () => {
      const before = await currentVersion(ASSIGNMENTS, key("X"))
      const [, rows] = succeeded(
        await steps("tw", [
          {
            context: context("administerRights", ASSIGNMENTS, key("X")),
            sql: `SELECT public.${ASSIGNMENTS}_delete($1::uuid, $2::bigint) AS r`,
            params: [key("X"), before],
          },
          readOutbox,
        ])
      ) as [unknown, OutboxRow[]]
      // Тригер оператора — до виклику сигналу ядра після DML.
      expect(rows).toEqual([
        userRightsRow(key("rd")),
        changeRow(
          inA(objectIdOf(model, ASSIGNMENTS)),
          "delete",
          key("X"),
          before
        ),
      ])
    })

    // Версія з послідовності (§8.1): повторне створення того самого ключа
    // не повертає старої версії, і клієнт не відкине сигнал як застарілий.
    it("delete and re-creation of the same key signal a greater version", async () => {
      const before = await currentVersion(ASSIGNMENTS, key("X"))
      const [, , rows] = succeeded(
        await steps("tw", [
          {
            context: context("administerRights", ASSIGNMENTS, key("X")),
            sql: `SELECT public.${ASSIGNMENTS}_delete($1::uuid, $2::bigint) AS r`,
            params: [key("X"), before],
          },
          save(
            ASSIGNMENTS,
            "administerRights",
            {
              id: key("X"),
              org_id: key("A"),
              subject: key("rd@A"),
              archetype: TASK_VIEWER_ID,
            },
            null
          ),
          readOutbox,
        ])
      ) as [unknown, unknown, OutboxRow[]]
      expect(rows.map((r) => r.payload.data.op)).toEqual([
        "rights",
        "delete",
        "rights",
        "create",
      ])
      const [removed, created] = rows
        .filter((r) => r.payload.data.op !== "rights")
        .map((r) => Number(r.payload.data.row_ver))
      expect(created).toBeGreaterThan(removed!)
    })

    it("leaves no outbox row after the command is rolled back", async () => {
      const before = await currentVersion(TICKET_TABLE, key("K1"))
      const [, rows] = succeeded(
        await steps("tw", [
          save(
            TICKET_TABLE,
            "update",
            { id: key("K1"), description: "r" },
            before
          ),
          readOutbox,
        ])
      ) as [unknown, OutboxRow[]]
      // Передумова: команда сигнал справді писала.
      expect(rows).toHaveLength(1)
      expect(await outboxRows(tx.client())).toEqual([])
    })

    // Повтор після `40001` (спека П4 §6.5): невдала спроба сигналу не лишає,
    // у транзакції — рівно рядок вдалої спроби з її версією.
    it("keeps only the signal of the successful retry after 40001", async () => {
      const before = await currentVersion(TICKET_TABLE, key("K1"))
      const update = () =>
        save(
          TICKET_TABLE,
          "update",
          { id: key("K1"), description: "t" },
          before
        )
      const completed = succeeded(
        await steps("tw", [
          { check: (client) => client.query("SAVEPOINT attempt") },
          update(),
          {
            check: async (client) => {
              const code = await client
                .query(
                  "DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = 'serialization_failure'; END $$"
                )
                .then(
                  () => "none",
                  (e: { code?: string }) => e.code
                )
              await client.query("ROLLBACK TO SAVEPOINT attempt")
              return code
            },
          },
          update(),
          version(TICKET_TABLE, () => key("K1")),
          readOutbox,
        ])
      )
      const [, , code, , after, rows] = completed as [
        unknown,
        unknown,
        string,
        unknown,
        string,
        OutboxRow[],
      ]
      expect(code).toBe("40001")
      expect(rows).toEqual([
        changeRow(inA(ticket()), "update", key("K1"), after),
      ])
    })

    it("the core sends no signal in the exact merge mode", async () => {
      const before = await currentVersion(TICKET_TABLE, key("K1"))
      const [, , rows] = succeeded(
        await steps("tw", [
          {
            check: (client) =>
              setLocalSetting(client, SIGNAL_MODE_SETTING, SIGNAL_MERGE_MODE),
          },
          save(
            TICKET_TABLE,
            "update",
            { id: key("K1"), description: "m" },
            before
          ),
          readOutbox,
        ])
      ) as [unknown, unknown, OutboxRow[]]
      expect(rows).toEqual([])
    })

    // Інваріант 5, шлях `signal()`: форму судить політика, а не довіра до
    // ядра. Зайвого поля `data` через `signal()` не передати — його форма
    // фіксована тілом; цей рядок — у кейсах прямого `INSERT`.
    const direct = (args: unknown[]): CommandStep => ({
      sql: SIGNAL_SQL,
      params: args,
    })
    const valid = () => [
      ticket(),
      ORG_KIND_ID,
      key("A"),
      JSON.stringify({ id: randomUUID() }),
      1,
      "update",
    ]
    /** Аргументи `valid()` з одним заміненим; значення — під час кейсу. */
    const withArg = (index: number, value: () => unknown) => () => {
      const args: unknown[] = valid()
      args[index] = value()
      return args
    }
    it.each([
      ["the rights op", withArg(5, () => "rights")],
      ["the invalidate op with keys", withArg(5, () => "invalidate")],
      // «Користувачі» гілки оракула не мають (§8.3).
      ["a non-signal object", withArg(0, () => objectIdOf(model, "users"))],
      [
        "an invented key name",
        withArg(3, () => JSON.stringify({ ref: randomUUID() })),
      ],
      [
        "two keys",
        withArg(3, () =>
          JSON.stringify({ id: randomUUID(), code: randomUUID() })
        ),
      ],
      ["version 0", withArg(4, () => 0)],
      ["a foreign scope", withArg(2, () => key("B"))],
      ["the zero scope of a scoped object", withArg(2, () => ZERO_UUID)],
    ] as const)("signal() refuses %s", async (_, args) => {
      const { completed, refusal } = await steps("tw", [direct(args())])
      expect(completed).toEqual([])
      expect({ code: refusal?.code, message: refusal?.message }).toEqual(
        BY_POLICY
      )
    })

    it("signal() inserts a valid signal (positive control)", async () => {
      const [, rows] = succeeded(
        await steps("tw", [direct(valid()), readOutbox])
      ) as [unknown, OutboxRow[]]
      expect(rows).toHaveLength(1)
    })
  })

  describe("signal of the root creation", () => {
    const tx = describeTransaction()
    const ids: Seed = {}
    let model: CompiledModel

    beforeAll(async () => {
      const result = await compileRights(
        policyDomain(tenantSelfService(), profileLayer())
      )
      expect(result.diagnostics).toEqual([])
      model = result.model!
      const client = await tx.open()
      await deploy(client, model)
      for (const user of ["creator", "owner"]) ids[user] = await signUp(client)
      ids.T = randomUUID()
      await insert(client, ORG, { id: ids.T })
      ids["owner@T"] = randomUUID()
      await insert(client, "org_member", {
        id: ids["owner@T"],
        org_id: ids.T,
        user_id: ids.owner,
      })
      await insert(client, ASSIGNMENTS, {
        org_id: ids.T,
        ...assignmentRow(ids["owner@T"], { archetype: TENANT_OWNER_ID }),
      })
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      await client.query("SET CONSTRAINTS ALL DEFERRED")
      // Засів пише факти прав, і їхні тригери кладуть сигнали прав (§8.2):
      // кейси судять рівно рядки своєї команди.
      await client.query(`DELETE FROM ${OUTBOX}`)
    }, 120_000)
    afterAll(() => tx.close())

    const organization = () => objectIdOf(model, ORG)
    const rootVersion = (id: string): CommandStep => ({
      check: async (client) =>
        (
          await client.query<{ v: string }>(
            `SELECT version::text AS v FROM public.${ORG} WHERE id = $1`,
            [id]
          )
        ).rows[0]!.v,
    })

    // Канал кореня — його власний скоуп (§8.3): сигнал доходить, лише якщо
    // множина скоупів творця бачить новий корінь у тій самій транзакції.
    it("create_root signals create into the channel of the new root", async () => {
      const root = randomUUID()
      const completed = succeeded(
        await commandSteps(tx.client(), claimsFor("user", ids.creator!), [
          {
            context: { action: "create", object: ORG, root },
            sql: `SELECT public.${ORG}_create_root($1::jsonb, $2::jsonb, $3::uuid) AS r`,
            params: [JSON.stringify({ id: root }), "{}", randomUUID()],
          },
          rootVersion(root),
          readOutbox,
        ])
      )
      const [, version, rows] = completed as [unknown, string, OutboxRow[]]
      // Про новий скоуп творця повідомляє канал прав користувача (§8.2):
      // функція гранту пише його членство й призначення — по рядку на оператор.
      expect(rows).toEqual([
        userRightsRow(ids.creator!),
        userRightsRow(ids.creator!),
        changeRow(
          { kind: ORG_KIND_ID, scope: root, object: organization() },
          "create",
          root,
          version
        ),
      ])
    })

    it("a change of the root signals into its own channel", async () => {
      const before = (
        await tx
          .client()
          .query<{ v: string }>(
            `SELECT version::text AS v FROM public.${ORG} WHERE id = $1`,
            [ids.T]
          )
      ).rows[0]!.v
      const completed = succeeded(
        await commandSteps(tx.client(), claimsFor("user", ids.owner!), [
          {
            context: { action: "update", object: ORG, root: ids.T! },
            sql: `SELECT public.${ORG}_save($1::jsonb, $2::bigint) AS r`,
            params: [JSON.stringify({ id: ids.T }), before],
          },
          rootVersion(ids.T!),
          readOutbox,
        ])
      )
      const [, version, rows] = completed as [unknown, string, OutboxRow[]]
      expect(rows).toEqual([
        changeRow(
          { kind: ORG_KIND_ID, scope: ids.T!, object: organization() },
          "update",
          ids.T!,
          version
        ),
      ])
    })
  })
}
