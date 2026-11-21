import { randomUUID } from "node:crypto"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { buildClientCatalog, buildRuntimeCatalog } from "simetra/compiler"
import {
  RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME,
  ZERO_UUID,
  channelTopic,
  rightsSnapshotSchema,
  type CatalogEntry,
  type RightsSnapshot,
} from "simetra/model"
import {
  ANNOUNCEMENT_ID,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  ROLE_FILE,
  SIGNAL_READER_ID,
  TASK_ID,
  catalog,
  grant,
  objects,
  role,
  type Layer,
} from "../../src/compiler/__tests__/fixtures/rights"
import { uuid } from "../../src/compiler/__tests__/helpers"
import { canSubscribe, readAllowed } from "../../src/data/store/rights"
import { signUp } from "./auth"
import { claimsFor, queryAs } from "./connection"
import {
  type Seed,
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  insertOrphan,
  orgDeltaRow,
} from "./rights-seed"
import { seedSignals, signalModel } from "./signal-topic-allowed.support"

/**
 * Еквівалентність предикатів T4 (`canSubscribe`, `readAllowed`) з базою
 * (спека П4-B §8.4, §9.1, Р9 плану B5b-1): знімок бере той самий користувач
 * викликом `rights_client_snapshot()`, а еталон — `signal_topic_allowed(…,
 * false)` для підписки й «хоч один фікстурний рядок пари видимий `SELECT`»
 * для читання. Фікстури сигналів — `signal-topic-allowed.support.ts`; тут
 * лише доповнення, яких там немає. Предикат — дзеркало SQL, тож оракул —
 * база, а не очікування тесту: розбіжність — дефект предиката.
 */

const REGION_TASK_READER_ID = uuid(9710)
const GLOBAL_ANNOUNCEMENT_READER_ID = uuid(9711)
const EVERY_NOTICE_ID = uuid(9712)
const NOTICE_ID = uuid(9720)
const NOTICE_FILE = "catalogs/Notice/Notice.meta.json"
const OPEN_ID = uuid(9721)
const OPEN_FILE = "catalogs/OpenNotice/OpenNotice.meta.json"

/**
 * Доповнення моделі сигналів: роль виміру на `Task`, глобальна роль читання
 * `Announcement` і роль «кожен користувач» на нескоупленому `Notice`.
 */
function predicateLayer(): Layer {
  return {
    [NOTICE_FILE]: catalog(NOTICE_ID, "Notice", "notice", {
      scope: "none",
      trackAuthor: true,
      ownership: ["createdBy"],
    }),
    // Нескоуплений довідник з `publicRead: anon`: єдиний об'єкт, який гість
    // бачить, — на ньому розрізняється гість і користувач (`Bulletin` — лише
    // для користувача).
    [OPEN_FILE]: catalog(OPEN_ID, "OpenNotice", "open_notice", {
      scope: "none",
      publicRead: "anon",
    }),
    [ROLE_FILE("RegionTaskReader")]: role(
      REGION_TASK_READER_ID,
      "RegionTaskReader",
      { scopeKind: "org" },
      {
        grants: [
          grant(objects(["Document", "Task"]), ["read"], {
            dimension: "region",
          }),
        ],
      }
    ),
    [ROLE_FILE("GlobalAnnouncementReader")]: role(
      GLOBAL_ANNOUNCEMENT_READER_ID,
      "GlobalAnnouncementReader",
      "global",
      {
        grants: [grant(objects(["Document", "Announcement"]), ["read"], "any")],
      }
    ),
    [ROLE_FILE("EveryNotice")]: role(
      EVERY_NOTICE_ID,
      "EveryNotice",
      "everyUser",
      { grants: [grant(objects(["Catalog", "Notice"]), ["read"], "own")] }
    ),
  }
}

/** Ключ знімка гостя в мапі знімків (користувачі — за ключем засіву). */
const GUEST = "<guest>"

/**
 * Знімок гостя фіксований: `rights_client_snapshot()` гостю не відкрито, тож
 * клієнт без сесії тримає порожній знімок без користувача.
 */
const GUEST_SNAPSHOT: RightsSnapshot = {
  userId: null,
  scopeSets: [],
  rights: [],
  members: [],
  dimensionValues: [],
}

const ORGS = ["A", "B", "C"] as const

/**
 * Клієнтський каталог поки містить лише довідники, а фікстури сигналів
 * тримають права на документах (`Task`, `Announcement`). Предикати читають із
 * запису лише ідентичність, вид скоупу, прапорці `signal` і `publicRead`, тож
 * запис документа збирається з довідника `Region` (скоуплений, без
 * `publicRead`) з перевизначеними полями; факти — ті самі, що й у моделі
 * сигналів (`signalFacts`).
 */
function documentEntries(objects: readonly CatalogEntry[]): CatalogEntry[] {
  const base = objects.find((e) => e.name === "Region")!
  const document = (
    over: Pick<CatalogEntry, "id" | "name" | "kindLabel" | "table">
  ): CatalogEntry => ({ ...base, kind: "Document", ...over })
  const task = document({
    id: TASK_ID,
    name: "Task",
    kindLabel: "task",
    table: { schema: "public", name: "task" },
  })
  const announcement = document({
    id: ANNOUNCEMENT_ID,
    name: "Announcement",
    kindLabel: "announcement",
    table: { schema: "public", name: "announcement" },
  })
  delete announcement.scopeKindId
  delete announcement.scopeColumn
  return [...objects, task, announcement]
}

/**
 * Користувачі поверх засіву сигналів (`m1`, `m4`, `m5`, `m6`, `o1`, `u9`,
 * `g1`): `d1` — A з роллю виміру й значенням `r1`; `n1` — A з кастомною
 * роллю `OrgMember`, де `deny read@any` + `allow read@own` звужують обсяг;
 * `x1` — права `SignalReader` лише в A, членство ще й в B без ролей;
 * `c1` — A лише з `OrgMember` (замикання включень без `SignalReader`);
 * `g2` — глобальна роль читання `Announcement`.
 */
async function seedPredicates(client: pg.Client, ids: Seed): Promise<void> {
  const create = async (
    key: string,
    table: string,
    values: Record<string, unknown> = {}
  ) => {
    ids[key] = randomUUID()
    await insert(client, table, { id: ids[key], ...values })
  }
  const member = async (
    user: string,
    org: string,
    assignment: Parameters<typeof assignmentRow>[1]
  ) => {
    const key = `${user}@${org}`
    await create(key, "org_member", { org_id: ids[org], user_id: ids[user] })
    await insert(client, "org_role_assignments", {
      org_id: ids[org],
      ...assignmentRow(ids[key]!, assignment),
    })
  }
  for (const user of ["d1", "n1", "c1", "g2", "x1", "i1"])
    ids[user] = await signUp(client)
  await create("PB", "project", { org_id: ids.B })
  await create("PC", "project", { org_id: ids.C })
  for (const org of ORGS)
    await create(`r${org}`, "region", { org_id: ids[org] })

  await member("d1", "A", { archetype: REGION_TASK_READER_ID })
  await insert(client, "member_region", {
    org_id: ids.A,
    member_id: ids["d1@A"],
    region_id: ids.rA,
  })
  await member("c1", "A", { archetype: ORG_MEMBER_ROLE_ID })
  // i1 — учасник A з роллю читання, але недійсний (#318): ні права, ні
  // `publicRead: authenticated` йому нічого не відкривають, як гостю.
  await member("i1", "A", { archetype: ORG_MEMBER_ROLE_ID })
  await client.query("UPDATE public.users SET invalid = true WHERE id = $1", [
    ids.i1,
  ])
  // Права лише в A, членство ще й в B: рядок права чужого скоупу не відкриває B.
  await member("x1", "A", { archetype: SIGNAL_READER_ID })
  await create("x1@B", "org_member", { org_id: ids.B, user_id: ids.x1 })
  await create("narrow", "org_roles", {
    org_id: ids.A,
    archetype: ORG_MEMBER_ROLE_ID,
  })
  await insert(
    client,
    "org_roles_delta",
    orgDeltaRow(ids.A!, ids.narrow!, 1, ["deny", "task", "read", "any"])
  )
  await insert(
    client,
    "org_roles_delta",
    orgDeltaRow(ids.A!, ids.narrow!, 2, ["allow", "task", "read", "own"])
  )
  await member("n1", "A", { customRole: ids.narrow })
  await insert(
    client,
    "global_role_assignments",
    assignmentRow(ids.g2!, { archetype: GLOBAL_ANNOUNCEMENT_READER_ID })
  )

  // Рядки задач кожного скоупу: по одному на кожен обсяг, щоб «хоч один
  // видимий» розрізняв обсяги, а не збігався для всіх. Власні — по рядку на
  // кожного учасника скоупу (`assignee`).
  const now = new Date()
  for (const org of ORGS) {
    await create(`task.${org}.plain`, "task", { org_id: ids[org], date: now })
    await create(`task.${org}.container`, "task", {
      org_id: ids[org],
      date: now,
      project_id: ids[org === "A" ? "P1" : `P${org}`],
    })
    await create(`task.${org}.dimension`, "task", {
      org_id: ids[org],
      date: now,
      region_id: ids[`r${org}`],
    })
    for (const [key, memberId] of Object.entries(ids)) {
      if (!key.endsWith(`@${org}`)) continue
      await create(`task.${org}.own.${key}`, "task", {
        org_id: ids[org],
        date: now,
        assignee_id: memberId,
      })
    }
    await create(`bulletin.${org}`, "bulletin", {
      org_id: ids[org],
      text: "x",
    })
  }

  // Автора ставить тригер від поточного користувача, тож власні рядки
  // `Announcement` вставляються без нього (засів — від власника таблиць).
  await create("announcement.plain", "announcement", { date: now })
  for (const user of USERS) {
    ids[`announcement.own.${user}`] = randomUUID()
    await insertOrphan(client, "announcement", {
      id: ids[`announcement.own.${user}`],
      date: now,
      created_by_id: ids[user],
    })
  }
  await create("open.plain", "open_notice")
  for (const user of USERS) {
    await insertOrphan(client, "notice", {
      id: randomUUID(),
      created_by_id: ids[user],
    })
  }
}

const USERS = [
  "m1",
  "m4",
  "m5",
  "m6",
  "o1",
  "u9",
  "g1",
  "d1",
  "n1",
  "c1",
  "g2",
  "x1",
  "i1",
]

/** Об'єкти з засіяними рядками: пара «скоуп, об'єкт» для еталона читання. */
const READ_OBJECTS = [
  "Task",
  "Organization",
  "Announcement",
  "Users",
  "Notice",
  "Bulletin",
  "OpenNotice",
]

type Topic = [kind: string, scope: string, object: string] | { raw: string }
interface Pair {
  name: string
  user: string | null
  topic: Topic
}

/**
 * Назви фікстурних випадків і значення, яке очікує БАЗА: оракул лишається
 * базою, а ці очікування страхують від виродження (обидва боки `false`).
 */
const NAMED: [
  user: string | null,
  object: string,
  scope: string,
  v: boolean,
][] = [
  ["m1", "Task", "A", true],
  ["m6", "Task", "A", false],
  ["m4", "Task", "A", true],
  ["o1", "Task", "A", true],
  ["d1", "Task", "A", true],
  ["n1", "Task", "A", true],
  ["c1", "Task", "A", true],
  ["c1", "Organization", "A", false],
  ["m1", "Task", "C", false],
  ["m1", "Announcement", ZERO_UUID, true],
  ["g1", "Announcement", ZERO_UUID, true],
  ["g2", "Announcement", ZERO_UUID, true],
  ["m6", "Announcement", ZERO_UUID, false],
  ["u9", "Notice", ZERO_UUID, true],
  ["u9", "Bulletin", "B", true],
  ["m1", "Users", ZERO_UUID, true],
  ["n1", "Task", "B", false],
  // Недійсний користувач: `publicRead: authenticated` закритий, як гостю (#318).
  ["i1", "Bulletin", "B", false],
  ["i1", "Task", "A", false],
  [null, "Task", "A", false],
]

/** Названі пари підписки й відповідь БАЗИ: страховка від виродження оракула. */
const NAMED_SUBSCRIBE: [
  user: string | null,
  object: string,
  scope: string,
  v: boolean,
][] = [
  ["m1", "Task", "A", true],
  ["m1", "Task", "B", false],
  ["m1", "Task", "C", false],
  ["m1", "Organization", "A", true],
  ["m6", "Task", "A", false],
  ["m4", "Task", "A", false],
  ["o1", "Task", "A", true],
  ["d1", "Task", "A", true],
  ["n1", "Task", "A", true],
  ["c1", "Task", "A", true],
  ["c1", "Organization", "A", false],
  ["x1", "Task", "B", false],
  ["g1", "Announcement", ZERO_UUID, true],
  ["g2", "Announcement", ZERO_UUID, true],
  ["m1", "Announcement", ZERO_UUID, true],
  ["m6", "Announcement", ZERO_UUID, false],
  ["u9", "Notice", ZERO_UUID, true],
  ["u9", "Bulletin", "B", true],
  ["m1", "Users", ZERO_UUID, false],
  [null, "Task", "A", false],
]

export function defineRightsPredicateCases(): void {
  describe("T4 rights predicates equal the database", () => {
    const tx = describeTransaction()
    let ids: Seed = {}
    let entries: CatalogEntry[] = []
    const snapshots = new Map<string | null, RightsSnapshot>()

    const key = (name: string) => {
      const id = ids[name]
      if (id === undefined) throw new Error(`unknown seed key ${name}`)
      return id
    }
    const scopeId = (scope: string) =>
      scope === ZERO_UUID ? scope : key(scope)
    const claims = (user: string | null) =>
      user === null ? claimsFor("user") : claimsFor("user", key(user))
    const entryOf = (name: string) => {
      const entry = entries.find((e) => e.name === name)
      if (entry === undefined) throw new Error(`no catalog entry ${name}`)
      return entry
    }
    const asUser = async <T extends pg.QueryResultRow>(
      user: string | null,
      sql: string,
      params: unknown[] = []
    ) => {
      const result = await queryAs<T>(
        tx.client(),
        "user",
        claims(user),
        sql,
        params
      )
      if ("code" in result) throw new Error(`refused: ${result.code}`)
      return result.rows
    }

    // Гість: роль `anonymous` без користувача, як її ставить сервер запитів.
    const asAnon = async <T extends pg.QueryResultRow>(
      sql: string,
      params: unknown[] = []
    ) => {
      const result = await queryAs<T>(
        tx.client(),
        "anonymous",
        claimsFor("anonymous"),
        sql,
        params
      )
      return result
    }

    beforeAll(async () => {
      const model = await signalModel(predicateLayer())
      const client = await tx.open()
      await deploy(client, model)
      ids = await seedSignals(client)
      await seedPredicates(client, ids)
      entries = documentEntries(
        buildClientCatalog(buildRuntimeCatalog(model)).objects
      )
      snapshots.set(GUEST, GUEST_SNAPSHOT)
      for (const user of [...USERS, null]) {
        const rows = await asUser<{ v: unknown }>(
          user,
          `SELECT simetra.${RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME}() AS v`
        )
        snapshots.set(user, rightsSnapshotSchema.parse(rows[0]!.v))
      }
    })

    afterAll(() => tx.close())

    const snapshotOf = (user: string | null) => snapshots.get(user)!
    const catalogOf = () => ({ objects: entries })

    const channelOf = (topic: Topic) =>
      "raw" in topic
        ? topic.raw.replace(/\{(\w+)(\^?)\}/g, (_, k: string, up: string) =>
            up === "" ? key(k) : key(k).toUpperCase()
          )
        : channelTopic({
            kind: "changes",
            scopeKindId: topic[0],
            scope: scopeId(topic[1]),
            object: topic[2],
          })

    const dbSubscribes = async (user: string | null, channel: string) =>
      (
        await asUser<{ v: boolean }>(
          user,
          "SELECT simetra.signal_topic_allowed($1, false) AS v",
          [channel]
        )
      )[0]!.v

    const dbReads = async (
      user: string | null,
      entry: CatalogEntry,
      scope: string
    ) => {
      const from = `${entry.table.schema}.${entry.table.name}`
      const rows =
        entry.scopeKindId === undefined
          ? await asUser<{ v: boolean }>(
              user,
              `SELECT EXISTS (SELECT 1 FROM ${from}) AS v`
            )
          : await asUser<{ v: boolean }>(
              user,
              `SELECT EXISTS (SELECT 1 FROM ${from} WHERE ${entry.scopeColumn ?? "id"} = $1) AS v`,
              [scopeId(scope)]
            )
      return rows[0]!.v
    }

    // Пари «користувач, скоуп, сигнальний об'єкт»: правильний вид топіка й
    // чужий (нескоупленому — вид org, скоупленому — нульовий).
    const subscribePairs = (user: string | null): Pair[] =>
      entries
        .filter((e) => e.signal)
        .flatMap((e) =>
          ["A", "B", "C", ZERO_UUID].flatMap((scope) =>
            [
              e.scopeKindId ?? ZERO_UUID,
              e.scopeKindId ? ZERO_UUID : ORG_KIND_ID,
            ].map((kind): Pair => ({
              name: `${e.name} @ ${scope === ZERO_UUID ? "zero" : scope} kind ${kind === ZERO_UUID ? "zero" : "org"}`,
              user,
              topic: [kind, scope, e.id],
            }))
          )
        )

    // Канали прав і користувача (І5; Р11 плану B6-2, перенесено в B6-1):
    // кожен скоуп засіву, глобальний, змішані нулі, вид поза видами скоупу,
    // свій і чужий канал користувача.
    const rightsPairs = (user: string | null): Pair[] => [
      ...ORGS.map((org): Pair => ({
        name: `rights @ ${org}`,
        user,
        topic: { raw: `simetra-rights:${ORG_KIND_ID}:{${org}}` },
      })),
      ...(
        [
          ["global rights", `simetra-rights:${ZERO_UUID}:${ZERO_UUID}`],
          ["rights, zero kind only", `simetra-rights:${ZERO_UUID}:{A}`],
          [
            "rights, zero scope only",
            `simetra-rights:${ORG_KIND_ID}:${ZERO_UUID}`,
          ],
          ["rights, not a scope kind", `simetra-rights:${TASK_ID}:{A}`],
          ["rights, uppercase scope", `simetra-rights:${ORG_KIND_ID}:{A^}`],
          ["foreign user channel", "simetra-user:{m5}"],
        ] as const
      ).map(([name, raw]): Pair => ({ name, user, topic: { raw } })),
      ...(user === null
        ? []
        : [
            {
              name: "own user channel",
              user,
              topic: { raw: `simetra-user:{${user}}` },
            },
          ]),
    ]

    const RAW: [string, Topic][] = [
      ["extra segment", { raw: `simetra:${ORG_KIND_ID}:{A}:${TASK_ID}:x` }],
      ["uppercase scope", { raw: `simetra:${ORG_KIND_ID}:{A^}:${TASK_ID}` }],
      ["trailing newline", { raw: `simetra:${ORG_KIND_ID}:{A}:${TASK_ID}\n` }],
      ["foreign prefix", { raw: `xsimetra:${ORG_KIND_ID}:{A}:${TASK_ID}` }],
      ["non-UUID object", { raw: `simetra:${ORG_KIND_ID}:{A}:task` }],
      ["user channel", { raw: "simetra-user:{m1}" }],
      ["rights channel", { raw: `simetra-rights:${ORG_KIND_ID}:{A}` }],
      ["unknown object", { raw: `simetra:${ORG_KIND_ID}:{A}:${uuid(1)}` }],
    ]

    it.each([...USERS, null])(
      "canSubscribe equals signal_topic_allowed for %s",
      async (user) => {
        const mismatches: string[] = []
        const pairs: Pair[] = [
          ...subscribePairs(user),
          ...rightsPairs(user),
          ...RAW.map(([name, topic]): Pair => ({ name, user, topic })),
        ]
        for (const pair of pairs) {
          const channel = channelOf(pair.topic)
          const predicate = canSubscribe(snapshotOf(user), channel, catalogOf())
          const db = await dbSubscribes(user, channel)
          if (predicate !== db)
            mismatches.push(
              `${pair.name}: predicate ${predicate}, database ${db}`
            )
        }
        expect(mismatches).toEqual([])
      }
    )

    it.each(USERS)(
      "readAllowed equals a visible fixture row for %s",
      async (user) => {
        const mismatches: string[] = []
        for (const name of READ_OBJECTS) {
          const entry = entryOf(name)
          const scopes =
            entry.scopeKindId === undefined ? [ZERO_UUID] : [...ORGS]
          for (const scope of scopes) {
            const predicate = readAllowed(
              snapshotOf(user),
              { scope: scopeId(scope) },
              entry
            )
            const db = await dbReads(user, entry, scope)
            if (predicate !== db)
              mismatches.push(
                `${name} @ ${scope === ZERO_UUID ? "zero" : scope}: predicate ${predicate}, database ${db}`
              )
          }
        }
        expect(mismatches).toEqual([])
      }
    )

    // Гість: знімок порожній (`GUEST_SNAPSHOT`), а базу питає роль `anonymous`. `publicRead`
    // відкриває лише значення для гостя (`anon`); `authenticated` — тільки
    // ролі користувача. Підписка гостю закрита: `EXECUTE` оракула в нього
    // немає, а предикат без користувача відмовляє.
    it("the database does not give the guest a rights snapshot", async () => {
      const result = await asAnon(
        `SELECT simetra.${RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME}() AS v`
      )
      expect("code" in result && result.code).toBe("42501")
    })

    it.each(READ_OBJECTS)(
      "readAllowed equals a visible fixture row for the guest on %s",
      async (name) => {
        const entry = entryOf(name)
        const from = `${entry.table.schema}.${entry.table.name}`
        const scopes = entry.scopeKindId === undefined ? [ZERO_UUID] : [...ORGS]
        for (const scope of scopes) {
          const result = await asAnon<{ v: boolean }>(
            entry.scopeKindId === undefined
              ? `SELECT EXISTS (SELECT 1 FROM ${from}) AS v`
              : `SELECT EXISTS (SELECT 1 FROM ${from} WHERE ${entry.scopeColumn ?? "id"} = $1) AS v`,
            entry.scopeKindId === undefined ? [] : [scopeId(scope)]
          )
          // Таблиця без `publicRead: anon` гостю закрита грантом: рядків немає.
          if ("code" in result) expect(result.code).toBe("42501")
          const db = "code" in result ? false : result.rows[0]!.v
          expect(
            readAllowed(snapshotOf(GUEST), { scope: scopeId(scope) }, entry),
            `${name} @ ${scope}`
          ).toBe(db)
        }
      }
    )

    it("the guest reads anon publicRead only: the database answers", async () => {
      const read = async (name: string) => {
        const result = await asAnon<{ v: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${entryOf(name).table.schema}.${entryOf(name).table.name}) AS v`
        )
        if ("code" in result) expect(result.code).toBe("42501")
        return "code" in result ? false : result.rows[0]!.v
      }
      expect(await read("OpenNotice")).toBe(true)
      expect(await read("Bulletin")).toBe(false)
    })

    it("the database refuses the guest every subscription, as the predicate", async () => {
      for (const pair of subscribePairs(null)) {
        const channel = channelOf(pair.topic)
        const result = await asAnon<{ v: boolean }>(
          "SELECT simetra.signal_topic_allowed($1, false) AS v",
          [channel]
        )
        expect("code" in result && result.code, pair.name).toBe("42501")
        expect(
          canSubscribe(snapshotOf(GUEST), channel, catalogOf()),
          pair.name
        ).toBe(false)
      }
    })

    it.each(NAMED_SUBSCRIBE)(
      "the database lets %s subscribe to %s @ %s: %s",
      async (user, object, scope, expected) => {
        const entry = entryOf(object)
        const channel = channelOf([
          entry.scopeKindId ?? ZERO_UUID,
          scope,
          entry.id,
        ])
        expect(await dbSubscribes(user, channel)).toBe(expected)
        expect(canSubscribe(snapshotOf(user), channel, catalogOf())).toBe(
          expected
        )
      }
    )

    // Оракул не вироджується: названі фікстурні пари мають задане значення БАЗИ.
    it.each(NAMED)(
      "the database answers for %s on %s @ %s",
      async (user, object, scope, expected) => {
        const entry = entryOf(object)
        expect(await dbReads(user, entry, scope)).toBe(expected)
      }
    )
  })
}
