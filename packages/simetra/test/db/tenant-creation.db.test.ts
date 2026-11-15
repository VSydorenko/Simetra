import { randomUUID } from "node:crypto"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import {
  COMMAND_CORE_ERRORS,
  COMMAND_SETTING,
  PLATFORM_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  SESSION_CLAIMS_SETTING,
  type CommandContext,
} from "simetra/model"
import {
  GLOBAL_ADMIN_ID,
  GLOBAL_FOUNDER_ID,
  GLOBAL_FULL_ID,
  ORG_ADMIN_ID,
  ORG_KIND_ID,
  TENANT_ADMIN_ID,
  TENANT_AUDITOR_ID,
  TENANT_OPERATOR_ID,
  TENANT_OWNER_ID,
  TENANT_READER_ID,
  compileRights,
  policyDomain,
  tenantOperator,
  tenantSelfService,
} from "../../src/compiler/__tests__/fixtures/rights"
import { fullAccessHolderRows } from "../../src/compiler/rights/guard-units"
import { LIVE, liveInputs } from "../../src/compiler/rights/functions"
import { signUp } from "./auth"
import {
  claimsFor,
  commandSteps,
  type CommandStep,
  type Refusal,
  setLocalSetting,
} from "./connection"
import {
  asOwnerLogin,
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  orgDeltaRow,
  profileLayer,
  type Seed,
} from "./rights-seed"

/**
 * Створення тенанта (спека П4 §6.13): ядро `<корінь>_create_root`, функція
 * гранту `simetra.<вид>_root_creator`, маркер кореня, знімок і ⊆ на COMMIT.
 * Порядок тригерів, RLS, відкладені перевірки й знімок виконує лише Postgres,
 * тож доказ — DB-рівня. Справжнього COMMIT транзакція опису не дає: «COMMIT»
 * — `SET CONSTRAINTS ALL IMMEDIATE` останнім кроком (`immediate`).
 */

const E = COMMAND_CORE_ERRORS
const forbidden = (detail: string): Refusal => ({
  code: E.forbidden.errcode,
  message: E.forbidden.message,
  detail,
})
const invalid = (detail: string): Refusal => ({
  code: E.invalid.errcode,
  message: E.invalid.message,
  detail,
})
const RIGHTS_CONTEXT = forbidden(E.forbidden.rightsContext)

const ORG = "organization"
const MEMBER = "org_member"
const ASSIGNMENTS = "org_role_assignments"
const GLOBAL_ASSIGNMENTS = "global_role_assignments"
const BRANCH = "branch"

const context = (
  action: string,
  object: string,
  root: string
): CommandContext => ({ action, object, root })

/** Виклик ядра кореня: результат — JSON Р-A6-10. */
const coreStep = (
  table: string,
  item: Record<string, unknown>,
  member: Record<string, unknown> | null,
  memberId: string | null
): CommandStep => ({
  context: context("create", table, item.id as string),
  sql: `SELECT public.${table}_create_root($1::jsonb, $2::jsonb, $3::uuid)::jsonb AS r`,
  params: [
    JSON.stringify(item),
    member === null ? null : JSON.stringify(member),
    memberId,
  ],
})

/** Сирий `INSERT` кореня під `create` (ядро оминається): маркер ставить тригер ефектів. */
const rawRootStep = (root: string, asOwner = false): CommandStep => ({
  context: context("create", ORG, root),
  sql: `INSERT INTO public.${ORG} (id) VALUES ($1)`,
  params: [root],
  asOwner,
})

/** Прямий виклик функції гранту виду `org` (ім'я — `physicalName` виду). */
const grantStep = (
  root: string,
  memberId: string,
  member: Record<string, unknown>,
  asOwner = false
): CommandStep => ({
  sql: "SELECT simetra.org_id_root_creator($1::uuid, $2::uuid, $3::jsonb)",
  params: [root, memberId, JSON.stringify(member)],
  asOwner,
})

/** Зміна claims посеред транзакції: інший актор тих самих операторів. */
const switchActor = (sub: string): CommandStep => ({
  check: (client) =>
    setLocalSetting(
      client,
      SESSION_CLAIMS_SETTING,
      JSON.stringify(claimsFor("user", sub))
    ),
})

/**
 * Оператор від ролі команд із контекстом, відомим лише під час сценарію
 * (id призначення, яке згенерувала функція гранту).
 */
const dynamicStep = (
  ctx: () => CommandContext,
  sql: string,
  params: () => unknown[]
): CommandStep => ({
  check: async (client) => {
    await setLocalSetting(client, COMMAND_SETTING, JSON.stringify(ctx()))
    await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
    return (await client.query(sql, params())).rowCount
  },
})

const query = (sql: string, params: unknown[] = []): CommandStep => ({
  check: async (client) => (await client.query(sql, params)).rows,
})

/**
 * Передумова рядка відмов: лічильник запиту `sql` дорівнює `n`, інакше
 * сценарій падає не відмовою, а помилкою тесту — пізніша перевірка не
 * сховає ранішу.
 */
const precondition = (
  sql: string,
  n: (count: number) => boolean
): CommandStep => ({
  check: async (client) => {
    const { rows } = await client.query<{ n: number }>(sql)
    if (!n(rows[0]!.n))
      throw new Error(`precondition failed: ${sql} = ${rows[0]!.n}`)
  },
})
const MARKERS =
  "SELECT count(*)::int AS n FROM simetra.rights_tx_root_marker WHERE xid = txid_current()"
const HEADERS =
  "SELECT count(*)::int AS n FROM simetra.rights_tx_header WHERE xid = txid_current() AND fact IN ('rights', 'scopes')"

/** Перший рядок першого `query`-кроку, у якого вибрано один стовпець `r`. */
const resultOf = (completed: unknown[], index: number) =>
  (completed[index] as { rows: { r: unknown }[] }).rows[0]!.r

/** Сценарій без відмови: інакше — причина в повідомленні, а не «undefined». */
function succeeded(outcome: { completed: unknown[]; refusal?: Refusal }) {
  expect(outcome.refusal).toBeUndefined()
  return outcome.completed
}

/** Опис з одним розгортанням: модель, транзакція й засів. */
function scenario(files: () => Map<string, string>) {
  const tx = describeTransaction()
  const ids: Seed = {}
  let compiled: CompiledModel | undefined
  const key = (name: string) => {
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  const claims = (user: string) => claimsFor("user", key(user))
  const steps = (
    user: string,
    list: readonly CommandStep[],
    immediate = false
  ) => commandSteps(tx.client(), claims(user), list, { immediate })
  const open = async (seed: (client: pg.Client) => Promise<void>) => {
    const result = await compileRights(files())
    expect(result.diagnostics).toEqual([])
    compiled = result.model!
    const client = await tx.open()
    await deploy(client, compiled)
    await seed(client)
    // Відкладені перевірки засіву — зараз: кейси починають з порожньої черги
    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    await client.query("SET CONSTRAINTS ALL DEFERRED")
  }
  /** Тенант `scope` з учасником `user` і архетипом `archetype`. */
  const member = async (
    client: pg.Client,
    user: string,
    scope: string,
    archetype: string,
    values: Record<string, unknown> = {}
  ) => {
    const id = randomUUID()
    ids[`${user}@${scope}`] = id
    await insert(client, MEMBER, {
      id,
      org_id: key(scope),
      user_id: key(user),
      ...values,
    })
    await insert(client, ASSIGNMENTS, {
      org_id: key(scope),
      ...assignmentRow(id, { archetype }),
    })
  }
  return {
    tx,
    ids,
    key,
    steps,
    member,
    open,
    model: () => compiled!,
    close: () => tx.close(),
  }
}

describe("tenant creation: self-service with a required member attribute and the operator model", () => {
  // Розгортання А: «кожен користувач» `TenantFounder` створює `Organization`
  // (`create@own`), `TenantOwner` — творець з `fullAccess`; `Branch` — вид
  // без творця, створює `TenantOperator`.
  const s = scenario(() =>
    policyDomain(
      tenantSelfService({ requiredMember: true, memberRegions: true }),
      tenantOperator(),
      profileLayer()
    )
  )
  const { key, ids, steps } = s
  const MEMBER_VALUES = { title: "founder" }

  beforeAll(
    () =>
      s.open(async (client) => {
        for (const user of ["creator", "other", "owner", "operator"])
          ids[user] = await signUp(client)
        ids.T = randomUUID()
        await insert(client, ORG, { id: ids.T })
        await s.member(client, "owner", "T", TENANT_OWNER_ID, {
          title: "owner",
        })
        await insert(
          client,
          GLOBAL_ASSIGNMENTS,
          assignmentRow(key("operator"), { archetype: TENANT_OPERATOR_ID })
        )
        ids.country = randomUUID()
        await insert(client, "country", { id: ids.country })
        ids.region = randomUUID()
        await insert(client, "region", { id: ids.region, org_id: ids.T })
      }),
    120_000
  )
  afterAll(() => s.close())

  it("creates a tenant: root, member and assignment in one transaction", async () => {
    const root = randomUUID()
    const member = randomUUID()
    const completed = succeeded(
      await steps(
        "creator",
        [
          coreStep(ORG, { id: root }, MEMBER_VALUES, member),
          query(
            `SELECT a.id, a.subject, a.archetype, j.reason, j.actor,
                    current_setting('${COMMAND_SETTING}')::jsonb AS ctx
               FROM public.${ASSIGNMENTS} a
               JOIN simetra.rights_journal j ON j.xid = txid_current() AND j.row_id = a.id
              WHERE a.org_id = $1`,
            [root]
          ),
          // Творець — дієвий носій `TenantOwner` уже в цій транзакції: корінь
          // видно ролі команд лише за правом нового скоупу
          { sql: `SELECT id FROM public.${ORG} WHERE id = $1`, params: [root] },
        ],
        true
      )
    )
    const result = resultOf(completed, 0) as {
      root: Record<string, unknown>
      member: Record<string, unknown>
    }
    expect(result.root).toMatchObject({
      id: root,
      created_by_id: key("creator"),
    })
    expect(result.member).toMatchObject({
      id: member,
      org_id: root,
      user_id: key("creator"),
      title: "founder",
    })
    expect(completed[1]).toEqual([
      {
        id: expect.any(String),
        subject: member,
        archetype: TENANT_OWNER_ID,
        reason: "root-creator",
        actor: key("creator"),
        ctx: context("create", ORG, root),
      },
    ])
    expect(completed[2]).toEqual({ rows: [{ id: root }], rowCount: 1 })
  })

  it("appended typed row equals the live typed row", async () => {
    const root = randomUUID()
    const member = randomUUID()
    const model = s.model()
    const style = model.project.naming.attributeCase
    const typed = liveInputs(model.contracts, model.physical, style, LIVE).typed
    const orgCatalog = model.contracts.rightsCatalogs.find(
      (c) => c.level.level === "scope" && c.level.scopeKindId === ORG_KIND_ID
    )!
    const holders = fullAccessHolderRows(
      orgCatalog,
      model.contracts,
      model.physical,
      style
    )
    const TYPED = `storage, storage_id, scope_kind_id, scope, container, custom_role, archetype, level, level_id`
    const pair = (appended: string, live: string): CommandStep =>
      query(
        `SELECT (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM (${appended}) x) AS appended,
                (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM (${live}) x) AS live`,
        [root]
      )
    const completed = succeeded(
      await steps("creator", [
        coreStep(ORG, { id: root }, MEMBER_VALUES, member),
        pair(
          `SELECT ${TYPED} FROM simetra.rights_tx_typed WHERE xid = txid_current() AND provenance = 'root-creator' AND scope = $1`,
          `SELECT ${TYPED} FROM (${typed}) t WHERE t.scope = $1`
        ),
        pair(
          `SELECT level, level_id, scope FROM simetra.rights_tx_holders WHERE xid = txid_current() AND scope = $1`,
          `SELECT 'scope' AS level, '${ORG_KIND_ID}'::uuid AS level_id, h.scope FROM (${holders}) h WHERE h.actor = (SELECT simetra.current_user_id()) AND h.scope = $1`
        ),
        pair(
          `SELECT scope_kind_id, scope, member, catalog FROM simetra.rights_tx_scopes WHERE xid = txid_current() AND scope = $1`,
          `SELECT scope_kind_id, scope, member, catalog FROM simetra.rights_my_scopes_live() WHERE scope = $1`
        ),
        query(
          `SELECT t.assignment, a.id FROM simetra.rights_tx_typed t, public.${ASSIGNMENTS} a WHERE t.xid = txid_current() AND t.provenance = 'root-creator' AND a.org_id = $1`,
          [root]
        ),
      ])
    )
    const [, typedRows, holderRows, scopeRows, assignment] = completed as [
      unknown,
      ...{ appended: unknown[]; live: unknown[] }[][],
    ]
    for (const [rows, length] of [
      [typedRows, 1],
      [holderRows, 1],
      [scopeRows, 1],
    ] as const) {
      expect(rows![0]!.appended).toHaveLength(length)
      expect(rows![0]!.appended).toEqual(rows![0]!.live)
    }
    expect(scopeRows![0]!.appended).toEqual([
      expect.objectContaining({ member, catalog: true }),
    ])
    const [link] = assignment as unknown as { assignment: string; id: string }[]
    expect(link!.assignment).toBe(link!.id)
  })

  /**
   * Відмови функції гранту: усі дають `rights-context`, тож кожен рядок
   * готує сценарій, де саме його перевірка — перша на шляху, а контроль
   * (`broken = false`) відрізняється лише цією умовою й доходить до COMMIT.
   * Виняток — рядок «(2)+(3)»: його відмову дають дві перевірки поспіль.
   */
  const refusals: [
    name: string,
    actor: string,
    prepare: (
      root: string,
      member: string,
      broken: boolean
    ) => readonly CommandStep[],
  ][] = [
    [
      "(1) context of another action",
      "creator",
      (root, member, broken) => [
        rawRootStep(root),
        {
          ...grantStep(root, member, MEMBER_VALUES),
          context: context(broken ? "update" : "create", ORG, root),
        },
      ],
    ],
    [
      "(1) context of another object",
      "creator",
      (root, member, broken) => [
        rawRootStep(root),
        {
          ...grantStep(root, member, MEMBER_VALUES),
          context: context("create", broken ? MEMBER : ORG, root),
        },
      ],
    ],
    [
      "(1) context of another root",
      "creator",
      (root, member, broken) => [
        rawRootStep(root),
        {
          ...grantStep(root, member, MEMBER_VALUES),
          context: context("create", ORG, broken ? randomUUID() : root),
        },
      ],
    ],
    [
      // Власник без контексту команди: тригер ефектів маркера не ставить;
      // режим обслуговування не вмикається — інакше відмова прийшла б з (5)
      "(2) root inserted without the command context",
      "creator",
      (root, member, broken) => [
        broken
          ? {
              sql: `INSERT INTO public.${ORG} (id) VALUES ($1)`,
              params: [root],
              asOwner: true,
            }
          : rawRootStep(root, true),
        {
          ...grantStep(root, member, MEMBER_VALUES),
          context: context("create", ORG, root),
        },
      ],
    ],
    [
      // Другий виклик відмовляє (2) — маркер уже спожито, — а без неї (3):
      // скоуп уже має учасника. (2) окремо доводять два інші рядки «(2) …»
      "(2)+(3) second call in the same scope",
      "creator",
      (root, member, broken) => [
        rawRootStep(root),
        grantStep(root, member, MEMBER_VALUES),
        ...(broken ? [grantStep(root, randomUUID(), MEMBER_VALUES)] : []),
      ],
    ],
    [
      // Маркер ставить актор вставки кореня; функцію кличе інший актор, і
      // заголовків знімка ще немає — відмова саме маркера
      "(2) marker of another actor",
      "creator",
      (root, member, broken) => [
        rawRootStep(root),
        precondition(HEADERS, (n) => n === 0),
        ...(broken ? [switchActor(key("other"))] : []),
        grantStep(root, member, MEMBER_VALUES),
      ],
    ],
    [
      "(3) scope already has a member",
      "creator",
      (root, member, broken) => [
        rawRootStep(root),
        ...(broken
          ? [
              {
                context: context("create", MEMBER, randomUUID()),
                sql: `INSERT INTO public.${MEMBER} (id, org_id, title) VALUES (gen_random_uuid(), $1, 'invite')`,
                params: [root],
                asOwner: true,
              },
            ]
          : []),
        {
          ...grantStep(root, member, MEMBER_VALUES),
          context: context("create", ORG, root),
        },
      ],
    ],
    [
      // Сесія власника функцій прав у режимі обслуговування: тригер ефектів
      // ставить маркер і тут, а тригер знімка знімка не бере. Режим гард
      // бачить лише від входу власника — кроки власника йдуть з нього
      "(5) snapshot headers missing",
      "creator",
      (root, member, broken) => [
        ...(broken
          ? [
              {
                check: (client: pg.Client) =>
                  setLocalSetting(client, RIGHTS_MAINTENANCE_SETTING, "on"),
              },
            ]
          : []),
        asOwnerLogin(rawRootStep(root, true)),
        // Маркер стоїть і в режимі обслуговування: відмова — не з (2)
        precondition(MARKERS, (n) => n === 1),
        asOwnerLogin(grantStep(root, member, MEMBER_VALUES, true)),
      ],
    ],
    [
      // Запис у джерело (членство наявного тенанта) бере знімок; перевірка
      // посеред транзакції заповнює кеш початку — він не мав би прав творця
      "(6) start cache filled before appending",
      "owner",
      (root, member, broken) => [
        {
          context: context("create", MEMBER, randomUUID()),
          sql: `INSERT INTO public.${MEMBER} (id, org_id, title) VALUES (gen_random_uuid(), $1, 'invite')`,
          params: [key("T")],
        },
        ...(broken
          ? [
              {
                check: (client: pg.Client) =>
                  client.query(
                    "SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED"
                  ),
              },
            ]
          : []),
        // Кеш початку заповнено рівно у зламаному варіанті, а заголовки
        // знімка є в обох — відмова не з (5)
        precondition(
          "SELECT count(*)::int AS n FROM simetra.rights_tx_start WHERE xid = txid_current()",
          (n) => n > 0 === broken
        ),
        precondition(HEADERS, (n) => n === 2),
        rawRootStep(root),
        grantStep(root, member, MEMBER_VALUES),
      ],
    ],
  ]

  it.each(refusals)("grant function refuses: %s", async (_, actor, prepare) => {
    const broken = await steps(
      actor,
      prepare(randomUUID(), randomUUID(), true),
      true
    )
    expect(broken.refusal).toEqual(RIGHTS_CONTEXT)
    succeeded(
      await steps(actor, prepare(randomUUID(), randomUUID(), false), true)
    )
  })

  it("marker without creator fails at COMMIT", async () => {
    const outcome = await steps("creator", [rawRootStep(randomUUID())], true)
    expect(outcome).toMatchObject({
      completed: [{ rowCount: 1 }],
      refusal: RIGHTS_CONTEXT,
    })
  })

  it("snapshot taken earlier passes", async () => {
    const root = randomUUID()
    const completed = succeeded(
      await steps(
        "owner",
        [
          {
            context: context("create", MEMBER, randomUUID()),
            sql: `INSERT INTO public.${MEMBER} (id, org_id, title) VALUES (gen_random_uuid(), $1, 'invite')`,
            params: [key("T")],
          },
          query(
            "SELECT fact FROM simetra.rights_tx_header WHERE xid = txid_current() ORDER BY fact"
          ),
          coreStep(ORG, { id: root }, MEMBER_VALUES, randomUUID()),
          { sql: `SELECT id FROM public.${ORG} WHERE id = $1`, params: [root] },
        ],
        true
      )
    )
    // Знімок узято до створення — права творця в новому скоупі все одно є
    expect(completed[1]).toEqual(
      expect.arrayContaining([{ fact: "rights" }, { fact: "scopes" }])
    )
    expect(completed[3]).toEqual({ rows: [{ id: root }], rowCount: 1 })
  })

  it("actor change fails", async () => {
    const outcome = await steps(
      "creator",
      [
        coreStep(ORG, { id: randomUUID() }, MEMBER_VALUES, randomUUID()),
        switchActor(key("other")),
      ],
      true
    )
    expect(outcome.completed).toHaveLength(2)
    expect(outcome.refusal).toEqual(RIGHTS_CONTEXT)
  })

  it("forced member columns: user and scope come from the function, not the payload", async () => {
    const root = randomUUID()
    const member = randomUUID()
    const completed = succeeded(
      await steps(
        "creator",
        [
          rawRootStep(root),
          grantStep(root, member, {
            ...MEMBER_VALUES,
            id: randomUUID(),
            user_id: key("other"),
            org_id: key("T"),
          }),
          query(
            `SELECT id, org_id, user_id FROM public.${MEMBER} WHERE id = $1 OR org_id = $2 OR user_id = $3`,
            [member, root, key("other")]
          ),
        ],
        true
      )
    )
    expect(completed[2]).toEqual([
      { id: member, org_id: root, user_id: key("creator") },
    ])
  })

  // Прямий виклик функції гранту сирим SQL оминає перевірки посилань ядра:
  // функція перевіряє рядок членства сама — від власника це «ціль існує й у
  // тому самому скоупі» (Р-A6-12), тож рядок чужого тенанта — відмова, і
  // жодного рядка членства не лишається
  it.each([
    [
      "array Ref to a row of another scope",
      () => ({ regions: [key("region")] }),
      false,
    ],
    [
      "polymorphic Ref to a row of another scope",
      () => ({ focus_type: "region", focus_id: key("region") }),
      false,
    ],
    [
      "unscoped targets that exist",
      () => ({
        countries: [key("country")],
        focus_type: "country",
        focus_id: key("country"),
      }),
      true,
    ],
  ] as const)(
    "direct grant call checks member references: %s",
    async (_, values, passes) => {
      const root = randomUUID()
      const member = randomUUID()
      const outcome = await steps("creator", [
        rawRootStep(root),
        grantStep(root, member, { ...MEMBER_VALUES, ...values() }),
        query(
          `SELECT count(*)::int AS n FROM public.${MEMBER} WHERE id = $1 OR org_id = $2`,
          [member, root]
        ),
      ])
      if (passes) {
        expect(succeeded(outcome)[2]).toEqual([{ n: 1 }])
      } else {
        expect(outcome.completed).toHaveLength(1)
        expect(outcome.refusal).toEqual(RIGHTS_CONTEXT)
      }
    }
  )

  // Поліморфний і масивний `Ref` на невидимий рядок — та сама відмова, що й
  // на відсутній id; власний рядок творця видно за `read@own`
  it.each([
    [
      "polymorphic Ref to a foreign user",
      () => ({ contact_type: "users", contact_id: key("other") }),
      "contact_id",
    ],
    [
      "polymorphic Ref to a missing row",
      () => ({ contact_type: "users", contact_id: randomUUID() }),
      "contact_id",
    ],
    [
      "array Ref to an invisible country",
      () => ({ countries: [key("country")] }),
      "countries",
    ],
    [
      "array Ref to a missing row",
      () => ({ countries: [randomUUID()] }),
      "countries",
    ],
    [
      "polymorphic Ref to the creator's own user",
      () => ({ contact_type: "users", contact_id: key("creator") }),
      undefined,
    ],
  ] as const)(
    "creatorMember reference checks: %s",
    async (_, values, column) => {
      const root = randomUUID()
      const outcome = await steps("creator", [
        coreStep(
          ORG,
          { id: root },
          { ...MEMBER_VALUES, ...values() },
          randomUUID()
        ),
      ])
      if (column === undefined) succeeded(outcome)
      else
        expect(outcome.refusal).toEqual(
          invalid(`${E.invalid.creatorMember}.${column}`)
        )
    }
  )

  it.each([
    [
      "tabular in p_item",
      () =>
        coreStep(
          ORG,
          { id: randomUUID(), tabular: {} },
          MEMBER_VALUES,
          randomUUID()
        ),
      E.invalid.tabular,
    ],
    [
      "no creator member on a rootCreator kind",
      () => coreStep(ORG, { id: randomUUID() }, null, null),
      E.invalid.creatorMember,
    ],
    [
      "creator member id without a member",
      () => coreStep(ORG, { id: randomUUID() }, MEMBER_VALUES, null),
      E.invalid.creatorMember,
    ],
    [
      "creator member on a kind without rootCreator",
      () => coreStep(BRANCH, { id: randomUUID() }, {}, randomUUID()),
      E.invalid.creatorMember,
    ],
  ] as const)("core input refusals: %s", async (_, step, detail) => {
    const outcome = await steps("operator", [step()])
    expect(outcome.refusal).toEqual(invalid(detail))
  })

  it("missing required member attribute fails on the member row", async () => {
    const outcome = await steps("creator", [
      coreStep(ORG, { id: randomUUID() }, {}, randomUUID()),
    ])
    // Код T3 для цієї відмови — Задача 6; тут — сира відмова бази
    expect(outcome.refusal).toMatchObject({ code: "23502", column: "title" })
    expect(outcome.refusal!.message).toMatch(/"org_member"/)
  })

  it("operator model: a root without a creator", async () => {
    const root = randomUUID()
    const completed = succeeded(
      await steps(
        "operator",
        [
          coreStep(BRANCH, { id: root }, null, null),
          query(MARKERS),
          {
            sql: `SELECT version::text AS v FROM public.${BRANCH} WHERE id = $1`,
            params: [root],
            asOwner: true,
          },
        ],
        true
      )
    )
    // Невидимий після створення корінь повертає версію, яку видав тригер
    // механіки, а не літерал.
    const stored = (completed[2] as { rows: { v: string }[] }).rows[0]!.v
    expect(resultOf(completed, 0)).toEqual({
      root: { id: root, version: stored },
      member: null,
    })
    expect(completed[1]).toEqual([{ n: 0 }])
  })

  it("insert policy: a direct root INSERT needs the create right", async () => {
    const insertBranch = (root: string): CommandStep => ({
      context: context("create", BRANCH, root),
      sql: `INSERT INTO public.${BRANCH} (id) VALUES ($1)`,
      params: [root],
    })
    const denied = await steps("creator", [insertBranch(randomUUID())])
    expect(denied.refusal).toMatchObject({ code: "42501" })
    expect(denied.refusal!.message).toMatch(/row-level security/)
    succeeded(await steps("operator", [insertBranch(randomUUID())], true))
  })
})

describe("tenant creation: invisible root version with an AFTER INSERT trigger writing another mechanics table", () => {
  // Дослівний тригер на `Branch` заступає платформені AFTER INSERT-тригери
  // (ефекти, `provision`): вони пишуть в іншу таблицю з механікою, і `currval`
  // після такої вставки вже не версія кореня, а налаштування на таблицю — так.
  // Підписка тут не підходить: прикладний SQL не пише таблиць видів
  // (`sql.kind-table-verbatim`).
  const s = scenario(() =>
    policyDomain(tenantSelfService(), tenantOperator(), profileLayer())
  )
  const { key, ids, steps } = s

  beforeAll(
    () =>
      s.open(async (client) => {
        ids.operator = await signUp(client)
        await insert(
          client,
          GLOBAL_ASSIGNMENTS,
          assignmentRow(key("operator"), { archetype: TENANT_OPERATOR_ID })
        )
        // Тригер, що пише таблицю з механікою, ставимо в транзакції опису.
        await client.query(`
          CREATE FUNCTION public.branch_write_test() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
          BEGIN INSERT INTO public.country (id) VALUES (gen_random_uuid()); RETURN NEW; END $$`)
        await client.query(
          "CREATE TRIGGER branch_write_test AFTER INSERT ON public.branch FOR EACH ROW EXECUTE FUNCTION public.branch_write_test()"
        )
      }),
    120_000
  )
  afterAll(() => s.close())

  it("the response carries the root version, not the last sequence value", async () => {
    const root = randomUUID()
    const completed = succeeded(
      await steps(
        "operator",
        [
          coreStep(BRANCH, { id: root }, null, null),
          {
            sql: `SELECT version::text AS v FROM public.${BRANCH} WHERE id = $1`,
            params: [root],
            asOwner: true,
          },
          {
            sql: "SELECT last_value::text AS v FROM simetra.row_version",
            asOwner: true,
          },
        ],
        true
      )
    )
    const version = (completed[1] as { rows: { v: string }[] }).rows[0]!.v
    const last = (completed[2] as { rows: { v: string }[] }).rows[0]!.v
    expect(last).not.toBe(version)
    expect(resultOf(completed, 0)).toEqual({
      root: { id: root, version },
      member: null,
    })
  })
})

describe("tenant creation: invisible member version", () => {
  // `TenantOwner` без `fullAccess` і без права читати членство: творець бачить
  // корінь, але не рядок свого члена, тож відповідь несе ключ і версію вставки
  // (налаштування тригера), а не `to_jsonb` рядка.
  const s = scenario(() =>
    policyDomain(
      tenantSelfService({ fullAccess: false, memberRead: false }),
      tenantOperator(),
      profileLayer()
    )
  )
  const { ids, steps } = s

  beforeAll(
    () =>
      s.open(async (client) => {
        ids.creator = await signUp(client)
      }),
    120_000
  )
  afterAll(() => s.close())

  it("the response carries the member version read under the schema owner", async () => {
    const root = randomUUID()
    const member = randomUUID()
    const completed = succeeded(
      await steps(
        "creator",
        [
          coreStep(ORG, { id: root }, {}, member),
          {
            sql: `SELECT version::text AS v FROM public.${MEMBER} WHERE id = $1`,
            params: [member],
            asOwner: true,
          },
          {
            sql: `SELECT id FROM public.${MEMBER} WHERE id = $1`,
            params: [member],
          },
        ],
        true
      )
    )
    const version = (completed[1] as { rows: { v: string }[] }).rows[0]!.v
    expect((completed[2] as { rows: unknown[] }).rows).toEqual([])
    expect(resultOf(completed, 0)).toMatchObject({
      member: { id: member, version },
    })
  })
})

describe("tenant creation: global founder without everyUser create", () => {
  // Розгортання Б: `TenantOwner` без `fullAccess`, `everyUser`-гранту на
  // корінь немає — `Organization` створює лише `GlobalFounder`, тож відмови
  // за правом не маскує рядок «кожного користувача».
  const s = scenario(() =>
    policyDomain(
      tenantSelfService({ fullAccess: false, founder: false }),
      tenantOperator(),
      profileLayer()
    )
  )
  const { key, ids, steps } = s

  beforeAll(
    () =>
      s.open(async (client) => {
        for (const user of ["founder", "full", "gadmin", "orgAdmin", "tOwner"])
          ids[user] = await signUp(client)
        ids.T = randomUUID()
        await insert(client, ORG, { id: ids.T })
        await s.member(client, "founder", "T", TENANT_ADMIN_ID)
        await s.member(client, "orgAdmin", "T", ORG_ADMIN_ID)
        await s.member(client, "tOwner", "T", TENANT_OWNER_ID)
        for (const [user, archetype] of [
          ["founder", GLOBAL_FOUNDER_ID],
          ["full", GLOBAL_FULL_ID],
          ["gadmin", GLOBAL_ADMIN_ID],
        ] as const)
          await insert(
            client,
            GLOBAL_ASSIGNMENTS,
            assignmentRow(key(user), { archetype })
          )
      }),
    120_000
  )
  afterAll(() => s.close())

  const assign = (
    id: string,
    scope: () => string,
    subject: () => string,
    archetype: string
  ): CommandStep =>
    dynamicStep(
      () => context("administerRights", ASSIGNMENTS, id),
      `INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)`,
      () => [id, scope(), subject(), archetype]
    )

  it("creator rights exist only in the new scope", async () => {
    const root = randomUUID()
    const member = randomUUID()
    const create = coreStep(ORG, { id: root }, {}, member)
    // Права творця в X не покривають приріст у наявному тенанті T
    const there = await steps(
      "founder",
      [
        create,
        assign(
          randomUUID(),
          () => key("T"),
          () => key("founder@T"),
          TENANT_READER_ID
        ),
      ],
      true
    )
    expect(there.completed).toHaveLength(2)
    expect(there.refusal).toEqual(forbidden(E.forbidden.escalation))
    succeeded(
      await steps(
        "founder",
        [
          create,
          assign(
            randomUUID(),
            () => root,
            () => member,
            TENANT_READER_ID
          ),
        ],
        true
      )
    )
  })

  it("escalation through the creator's own assignment", async () => {
    const root = randomUUID()
    let assignment = ""
    const outcome = await steps(
      "founder",
      [
        coreStep(ORG, { id: root }, {}, randomUUID()),
        {
          check: async (client) => {
            const { rows } = await client.query<{ id: string }>(
              `SELECT id FROM public.${ASSIGNMENTS} WHERE org_id = $1`,
              [root]
            )
            assignment = rows[0]!.id
          },
        },
        dynamicStep(
          () => context("administerRights", ASSIGNMENTS, assignment),
          `UPDATE public.${ASSIGNMENTS} SET archetype = $2 WHERE id = $1`,
          () => [assignment, TENANT_AUDITOR_ID]
        ),
        {
          check: async (client) =>
            (
              await client.query(
                "SELECT operation, reason FROM simetra.rights_journal WHERE xid = txid_current() AND row_id = $1 ORDER BY seq",
                [assignment]
              )
            ).rows,
        },
      ],
      true
    )
    expect(outcome.completed[2]).toBe(1)
    // Зміна власного призначення — уже дія творця командою
    expect(outcome.completed[3]).toEqual([
      { operation: expect.stringMatching(/insert/i), reason: "root-creator" },
      { operation: expect.stringMatching(/update/i), reason: "command" },
    ])
    expect(outcome.refusal).toEqual(forbidden(E.forbidden.escalation))
  })

  it("global creator on a rootCreator kind becomes the owner", async () => {
    const root = randomUUID()
    const member = randomUUID()
    const completed = succeeded(
      await steps(
        "founder",
        [
          coreStep(ORG, { id: root }, {}, member),
          query(
            `SELECT m.user_id, a.subject, a.archetype FROM public.${MEMBER} m JOIN public.${ASSIGNMENTS} a ON a.org_id = m.org_id WHERE m.org_id = $1`,
            [root]
          ),
          { sql: `SELECT id FROM public.${ORG} WHERE id = $1`, params: [root] },
        ],
        true
      )
    )
    expect(completed[1]).toEqual([
      { user_id: key("founder"), subject: member, archetype: TENANT_OWNER_ID },
    ])
    expect(completed[2]).toEqual({ rows: [{ id: root }], rowCount: 1 })
  })

  it("global fullAccess without explicit grant cannot create a root", async () => {
    const create = () => coreStep(ORG, { id: randomUUID() }, {}, randomUUID())
    const denied = await steps("full", [create()])
    expect(denied.refusal).toEqual(forbidden(E.forbidden.noRight))
    // Носій глобального `fullAccess` призначає собі `GlobalFounder` (Р-A6-22)
    const selfAssign = (user: string): CommandStep => {
      const id = randomUUID()
      return {
        context: context("administerRights", GLOBAL_ASSIGNMENTS, id),
        sql: `INSERT INTO public.${GLOBAL_ASSIGNMENTS} (id, subject, archetype) VALUES ($1, $2, $3)`,
        params: [id, key(user), GLOBAL_FOUNDER_ID],
      }
    }
    succeeded(await steps("full", [selfAssign("full")], true))
    // Засіяне призначення відкриває створення кореня
    succeeded(
      await steps(
        "full",
        [
          {
            check: (client) =>
              insert(
                client,
                GLOBAL_ASSIGNMENTS,
                assignmentRow(key("full"), { archetype: GLOBAL_FOUNDER_ID })
              ),
          },
          create(),
        ],
        true
      )
    )
    // Без `fullAccess` дати пару без неї самої не можна
    const escalated = await steps("gadmin", [selfAssign("gadmin")], true)
    expect(escalated.refusal).toEqual(forbidden(E.forbidden.escalation))
  })

  it.each([
    [
      "root create",
      ["allow", ORG, "create", "any"],
      forbidden(E.forbidden.deltaDomain),
    ],
    [
      "control: root markDeletion",
      ["allow", ORG, "markDeletion", "any"],
      undefined,
    ],
  ] as const)(
    "scope delta cannot grant root create: %s",
    async (_, delta, refusal) => {
      const role = randomUUID()
      const outcome = await steps(
        "orgAdmin",
        [
          {
            context: context("administerRights", "org_roles", role),
            sql: "INSERT INTO public.org_roles (id, org_id, archetype) VALUES ($1, $2, $3)",
            params: [role, key("T"), TENANT_OWNER_ID],
          },
          {
            sql: "INSERT INTO public.org_roles_delta (id, org_id, parent_id, line_number, object, action, extent, effect) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            params: (() => {
              const row = orgDeltaRow(key("T"), role, 1, [...delta])
              return [
                row.id,
                row.org_id,
                row.parent_id,
                row.line_number,
                row.object,
                row.action,
                row.extent,
                row.effect,
              ]
            })(),
          },
        ],
        true
      )
      expect(outcome.refusal).toEqual(refusal)
    }
  )

  it("insert policy: update of a root elsewhere does not open INSERT", async () => {
    const root = randomUUID()
    const outcome = await steps("tOwner", [
      {
        context: context("update", ORG, root),
        sql: `INSERT INTO public.${ORG} (id) VALUES ($1)`,
        params: [root],
      },
    ])
    expect(outcome.refusal).toMatchObject({ code: "42501" })
    expect(outcome.refusal!.message).toMatch(/row-level security/)
  })
})
