import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  buildRuntimeCatalog,
  compile,
  fullAccessHolderRows,
  type CompiledModel,
} from "simetra/compiler"
import {
  PLATFORM_ROLES,
  defineObjectModule,
  type MetadataRef,
  type ObjectModule,
  type Operation,
  type RuntimeCatalog,
  type SessionClaims,
} from "simetra/model"
import { desiredForApply } from "simetra/schema"
import {
  createCommandRuntime,
  fromPgPool,
  readRoleOf,
  type CommandDatabase,
  type CommandRuntime,
  type CommandRuntimeOptions,
} from "simetra/server"
import {
  GLOBAL_FOUNDER_ID,
  ORG_KIND_ID,
  TENANT_AUDITOR_ID,
  TENANT_OPERATOR_ID,
  TENANT_OWNER_ID,
  TENANT_READER_ID,
  policyDomain,
  signUp,
  tenantOperator,
  tenantSelfService,
} from "../../../simetra/test/support"
import {
  commandRefusal as refusal,
  heldResource,
  inTarget,
  recordingDatabase,
  seedMarker,
  seedUnderMaintenance,
  throughPoolerAs,
  withRuntimeLogin,
} from "./support/db"

/**
 * Створення тенанта через `runtime.run` (спека П4 §6.13, §7.2, §7.3) над
 * тінню рушія: транзакція `runCommand` закомічується по-справжньому, тож
 * знімок, маркер кореня й ⊆ судяться на справжньому `COMMIT`, а пулер у
 * режимі транзакцій міняє серверне з'єднання між командами — порт-фейк T3 і
 * транзакція опису simetra DB цього не дають. Дві моделі: А — самообслуговування
 * з обов'язковим реквізитом учасника й модель оператора на `Branch`; Б —
 * `Organization` створює лише `GlobalFounder`, `TenantOwner` без `fullAccess`
 * (хук членства призначає роль у межах прав творця).
 */

const ORGANIZATION: MetadataRef = { kind: "Catalog", name: "Organization" }
const BRANCH: MetadataRef = { kind: "Catalog", name: "Branch" }
const ASSIGNMENTS: MetadataRef = {
  kind: "Catalog",
  name: "OrgRoleAssignments",
}
const ORGANIZATION_KEY = "Catalog.Organization"
const MEMBER_KEY = "Catalog.OrgMember"
const REQUEST_ROLE = readRoleOf("supabase")!

interface Env {
  model: CompiledModel
  catalog: RuntimeCatalog
  owner: pg.Client
  direct: pg.Pool
  pooled: pg.Pool
  /** Засіяні актори моделі: ім'я → id користувача. */
  users: Record<string, string>
}

const sessionOf = (user: string): SessionClaims => ({
  sub: user,
  role: REQUEST_ROLE,
})

/**
 * Тінь моделі `files` з бажаним станом застосування й marker, засів `seed`
 * (глобальні призначення — у режимі обслуговування) і роль входу форми
 * `simetra_runtime` — напряму й через пулер.
 */
const heldEnv = (
  files: () => Map<string, string>,
  label: string,
  seed: (owner: pg.Client) => Promise<Record<string, string>>
) =>
  heldResource<Env>(async (use) => {
    const result = await compile(files())
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    const desired = await desiredForApply(model)
    await inTarget(desired.sql, desired.scope, async (url) => {
      const owner = new pg.Client({ connectionString: url })
      await owner.connect()
      try {
        await seedMarker(owner, model.hash)
        const users = await seed(owner)
        await withRuntimeLogin(
          url,
          [PLATFORM_ROLES.command, REQUEST_ROLE],
          async (login) => {
            const direct = new pg.Pool({ connectionString: login })
            const pooled = new pg.Pool({
              connectionString: throughPoolerAs(login),
            })
            try {
              await use({
                model,
                catalog: buildRuntimeCatalog(model),
                owner,
                direct,
                pooled,
                users,
              })
            } finally {
              await direct.end()
              await pooled.end()
            }
          },
          label
        )
      } finally {
        await owner.end()
      }
    })
  })

/** Користувачі з глобальними призначеннями `archetypes` (ім'я → архетип). */
async function seedGlobal(
  owner: pg.Client,
  archetypes: Record<string, string>
): Promise<Record<string, string>> {
  const users: Record<string, string> = {}
  await seedUnderMaintenance(owner, async () => {
    for (const [name, archetype] of Object.entries(archetypes)) {
      users[name] = await signUp(owner)
      await owner.query(
        "INSERT INTO public.global_role_assignments (id, subject, archetype) VALUES ($1, $2, $3)",
        [randomUUID(), users[name], archetype]
      )
    }
  })
  return users
}

/** Порт, що віддає порт пулу `env` за назвою способу підключення. */
type Port = (env: Env) => pg.Pool
const PORTS: [string, Port][] = [
  ["the direct port", (env) => env.direct],
  ["the pooler", (env) => env.pooled],
]

/**
 * Порт, що на першому `COMMIT` після `arm()` замість нього виконує в тій
 * самій транзакції оператор із `SQLSTATE 40001`: відмову повтору дає сама
 * база, а не підроблена помилка (власний виняток хука — `command.internal`,
 * спека П4 §7.2).
 */
function serializationFailureOnce(inner: CommandDatabase): {
  database: CommandDatabase
  arm: () => void
} {
  let armed = false
  return {
    arm: () => {
      armed = true
    },
    database: {
      async connect() {
        const client = await inner.connect()
        return {
          query(text, params) {
            if (text === "COMMIT" && armed) {
              armed = false
              return client.query(
                "DO $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '40001'; END $$",
                []
              )
            }
            return client.query(text, params)
          },
          release: (destroy) => client.release(destroy),
        }
      },
    },
  }
}

describe("tenant creation through runtime.run", () => {
  // Модель А: «кожен користувач» створює `Organization` з `creatorMember`
  // (обов'язковий `title`), `TenantOwner` з `fullAccess` — творець;
  // `TenantOperator` створює `Branch` без творця.
  const targetA = heldEnv(
    () =>
      policyDomain(
        tenantSelfService({ requiredMember: true }),
        tenantOperator()
      ),
    "tenant_a",
    (owner) => seedGlobal(owner, { operator: TENANT_OPERATOR_ID })
  )
  // Модель Б: лише `GlobalFounder` створює `Organization`; `TenantOwner` без
  // `fullAccess` адмініструє призначення в межах своїх прав.
  const targetB = heldEnv(
    () =>
      policyDomain(
        tenantSelfService({ fullAccess: false, founder: false }),
        tenantOperator()
      ),
    "tenant_b",
    (owner) => seedGlobal(owner, { founder: GLOBAL_FOUNDER_ID })
  )
  let a: Env
  let b: Env

  beforeAll(async () => {
    a = await targetA.open()
    b = await targetB.open()
  }, 240_000)
  afterAll(async () => {
    await targetA.close()
    await targetB.close()
  }, 60_000)

  const runtime = (
    env: Env,
    database: CommandDatabase,
    options: Partial<CommandRuntimeOptions> = {}
  ): Promise<CommandRuntime> =>
    createCommandRuntime({ database, catalog: env.catalog, ...options })

  const objectOf = (env: Env, ref: MetadataRef) =>
    env.catalog.objects.find((o) => o.kind === ref.kind && o.name === ref.name)!

  const user = (env: Env) => signUp(env.owner)

  const createOrganization = (
    creatorMember?: Record<string, unknown>
  ): Extract<Operation, { action: "create" }> => ({
    action: "create",
    object: ORGANIZATION,
    ...(creatorMember === undefined ? {} : { creatorMember }),
  })

  /** Скоупи, де `actor` — дієвий носій `fullAccess` рівня `org` (модель А). */
  const fullAccessScopes = async (env: Env, actor: string) => {
    const catalog = env.model.contracts.rightsCatalogs.find(
      (c) => c.level.level === "scope" && c.level.scopeKindId === ORG_KIND_ID
    )!
    const sql = fullAccessHolderRows(
      catalog,
      env.model.contracts,
      env.model.physical,
      env.model.project.naming.attributeCase
    )
    const { rows } = await env.owner.query<{ scope: string }>(
      `SELECT h.scope::text AS scope FROM (${sql}) h WHERE h.actor = $1 ORDER BY 1`,
      [actor]
    )
    return rows.map((r) => r.scope)
  }

  /** Призначення тенанта `org` з причиною журналу й актором першого запису. */
  const assignmentsOf = async (env: Env, org: string) =>
    (
      await env.owner.query(
        `SELECT a.id::text AS id, m.user_id::text AS "user", a.archetype::text AS archetype,
                j.reason, j.actor::text AS actor
           FROM public.org_role_assignments a
           JOIN public.org_member m ON m.id = a.subject
           JOIN simetra.rights_journal j ON j.row_id = a.id
          WHERE a.org_id = $1
          ORDER BY a.archetype`,
        [org]
      )
    ).rows

  describe.each(PORTS)("through %s", (_, port) => {
    // Корінь видно творцю лише за правом нового скоупу: повний рядок у
    // результаті й читання наступною транзакцією доводять, що права творця
    // діють уже в транзакції створення й пережили справжній COMMIT.
    it("self-service tenant: the full root row, read by the next transaction, journal root-creator", async () => {
      const creator = await user(a)
      const rt = await runtime(a, fromPgPool(port(a)))
      const organization = objectOf(a, ORGANIZATION)
      const created = await rt.run(
        sessionOf(creator),
        createOrganization({ title: "founder" })
      )
      const [row] = created.rows
      const id = row![organization.keyName] as string
      const author = organization.attributes.find(
        (attribute) => attribute.column === "created_by_id"
      )!.name
      expect(row).toMatchObject({
        [organization.versionName]: 1,
        [author]: creator,
      })
      expect(created.changes).toEqual([
        {
          object: ORGANIZATION,
          scopeKind: organization.scopeKindId,
          scope: id,
          id,
          version: 1,
          operation: "create",
        },
      ])
      expect(
        await rt.read(sessionOf(creator), { object: ORGANIZATION, id })
      ).toEqual([row])
      expect(await assignmentsOf(a, id)).toEqual([
        {
          id: expect.any(String),
          user: creator,
          archetype: TENANT_OWNER_ID,
          reason: "root-creator",
          actor: creator,
        },
      ])
      expect(await fullAccessScopes(a, creator)).toEqual([id])
    })

    it("operator tenant: the root without a creator is { id, version: 1 }", async () => {
      const rt = await runtime(a, fromPgPool(port(a)))
      const branch = objectOf(a, BRANCH)
      const created = await rt.run(sessionOf(a.users.operator!), {
        action: "create",
        object: BRANCH,
      })
      const id = created.rows[0]![branch.keyName] as string
      expect(created.rows).toEqual([
        { [branch.keyName]: id, [branch.versionName]: 1 },
      ])
      const { rows } = await a.owner.query(
        "SELECT (SELECT count(*)::int FROM public.branch WHERE id = $1) AS roots, (SELECT count(*)::int FROM public.branch_member WHERE branch_id = $1) AS members",
        [id]
      )
      expect(rows).toEqual([{ roots: 1, members: 0 }])
    })

    it.each<[string, Operation, Record<string, unknown>]>([
      [
        "an id in the input",
        { ...createOrganization({ title: "x" }), id: randomUUID() },
        { path: "id" },
      ],
      [
        "tabularSections",
        {
          ...createOrganization({ title: "x" }),
          tabularSections: { lines: [] },
        },
        { path: "tabularSections" },
      ],
      [
        // `23502` таблиці членства в фазі кореня — реквізит `creatorMember`
        "creatorMember without the required attribute",
        createOrganization({}),
        { path: "creatorMember.title" },
      ],
    ])("%s is command.invalid and writes nothing", async (_, op, error) => {
      const creator = await user(a)
      const rt = await runtime(a, fromPgPool(port(a)))
      expect(await refusal(rt.run(sessionOf(creator), op))).toEqual({
        code: "command.invalid",
        ...error,
      })
      const { rows } = await a.owner.query(
        "SELECT count(*)::int AS n FROM public.organization WHERE created_by_id = $1",
        [creator]
      )
      expect(rows).toEqual([{ n: 0 }])
    })

    // Два маркери й два гранти одного актора в одній транзакції: права —
    // рівно в X і Y (Review Focus 2).
    it("two tenants in one batch: the creator holds TenantOwner exactly in both", async () => {
      const creator = await user(a)
      const rt = await runtime(a, fromPgPool(port(a)))
      const key = objectOf(a, ORGANIZATION).keyName
      const created = await rt.run(sessionOf(creator), [
        createOrganization({ title: "x" }),
        createOrganization({ title: "y" }),
      ])
      const ids = created.rows.map((r) => r[key] as string)
      expect(new Set(ids).size).toBe(2)
      expect(await fullAccessScopes(a, creator)).toEqual([...ids].sort())
    })

    // Відкат першої спроби прибирає корінь, членство й маркер; повтор бере ті
    // самі id (Р-A6-20), і другий маркер того самого кореня не конфліктує.
    it("retry keeps ids: a 40001 on the first COMMIT, the second attempt commits", async () => {
      const creator = await user(a)
      const failing = serializationFailureOnce(fromPgPool(port(a)))
      const recorded = recordingDatabase(failing.database)
      const seen: string[] = []
      const module = defineObjectModule({
        onWrite: ({ ctx }) => {
          seen.push(ctx.id)
          if (seen.length === 1) failing.arm()
        },
      })
      const rt = await runtime(a, recorded.database, {
        objectModules: { [ORGANIZATION_KEY]: module as ObjectModule<object> },
      })
      recorded.statements.length = 0
      const created = await rt.run(
        sessionOf(creator),
        createOrganization({ title: "retry" })
      )
      const id = created.rows[0]![objectOf(a, ORGANIZATION).keyName] as string
      const cores = recorded.statements.filter((s) =>
        s.text.includes("_create_root")
      )
      expect(cores).toHaveLength(2)
      expect(cores[1]!.params).toEqual(cores[0]!.params)
      expect(JSON.parse(cores[0]!.params[0]!)).toEqual({ id })
      expect(seen).toEqual([id, id])
      expect(
        recorded.statements
          .filter((s) => s.text === "COMMIT")
          .map((s) => s.failed?.code)
      ).toEqual(["40001", undefined])
      const { rows } = await a.owner.query(
        "SELECT count(*)::int AS n FROM simetra.rights_tx_root_marker"
      )
      expect(rows).toEqual([{ n: 0 }])
      expect(await fullAccessScopes(a, creator)).toEqual([id])
    })

    // Хук членства пише командою в межах прав творця, що діють у тій самій
    // транзакції; ⊆ на COMMIT судить призначення як дію творця (`command`).
    it("membership hook assigns a role: TenantReader commits with journal command, TenantAuditor is escalation", async () => {
      const founder = b.users.founder!
      const member = objectOf(b, { kind: "Catalog", name: "OrgMember" })
      const assignOnWrite = (archetype: string, id: string) =>
        defineObjectModule({
          onWrite: async ({ ctx, row }) => {
            const scope = member.attributes.find(
              (attribute) => attribute.column === "org_id"
            )!.name
            await ctx.run({
              action: "create",
              object: ASSIGNMENTS,
              id,
              values: {
                org: (row as Record<string, unknown>)[scope],
                subject: (row as Record<string, unknown>)[member.keyName],
                archetype,
              },
            })
          },
        })
      const run = async (archetype: string, id: string) =>
        (
          await runtime(b, fromPgPool(port(b)), {
            objectModules: {
              [MEMBER_KEY]: assignOnWrite(
                archetype,
                id
              ) as ObjectModule<object>,
            },
          })
        ).run(sessionOf(founder), createOrganization({}))

      const reader = randomUUID()
      const created = await run(TENANT_READER_ID, reader)
      const org = created.rows[0]![objectOf(b, ORGANIZATION).keyName] as string
      expect(await assignmentsOf(b, org)).toEqual([
        {
          id: expect.any(String),
          user: founder,
          archetype: TENANT_OWNER_ID,
          reason: "root-creator",
          actor: founder,
        },
        {
          id: reader,
          user: founder,
          archetype: TENANT_READER_ID,
          reason: "command",
          actor: founder,
        },
      ])

      const auditor = randomUUID()
      expect(await refusal(run(TENANT_AUDITOR_ID, auditor))).toEqual({
        code: "command.forbidden",
        reason: "escalation",
      })
      const { rows } = await b.owner.query(
        "SELECT count(*)::int AS n FROM public.org_role_assignments WHERE id = $1",
        [auditor]
      )
      expect(rows).toEqual([{ n: 0 }])
    })
  })

  // Чутливий до часу й чужих сесій сценарій — окремо й послідовно: перша
  // транзакція тримає вставлений корінь, членство, маркер і знімок, а друга
  // іншого актора мусить завершитися, не чекаючи на неї (спека П4 §7.2).
  describe.each(PORTS)("parallel tenant creation through %s", (_, port) => {
    it("does not block: the second creator commits while the first holds its transaction", async () => {
      const [first, second] = [await user(a), await user(a)]
      let entered!: () => void
      const inHook = new Promise<void>((resolve) => (entered = resolve))
      let release!: () => void
      const gate = new Promise<void>((resolve) => (release = resolve))
      const holding = defineObjectModule({
        onWrite: async () => {
          entered()
          await gate
        },
      })
      const blocked = await runtime(a, fromPgPool(port(a)), {
        objectModules: { [ORGANIZATION_KEY]: holding as ObjectModule<object> },
      })
      const free = await runtime(a, fromPgPool(port(a)))
      const key = objectOf(a, ORGANIZATION).keyName
      let firstDone = false
      const firstRun = blocked
        .run(sessionOf(first), createOrganization({ title: "first" }))
        .finally(() => {
          firstDone = true
        })
      try {
        await inHook
        const secondRun = free.run(
          sessionOf(second),
          createOrganization({ title: "second" })
        )
        let timer: NodeJS.Timeout | undefined
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("the second creation waited")),
            15_000
          )
        })
        const y = (
          await Promise.race([secondRun, timeout]).finally(() =>
            clearTimeout(timer)
          )
        ).rows[0]![key] as string
        expect(firstDone).toBe(false)
        expect(await fullAccessScopes(a, second)).toEqual([y])
      } finally {
        release()
      }
      const x = (await firstRun).rows[0]![key] as string
      expect(await fullAccessScopes(a, first)).toEqual([x])
    })
  })
})
