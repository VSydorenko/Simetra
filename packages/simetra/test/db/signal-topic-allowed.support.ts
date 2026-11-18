import { randomUUID } from "node:crypto"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import {
  PLATFORM_LOGIN_ROLES,
  PLATFORM_ROLES,
  SESSION_CLAIMS_SETTING,
  SIGNAL_OUTBOX,
  ZERO_UUID,
  channelTopic,
} from "simetra/model"
import {
  ANNOUNCEMENT_ID,
  ANNOUNCEMENT_OWN_READER_ID,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  PROJECT_LEAD_ID,
  PROJECT_WRITER_ID,
  ROLE_FILE,
  SIGNAL_READER_ID,
  SUPPORT_ID,
  TASK_ID,
  TASK_OWN_READER_ID,
  compileRights,
  grant,
  objects,
  role,
  signalTopicDomain,
  singleTenantRights,
} from "../../src/compiler/__tests__/fixtures/rights"
import { uuid } from "../../src/compiler/__tests__/helpers"
import { signUp } from "./auth"
import {
  type Refusal,
  asRole,
  asSessionLogin,
  claimsFor,
  commandSteps,
  queryAs,
  setLocalSetting,
} from "./connection"
import { testProvider } from "./profile"
import {
  type Assignment,
  type Seed,
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  profileLayer,
} from "./rights-seed"

/**
 * Оракул каналу сигналу й правило форми сигналу на справжньому Postgres
 * (спека П4-B §8.2, §8.3; інваріанти 3, 4, 5, 8 плану B2): що повертають
 * функції множин і прав під claims користувача, які гранти судять виклик і
 * що RLS outbox пропускає від ролі команд, — вирішує Postgres, компілятор
 * бачить лише текст. Одне розгортання на опис у транзакції опису; кожен
 * запит — у точці збереження помічника.
 */

const USERS_ID = uuid(6003)
const ORGANIZATION_ID = uuid(6002)
const BULLETIN_ID = uuid(6724)

const changes = (kind: string, scope: string, object: string) =>
  channelTopic({ kind: "changes", scopeKindId: kind, scope, object })
const unscoped = (object: string) => changes(ZERO_UUID, ZERO_UUID, object)

async function signalModel(): Promise<CompiledModel> {
  const result = await compileRights(signalTopicDomain(profileLayer()))
  expect(result.diagnostics).toEqual([])
  return result.model!
}

/**
 * Засів: організації A, B і C (C — з позначкою видалення: дослівна функція
 * множини її відсікає). Учасники: `m1` — A і C з `OrgMember` і
 * `SignalReader`; `m5` — B з тими самими ролями; `m6` — A без призначень;
 * `o1` — A лише з `TaskOwnReader`; `m4` — A лише з контейнерною
 * `ProjectWriter` на P1. Без членства: `u9` — нічого, `g1` — глобальна
 * `AnnouncementOwnReader`.
 */
async function seedSignals(client: pg.Client): Promise<Seed> {
  const ids: Seed = {}
  const create = async (
    key: string,
    table: string,
    values: Record<string, unknown> = {}
  ) => {
    ids[key] = randomUUID()
    await insert(client, table, { id: ids[key], ...values })
  }
  const member = async (user: string, org: string, roles: Assignment[]) => {
    const key = `${user}@${org}`
    await create(key, "org_member", { org_id: ids[org], user_id: ids[user] })
    for (const a of roles)
      await insert(client, "org_role_assignments", {
        org_id: ids[org],
        ...assignmentRow(ids[key]!, a),
      })
  }
  for (const user of ["m1", "m4", "m5", "m6", "o1", "u9", "g1"])
    ids[user] = await signUp(client)
  await create("A", "organization")
  await create("B", "organization")
  await create("C", "organization", { deletion_mark: true })
  await create("P1", "project", { org_id: ids.A })
  const reader = [
    { archetype: ORG_MEMBER_ROLE_ID },
    { archetype: SIGNAL_READER_ID },
  ]
  await member("m1", "A", reader)
  await member("m1", "C", reader)
  await member("m5", "B", reader)
  await member("m6", "A", [])
  await member("o1", "A", [{ archetype: TASK_OWN_READER_ID }])
  await member("m4", "A", [{ archetype: PROJECT_WRITER_ID, container: ids.P1 }])
  await insert(
    client,
    "global_role_assignments",
    assignmentRow(ids.g1!, { archetype: ANNOUNCEMENT_OWN_READER_ID })
  )
  return ids
}

/** Канал кейсу з ключами засіву замість id: `[вид, скоуп, об'єкт]` чи сирий. */
type Topic = [kind: string, scope: string, object: string] | { raw: string }

/** Кейс оракула: користувач (`null` — claims без `sub`), канал, відповідь. */
type TopicCase = [
  name: string,
  user: string | null,
  topic: Topic,
  allowed: boolean,
]

/**
 * Якорі суворого шаблону топіка: кожен кейс — дозволений канал `m1` з
 * хвостом, префіксом, не-UUID сегментом чи кінцевим `\n`.
 */
const ANCHOR_CASES: TopicCase[] = [
  [
    "an extra trailing segment",
    "m1",
    { raw: `simetra:${ORG_KIND_ID}:{A}:${TASK_ID}:${TASK_ID}` },
    false,
  ],
  [
    "a leading prefix",
    "m1",
    { raw: `xsimetra:${ORG_KIND_ID}:{A}:${TASK_ID}` },
    false,
  ],
  [
    "a non-UUID segment",
    "m1",
    { raw: `simetra:${ORG_KIND_ID}:{A}:task` },
    false,
  ],
  [
    "a trailing newline",
    "m1",
    { raw: `simetra:${ORG_KIND_ID}:{A}:${TASK_ID}\n` },
    false,
  ],
  // Позитивний контроль: той самий канал без перекручень дозволено.
  ["the same channel as is", "m1", [ORG_KIND_ID, "A", TASK_ID], true],
]

const SUBSCRIBE: TopicCase[] = [
  ["own scope with a read right", "m1", [ORG_KIND_ID, "A", TASK_ID], true],
  // Інваріант 8: скоуп без умови права відкрив би канал учаснику без права.
  ["a member without any read right", "m6", [ORG_KIND_ID, "A", TASK_ID], false],
  ["a foreign scope", "m1", [ORG_KIND_ID, "B", TASK_ID], false],
  ["only own", "o1", [ORG_KIND_ID, "A", TASK_ID], true],
  // Інваріант 8: контейнерного обсягу в підписці немає.
  ["only a container right", "m4", [ORG_KIND_ID, "A", TASK_ID], false],
  [
    "unscoped with only own",
    "g1",
    [ZERO_UUID, ZERO_UUID, ANNOUNCEMENT_ID],
    true,
  ],
  [
    "unscoped with a scope-level role",
    "m1",
    [ZERO_UUID, ZERO_UUID, ANNOUNCEMENT_ID],
    true,
  ],
  [
    "unscoped without a read right",
    "m6",
    [ZERO_UUID, ZERO_UUID, ANNOUNCEMENT_ID],
    false,
  ],
  // Права й членство в C є, але дослівна функція множини виду C відсікає.
  [
    "a scope the verbatim set function cuts",
    "m1",
    [ORG_KIND_ID, "C", TASK_ID],
    false,
  ],
  [
    "publicRead for any valid user",
    "u9",
    [ORG_KIND_ID, "B", BULLETIN_ID],
    true,
  ],
  ["Users have no channel", "m1", [ZERO_UUID, ZERO_UUID, USERS_ID], false],
  [
    "the root channel of own scope",
    "m1",
    [ORG_KIND_ID, "A", ORGANIZATION_ID],
    true,
  ],
  [
    "the root channel of a foreign scope",
    "m1",
    [ORG_KIND_ID, "B", ORGANIZATION_ID],
    false,
  ],
  [
    "the root without a read right on it",
    "o1",
    [ORG_KIND_ID, "A", ORGANIZATION_ID],
    false,
  ],
  ["another scope kind in the topic", "m1", [ZERO_UUID, "A", TASK_ID], false],
  // Канали прав і користувача відкриє B6 (Р1 плану B2).
  ["own user channel (B6)", "m1", { raw: "simetra-user:{m1}" }, false],
  [
    "the rights channel of own scope (B6)",
    "m1",
    { raw: `simetra-rights:${ORG_KIND_ID}:{A}` },
    false,
  ],
  [
    "an uppercase topic",
    "m1",
    { raw: `simetra:${ORG_KIND_ID}:{A^}:${TASK_ID}` },
    false,
  ],
  ["without a user", null, [ORG_KIND_ID, "A", TASK_ID], false],
  ...ANCHOR_CASES,
]

const SEND: TopicCase[] = [
  [
    "only a container right in own scope",
    "m4",
    [ORG_KIND_ID, "A", TASK_ID],
    true,
  ],
  [
    "only a container right in a foreign scope",
    "m4",
    [ORG_KIND_ID, "B", TASK_ID],
    false,
  ],
  ["an unscoped object", "u9", [ZERO_UUID, ZERO_UUID, ANNOUNCEMENT_ID], true],
  [
    "a scope the verbatim set function cuts",
    "m1",
    [ORG_KIND_ID, "C", TASK_ID],
    false,
  ],
  [
    "the rights channel",
    "m1",
    { raw: `simetra-rights:${ORG_KIND_ID}:{A}` },
    false,
  ],
  ["own user channel", "m1", { raw: "simetra-user:{m1}" }, false],
  ["without a user", null, [ORG_KIND_ID, "A", TASK_ID], false],
  ...ANCHOR_CASES,
]

const TOPIC_SQL = "SELECT simetra.signal_topic_allowed($1, $2) AS v"
const PAYLOAD_SQL = "SELECT simetra.signal_payload_allowed($1) AS v"
const OUTBOX_INSERT = `INSERT INTO ${SIGNAL_OUTBOX.schema}.${SIGNAL_OUTBOX.name} (method, payload) VALUES ('publish', $1::jsonb)`

/**
 * `platformRoles` — чи може з'єднання тестів стати роллю команд і роллю
 * входу споживача: на стеку postgres сесія — суперкористувач, на Supabase
 * вхід тестів (`postgres`) ні `SET ROLE simetra_command`, ні `SET SESSION
 * AUTHORIZATION` не має. Без них лишаються оракул і відмова аноніму.
 */
export function defineSignalTopicCases(options: {
  platformRoles: boolean
}): void {
  describe("signal_topic_allowed and the outbox insert policy", () => {
    const tx = describeTransaction()
    let ids: Seed = {}

    beforeAll(async () => {
      const model = await signalModel()
      const client = await tx.open()
      await deploy(client, model)
      ids = await seedSignals(client)
    })

    afterAll(() => tx.close())

    const key = (name: string) => {
      const id = ids[name]
      if (id === undefined) throw new Error(`unknown seed key ${name}`)
      return id
    }
    const topicOf = (topic: Topic) =>
      "raw" in topic
        ? // `{k^}` — id засіву у верхньому регістрі (сталі фікстури — лише цифри).
          topic.raw.replace(/\{(\w+)(\^?)\}/g, (_, k: string, up: string) =>
            up === "" ? key(k) : key(k).toUpperCase()
          )
        : changes(
            topic[0],
            topic[1] === ZERO_UUID ? ZERO_UUID : key(topic[1]),
            topic[2]
          )
    const claims = (user: string | null) =>
      user === null ? claimsFor("user") : claimsFor("user", key(user))

    it.each(SUBSCRIBE)("subscribe: %s", async (_, user, topic, allowed) => {
      const result = await queryAs<{ v: boolean }>(
        tx.client(),
        "user",
        claims(user),
        TOPIC_SQL,
        [topicOf(topic), false]
      )
      expect(result).toEqual({ rows: [{ v: allowed }] })
    })

    // Оракул — `SECURITY DEFINER`: відповідь залежить лише від claims, не
    // від ролі, що питає. Шлях відправки ролі команд — кейси `INSERT` нижче.
    it.each(SEND)("send: %s", async (_, user, topic, allowed) => {
      const result = await queryAs<{ v: boolean }>(
        tx.client(),
        "user",
        claims(user),
        TOPIC_SQL,
        [topicOf(topic), true]
      )
      expect(result).toEqual({ rows: [{ v: allowed }] })
    })

    /** Сигнал зміни задачі в скоупі `scope`; `data` перевизначає поля. */
    const change = (scope: string, data: Record<string, unknown> = {}) => ({
      channel: changes(ORG_KIND_ID, key(scope), TASK_ID),
      data: {
        object: TASK_ID,
        op: "update",
        keys: { id: randomUUID() },
        row_ver: 1,
        ...data,
      },
    })
    const insertAs = (user: string, ...payloads: unknown[]) =>
      commandSteps(
        tx.client(),
        claims(user),
        payloads.map((payload) => ({
          sql: OUTBOX_INSERT,
          params: [JSON.stringify(payload)],
        }))
      )
    // Відмова саме політики outbox: відмова перемикання ролі чи гранту теж
    // `42501`, але не доводила б правила форми.
    const refused = (refusal: Refusal | undefined) => ({
      code: refusal?.code,
      policy:
        /^new row violates row-level security policy for table "signal_outbox"$/.test(
          refusal?.message ?? ""
        ),
    })
    const BY_POLICY = { code: "42501", policy: true }

    if (options.platformRoles) {
      // Інваріант 5: форму сигналу судить політика `INSERT`, а не довіра до
      // ядра; та сама відмова, що й у чужий канал.
      it.each([
        ["an extra data field", { extra: 1 }],
        ["the rights op", { op: "rights" }],
        ["a foreign object", { object: ANNOUNCEMENT_ID }],
        ["an invented key name", { keys: { ref: randomUUID() } }],
        ["two keys", { keys: { id: randomUUID(), code: randomUUID() } }],
        ["version 0", { row_ver: 0 }],
        ["a fractional version", { row_ver: 1.5 }],
        ["invalidate with keys", { op: "invalidate", row_ver: undefined }],
      ])("the command role cannot insert %s", async (_, data) => {
        const { completed, refusal } = await insertAs("m1", change("A", data))
        expect(completed).toEqual([])
        expect(refused(refusal)).toEqual(BY_POLICY)
      })

      it("the command role inserts a change and an invalidate of an allowed channel", async () => {
        const invalidate = {
          channel: changes(ORG_KIND_ID, key("A"), TASK_ID),
          data: { object: TASK_ID, op: "invalidate" },
        }
        const { completed, refusal } = await insertAs(
          "m4",
          change("A"),
          invalidate
        )
        expect(refusal).toBeUndefined()
        expect(completed).toHaveLength(2)
      })

      // Інваріант 1, шлях ролі команд: `data.id` ставить тригер з `id` рядка.
      it("a forged data.id of the command role is rewritten", async () => {
        const { completed, refusal } = await commandSteps(
          tx.client(),
          claims("m1"),
          [
            {
              sql: OUTBOX_INSERT,
              params: [JSON.stringify(change("A", { id: "1" }))],
            },
            {
              check: async (client) =>
                (
                  await client.query<{ ok: boolean }>(
                    `SELECT bool_and(payload -> 'data' ->> 'id' = id::text AND payload ->> 'idempotency_key' = id::text) AS ok FROM ${SIGNAL_OUTBOX.schema}.${SIGNAL_OUTBOX.name}`
                  )
                ).rows[0]!.ok,
            },
          ]
        )
        expect(refusal).toBeUndefined()
        expect(completed[1]).toBe(true)
      })

      // Інваріант 3: дозволений рядок не відкриває транзакції інших каналів.
      it("an allowed then a forbidden channel in one transaction refuses the second", async () => {
        const { completed, refusal } = await insertAs(
          "m1",
          change("A"),
          change("B")
        )
        expect(completed).toHaveLength(1)
        expect(refused(refusal)).toEqual(BY_POLICY)
      })
    }

    // Інваріант 4: ні споживач з підробленими claims справжнього учасника,
    // ні анонім оракула не питають — відмова гранту, а не `false`.
    const ORACLES = [
      [
        "signal_topic_allowed",
        TOPIC_SQL,
        () => [changes(ORG_KIND_ID, key("A"), TASK_ID), false],
      ],
      [
        "signal_payload_allowed",
        PAYLOAD_SQL,
        () => [JSON.stringify(change("A"))],
      ],
    ] as const
    // Відмова саме на функції: відмова перемикання ролі чи схеми теж
    // `42501`, але не доводила б гранту `EXECUTE`.
    const DENIED = {
      code: "42501",
      message: expect.stringMatching(/^permission denied for function signal_/),
    }
    const outcome = (run: Promise<unknown>) =>
      run.then(
        () => ({ code: "allowed" }),
        (e: { code?: string; message?: string }) => ({
          code: e.code,
          message: e.message,
        })
      )

    // Ролі запиту провайдера (на Supabase — з типовими привілеями схеми):
    // outbox для них закритий цілком, а оракул `user` має лише за Р10 —
    // його відповіді звіряють кейси підписки вище.
    const OUTBOX = `${SIGNAL_OUTBOX.schema}.${SIGNAL_OUTBOX.name}`
    const TABLE_DENIED = {
      code: "42501",
      message: `permission denied for table ${SIGNAL_OUTBOX.name}`,
    }
    const fnDenied = (name: string) => ({
      code: "42501",
      message: `permission denied for function ${name}`,
    })
    type RequestRoleCase = [
      purpose: "anonymous" | "user",
      what: string,
      sql: string,
      params: () => unknown[],
      expected: { code: string; message: string },
    ]
    const REQUEST_ROLE_CASES: RequestRoleCase[] = (
      ["anonymous", "user"] as const
    ).flatMap((purpose): RequestRoleCase[] => [
      [purpose, "SELECT", `SELECT id FROM ${OUTBOX}`, () => [], TABLE_DENIED],
      [
        purpose,
        "INSERT",
        OUTBOX_INSERT,
        () => [JSON.stringify(change("A"))],
        TABLE_DENIED,
      ],
      [purpose, "DELETE", `DELETE FROM ${OUTBOX}`, () => [], TABLE_DENIED],
      [
        purpose,
        "EXECUTE signal_payload_allowed",
        PAYLOAD_SQL,
        () => [JSON.stringify(change("A"))],
        fnDenied("signal_payload_allowed"),
      ],
      ...(purpose === "anonymous"
        ? [
            [
              purpose,
              "EXECUTE signal_topic_allowed",
              TOPIC_SQL,
              () => [changes(ORG_KIND_ID, key("A"), TASK_ID), false],
              fnDenied("signal_topic_allowed"),
            ] satisfies RequestRoleCase,
          ]
        : []),
    ])

    // Інваріант 4 і умова архітекторки: живий кейс на привілеях провайдера.
    it.each(REQUEST_ROLE_CASES)(
      "the %s role cannot %s on the outbox signal objects",
      async (purpose, _, sql, params, expected) => {
        const client = tx.client()
        await client.query("SAVEPOINT request_role_outbox")
        const result = await outcome(
          (async () => {
            await asRole(client, purpose, claimsFor(purpose, key("m1")))
            await client.query(sql, params())
          })()
        )
        await client.query("ROLLBACK TO SAVEPOINT request_role_outbox")
        expect(result).toEqual(expected)
      }
    )

    if (options.platformRoles) {
      it.each(ORACLES)(
        "%s is closed to the signal consumer with a member's claims",
        async (_, sql, params) => {
          const client = tx.client()
          const consumer = await outcome(
            asSessionLogin(client, PLATFORM_LOGIN_ROLES.signals, async () => {
              await setLocalSetting(
                client,
                SESSION_CLAIMS_SETTING,
                JSON.stringify(claims("m1"))
              )
              await client.query(
                `SET LOCAL ROLE ${PLATFORM_ROLES.signalConsumer}`
              )
              await client.query(sql, [...params()])
            })
          )
          expect(consumer).toEqual(DENIED)
        }
      )
    }
  })

  describe("signal_topic_allowed without scope kinds", () => {
    const tx = describeTransaction()
    let lead = ""
    let support = ""

    beforeAll(async () => {
      const result = await compileRights(
        singleTenantRights(
          {
            [ROLE_FILE("Support")]: role(SUPPORT_ID, "Support", "global", {
              grants: [grant(objects(["Document", "Task"]), ["read"], "any")],
            }),
          },
          testProvider()
        )
      )
      expect(result.diagnostics).toEqual([])
      const client = await tx.open()
      await deploy(client, result.model!)
      lead = await signUp(client)
      support = await signUp(client)
      const p1 = randomUUID()
      await insert(client, "project", { id: p1 })
      await insert(
        client,
        "global_role_assignments",
        assignmentRow(lead, { archetype: PROJECT_LEAD_ID, container: p1 })
      )
      await insert(
        client,
        "global_role_assignments",
        assignmentRow(support, { archetype: SUPPORT_ID })
      )
    })

    afterAll(() => tx.close())

    // `has_right` контейнерних рядків не бачить: роль на одному контейнері не
    // відкриває каналу всіх рядків об'єкта.
    it.each([
      ["only a container right", () => lead, false],
      ["a global read right", () => support, true],
    ] as const)("subscribe: %s", async (_, user, allowed) => {
      const result = await queryAs<{ v: boolean }>(
        tx.client(),
        "user",
        claimsFor("user", user()),
        TOPIC_SQL,
        [unscoped(TASK_ID), false]
      )
      expect(result).toEqual({ rows: [{ v: allowed }] })
    })
  })
}
