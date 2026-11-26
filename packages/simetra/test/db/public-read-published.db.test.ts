import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import {
  COMMAND_CORE_ERRORS,
  type CommandContext,
  channelTopic,
} from "simetra/model"
import { accessPolicyNames } from "../../src/compiler/access-units"
import { ORG_KIND_ID } from "../../src/compiler/__tests__/fixtures/rights"
import {
  type CommandStep,
  type Refusal,
  claimsFor,
  commandAs,
  commandSteps,
  queryAs,
} from "./connection"
import {
  MEMO_ID,
  MEMO_TABLE,
  NOTICE_GUARD,
  NOTICE_ID,
  NOTICE_ITEMS_TABLE,
  NOTICE_STATES,
  NOTICE_TABLE,
  publicReadPublishedModel,
  seedPublicRead,
} from "./public-read-published.support"
import {
  type Seed,
  asOwnerLogin,
  deploy,
  describeTransaction,
} from "./rights-seed"

/**
 * Межа умовного `publicRead` на справжньому Postgres (D1, спека публічної
 * частини §5.1, права §5.2–§5.4): який рядок бачить гість, користувач
 * тенанта й автентифікований без прав, що пропускає запис і ядро команд, що
 * розкриває пояснення — вирішує Postgres: політики, тригери ефектів і
 * копії ТЧ компілятор бачить лише текстом. Одне розгортання на опис,
 * кожен запит — у точці збереження помічників.
 */

const E = COMMAND_CORE_ERRORS
const refusal = (message: string, detail: string): Refusal => ({
  code: "42501",
  message,
  detail,
})
const NO_RIGHT = refusal(E.forbidden.message, E.forbidden.noRight)
const EFFECT = refusal(E.forbidden.message, E.forbidden.effect)
const NO_CONTEXT = refusal(E.context.message, E.context.missing)
const MARKED: Refusal = {
  code: E.invalid.errcode,
  message: E.invalid.message,
  detail: E.invalid.marked,
}
/** Відмова саме гранту: текст Postgres без деталі тригера чи ядра. */
const GRANT_DENIAL = {
  code: "42501",
  message: expect.stringMatching(/^permission denied for (table|column) /),
} as unknown as Refusal

/** Рядок `rights_explain`. */
interface Explained {
  row: string
  policy: string
  kind: "permissive" | "restrictive"
  has_right: boolean | null
  carrier_match: boolean | null
}

/**
 * Правило видимості пояснення (права §5.1): кожен `restrictive` має
 * `carrier_match`, і хоч один `permissive` — `has_right AND carrier_match`.
 */
const visible = (rows: readonly Explained[]) =>
  rows
    .filter((r) => r.kind === "restrictive")
    .every((r) => r.carrier_match === true) &&
  rows.some(
    (r) =>
      r.kind === "permissive" &&
      r.has_right === true &&
      r.carrier_match === true
  )

const KEYS = NOTICE_STATES.map(([key]) => key)
const itemOf = (keys: readonly string[]) => keys.map((k) => `${k}.l1`)

/**
 * Матриця видимості (інваріанти 1–3): користувач (`null` — гість), рядки
 * шапки `Notice` і рядки `Memo`. Опублікований непозначений рядок видно всім;
 * чернетку й позначений рядок — лише в межі тенанта з правом `read`.
 * Рядок B з контейнером A недосяжний: складений зовнішній ключ
 * `(org_id, project_id)` його не пропускає (Р-D1-16).
 */
const MATRIX: [
  name: string,
  user: string | null,
  notice: string[],
  memo: string[] | "refused",
][] = [
  ["a guest", null, ["pA", "pB"], "refused"],
  [
    "a reader of tenant A",
    "rA",
    ["dA", "kA", "mA", "pA", "pB"],
    ["mdA", "mpA"],
  ],
  ["a reader of tenant B", "rB", ["dB", "pA", "pB"], ["mpA"]],
  ["a signed-in user without rights", "nobody", ["pA", "pB"], ["mpA"]],
  // `dA` (проєкт P1) бачить контейнерна роль у своєму тенанті.
  ["a container reader of tenant A", "cA", ["dA", "pA", "pB"], ["mpA"]],
]

describe("conditional publicRead", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const model = await publicReadPublishedModel()
    const client = await tx.open()
    await deploy(client, model)
    ids = await seedPublicRead(client)
  }, 120_000)

  afterAll(() => tx.close())

  const key = (name: string) => {
    // Невідомий ключ дав би `NULL` замість id — і зелений кейс без причини.
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  const nameOf = (id: string) =>
    Object.entries(ids).find(([, value]) => value === id)?.[0] ?? id
  const claims = (user: string | null) =>
    user === null ? claimsFor("anonymous") : claimsFor("user", key(user))

  /** Ключі рядків таблиці, які бачить користувач (`null` — гість). */
  const seenBy = async (
    user: string | null,
    table: string,
    client: pg.Client = tx.client()
  ): Promise<string[] | "refused"> => {
    const result = await queryAs<{ id: string }>(
      client,
      user === null ? "anonymous" : "user",
      claims(user),
      `SELECT id::text AS id FROM public.${table}`
    )
    if (!("rows" in result)) return "refused"
    return result.rows.map((r) => nameOf(r.id)).sort()
  }
  const guestSees = (client: pg.Client, table = NOTICE_TABLE) =>
    seenBy(null, table, client)

  const asUser = (user: string, steps: CommandStep[]) =>
    commandSteps(tx.client(), claims(user), steps)
  const context = (action: string, root: string): CommandContext => ({
    action,
    object: NOTICE_TABLE,
    root: key(root),
  })
  const versionSql = (row: string) =>
    `(SELECT version FROM public.${NOTICE_TABLE} WHERE id = '${key(row)}')`
  /** Виклик ядра `<t>_<fn>` над рядком з поточною версією. */
  const coreStep = (
    action: string,
    fn: string,
    row: string,
    tail = ""
  ): CommandStep => ({
    context: context(action, row),
    sql: `SELECT public.${NOTICE_TABLE}_${fn}('${key(row)}'::uuid, ${versionSql(row)}${tail}) AS r`,
  })
  const markStep = (row: string, mark: boolean) =>
    coreStep("markDeletion", "mark_deletion", row, `, ${mark}::boolean`)
  const rowOf = (row: string): CommandStep => ({
    check: async (client) =>
      (
        await client.query(
          `SELECT published, deletion_mark, headline FROM public.${NOTICE_TABLE} WHERE id = $1`,
          [key(row)]
        )
      ).rows[0],
  })
  const guestStep = (table = NOTICE_TABLE): CommandStep => ({
    check: (client) => guestSees(client, table),
  })

  describe("visibility (invariants 1–3)", () => {
    it.each(MATRIX)("%s", async (_, user, notice, memo) => {
      expect.soft(await seenBy(user, NOTICE_TABLE)).toEqual(notice)
      // ТЧ несе копії умови шапки: ті самі рядки (Р-D1-9)
      expect
        .soft(await seenBy(user, NOTICE_ITEMS_TABLE))
        .toEqual(itemOf(notice))
      expect.soft(await seenBy(user, MEMO_TABLE)).toEqual(memo)
    })

    it("the matrix names every seeded state", () => {
      expect(new Set(MATRIX.flatMap(([, , notice]) => notice))).toEqual(
        new Set(KEYS)
      )
    })
  })

  describe("writes (invariants 4–8, 12)", () => {
    it("4: a new row is a draft and the command role reads it back", async () => {
      const id = randomUUID()
      const result = await commandAs<{ r: string }>(
        tx.client(),
        claims("wA"),
        { action: "create", object: NOTICE_TABLE, root: id },
        `SELECT public.${NOTICE_TABLE}_save($1::jsonb, NULL::bigint, NULL::jsonb) AS r`,
        {
          params: [JSON.stringify({ id, org_id: key("A"), headline: "n" })],
          after: `SELECT published FROM public.${NOTICE_TABLE} WHERE id = '${id}'`,
        }
      )
      expect(result).toMatchObject({ after: [{ published: false }] })
      expect("rows" in result && result.rows).toHaveLength(1)
    })

    it("4: update changes a draft", async () => {
      const { completed, refusal } = await asUser("wA", [
        {
          context: context("update", "dA"),
          sql: `SELECT public.${NOTICE_TABLE}_save($1::jsonb, ${versionSql("dA")}, NULL::jsonb) AS r`,
          params: [JSON.stringify({ id: key("dA"), headline: "x" })],
        },
        rowOf("dA"),
      ])
      expect(refusal).toBeUndefined()
      expect(completed[1]).toMatchObject({ published: false, headline: "x" })
    })

    it("4: an insert of an owner with published = true under create is refused by the effects trigger", async () => {
      const id = randomUUID()
      const { refusal } = await asUser("wA", [
        asOwnerLogin({
          context: { action: "create", object: NOTICE_TABLE, root: id },
          sql: `INSERT INTO public.${NOTICE_TABLE} (id, org_id, published) VALUES ('${id}', '${key("A")}', true)`,
          asOwner: true,
        }),
      ])
      expect(refusal).toMatchObject({ ...EFFECT, column: "published" })
    })

    it("5: publish is its own right", async () => {
      const call = (user: string) =>
        asUser(user, [
          coreStep("publish", "publish", "dA"),
          rowOf("dA"),
          guestStep(),
        ])
      // `NoticeWriter` пише, але не публікує
      expect((await call("wA")).refusal).toEqual(NO_RIGHT)
      // `NoticePublisher` публікує без `update`; гість бачить одразу
      const published = await call("pU")
      expect(published.refusal).toBeUndefined()
      expect(published.completed[1]).toMatchObject({ published: true })
      expect(published.completed[2]).toContain("dA")
    })

    it("5: published is not a value of update, nor of a direct UPDATE", async () => {
      const update = await asUser("wA", [
        {
          context: context("update", "dA"),
          sql: `SELECT public.${NOTICE_TABLE}_save($1::jsonb, ${versionSql("dA")}, NULL::jsonb) AS r`,
          params: [JSON.stringify({ id: key("dA"), published: true })],
        },
      ])
      // Шар — ядро команди: `command.invalid` з назвою колонки, не тригер
      expect(update.refusal).toEqual({
        code: E.invalid.errcode,
        message: E.invalid.message,
        detail: "published",
      })
      expect(
        (
          await tx
            .client()
            .query(
              `SELECT published FROM public.${NOTICE_TABLE} WHERE id = $1`,
              [key("dA")]
            )
        ).rows
      ).toEqual([{ published: false }])
      const direct = await commandAs(
        tx.client(),
        claims("wA"),
        context("update", "dA"),
        `UPDATE public.${NOTICE_TABLE} SET published = true WHERE id = '${key("dA")}'`
      )
      expect(direct).toMatchObject({ ...EFFECT, column: "published" })
    })

    it("6: the update of a published row is visible to a guest at once", async () => {
      const { completed, refusal } = await asUser("wA", [
        {
          context: context("update", "pA"),
          sql: `SELECT public.${NOTICE_TABLE}_save($1::jsonb, ${versionSql("pA")}, NULL::jsonb) AS r`,
          params: [JSON.stringify({ id: key("pA"), headline: "fresh" })],
        },
        {
          check: async (client) =>
            await queryAs<{ headline: string }>(
              client,
              "anonymous",
              claims(null),
              `SELECT headline FROM public.${NOTICE_TABLE} WHERE id = '${key("pA")}'`
            ),
        },
      ])
      expect(refusal).toBeUndefined()
      expect(completed[1]).toEqual({ rows: [{ headline: "fresh" }] })
    })

    it("7: a mark takes the publication off, an unmark gives a draft", async () => {
      const { completed, refusal } = await asUser("pU", [
        markStep("pA", true),
        rowOf("pA"),
        guestStep(),
        markStep("pA", false),
        rowOf("pA"),
        guestStep(),
      ])
      expect(refusal).toBeUndefined()
      expect(completed[1]).toMatchObject({
        published: false,
        deletion_mark: true,
      })
      expect(completed[2]).toEqual(["pB"])
      expect(completed[4]).toMatchObject({
        published: false,
        deletion_mark: false,
      })
      expect(completed[5]).toEqual(["pB"])
    })

    it("7: a marked row is not published (mark → publish)", async () => {
      const { completed, refusal } = await asUser("pU", [
        markStep("dA", true),
        coreStep("publish", "publish", "dA"),
      ])
      expect(completed).toHaveLength(1)
      expect(refusal).toEqual(MARKED)
      // seeded marked draft: the same reason, not a trigger refusal
      expect(
        (await asUser("pU", [coreStep("publish", "publish", "kA")])).refusal
      ).toEqual(MARKED)
    })

    it("7: the effects trigger of the owner refuses a published mark, an unmark with publication and a publish of a marked row", async () => {
      // Контекст завжди на самому рядку: рядок поза коренем судить лише
      // природна дія, а не гілка дії контексту.
      const owner = (action: string, sql: string, root = "pB") =>
        asUser("pU", [
          asOwnerLogin({ context: context(action, root), sql, asOwner: true }),
        ])
      const update = (set: string, row: string) =>
        `UPDATE public.${NOTICE_TABLE} SET ${set} WHERE id = '${key(row)}'`
      const cases: [string, string, string, string][] = [
        [
          "mark with published",
          "markDeletion",
          update("deletion_mark = true", "pB"),
          "pB",
        ],
        [
          "unmark with published",
          "markDeletion",
          update("deletion_mark = false", "mA"),
          "mA",
        ],
        [
          "publish of a marked row",
          "publish",
          update("published = true", "kA"),
          "kA",
        ],
        // Перехід лише у свій бік: `publish` не знімає публікації, `unpublish`
        // не публікує
        [
          "unpublish under publish",
          "publish",
          update("published = false", "pB"),
          "pB",
        ],
        [
          "publish under unpublish",
          "unpublish",
          update("published = true", "dB"),
          "dB",
        ],
      ]
      for (const [name, action, sql, root] of cases)
        expect
          .soft((await owner(action, sql, root)).refusal, name)
          .toMatchObject(EFFECT)
      // контроль: позначка з `published = false` проходить
      const control = await owner(
        "markDeletion",
        update("deletion_mark = true, published = false", "pB")
      )
      expect(control.refusal).toBeUndefined()
    })

    it("8: a change of the header publication reaches the copy, a direct change of the copy does not stay", async () => {
      const { completed, refusal } = await asUser("pU", [
        coreStep("unpublish", "unpublish", "pA"),
        guestStep(NOTICE_ITEMS_TABLE),
      ])
      expect(refusal).toBeUndefined()
      expect(completed[1]).toEqual(["pB.l1"])
      const direct = await asUser("pU", [
        asOwnerLogin({
          sql: `UPDATE public.${NOTICE_ITEMS_TABLE} SET published = false WHERE parent_id = '${key("pA")}'`,
          asOwner: true,
        }),
        {
          check: async (client) =>
            (
              await client.query(
                `SELECT published FROM public.${NOTICE_ITEMS_TABLE} WHERE parent_id = $1`,
                [key("pA")]
              )
            ).rows,
        },
      ])
      expect(direct.refusal).toBeUndefined()
      expect(direct.completed[1]).toEqual([{ published: true }])
    })

    const without = (sql: string) =>
      commandAs(tx.client(), claims("wA"), undefined, sql)

    it("12: the command role without a context cannot set published", async () => {
      expect(
        await without(
          `UPDATE public.${NOTICE_TABLE} SET published = true WHERE id = '${key("dA")}'`
        )
      ).toEqual(NO_CONTEXT)
    })

    it("12: the command role without a context cannot insert", async () => {
      expect(
        await without(
          `INSERT INTO public.${NOTICE_TABLE} (id, org_id) VALUES ('${randomUUID()}', '${key("A")}')`
        )
      ).toEqual(NO_CONTEXT)
    })

    it("12: published is not in the insert grant of the command role", async () => {
      const id = randomUUID()
      expect(
        await commandAs(
          tx.client(),
          claims("wA"),
          { action: "create", object: NOTICE_TABLE, root: id },
          `INSERT INTO public.${NOTICE_TABLE} (id, org_id, published) VALUES ('${id}', '${key("A")}', true)`
        )
      ).toMatchObject(GRANT_DENIAL)
    })
  })

  describe("explanation and guards (invariants 9–11)", () => {
    const explain = async (
      caller: string,
      object: string,
      rows: readonly string[],
      subject: string
    ) => {
      const result = await queryAs<Explained & { row: string }>(
        tx.client(),
        "user",
        claims(caller),
        "SELECT r.id::text AS row, e.* FROM unnest($1::uuid[]) AS r(id) CROSS JOIN LATERAL simetra.rights_explain($2, r.id, $3) e",
        [rows, object, subject]
      )
      if (!("rows" in result)) throw new Error(`${caller}: ${result.code}`)
      return result.rows
    }

    it("9: the explanation is no oracle of a draft, a foreign row or a random id", async () => {
      // Чернетка B й випадковий id — те саме порожнє пояснення
      expect(
        await explain("admin", NOTICE_TABLE, [key("dB")], key("rB"))
      ).toEqual([])
      expect(
        await explain("admin", NOTICE_TABLE, [randomUUID()], key("rB"))
      ).toEqual([])
      // Чернетка A з користувачем поза A
      expect(
        await explain("admin", NOTICE_TABLE, [key("dA")], key("rB"))
      ).toEqual([])
    })

    it("9: a published row of A with a user outside A explains only public_read", async () => {
      const rows = await explain("admin", NOTICE_TABLE, [key("pA")], key("rB"))
      expect(rows.map((r) => r.policy)).toEqual([
        accessPolicyNames({ name: NOTICE_TABLE }).publicRead,
      ])
    })

    it("9: a conditional object of the authenticated role has no validity oracle", async () => {
      for (const subject of [key("rB"), randomUUID()])
        expect(
          await explain("admin", MEMO_TABLE, [key("mpA")], subject)
        ).toEqual([])
    })

    const SUBJECTS = ["rA", "rB", "wA", "pU", "nobody", "cA", "admin"]
    const A_ROWS = ["dA", "kA", "pA", "mA"]

    it("10: RLS, the call guard and the explanation agree on every row and user", async () => {
      for (const user of SUBJECTS) {
        const seen = await seenBy(user, NOTICE_TABLE)
        if (seen === "refused") throw new Error(`${user}: refused`)
        for (const row of KEYS) {
          const guard = await queryAs(
            tx.client(),
            "user",
            claims(user),
            `SELECT public.${NOTICE_GUARD}($1)`,
            [key(row)]
          )
          expect
            .soft("rows" in guard, `guard ${user} → ${row}`)
            .toBe(seen.includes(row))
        }
        // Пояснення адміністратора A — для рядків A, які той бачить сам
        const explained = await explain(
          "admin",
          NOTICE_TABLE,
          A_ROWS.map(key),
          key(user)
        )
        for (const row of A_ROWS)
          expect
            .soft(
              visible(explained.filter((r) => r.row === key(row))),
              `explain ${user} → ${row}`
            )
            .toBe(seen.includes(row))
      }
    })

    it("11: a signed-in user without read cannot subscribe to the signals of a conditional object", async () => {
      const topic = (object: string, scope: string) =>
        channelTopic({
          kind: "changes",
          scopeKindId: ORG_KIND_ID,
          scope: key(scope),
          object,
        })
      const allowed = async (user: string, object: string, scope = "A") => {
        const result = await queryAs<{ v: boolean }>(
          tx.client(),
          "user",
          claims(user),
          "SELECT simetra.signal_topic_allowed($1, false) AS v",
          [topic(object, scope)]
        )
        return result
      }
      expect(await allowed("rA", NOTICE_ID)).toEqual({ rows: [{ v: true }] })
      expect(await allowed("nobody", NOTICE_ID)).toEqual({
        rows: [{ v: false }],
      })
      expect(await allowed("nobody", MEMO_ID)).toEqual({ rows: [{ v: false }] })
      expect(await allowed("rB", NOTICE_ID)).toEqual({ rows: [{ v: false }] })
    })
  })
})
