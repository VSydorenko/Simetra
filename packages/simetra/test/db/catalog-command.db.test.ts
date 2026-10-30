import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PLATFORM_ROLES, type CommandContext } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import { CATALOG_COMMAND_ERRORS } from "../../src/compiler/catalog-command/units"
import {
  MEMBER_EDITOR_ID,
  NOTE_OWN_CREATOR_ID,
  NOTE_WRITER_ID,
  TICKET_CHECKLIST_TABLE,
  TICKET_TABLE,
  adminRoles,
  authorCarrier,
  commandCoreLayer,
  compileRights,
  noteOwnCreator,
  policyDomain,
  singleTenantRights,
  ticketNoticeHandler,
  withSql,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { type Refusal, commandAs, queryAs } from "./connection"
import {
  type Seed,
  assignmentRow,
  describeTransaction,
  insert,
  seedCommandCore,
} from "./rights-seed"

/**
 * Ядро довідника `<t>_save` / `<t>_mark_deletion` на справжньому Postgres
 * (спека П4 §6.6, §6.7, §6.10; план П4-A2, Задача 7). Що бачить замок
 * `FOR UPDATE` під RLS, чи дає ключ `23505`, що пропускає колонковий грант і
 * від чиєї ролі виконується обробник — вирішує Postgres, компілятор бачить
 * лише текст тіла. Роль команд має лише згенеровані гранти: доказ — контракт
 * ролі, а не повний DML фікстури. Кожен виклик — у точці збереження
 * `commandAs`, тож порядок кейсів нічого не змінює.
 */

const E = CATALOG_COMMAND_ERRORS
const INVALID = (detail: string): Refusal => ({
  code: E.invalid.errcode,
  message: E.invalid.message,
  detail,
})
const FORBIDDEN = (detail: string): Refusal => ({
  code: E.forbidden.errcode,
  message: E.forbidden.message,
  detail,
})
const NO_RIGHT = FORBIDDEN(E.forbidden.noRight)
const NEW_CARRIER = FORBIDDEN(E.forbidden.newCarrier)
const CONTEXT: Refusal = {
  code: E.context.errcode,
  message: E.context.message,
  detail: E.context.detail,
}
const CONFLICT = (detail: string, hint?: string): Refusal => ({
  code: E.conflict.errcode,
  message: E.conflict.message,
  detail,
  ...(hint === undefined ? {} : { hint }),
})
/** Відмова саме гранту: текст Postgres без деталі тригера чи ядра. */
const GRANT_DENIAL = {
  code: "42501",
  message: expect.stringMatching(/^permission denied for (table|column) /),
} as unknown as Refusal

const LINES = TICKET_CHECKLIST_TABLE

/** Результат ядра: розібраний JSON (функція повертає `text`) чи відмова. */
type Outcome = Record<string, unknown> | Refusal

async function outcomeOf(
  result: { rows: { r: string }[] } | Refusal
): Promise<Outcome> {
  if (!("rows" in result)) return result
  return JSON.parse(result.rows[0]!.r) as Record<string, unknown>
}

describe("catalog command core", () => {
  const tx = describeTransaction()
  let ids: Seed = {}
  const notices: string[] = []

  beforeAll(async () => {
    const result = await compileRights(
      withSql(
        policyDomain(
          writeRoles(),
          adminRoles(),
          commandCoreLayer(),
          ticketNoticeHandler().layer
        ),
        ticketNoticeHandler()
      )
    )
    expect(result.diagnostics).toEqual([])
    const client = await tx.open()
    await client.query(renderDesiredState(result.model!).sql)
    // Лише згенеровані гранти: членство з `SET` потрібне `SET LOCAL ROLE`
    // у `commandAs`, повного DML-гранту таблиць немає.
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    ids = await seedCommandCore(client)
    // Довідник без ТЧ, який дає змінювати роль домену: `OrgMember` під
    // `MemberEditor` (`adminRoles`). Засів ядра його не дає — сітка прав
    // ділить засів і цієї ролі не компілює. Ціль — запрошений рядок без
    // призначень: його зміна не зачіпає носіїв прав
    ids.me = await signUp(client)
    for (const [member, user] of [
      ["me@A", ids.me],
      ["invite@A", null],
    ] as const) {
      ids[member] = randomUUID()
      await insert(client, "org_member", {
        id: ids[member],
        org_id: ids.A,
        user_id: user,
      })
    }
    await insert(client, "org_role_assignments", {
      org_id: ids.A,
      ...assignmentRow(ids["me@A"]!, { archetype: MEMBER_EDITOR_ID }),
    })
    client.on("notice", (message) => {
      if (message.message?.startsWith("ticket-handler:") === true)
        notices.push(message.message)
    })
  }, 120_000)

  afterAll(() => tx.close())

  const key = (name: string) => {
    // Невідомий ключ дав би `NULL` замість id — і зелений кейс без причини
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  const claims = (user: string) => ({ sub: key(user), role: "authenticated" })

  /** Поточна версія рядка — читає власник, RLS її не ховає. */
  const versionById = async (id: string) =>
    (
      await tx
        .client()
        .query<{ v: string }>(
          `SELECT version::text AS v FROM public.${TICKET_TABLE} WHERE id = $1`,
          [id]
        )
    ).rows[0]!.v
  const versionOf = (row: string) => versionById(key(row))

  type Version = null | "current" | string
  interface Call {
    user: string
    item: Record<string, unknown>
    /** `null` — створення; `current` — версія рядка з бази; інакше — як є. */
    version: Version
    /** Перевизначення контексту: за замовчуванням дія гілки й id рядка. */
    context?: Partial<CommandContext>
    after?: string
  }

  const contextOf = (
    action: string,
    root: string,
    override: Partial<CommandContext> = {}
  ): CommandContext => ({
    action,
    object: TICKET_TABLE,
    root,
    ...override,
  })

  const save = async (call: Call) => {
    const id = call.item.id as string
    const version =
      call.version === "current" ? await versionById(id) : call.version
    return commandAs<{ r: string }>(
      tx.client(),
      claims(call.user),
      contextOf(call.version === null ? "create" : "update", id, call.context),
      `SELECT public.${TICKET_TABLE}_save($1::jsonb, $2::bigint) AS r`,
      {
        params: [JSON.stringify(call.item), version],
        ...(call.after === undefined ? {} : { after: call.after }),
      }
    )
  }

  const mark = async (user: string, row: string, markValue: boolean | null) =>
    outcomeOf(
      await commandAs<{ r: string }>(
        tx.client(),
        claims(user),
        contextOf("markDeletion", key(row)),
        `SELECT public.${TICKET_TABLE}_mark_deletion($1::uuid, $2::bigint, $3::boolean) AS r`,
        { params: [key(row), await versionOf(row), markValue] }
      )
    )

  const run = async (call: Call) => outcomeOf(await save(call))
  const fresh = () => randomUUID()
  const newTicket = (values: Record<string, unknown> = {}) => ({
    id: fresh(),
    org_id: key("A"),
    ...values,
  })

  // Кожен рядок — один виклик ядра і точна відмова: код, повідомлення,
  // деталь (і підказка, коли вона є). Причина кожного — у назві.
  const CASES: [string, () => Promise<Outcome>, () => Promise<Refusal>][] = [
    // Конфлікт версії несе поточну версію в `HINT` (Р-A2-8)
    [
      "conflict: stale version",
      () =>
        run({
          user: "tw",
          item: { id: key("K1"), description: "x" },
          version: "999",
        }),
      async () => CONFLICT(E.conflict.version, await versionOf("K1")),
    ],
    [
      "conflict: create with a visible id",
      () =>
        run({ user: "tw", item: newTicket({ id: key("K1") }), version: null }),
      async () => CONFLICT(E.conflict.exists),
    ],
    // Невидимий рядок тенанта B: ядро його не бачить, `23505` на ключі —
    // `no-right`, а не `exists` (Рт4)
    [
      "conflict: create with the id of a tenant B row",
      () =>
        run({ user: "tw", item: newTicket({ id: key("KB") }), version: null }),
      async () => NO_RIGHT,
    ],
    // Межа `scope_insert` (Р-A2-15): контейнер P1 свій, скоуп — чужий.
    // `subject` і масиви порожні: інакше відмовила б умова скоупу `pair`.
    [
      "tenant boundary: ProjectTicketWriter creates in tenant B",
      () =>
        run({
          user: "tp",
          item: newTicket({ org_id: key("B"), project_id: key("P1") }),
          version: null,
        }),
      async () => NO_RIGHT,
    ],
    // Чужий і відсутній рядок — та сама відмова (Рт4)
    [
      "foreign row: update a tenant B row",
      () =>
        run({
          user: "tw",
          item: { id: key("KB"), description: "x" },
          version: "1",
        }),
      async () => NO_RIGHT,
    ],
    [
      "foreign row: update a random id",
      () =>
        run({
          user: "tw",
          item: { id: fresh(), description: "x" },
          version: "1",
        }),
      async () => NO_RIGHT,
    ],
    // Конфлікт бачить лише той, хто має право: замок `FOR UPDATE` не дає
    // рядка ролі без `update`, тож версію ядро не звіряє
    [
      "reader: stale version without update is no-right",
      () =>
        run({
          user: "rd",
          item: { id: key("K1"), description: "x" },
          version: "999",
        }),
      async () => NO_RIGHT,
    ],
    // Обсяги: стан «після» поза обсягом ролі
    [
      "own: assignee changed to a foreign member",
      () =>
        run({
          user: "to",
          item: { id: key("K2"), assignee_id: key("tw@A") },
          version: "current",
        }),
      async () => NEW_CARRIER,
    ],
    [
      "dimension: region changed to a foreign value",
      () =>
        run({
          user: "tr",
          item: { id: key("KR"), region_id: key("r2") },
          version: "current",
        }),
      async () => NEW_CARRIER,
    ],
    [
      "container: project changed to a foreign container",
      () =>
        run({
          user: "tp",
          item: { id: key("KR"), project_id: key("P2") },
          version: "current",
        }),
      async () => NEW_CARRIER,
    ],
    // Носій `NULL` — відмова ядра, не сирий `42501` RLS (`IS NOT TRUE`)
    [
      "dimension: create with an empty region",
      () => run({ user: "tr", item: newTicket(), version: null }),
      async () => NO_RIGHT,
    ],
    [
      "dimension: region cleared on update",
      () =>
        run({
          user: "tr",
          item: { id: key("KR"), region_id: null },
          version: "current",
        }),
      async () => NEW_CARRIER,
    ],
    // ТЧ: id рядка іншого власника — видимий (явна перевірка) і невидимий
    // (`23505` на ключі ТЧ) — одна відмова (Р-A2-12)
    [
      "tabular: a visible row of another owner",
      () =>
        run({
          user: "tw",
          item: { id: key("K1"), tabular: { [LINES]: [{ id: key("K2.l1") }] } },
          version: "current",
        }),
      async () => NO_RIGHT,
    ],
    [
      "tabular: an invisible row of tenant B",
      () =>
        run({
          user: "tw",
          item: { id: key("K1"), tabular: { [LINES]: [{ id: key("KB.l1") }] } },
          version: "current",
        }),
      async () => NO_RIGHT,
    ],
    [
      "tabular: duplicate id",
      () => {
        const line = fresh()
        return run({
          user: "tw",
          item: {
            id: key("K1"),
            tabular: { [LINES]: [{ id: line }, { id: line }] },
          },
          version: "current",
        })
      },
      async () => INVALID(`tabular.${LINES}`),
    ],
    // Форма входу ТЧ: невідома ТЧ і `tabular` у довідника без ТЧ — відмова
    // з ключем, а не мовчазний пропуск
    [
      "shape: unknown tabular section",
      () =>
        run({
          user: "tw",
          item: { id: key("K1"), tabular: { no_such: [] } },
          version: "current",
        }),
      async () => INVALID("tabular.no_such"),
    ],
    [
      "shape: tabular on a catalog without tabular sections",
      async () => {
        // Не `TaskComment`: у домені прав він має ТЧ `attachments`, і
        // `tabular: {}` там — чинна порожня зміна, а не відмова форми
        const id = key("invite@A")
        const { rows } = await tx
          .client()
          .query<{ v: string }>(
            "SELECT version::text AS v FROM public.org_member WHERE id = $1",
            [id]
          )
        return outcomeOf(
          await commandAs<{ r: string }>(
            tx.client(),
            claims("me"),
            { action: "update", object: "org_member", root: id },
            "SELECT public.org_member_save($1::jsonb, $2::bigint) AS r",
            { params: [JSON.stringify({ id, tabular: {} }), rows[0]!.v] }
          )
        )
      },
      async () => INVALID("tabular"),
    ],
    // Ключі поза гілкою (Р-A2-5) — відмова раніше за грант. На `Ticket`
    // колонка переходу — сама позначка видалення.
    ...(
      [
        ["deletion_mark", true],
        ["version", "5"],
        ["created_by_id", "tw"],
        ["predefined_name", "main"],
        ["no_such_key", 1],
      ] as const
    ).map(
      ([column, value]): [
        string,
        () => Promise<Outcome>,
        () => Promise<Refusal>,
      ] => [
        `keys: ${column} on update`,
        () =>
          run({
            user: "tw",
            item: {
              id: key("K1"),
              [column]: column === "created_by_id" ? key("tw") : value,
            },
            version: "current",
          }),
        async () => INVALID(column),
      ]
    ),
    [
      "keys: deletion_mark on create",
      () =>
        run({
          user: "tw",
          item: newTicket({ deletion_mark: true }),
          version: null,
        }),
      async () => INVALID("deletion_mark"),
    ],
    // `Ref` на невидимий рядок свого тенанта — те саме, що випадковий UUID
    [
      "ref: header parent invisible to TicketOwnWriter",
      () =>
        run({
          user: "to",
          item: { id: key("K3"), parent_id: key("K1") },
          version: "current",
        }),
      async () => INVALID("parent_id"),
    ],
    [
      "ref: header parent is a random id",
      () =>
        run({
          user: "to",
          item: { id: key("K3"), parent_id: fresh() },
          version: "current",
        }),
      async () => INVALID("parent_id"),
    ],
    [
      "ref: tabular row points to an invisible ticket",
      () =>
        run({
          user: "to",
          item: {
            id: key("K2"),
            tabular: { [LINES]: [{ id: fresh(), related_id: key("K1") }] },
          },
          version: "current",
        }),
      async () => INVALID(`tabular.${LINES}.related_id`),
    ],
    [
      "ref: tabular row points to a random id",
      () =>
        run({
          user: "to",
          item: {
            id: key("K2"),
            tabular: { [LINES]: [{ id: fresh(), related_id: fresh() }] },
          },
          version: "current",
        }),
      async () => INVALID(`tabular.${LINES}.related_id`),
    ],
    // Пара перевіряється над рядком «після»: відсутній ключ пари — збережене
    // значення, не `NULL`. Лише `id` — ціль за старим типом; лише тип —
    // новий тип зі старим `id`. `KL` і `KL.l1` — (project, P1), PB — тенанта B
    ...(
      [
        ["header", undefined],
        ["tabular", `tabular.${LINES}.`],
      ] as const
    ).flatMap(
      ([where, prefix]): [
        string,
        () => Promise<Outcome>,
        () => Promise<Refusal>,
      ][] =>
        (
          [
            ["only the id, to a tenant B project", { subject_id: "PB" }],
            ["only the type, with the stored id", { subject_type: "region" }],
          ] as const
        ).map(([name, change]) => [
          `ref: ${where} pair — ${name}`,
          () => {
            // Ключ засіву розв'язується лише під час кейсу: CASES будується
            // при збиранні тестів, раніше за `beforeAll` із засівом
            const value =
              "subject_id" in change
                ? { subject_id: key(change.subject_id) }
                : change
            return run({
              user: "tw",
              item:
                prefix === undefined
                  ? { id: key("KL"), ...value }
                  : {
                      id: key("KL"),
                      tabular: {
                        [LINES]: [
                          { id: key("KL.l1"), ...value },
                          { id: key("KL.l2") },
                        ],
                      },
                    },
              version: "current",
            })
          },
          async () => INVALID(`${prefix ?? ""}subject_id`),
        ])
    ),
    [
      "ref: polymorphic label outside allowed types",
      () =>
        run({
          user: "tw",
          item: newTicket({ subject_type: "ticket", subject_id: key("K1") }),
          version: null,
        }),
      async () => INVALID("subject_type"),
    ],
    // Масив без FK: кожен елемент — видимий рядок того самого скоупу;
    // невидимий — другим, щоб «лише перший елемент» не пройшов
    [
      "scope refs: watchers with a tenant B member second",
      () =>
        run({
          user: "tw",
          item: newTicket({ watchers: [key("tw@A"), key("tb@B")] }),
          version: null,
        }),
      async () => INVALID("watchers"),
    ],
    // Старе `[NULL]`: новизна через `<> ALL` дала б `NULL` і пропустила б
    // учасника тенанта B (новизна — `IS NOT TRUE`)
    [
      "scope refs: watchers [null] → [null, tenant B member]",
      () =>
        run({
          user: "tw",
          item: { id: key("KW"), watchers: [null, key("tb@B")] },
          version: "current",
        }),
      async () => INVALID("watchers"),
    ],
    // Той самий запит, що «межа тенанта», з непорожнім `subject`: умова
    // скоупу `pair` відмовляє раніше за право
    [
      "scope refs: subject of tenant A with org_id of tenant B",
      () =>
        run({
          user: "tp",
          item: newTicket({
            org_id: key("B"),
            project_id: key("P1"),
            subject_type: "project",
            subject_id: key("P1"),
          }),
          version: null,
        }),
      async () => INVALID("subject_id"),
    ],
    // Значення не приводиться до типу колонки (Р-A2-7): ключ у `DETAIL`
    [
      "cast: a value of the wrong type",
      () =>
        run({
          user: "tw",
          item: newTicket({ is_folder: "maybe" }),
          version: null,
        }),
      async () => INVALID("is_folder"),
    ],
    // Позначка видалення
    [
      "mark: predefined row",
      () => mark("tw", "KP", true),
      async () => INVALID("predefined"),
    ],
    [
      "mark: without the right",
      () => mark("rd", "K1", true),
      async () => NO_RIGHT,
    ],
    [
      "mark: p_mark null",
      () => mark("tw", "K1", null),
      async () => INVALID("p_mark"),
    ],
    // Контекст фази звіряється до замка (Р-A2-9, Р-A2-18)
    [
      "context: root of another row",
      () =>
        run({
          user: "tw",
          item: { id: key("K1"), description: "x" },
          version: "current",
          context: { root: key("KR") },
        }),
      async () => CONTEXT,
    ],
    [
      "context: label of another object",
      () =>
        run({
          user: "tw",
          item: { id: key("K1"), description: "x" },
          version: "current",
          context: { object: "project" },
        }),
      async () => CONTEXT,
    ],
    [
      "context: markDeletion under save",
      () =>
        run({
          user: "tw",
          item: { id: key("K1"), description: "x" },
          version: "current",
          context: { action: "markDeletion" },
        }),
      async () => CONTEXT,
    ],
  ]

  it.each(CASES)("refusal: %s", async (_, call, expected) => {
    expect(await call()).toEqual(await expected())
  })

  // Прямий запис повз ядро: `predefined_name` поза грантом — відмова
  // привілею; позначку на `Ticket` під дією `update` відхиляє тригер
  // ефектів, бо вона — колонка переходу `markDeletion`.
  it.each([
    ["predefined_name", GRANT_DENIAL],
    [
      "deletion_mark",
      {
        code: "42501",
        message: "command.forbidden",
        detail: "effect",
        column: "deletion_mark",
      },
    ],
  ] as const)("direct update of %s", async (column, expected) => {
    const value = column === "predefined_name" ? "'other'" : "true"
    const result = await commandAs(
      tx.client(),
      claims("tw"),
      contextOf("update", key("K1")),
      `UPDATE public.${TICKET_TABLE} SET ${column} = ${value} WHERE id = $1`,
      { params: [key("K1")] }
    )
    expect(result).toEqual(expected)
  })

  it("create: row with tabular section and polymorphic subject", async () => {
    const lines = [
      { id: fresh(), line_region_id: key("r1") },
      { id: fresh(), related_id: key("K1") },
    ]
    const item = newTicket({
      description: "new",
      subject_type: "region",
      subject_id: key("r1"),
      tabular: { [LINES]: lines },
    })
    const result = await run({ user: "tw", item, version: null })
    expect(result).toMatchObject({
      id: item.id,
      org_id: key("A"),
      subject_type: "region",
      subject_id: key("r1"),
      created_by_id: key("tw"),
      // `bigint` T3 читає рядком (Рт1)
      version: expect.stringMatching(/^\d+$/),
      tabular: {
        // Скоуп рядка ТЧ — з рядка шапки, не з входу; номер — порядок масиву
        [LINES]: lines.map((line, index) => ({
          id: line.id,
          parent_id: item.id,
          org_id: key("A"),
          line_number: index + 1,
        })),
      },
    })
  })

  it("update: version grows and comes back as text", async () => {
    const before = await versionOf("K1")
    const result = await run({
      user: "tw",
      item: { id: key("K1"), description: "changed" },
      version: before,
    })
    expect(result).toMatchObject({
      id: key("K1"),
      description: "changed",
      version: String(BigInt(before) + 1n),
    })
  })

  it("markDeletion: the mark is set", async () => {
    expect(await mark("tw", "K1", true)).toMatchObject({
      id: key("K1"),
      deletion_mark: true,
    })
  })

  // Правка ТЧ одного довідника не чіпає рядків ТЧ іншого, на який роль має
  // `update`: `DELETE` відсутніх рядків обмежений власником
  it("tabular: rows of another owner stay intact; order and removal", async () => {
    const added = fresh()
    const result = await save({
      user: "tw",
      item: {
        id: key("KL"),
        tabular: { [LINES]: [{ id: key("KL.l2") }, { id: added }] },
      },
      version: "current",
      after: `SELECT parent_id, id, line_number FROM public.${LINES} WHERE parent_id IN ('${key("KL")}', '${key("K2")}') ORDER BY parent_id = '${key("K2")}', line_number`,
    })
    expect(result).toEqual({
      rows: [expect.anything()],
      after: [
        { parent_id: key("KL"), id: key("KL.l2"), line_number: 1 },
        { parent_id: key("KL"), id: added, line_number: 2 },
        { parent_id: key("K2"), id: key("K2.l1"), line_number: 1 },
      ],
    })
  })

  // Незмінене невидиме значення не перевіряється: `parent_id` K2 (K1) і
  // `related_id` рядка K2.l1 (K1) невидимі для `TicketOwnWriter`. Значення
  // порівнюється зі збереженим рядком, тож і передане знову — незмінене
  it.each([
    ["header column changed", { description: "x" }],
    ["unchanged invisible parent passed again", { parent_id: "K1" }],
    ["tabular row kept without its ref key", { tabular: "K2.l1" }],
    [
      "unchanged invisible tabular ref passed again",
      { tabular: "K2.l1", related_id: "K1" },
    ],
  ] as const)("ref: %s — passes", async (_, change) => {
    const item: Record<string, unknown> = { id: key("K2") }
    if ("description" in change) item.description = change.description
    if ("parent_id" in change) item.parent_id = key(change.parent_id)
    if ("tabular" in change)
      item.tabular = {
        [LINES]: [
          {
            id: key(change.tabular),
            ...("related_id" in change
              ? { related_id: key(change.related_id) }
              : {}),
          },
        ],
      }
    expect(await run({ user: "to", item, version: "current" })).toMatchObject({
      id: key("K2"),
    })
  })

  // Лише тип пари, рівний збереженому: рядок «після» — (project, P1), пара
  // не змінилась і не перевіряється; над самим входом `id` був би `NULL`
  it.each([
    ["header", false],
    ["tabular", true],
  ] as const)(
    "ref: %s pair — only the stored type passed again — passes",
    async (_, tabular) => {
      const value = { subject_type: "project" }
      const item = tabular
        ? {
            id: key("KL"),
            tabular: {
              [LINES]: [{ id: key("KL.l1"), ...value }, { id: key("KL.l2") }],
            },
          }
        : { id: key("KL"), ...value }
      expect(await run({ user: "tw", item, version: "current" })).toMatchObject(
        { id: key("KL"), subject_type: "project", subject_id: key("P1") }
      )
    }
  )

  // Обробник `beforeWrite` шапки на правці лише ТЧ — від ролі команд, не
  // від власника таблиці: `UPDATE` шапки самоприсвоєнням (Р-A2-6) його будить
  it("beforeWrite handler runs as the command role on a tabular-only change", async () => {
    notices.length = 0
    const result = await run({
      user: "tw",
      item: { id: key("KR"), tabular: { [LINES]: [{ id: fresh() }] } },
      version: "current",
    })
    expect(result).toMatchObject({ id: key("KR") })
    // Множина: важлива роль, не кількість спрацювань
    expect([...new Set(notices)]).toEqual([
      `ticket-handler:${PLATFORM_ROLES.command}`,
    ])
  })
})

/**
 * Нескоуплений довідник `Note` з носієм `createdBy.mentor` (Р-A1-8): ядро
 * без колонки скоупу, і копія носія від авторства в стані «після» —
 * з функції джерел поточного користувача (Р-A2-14), а не з рядка
 * «Користувачів» під командою.
 */
describe("catalog command core: unscoped Note", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const result = await compileRights(
      singleTenantRights({
        ...authorCarrier(),
        ...authorCarrier("long"),
        ...noteOwnCreator(),
      })
    )
    expect(result.diagnostics).toEqual([])
    const client = await tx.open()
    await client.query(renderDesiredState(result.model!).sql)
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    // W — `NoteWriter`; C — `NoteOwnCreator`, сам собі наставник, без
    // права на «Користувачів».
    ids = {}
    for (const user of ["W", "C"]) ids[user] = await signUp(client)
    await client.query("UPDATE public.users SET mentor_id = id WHERE id = $1", [
      ids.C,
    ])
    for (const [user, archetype] of [
      ["W", NOTE_WRITER_ID],
      ["C", NOTE_OWN_CREATOR_ID],
    ] as const)
      await insert(
        client,
        "global_role_assignments",
        assignmentRow(ids[user]!, { archetype })
      )
    ids.N1 = randomUUID()
    await insert(client, "note", {
      id: ids.N1,
      text: "n",
      created_by_id: ids.W,
      updated_by_id: ids.W,
    })
  }, 120_000)

  afterAll(() => tx.close())

  const key = (name: string) => {
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  const claims = (user: string) => ({ sub: key(user), role: "authenticated" })
  const noteVersion = async () =>
    (
      await tx
        .client()
        .query<{ v: string }>(
          "SELECT version::text AS v FROM public.note WHERE id = $1",
          [key("N1")]
        )
    ).rows[0]!.v
  const save = async (
    user: string,
    action: string,
    item: Record<string, unknown>,
    version: string | null
  ) =>
    outcomeOf(
      await commandAs<{ r: string }>(
        tx.client(),
        claims(user),
        { action, object: "note", root: item.id as string },
        "SELECT public.note_save($1::jsonb, $2::bigint) AS r",
        { params: [JSON.stringify(item), version] }
      )
    )
  const lines = () => ({
    note_lines: [
      { id: randomUUID(), text: "a" },
      { id: randomUUID(), text: "b" },
    ],
  })

  it("NoteWriter: create with lines", async () => {
    const item = { id: randomUUID(), text: "x", tabular: lines() }
    expect(await save("W", "create", item, null)).toMatchObject({
      id: item.id,
      created_by_id: key("W"),
      tabular: {
        note_lines: [{ line_number: 1 }, { line_number: 2 }],
      },
    })
  })

  it("NoteWriter: update with lines", async () => {
    const item = { id: key("N1"), text: "y", tabular: lines() }
    expect(await save("W", "update", item, await noteVersion())).toMatchObject({
      id: key("N1"),
      text: "y",
      tabular: { note_lines: [{ line_number: 1 }, { line_number: 2 }] },
    })
  })

  it("NoteWriter: markDeletion without the right is no-right", async () => {
    const result = await commandAs(
      tx.client(),
      claims("W"),
      { action: "markDeletion", object: "note", root: key("N1") },
      "SELECT public.note_mark_deletion($1::uuid, $2::bigint, true) AS r",
      { params: [key("N1"), await noteVersion()] }
    )
    expect(result).toEqual(NO_RIGHT)
  })

  // Авторство поза перевіркою видимості, копія — з функції джерел: під
  // командою рядок «Користувачів» для C невидимий, і копія `NULL` дала б
  // хибне `no-right` праву `own`
  it("NoteOwnCreator without read on Users: author carrier copy", async () => {
    const item = { id: randomUUID(), text: "own", tabular: lines() }
    expect(await save("C", "create", item, null)).toMatchObject({
      id: item.id,
      created_by_id: key("C"),
      created_by_id_mentor_id: key("C"),
      tabular: { note_lines: [{ line_number: 1 }, { line_number: 2 }] },
    })
  })

  // Функцію джерел викликає лише роль команд
  it("author sources function is closed to API roles", async () => {
    expect(
      await queryAs(
        tx.client(),
        "authenticated",
        claims("C"),
        "SELECT * FROM simetra.current_user_carrier_sources()"
      )
    ).toEqual({ code: "42501" })
  })
})
