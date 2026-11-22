import { randomUUID } from "node:crypto"
import { uuid } from "../../src/compiler/__tests__/helpers"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildClientCatalog,
  buildRuntimeCatalog,
  type CompiledModel,
} from "simetra/compiler"
import {
  PLATFORM_ROLES,
  RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME,
  rightsSnapshotSchema,
  type CatalogEntry,
  type ClientCatalog,
  type CommandContext,
  type RightsSnapshot,
} from "simetra/model"
import {
  GLOBAL_FOUNDER_ID,
  ROLE_FILE,
  TICKET_WRITER_ID,
  grant,
  objects,
  role,
  type Layer,
  TENANT_OPERATOR_ID,
  TICKET_TABLE,
  commandCoreLayer,
  compileRights,
  policyDomain,
  tenantOperator,
  tenantSelfService,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { can, type CanResult } from "../../src/data/store/rights"
import { type Refusal, claimsFor, commandAs, queryAs } from "./connection"
import { signUp } from "./auth"
import { testProvider } from "./profile"
import {
  type Seed,
  assignmentRow,
  deploy,
  orgDeltaRow,
  describeTransaction,
  insert,
  profileLayer,
  seedCommandCore,
} from "./rights-seed"
import { seedSignals, signalModel } from "./signal-topic-allowed.support"
import {
  USERS as PREDICATE_USERS,
  predicateLayer,
  seedPredicates,
} from "./rights-predicates.support"

/**
 * Еквівалентність обчислювача `can` з базою (спека П4-B §9.2, інваріант І6
 * плану B6-2): знімок бере той самий користувач викликом
 * `rights_client_snapshot()`, оракул — база. Дії запису: `can` ≡ чи проходить
 * пряме DML під контекстом команди (RLS запису; `update` — «до» і «після»
 * рядка); `read` — чи бачить рядок `SELECT` під claims. Відповідь `unknown`
 * не судиться (хост показує дію доступною), але для свіжих фактів її не має
 * бути взагалі. Обчислювач — дзеркало SQL, тож розбіжність — дефект
 * обчислювача, а не очікування тесту.
 */

type Row = Record<string, unknown>
type Tenant = "A" | "B"

const MARK = "evaluator-grid"
/** Користувачі лише з контейнерними правами: цілого скоупу вони не відкривають. */
const CONTAINER_ONLY = ["tp", "po", "pr"]
type WriteAction = "create" | "update" | "markDeletion"

/**
 * Відмова права: RLS запису чи `command.forbidden` ядра. Інша `42501` —
 * наприклад, відсутній грант таблиці — не відповідь оракула, а дефект сітки.
 */
const isRightsRefusal = (r: Refusal) =>
  r.code === "42501" &&
  (/row-level security/.test(r.message) || r.message === "command.forbidden")

/**
 * На Supabase вхід тестів не може стати роллю команд (на `postgres` він
 * суперкористувач): членство вхідній ролі — лише в транзакції опису.
 */
async function grantCommandSwitch(client: pg.Client): Promise<void> {
  if (testProvider() !== "supabase") return
  await client.query(`GRANT ${PLATFORM_ROLES.command} TO session_user`)
}

const OWN_IN_PROJECT_ID = uuid(9801)
const REGION_IN_PROJECT_ID = uuid(9802)
const FULL_ACCESS_ID = uuid(9805)
const WRITES = ["read", "create", "update", "markDeletion"]

/**
 * Доповнення моделі ядра команд (`commandCoreLayer`): контейнерні ролі з
 * обсягами `own` і виміру та роль з `fullAccess`. Глобальна роль і «кожен
 * користувач» на скоупленому об'єкті — помилка компілятора
 * (`rights.grant-level`), тож їх фікстур тут немає.
 */
function evaluatorLayer(): Layer {
  const ticket = objects(["Catalog", "Ticket"])
  const inProject = { container: objects(["Catalog", "Project"])[0] }
  return {
    [ROLE_FILE("TicketOwnInProject")]: role(
      OWN_IN_PROJECT_ID,
      "TicketOwnInProject",
      inProject,
      { grants: [grant(ticket, WRITES, "own")] }
    ),
    [ROLE_FILE("TicketRegionInProject")]: role(
      REGION_IN_PROJECT_ID,
      "TicketRegionInProject",
      inProject,
      { grants: [grant(ticket, WRITES, { dimension: "region" })] }
    ),
    [ROLE_FILE("TicketFullAccess")]: role(
      FULL_ACCESS_ID,
      "TicketFullAccess",
      { scopeKind: "org" },
      { fullAccess: true }
    ),
  }
}

/**
 * Користувачі поверх засіву ядра команд: `po` — `own` у контейнері P1,
 * `pr` — вимір у P1 (регіон r1), `fa` — `fullAccess`, `dn` — `TicketWriter` з `deny update@any` у кастомній ролі.
 * Рядки `KOWN` (виконавець `po`, P1), `KOWN2` (він же, P2) і `KDN`.
 */
async function seedEvaluator(client: pg.Client, ids: Seed): Promise<void> {
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
    assignment: Parameters<typeof assignmentRow>[1]
  ) => {
    ids[user] = await signUp(client)
    await create(`${user}@A`, "org_member", {
      org_id: ids.A,
      user_id: ids[user],
    })
    await insert(client, "org_role_assignments", {
      org_id: ids.A,
      ...assignmentRow(ids[`${user}@A`]!, assignment),
    })
  }
  await member("po", { archetype: OWN_IN_PROJECT_ID, container: ids.P1 })
  await member("pr", { archetype: REGION_IN_PROJECT_ID, container: ids.P1 })
  await insert(client, "member_region", {
    org_id: ids.A,
    member_id: ids["pr@A"],
    region_id: ids.r1,
  })
  await member("fa", { archetype: FULL_ACCESS_ID })
  await create("denyRole", "org_roles", {
    org_id: ids.A,
    archetype: TICKET_WRITER_ID,
  })
  await insert(
    client,
    "org_roles_delta",
    orgDeltaRow(ids.A!, ids.denyRole!, 1, ["deny", "ticket", "update", "any"])
  )
  await member("dn", { customRole: ids.denyRole })
  // Свій рядок `dn`: його `own`-право без рядка в скоупі — право «хоч на щось»
  await create("KDN", TICKET_TABLE, { org_id: ids.A, assignee_id: ids["dn@A"] })
  for (const [key, project] of [
    ["KOWN", ids.P1],
    ["KOWN2", ids.P2],
  ] as const)
    await create(key, TICKET_TABLE, {
      org_id: ids.A,
      assignee_id: ids["po@A"],
      project_id: project,
    })
}

/** Значення рядка за логічними іменами атрибутів і ключем (носії прав). */
function logicalRow(entry: CatalogEntry, raw: Row): Row {
  const row: Row = { [entry.keyName]: raw[entry.key] }
  for (const a of entry.attributes) row[a.name] = raw[a.column]
  return row
}

interface World {
  readonly catalog: ClientCatalog
  entry: (name: string) => CatalogEntry
  snapshot: (user: string) => RightsSnapshot
  key: (name: string) => string
}

export function defineRightsEvaluatorCases(): void {
  describe("T4 can equals the database: commands model", () => {
    const tx = describeTransaction()
    let ids: Seed = {}
    let world!: World
    const snapshots = new Map<string, RightsSnapshot>()

    const key = (name: string) => {
      const id = ids[name]
      if (id === undefined) throw new Error(`unknown seed key ${name}`)
      return id
    }
    const claims = (user: string) => claimsFor("user", key(user))
    const USERS = [
      "tw",
      "to",
      "tr",
      "tp",
      "rd",
      "cw",
      "tb",
      "po",
      "pr",
      "fa",
      "dn",
    ]

    beforeAll(async () => {
      const result = await compileRights(
        policyDomain(
          writeRoles(),
          commandCoreLayer(),
          evaluatorLayer(),
          profileLayer()
        )
      )
      expect(result.diagnostics).toEqual([])
      const model = result.model!
      const client = await tx.open()
      await deploy(client, model)
      // Повний DML ролі команд лише в цій транзакції: базова лінія RLS не
      // впирається в колонкові гранти (як у `catalog-command-rights`).
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
      )
      await grantCommandSwitch(client)
      ids = await seedCommandCore(client)
      await seedEvaluator(client, ids)
      // `publicRead` без межі тенанта: по рядку в обох тенантах.
      for (const org of ["A", "B"]) {
        ids[`bulletin.${org}`] = randomUUID()
        await insert(client, "bulletin", {
          id: ids[`bulletin.${org}`],
          org_id: ids[org],
          text: "x",
        })
      }
      world = await buildWorld(tx.client, model, USERS, key, claims, snapshots)
    }, 120_000)

    afterAll(() => tx.close())

    it("read: can equals a visible row, no unknown for fresh facts", async () => {
      const report = await readGrid(tx.client(), world, USERS, claims)
      expect(report.mismatches).toEqual([])
      // Оракул не вироджується: є і дозволені, і заборонені рядки.
      expect(report.allowed).toBeGreaterThan(0)
      expect(report.denied).toBeGreaterThan(0)
      // Єдине джерело `unknown` тут — межа «Користувачів».
      expect(report.unknown.filter((n) => n !== "Users")).toEqual([])
    })

    // --- запис: Ticket ---

    const POOL: Record<
      Tenant,
      { assignee: string[]; region: string[]; project: string[] }
    > = {
      A: {
        assignee: [
          "tw@A",
          "to@A",
          "tr@A",
          "tp@A",
          "rd@A",
          "cw@A",
          "po@A",
          "pr@A",
        ],
        region: ["r1", "r2"],
        project: ["P1", "P2"],
      },
      B: { assignee: ["tb@B"], region: [], project: ["PB"] },
    }
    const COLUMN = {
      assignee: "assignee_id",
      region: "region_id",
      project: "project_id",
    } as const
    type Carrier = keyof typeof COLUMN
    type State = { label: string; set: Partial<Record<Carrier, string | null>> }

    const statesOf = (tenant: Tenant): State[] => [
      { label: "unchanged", set: {} },
      // Контейнерні обсяги судять носій і контейнер разом
      ...POOL[tenant].project.slice(0, 1).flatMap((project) => [
        ...POOL[tenant].assignee.map((a) => ({
          label: `assignee=${a}+project=${project}`,
          set: { assignee: key(a), project: key(project) },
        })),
        ...POOL[tenant].region.map((r) => ({
          label: `region=${r}+project=${project}`,
          set: { region: key(r), project: key(project) },
        })),
      ]),
      ...(Object.keys(COLUMN) as Carrier[]).flatMap((c) => [
        { label: `${c}=NULL`, set: { [c]: null } },
        ...POOL[tenant][c].map((k) => ({
          label: `${c}=${k}`,
          set: { [c]: key(k) },
        })),
      ]),
    ]
    const ROWS: [string, Tenant][] = [
      ["K1", "A"],
      ["K2", "A"],
      ["KR", "A"],
      ["KB", "B"],
      ["KOWN", "A"],
      ["KOWN2", "A"],
    ]

    const ownerRow = async (id: string) =>
      (
        await tx
          .client()
          .query<Row>(`SELECT * FROM public.${TICKET_TABLE} WHERE id = $1`, [
            id,
          ])
      ).rows[0]!

    const canWrite = (
      user: string,
      action: WriteAction,
      raw: Row,
      tenant: Tenant
    ): CanResult =>
      can(
        world.snapshot(user),
        world.entry("Ticket"),
        action,
        { scope: key(tenant), row: logicalRow(world.entry("Ticket"), raw) },
        world.catalog.adoptedFacts
      )
    const both = (a: CanResult, b: CanResult): CanResult =>
      a === false || b === false
        ? false
        : a === true && b === true
          ? true
          : "unknown"

    const context = (action: WriteAction, id: string): CommandContext => ({
      action,
      object: TICKET_TABLE,
      root: id,
    })

    /** Чи пройшов запис: `INSERT` без помилки, `UPDATE` — коли власник бачить зміну. */
    async function viaDb(
      user: string,
      action: WriteAction,
      id: string,
      values: Row
    ): Promise<boolean> {
      const columns = Object.keys(values)
      const params = Object.values(values)
      const write =
        action === "create"
          ? {
              sql: `INSERT INTO public.${TICKET_TABLE} (id, ${columns.join(", ")}) VALUES ($1, ${columns.map((_, i) => `$${i + 2}`).join(", ")})`,
              params: [id, ...params],
              after: undefined,
            }
          : action === "update"
            ? {
                sql: `UPDATE public.${TICKET_TABLE} SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(", ")} WHERE id = $1`,
                params: [id, ...params],
                after: `SELECT description IS NOT DISTINCT FROM '${MARK}' AS hit FROM public.${TICKET_TABLE} WHERE id = '${id}'`,
              }
            : {
                sql: `UPDATE public.${TICKET_TABLE} SET deletion_mark = true WHERE id = $1`,
                params: [id],
                after: `SELECT deletion_mark AS hit FROM public.${TICKET_TABLE} WHERE id = '${id}'`,
              }
      const result = await commandAs(
        tx.client(),
        claims(user),
        context(action, id),
        write.sql,
        write.after === undefined
          ? { params: write.params }
          : { params: write.params, after: write.after }
      )
      if (!("rows" in result)) {
        if (!isRightsRefusal(result))
          throw new Error(`unexpected refusal ${result.code} ${result.message}`)
        return false
      }
      return write.after === undefined ? true : result.after?.[0]?.hit === true
    }

    const outcomes = { true: 0, false: 0 }
    const judge = (
      mismatches: string[],
      label: string,
      predicted: CanResult,
      db: boolean
    ) => {
      expect(predicted, `${label}: fresh facts never give unknown`).not.toBe(
        "unknown"
      )
      outcomes[String(db) as "true" | "false"]++
      if (predicted !== db)
        mismatches.push(`${label}: can ${predicted}, database ${db}`)
    }

    it.each(USERS)(
      "write: can equals the database for %s",
      async (user) => {
        const mismatches: string[] = []
        outcomes.true = 0
        outcomes.false = 0
        for (const [rowKey, tenant] of ROWS) {
          const before = await ownerRow(key(rowKey))
          for (const state of statesOf(tenant)) {
            const set = Object.fromEntries(
              Object.entries(state.set).map(([c, v]) => [
                COLUMN[c as Carrier],
                v,
              ])
            )
            // update: «до» і «після» рядка судять USING і WITH CHECK
            judge(
              mismatches,
              `${user} update ${rowKey} ${state.label}`,
              both(
                canWrite(user, "update", before, tenant),
                canWrite(user, "update", { ...before, ...set }, tenant)
              ),
              await viaDb(user, "update", key(rowKey), {
                description: MARK,
                ...set,
              })
            )
            // create: новий рядок із носіями стану, решта — порожня
            const fresh: Row = {
              org_id: key(tenant),
              assignee_id: null,
              region_id: null,
              project_id: null,
              ...set,
            }
            judge(
              mismatches,
              `${user} create in ${tenant} ${state.label}`,
              canWrite(user, "create", fresh, tenant),
              await viaDb(user, "create", randomUUID(), fresh)
            )
          }
          judge(
            mismatches,
            `${user} markDeletion ${rowKey}`,
            canWrite(user, "markDeletion", before, tenant),
            await viaDb(user, "markDeletion", key(rowKey), {})
          )
        }
        expect(mismatches).toEqual([])
        // Сітка не вироджується: кожен користувач має хоч одну відмову, а
        // власник будь-якого обсягу — хоч один дозвіл.
        expect(outcomes.false).toBeGreaterThan(0)
        if (!["rd", "cw"].includes(user))
          expect(
            outcomes.true,
            `${user} has a permitted point`
          ).toBeGreaterThan(0)
      },
      180_000
    )

    it("write without a row: the scope has a right to something", async () => {
      const mismatches: string[] = []
      for (const user of USERS) {
        for (const action of ["update", "markDeletion"] as const) {
          // Право «хоч на щось»: хоч один фікстурний рядок скоупу A проходить
          let some = false
          for (const rowKey of ["K1", "K2", "KR", "KL", "KW", "KOWN", "KDN"]) {
            some ||= await viaDb(user, action, key(rowKey), {
              ...(action === "update" ? { description: MARK } : {}),
            })
          }
          const predicted = can(
            world.snapshot(user),
            world.entry("Ticket"),
            action,
            { scope: key("A") },
            world.catalog.adoptedFacts
          )
          // Без рядка контейнерне право цілого скоупу не відкриває (Р3): `tp`
          // мають лише його (`tp`, `po`, `pr`), тож для них `false` при проходженні рядка —
          // задумане. Для решти `true` ⇔ є рядок, який проходить.
          if (predicted === true && !some)
            mismatches.push(
              `${user} ${action}: can true, no fixture row passes`
            )
          if (predicted === false && some && !CONTAINER_ONLY.includes(user))
            mismatches.push(`${user} ${action}: can false, a row passes`)
        }
      }
      expect(mismatches).toEqual([])
    }, 120_000)
  })

  describe("T4 can equals the database: signal model", () => {
    const tx = describeTransaction()
    let ids: Seed = {}
    let world!: World
    const snapshots = new Map<string, RightsSnapshot>()
    const key = (name: string) => {
      const id = ids[name]
      if (id === undefined) throw new Error(`unknown seed key ${name}`)
      return id
    }
    const claims = (user: string) => claimsFor("user", key(user))

    beforeAll(async () => {
      const model = await signalModel(predicateLayer())
      const client = await tx.open()
      await deploy(client, model)
      ids = await seedSignals(client)
      await seedPredicates(client, ids)
      world = await buildWorld(
        tx.client,
        model,
        PREDICATE_USERS,
        key,
        claims,
        snapshots
      )
    }, 120_000)

    afterAll(() => tx.close())

    it("read: can equals a visible row on every catalog object", async () => {
      const report = await readGrid(tx.client(), world, PREDICATE_USERS, claims)
      expect(report.mismatches).toEqual([])
      expect(report.allowed).toBeGreaterThan(0)
      expect(report.denied).toBeGreaterThan(0)
      // Дослівна функція множини скоупів: скоуповані об'єкти — `unknown`
      // (§14.3), нескоуповані судяться як зазвичай.
      const scoped = world.catalog.objects
        .filter((o) => o.scopeKindId !== undefined)
        .map((o) => o.name)
      expect(report.unknown.length).toBeGreaterThan(0)
      expect(
        report.unknown.filter((n) => !scoped.includes(n) && n !== "Users")
      ).toEqual([])
    })
  })

  describe("T4 can equals the database: create of a scope root", () => {
    const tx = describeTransaction()
    const ids: Seed = {}
    let world!: World
    const snapshots = new Map<string, RightsSnapshot>()
    const key = (name: string) => {
      const id = ids[name]
      if (id === undefined) throw new Error(`unknown seed key ${name}`)
      return id
    }
    const claims = (user: string) => claimsFor("user", key(user))
    // `plain` — лише «кожен користувач» (`create@own` кореня), `founder` —
    // глобальна роль `create@any` кореня, `operator` — `create` іншого кореня.
    const USERS = ["plain", "founder", "operator"]
    const ROOTS = [
      ["Organization", "organization"],
      ["Branch", "branch"],
    ] as const

    beforeAll(async () => {
      const result = await compileRights(
        policyDomain(tenantSelfService(), tenantOperator(), profileLayer())
      )
      expect(result.diagnostics).toEqual([])
      const client = await tx.open()
      await deploy(client, result.model!)
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
      )
      await grantCommandSwitch(client)
      for (const user of USERS) ids[user] = await signUp(client)
      for (const [user, role] of [
        ["founder", GLOBAL_FOUNDER_ID],
        ["operator", TENANT_OPERATOR_ID],
      ] as const)
        await insert(
          client,
          "global_role_assignments",
          assignmentRow(key(user), { archetype: role })
        )
      world = await buildWorld(
        tx.client,
        result.model!,
        USERS,
        key,
        claims,
        snapshots
      )
    }, 120_000)

    afterAll(() => tx.close())

    it.each(USERS)(
      "create of a root: can equals the insert for %s",
      async (user) => {
        const mismatches: string[] = []
        const seen = new Set<boolean>()
        for (const [name, table] of ROOTS) {
          const entry = world.entry(name)
          // Корінь, що створюється, ще не має скоупу; автор рядка — я
          const predicted = can(
            world.snapshot(user),
            entry,
            "create",
            { row: { createdBy: key(user) } },
            world.catalog.adoptedFacts
          )
          const id = randomUUID()
          const result = await commandAs(
            tx.client(),
            claims(user),
            { action: "create", object: table, root: id },
            `INSERT INTO public.${table} (id) VALUES ($1)`,
            { params: [id] }
          )
          if (!("rows" in result) && !isRightsRefusal(result))
            throw new Error(
              `unexpected refusal ${result.code} ${result.message}`
            )
          const db = "rows" in result
          seen.add(db)
          expect(predicted, `${user} create ${name}`).not.toBe("unknown")
          if (predicted !== db)
            mismatches.push(
              `${user} create ${name}: can ${predicted}, database ${db}`
            )
        }
        expect(mismatches).toEqual([])
        // `plain` і `founder` створюють `Organization`, але не `Branch`;
        // `operator` має обидва: сітка не вироджується лише на відмові.
        expect(seen.size).toBe(user === "operator" ? 1 : 2)
      }
    )
  })
}

async function buildWorld(
  client: () => pg.Client,
  model: CompiledModel,
  users: readonly string[],
  key: (name: string) => string,
  claims: (user: string) => Record<string, unknown>,
  snapshots: Map<string, RightsSnapshot>
): Promise<World> {
  const catalog = buildClientCatalog(buildRuntimeCatalog(model))
  for (const user of users) {
    const result = await queryAs<{ v: unknown }>(
      client(),
      "user",
      claims(user),
      `SELECT simetra.${RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME}() AS v`
    )
    if ("code" in result) throw new Error(`refused: ${result.code}`)
    snapshots.set(user, rightsSnapshotSchema.parse(result.rows[0]!.v))
  }
  return {
    catalog,
    key,
    entry: (name) => {
      const entry = catalog.objects.find((o) => o.name === name)
      if (entry === undefined) throw new Error(`no catalog entry ${name}`)
      return entry
    },
    snapshot: (user) => snapshots.get(user)!,
  }
}

interface ReadReport {
  mismatches: string[]
  allowed: number
  denied: number
  /** Імена об'єктів, де `can` відповів `unknown` (не судиться). */
  unknown: string[]
}

/**
 * Для кожного користувача, кожного об'єкта з контрактом і кожного засіяного
 * рядка: `can(read)` ≡ чи бачить користувач рядок `SELECT`-ом.
 */
async function readGrid(
  client: pg.Client,
  world: World,
  users: readonly string[],
  claims: (user: string) => Record<string, unknown>
): Promise<ReadReport> {
  const report: ReadReport = {
    mismatches: [],
    allowed: 0,
    denied: 0,
    unknown: [],
  }
  for (const entry of world.catalog.objects) {
    if (entry.rights === undefined) continue
    const from = `${entry.table.schema}.${entry.table.name}`
    const owned = (await client.query<Row>(`SELECT * FROM ${from}`)).rows
    for (const user of users) {
      const result = await queryAs<Row>(
        client,
        "user",
        claims(user),
        `SELECT ${entry.key} AS id FROM ${from}`
      )
      // Таблиця без гранту ролі запиту: жодного видимого рядка
      const visible = new Set(
        "rows" in result ? result.rows.map((r) => String(r.id)) : []
      )
      for (const raw of owned) {
        const scope =
          entry.scopeKindId === undefined
            ? undefined
            : String(raw[entry.scopeColumn ?? entry.key])
        const answer = can(
          world.snapshot(user),
          entry,
          "read",
          {
            ...(scope === undefined ? {} : { scope }),
            row: logicalRow(entry, raw),
          },
          world.catalog.adoptedFacts
        )
        const db = visible.has(String(raw[entry.key]))
        if (answer === "unknown") {
          report.unknown.push(entry.name)
          continue
        }
        if (db) report.allowed++
        else report.denied++
        if (answer !== db)
          report.mismatches.push(
            `${user} read ${entry.name} ${String(raw[entry.key])}: can ${answer}, database ${db}`
          )
      }
    }
  }
  return report
}
