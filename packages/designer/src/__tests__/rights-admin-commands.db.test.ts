import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
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
  SESSION_CLAIMS_SETTING,
  defineObjectModule,
  type CommandError,
  type MetadataRef,
  type ObjectModule,
  type Operation,
  type RuntimeCatalog,
  type SessionClaims,
  CommandFailure,
} from "simetra/model"
import type { RightsOrphans } from "simetra/schema"
import {
  createCommandRuntime,
  fromPgPool,
  readRoleOf,
  type CommandRuntime,
} from "simetra/server"
import { runTool } from "../cli/command"
import { databaseResource } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import type { PlanData } from "../tools/apply-tools"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { InvokeOptions, ToolResult } from "../tools/types"
import {
  MEMBER_CREATOR_ID,
  MEMBER_EDITOR_ID,
  ORG_ADMIN_ID,
  RIGHTS_ADMIN_ID,
  SNAPSHOT_TABLES,
  TASK_VIEWER_ID,
  TICKET_OWN_WRITER_ID,
  TICKET_REGION_WRITER_ID,
  TICKET_TABLE,
  TICKET_WRITER_ID,
  acceptDebt,
  adminRoles,
  commandCoreLayer,
  insertOrphan,
  memberCreator,
  planNodes,
  policyDomain,
  rightsAdminReadingMembers,
  signUp,
} from "../../../simetra/test/support"
import {
  committed,
  heldResource,
  inTarget,
  recordingDatabase,
  seedUnderMaintenance,
  throughPoolerAs,
  withRuntimeLogin,
  type RecordedStatement,
} from "./support/db"

/**
 * Команди адміністрування прав (спека П4 §6.12) через `runtime.run` над
 * ціллю, розгорнутою справжніми `plan` + `apply`: marker з канонічним знімком
 * потрібен і рантайму, і плану. Запобіжники прав судять на `COMMIT` у
 * справжній транзакції з закоміченими даними, а план читає дані цілі — цього
 * порт-фейк unit-тестів T3 не доводить. Кожен кейс — і прямим портом, і через
 * пулер Supavisor (П4 §7.3), у своїй організації зі своїми акторами. Ціль одна
 * на файл (одне розгортання), кейси йдуть послідовно.
 */

const SIMETRA = resolve(__dirname, "../../../simetra")
const ENV = "SIMETRA_DATABASE_URL"
const REQUEST_ROLE = readRoleOf("supabase")!

const ROLES: MetadataRef = { kind: "Catalog", name: "OrgRoles" }
const ASSIGNMENTS: MetadataRef = { kind: "Catalog", name: "OrgRoleAssignments" }
const MEMBERS: MetadataRef = { kind: "Catalog", name: "OrgMember" }
const TICKET: MetadataRef = { kind: "Catalog", name: "Ticket" }
const ASSIGNMENTS_KEY = "Catalog.OrgRoleAssignments"

interface Env {
  dir: string
  url: string
  model: CompiledModel
  catalog: RuntimeCatalog
  owner: pg.Client
}

/** Пули ролі входу рантайму: прямим портом і через пулер. */
interface Pools {
  direct: pg.Pool
  pooled: pg.Pool
}

interface Person {
  user: string
  member: string
  session: SessionClaims
}

interface Org {
  id: string
  people: Record<string, Person>
  /** Id засіяного призначення за ключем `<людина>:<архетип>`. */
  assignments: Record<string, string>
}

const sessionOf = (user: string): SessionClaims => ({
  sub: user,
  role: REQUEST_ROLE,
})

/** Корінь проєкту з `node_modules/simetra` і текою метаданих моделі файлу. */
async function writeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-rights-admin-"))
  await mkdir(join(root, "node_modules"))
  await symlink(SIMETRA, join(root, "node_modules", "simetra"), "dir")
  const dir = join(root, "metadata")
  const files = await acceptDebt(
    policyDomain(
      adminRoles(),
      commandCoreLayer(),
      rightsAdminReadingMembers(),
      memberCreator()
    )
  )
  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

const options = (dir: string, url: string): InvokeOptions => ({
  dir,
  readOnly: false,
  allowDatabaseWrite: true,
  dryRun: false,
  confirmed: true,
  channel: "cli",
  database: databaseResource({ [ENV]: url }, { url: ENV }),
})

const errors = (r: ToolResult) =>
  r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)

/** Справжнє розгортання: `plan` пише план, `apply` його застосовує. */
async function deploy(dir: string, url: string): Promise<void> {
  const planned = await invoke(toolByName("plan")!, {}, options(dir, url))
  expect(errors(planned), JSON.stringify(planned.diagnostics)).toEqual([])
  const data = planned.data as PlanData
  const applied = await invoke(
    toolByName("apply")!,
    {
      plan: data.file,
      planHash: data.planHash,
      allow: data.requiredPermissions,
    },
    options(dir, url)
  )
  expect(errors(applied), JSON.stringify(applied.diagnostics)).toEqual([])
  expect(applied.data).toMatchObject({ status: "committed" })
}

/**
 * Організація з людьми: кожна — користувач (реєстрацією: провізія дає
 * ідентичність), учасник і призначення архетипів зі списку. Призначення —
 * довідник прав, тож засів під режимом обслуговування.
 */
async function seedOrg(
  owner: pg.Client,
  people: Record<string, string[]>
): Promise<Org> {
  const org: Org = { id: randomUUID(), people: {}, assignments: {} }
  await seedUnderMaintenance(owner, async () => {
    await owner.query("INSERT INTO public.organization (id) VALUES ($1)", [
      org.id,
    ])
    await addPeople(owner, org, people)
  })
  return org
}

/** Люди в наявній організації; режим обслуговування тримає викликач. */
async function addPeople(
  owner: pg.Client,
  org: Org,
  people: Record<string, string[]>
): Promise<void> {
  for (const [name, archetypes] of Object.entries(people)) {
    const user = await signUp(owner)
    const member = randomUUID()
    await owner.query(
      "INSERT INTO public.org_member (id, org_id, user_id) VALUES ($1, $2, $3)",
      [member, org.id, user]
    )
    org.people[name] = { user, member, session: sessionOf(user) }
    for (const archetype of archetypes) {
      const id = randomUUID()
      await owner.query(
        "INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)",
        [id, org.id, member, archetype]
      )
      org.assignments[`${name}:${archetype}`] = id
    }
  }
}

/**
 * Ціль, розгорнута `plan` + `apply`, і її власник; тримається, доки `close`
 * не відпустить колбек `inTarget`.
 */
const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const dir = await writeProject()
    try {
      const compiled = await compile(await readMetadataDir(dir))
      expect(compiled.diagnostics).toEqual([])
      const model = compiled.model!
      await inTarget(
        "select 1;",
        { schemas: ["public"], provider: "supabase" },
        async (url) => {
          await deploy(dir, url)
          const owner = new pg.Client({ connectionString: url })
          await owner.connect()
          try {
            await use({
              dir,
              url,
              model,
              catalog: buildRuntimeCatalog(model),
              owner,
            })
          } finally {
            await owner.end()
          }
        }
      )
    } finally {
      await rm(dirname(dir), { recursive: true, force: true })
    }
  })

/**
 * Роль входу рантайму (форма `simetra_runtime`: членства лише з `SET`) і її
 * пули. Лише на час команд: план відмовляє `plan.platform-role-shape`, доки
 * роль команд має чужого члена, тож тримає її `beforeAll` блоку команд.
 */
const heldLogin = (url: () => string) =>
  heldResource<Pools>((use) =>
    withRuntimeLogin(
      url(),
      [PLATFORM_ROLES.command, REQUEST_ROLE],
      async (login) => {
        const direct = new pg.Pool({ connectionString: login })
        const pooled = new pg.Pool({ connectionString: throughPoolerAs(login) })
        try {
          await use({ direct, pooled })
        } finally {
          await direct.end()
          await pooled.end()
        }
      }
    )
  )

/** Відмова команди як `CommandError`; успіх — помилка тесту. */
async function refusal(work: Promise<unknown>): Promise<CommandError> {
  try {
    await work
  } catch (error) {
    if (error instanceof CommandFailure) return error.error
    throw error
  }
  throw new Error("the command succeeded")
}

/** Оператори, що згадують таблицю `table` текстом чи параметром. */
const touching = (statements: RecordedStatement[], table: string) =>
  statements.filter((s) =>
    [s.text, ...s.params].some((p) => p !== null && p.includes(table))
  )

const assign = (
  org: string,
  subject: string,
  role: { archetype: string } | { customRole: string },
  id: string = randomUUID()
): Operation => ({
  action: "create",
  object: ASSIGNMENTS,
  id,
  values: { org, subject, ...role },
})

/** Новий рядок має версію 1 — так пакет знімає призначення, створене в ньому ж. */
const unassign = (id: string, expectedVersion = 1): Operation => ({
  action: "delete",
  object: ASSIGNMENTS,
  id,
  expectedVersion,
})

const deltaLine = (effect: "allow" | "deny") => ({
  ref: randomUUID(),
  object: "task",
  action: "read",
  extent: "any",
  effect,
})

describe("rights administration commands over a planned and applied target", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 180_000)
  afterAll(() => target.close(), 60_000)

  /** Рядок таблиці за id — читає власник, RLS його не ховає. */
  const rowOf = async (table: string, id: string) =>
    (
      await env.owner.query<{ r: Record<string, unknown> }>(
        `SELECT to_jsonb(t) AS r FROM public.${table} t WHERE t.id = $1`,
        [id]
      )
    ).rows[0]?.r

  /** Дієві носії `fullAccess` організації — тим самим SQL, що й запобіжник. */
  const holdersOf = async (org: string) => {
    const catalog = env.model.contracts.rightsCatalogs.find(
      (c) => c.level.level === "scope"
    )!
    const sql = fullAccessHolderRows(
      catalog,
      env.model.contracts,
      env.model.physical,
      env.model.project.naming.attributeCase
    )
    const { rows } = await env.owner.query<{ actor: string }>(
      `SELECT h.actor::text AS actor FROM (${sql}) h WHERE h.scope = $1`,
      [org]
    )
    return rows.map((r) => r.actor)
  }

  describe("commands", () => {
    const login = heldLogin(() => env.url)
    let pools: Pools
    beforeAll(async () => {
      pools = await login.open()
    }, 60_000)
    afterAll(() => login.close(), 60_000)

    describe.each([
      ["direct", (p: Pools) => p.direct],
      ["pooler", (p: Pools) => p.pooled],
    ] as const)("%s", (_, poolOf) => {
      let org: Org
      let transfer: Org
      let last: Org
      let ticket: string

      beforeAll(async () => {
        org = await seedOrg(env.owner, {
          admin: [RIGHTS_ADMIN_ID],
          peer: [],
          third: [],
        })
        // Передача й «останній носій» — у своїх організаціях: адміністрування
        // дає окрема роль, тож носій лишається адміністратором і без `fullAccess`
        transfer = await seedOrg(env.owner, {
          holder: [ORG_ADMIN_ID, RIGHTS_ADMIN_ID],
          third: [],
        })
        last = await seedOrg(env.owner, {
          holder: [ORG_ADMIN_ID, RIGHTS_ADMIN_ID],
        })
        ticket = randomUUID()
        await env.owner.query(
          `INSERT INTO public.${TICKET_TABLE} (id, org_id) VALUES ($1, $2)`,
          [ticket, org.id]
        )
      }, 60_000)

      /** Рантайм над записувальним портом; оператори — лише після створення. */
      const runtime = async (
        modules: Record<string, ObjectModule<object>> = {}
      ): Promise<{ rt: CommandRuntime; statements: RecordedStatement[] }> => {
        const recorded = recordingDatabase(fromPgPool(poolOf(pools)))
        const rt = await createCommandRuntime({
          database: recorded.database,
          catalog: env.catalog,
          objectModules: modules,
        })
        recorded.statements.length = 0
        return { rt, statements: recorded.statements }
      }

      const admin = () => org.people.admin!

      const createRole = async (rt: CommandRuntime) => {
        const id = randomUUID()
        const { rows } = await rt.run(admin().session, {
          action: "create",
          object: ROLES,
          id,
          values: { org: org.id, archetype: TASK_VIEWER_ID },
          tabularSections: { delta: [deltaLine("allow")] },
        })
        return { id, version: rows[0]!.version as number }
      }

      it("creates, updates and marks a custom role", async () => {
        const { rt } = await runtime()
        const { id, version } = await createRole(rt)
        const journal = await env.owner.query(
          "SELECT DISTINCT actor::text AS actor, reason FROM simetra.rights_journal WHERE row_id = $1",
          [id]
        )
        expect(journal.rows).toEqual([
          { actor: admin().user, reason: "command" },
        ])

        const updated = await rt.run(admin().session, {
          action: "update",
          object: ROLES,
          id,
          expectedVersion: version,
          tabularSections: { delta: [deltaLine("deny")] },
        })
        expect(updated.rows[0]!.version).toBe(version + 1)
        const delta = await env.owner.query(
          "SELECT object, action, extent, effect FROM public.org_roles_delta WHERE parent_id = $1",
          [id]
        )
        expect(delta.rows).toEqual([
          { object: "task", action: "read", extent: "any", effect: "deny" },
        ])

        expect(
          await refusal(
            rt.run(admin().session, {
              action: "update",
              object: ROLES,
              id,
              expectedVersion: version,
              tabularSections: { delta: [] },
            })
          )
        ).toEqual({
          code: "command.conflict",
          reason: "version",
          currentVersion: version + 1,
        })

        const marked = await rt.run(admin().session, {
          action: "markDeletion",
          object: ROLES,
          id,
          expectedVersion: version + 1,
          mark: true,
        })
        expect(marked.rows[0]).toMatchObject({ deletionMark: true })
      })

      it("assigns two subjects in one batch, then unassigns", async () => {
        const { rt } = await runtime()
        const role = await createRole(rt)
        const { peer, third } = org.people
        const assigned = await rt.run(admin().session, [
          assign(org.id, peer!.member, { customRole: role.id }),
          assign(org.id, third!.member, { customRole: role.id }),
        ])
        expect(assigned.rows).toHaveLength(2)
        await rt.run(
          admin().session,
          assigned.rows.map((row) =>
            unassign(row.ref as string, row.version as number)
          )
        )
        for (const row of assigned.rows)
          expect(await rowOf("org_role_assignments", row.ref as string)).toBe(
            undefined
          )
        const marked = await rt.run(admin().session, {
          action: "markDeletion",
          object: ROLES,
          id: role.id,
          expectedVersion: role.version,
          mark: true,
        })
        expect(marked.rows[0]).toMatchObject({ deletionMark: true })
      })

      it("refuses to mark a role in use", async () => {
        const { rt } = await runtime()
        const role = await createRole(rt)
        await rt.run(
          admin().session,
          assign(org.id, org.people.peer!.member, { customRole: role.id })
        )
        expect(
          await refusal(
            rt.run(admin().session, {
              action: "markDeletion",
              object: ROLES,
              id: role.id,
              expectedVersion: role.version,
              mark: true,
            })
          )
        ).toEqual({ code: "command.forbidden", reason: "role-in-use" })
        expect(await rowOf("org_roles", role.id)).toMatchObject({
          deletion_mark: false,
        })
      })

      // Самопризначення T3 не відхиляє сам: відмову дає база відповіддю на
      // `COMMIT`, уже після виклику ядра (Р-A4-2).
      it("refuses self-assignment as escalation at COMMIT", async () => {
        const { rt, statements } = await runtime()
        const id = randomUUID()
        expect(
          await refusal(
            rt.run(
              admin().session,
              assign(
                org.id,
                admin().member,
                { archetype: TICKET_WRITER_ID },
                id
              )
            )
          )
        ).toEqual({ code: "command.forbidden", reason: "escalation" })
        const core = statements.findIndex((s) =>
          s.text.includes("org_role_assignments_save")
        )
        const failed = statements.findIndex((s) => s.failed !== undefined)
        expect(core).toBeGreaterThanOrEqual(0)
        expect(statements[core]!.failed).toBeUndefined()
        expect(failed).toBeGreaterThan(core)
        expect(statements[failed]).toMatchObject({
          text: "COMMIT",
          failed: { code: "42501", detail: "escalation" },
        })
        expect(await rowOf("org_role_assignments", id)).toBe(undefined)
      })

      it("refuses a non-holder granting fullAccess", async () => {
        const { rt } = await runtime()
        const id = randomUUID()
        expect(
          await refusal(
            rt.run(
              admin().session,
              assign(
                org.id,
                org.people.peer!.member,
                { archetype: ORG_ADMIN_ID },
                id
              )
            )
          )
        ).toEqual({ code: "command.forbidden", reason: "escalation" })
        expect(await rowOf("org_role_assignments", id)).toBe(undefined)
      })

      // Проходить лише тому, що `last-full-access` судять на `COMMIT`: після
      // першої операції носія в організації немає.
      it("transfers fullAccess in one batch, own assignment first", async () => {
        const { rt } = await runtime()
        const { holder, third } = transfer.people
        const own = transfer.assignments[`holder:${ORG_ADMIN_ID}`]!
        const version = (await rowOf("org_role_assignments", own))!
          .version as number
        await rt.run(holder!.session, [
          unassign(own, version),
          assign(transfer.id, third!.member, { archetype: ORG_ADMIN_ID }),
        ])
        expect(await holdersOf(transfer.id)).toEqual([third!.user])
      })

      it("refuses to drop the last fullAccess holder", async () => {
        const { rt } = await runtime()
        const own = last.assignments[`holder:${ORG_ADMIN_ID}`]!
        const version = (await rowOf("org_role_assignments", own))!
          .version as number
        expect(
          await refusal(
            rt.run(last.people.holder!.session, unassign(own, version))
          )
        ).toEqual({ code: "command.forbidden", reason: "last-full-access" })
        expect(await holdersOf(last.id)).toEqual([last.people.holder!.user])
      })

      // Права команди — права початку її транзакції (спека прав §7): знімок
      // фактів бере перший запис у джерело, тут — самопризначення, тож
      // видане собі право не діє до COMMIT. Відмову дає ядро бази тією самою
      // причиною, що й запис без ролі; DB, бо знімок і RLS — це база.
      describe("the database judges a batch by the rights at the start of its transaction", () => {
        const ticketVersion = async () =>
          (await rowOf(TICKET_TABLE, ticket))!.version as number
        const updateTicket = async (): Promise<Operation> => ({
          action: "update",
          object: TICKET,
          id: ticket,
          expectedVersion: await ticketVersion(),
          values: { description: "changed" },
        })
        const selfGrant = (
          person: Person,
          id: string,
          archetype = TICKET_WRITER_ID
        ) => assign(org.id, person.member, { archetype }, id)

        beforeAll(async () => {
          // Контроль читання: та сама роль — з початку транзакції.
          await seedUnderMaintenance(env.owner, () =>
            addPeople(env.owner, org, {
              reader: [RIGHTS_ADMIN_ID, TICKET_WRITER_ID],
            })
          )
        }, 60_000)

        /**
         * Пакет відмовило ядро бази `no-right` на записі `table`; відкат — ні
         * `X`, ні призначення.
         */
        const expectRefused = async (
          rt: CommandRuntime,
          statements: RecordedStatement[],
          batch: Operation[],
          grant: string,
          table: string
        ) => {
          expect(await refusal(rt.run(admin().session, batch))).toEqual({
            code: "command.forbidden",
            reason: "no-right",
          })
          const failed = statements.filter((s) => s.failed !== undefined)
          expect(failed).toHaveLength(1)
          expect(touching(failed, table)).toEqual(failed)
          expect(await rowOf(TICKET_TABLE, ticket)).toMatchObject({
            description: null,
          })
          expect(await rowOf("org_role_assignments", grant)).toBe(undefined)
        }

        it("assign → update X → unassign in one batch", async () => {
          const { rt, statements } = await runtime()
          const grant = randomUUID()
          await expectRefused(
            rt,
            statements,
            [selfGrant(admin(), grant), await updateTicket(), unassign(grant)],
            grant,
            TICKET_TABLE
          )
        })

        it("assign → read X → unassign through a hook", async () => {
          let seen: Record<string, unknown>[] | undefined
          const module = defineObjectModule({
            onWrite: async ({ ctx }) => {
              if (ctx.action === "create")
                seen = await ctx.read({ object: TICKET, id: ticket })
            },
          })
          const { rt } = await runtime({
            [ASSIGNMENTS_KEY]: module as ObjectModule<object>,
          })
          const batch = (person: Person, grant: string) =>
            rt.run(person.session, [selfGrant(person, grant), unassign(grant)])
          const grant = randomUUID()
          await batch(admin(), grant)
          expect(seen).toEqual([])
          expect(await rowOf("org_role_assignments", grant)).toBe(undefined)
          // Контроль: актор з роллю з початку той самий хук бачить `X`.
          seen = undefined
          await batch(org.people.reader!, randomUUID())
          expect(seen).toMatchObject([{ ref: ticket }])
        })

        it("assign → update X through ctx.run in a hook", async () => {
          const update = await updateTicket()
          const module = defineObjectModule({
            onWrite: async ({ ctx }) => {
              if (ctx.action === "create") await ctx.run(update)
            },
          })
          const { rt, statements } = await runtime({
            [ASSIGNMENTS_KEY]: module as ObjectModule<object>,
          })
          const grant = randomUUID()
          await expectRefused(
            rt,
            statements,
            [selfGrant(admin(), grant), unassign(grant)],
            grant,
            TICKET_TABLE
          )
        })

        it("assign → update a member row → unassign", async () => {
          const { rt, statements } = await runtime()
          const grant = randomUUID()
          const peer = org.people.peer!.member
          const version = (await rowOf("org_member", peer))!.version as number
          await expectRefused(
            rt,
            statements,
            [
              selfGrant(admin(), grant, MEMBER_EDITOR_ID),
              {
                action: "update",
                object: MEMBERS,
                id: peer,
                expectedVersion: version,
                values: { description: "changed" },
              },
              unassign(grant),
            ],
            grant,
            "org_member"
          )
          expect(await rowOf("org_member", peer)).toMatchObject({
            description: null,
            version,
          })
        })
      })

      // Членство — дані застосунку: зміна членства командою не дає актору
      // прав у тій самій транзакції — права транзакції ті, що були на її
      // початку (знімок актора, спека прав §7). DB, бо це тримають знімок і
      // RLS бази, а не T3.
      describe("a membership change gives the actor no right", () => {
        let home: Org
        let away: { org: string; member: string; ticket: string }
        /** Ticket-и `home`: без носіїв, свій за `assignee`, свій за виміром. */
        let plain: string
        let owned: string
        let regional: string

        const actor = () => home.people.actor!
        const updateOf = async (id: string): Promise<Operation> => ({
          action: "update",
          object: TICKET,
          id,
          expectedVersion: (await rowOf(TICKET_TABLE, id))!.version as number,
          values: { description: "changed" },
        })

        beforeAll(async () => {
          home = await seedOrg(env.owner, {
            actor: [
              MEMBER_CREATOR_ID,
              TICKET_OWN_WRITER_ID,
              TICKET_REGION_WRITER_ID,
            ],
          })
          const other = await seedOrg(env.owner, {})
          away = {
            org: other.id,
            member: randomUUID(),
            ticket: randomUUID(),
          }
          ;[plain, owned, regional] = [randomUUID(), randomUUID(), randomUUID()]
          const [homeRegion, awayRegion] = [randomUUID(), randomUUID()]
          const q = (sql: string, params: unknown[]) =>
            env.owner.query(sql, params)
          await seedUnderMaintenance(env.owner, async () => {
            // Той самий користувач — учасник `away` без жодного призначення;
            // вимір і власність там указують на цей рядок учасника.
            await q(
              "INSERT INTO public.org_member (id, org_id, user_id) VALUES ($1, $2, $3)",
              [away.member, away.org, actor().user]
            )
            await q(
              "INSERT INTO public.region (id, org_id) VALUES ($1, $2), ($3, $4)",
              [homeRegion, home.id, awayRegion, away.org]
            )
            await q(
              "INSERT INTO public.member_region (org_id, member_id, region_id) VALUES ($1, $2, $3), ($4, $5, $6)",
              [
                home.id,
                actor().member,
                homeRegion,
                away.org,
                away.member,
                awayRegion,
              ]
            )
            await q(
              `INSERT INTO public.${TICKET_TABLE} (id, org_id, assignee_id, region_id) VALUES ($1, $2, NULL, NULL), ($3, $2, $4, NULL), ($5, $2, NULL, $6), ($7, $8, $9, $10)`,
              [
                plain,
                home.id,
                owned,
                actor().member,
                regional,
                homeRegion,
                away.ticket,
                away.org,
                away.member,
                awayRegion,
              ]
            )
          })
        }, 60_000)

        // Сценарій архітекторки: [учасник собі → X → позначити учасника]
        // (`delete` команда має лише на призначеннях).
        // Право `create` на членстві скоупу має лише його учасник, а ключ
        // членства (скоуп, користувач) другого рядка не пускає.
        it("cannot add himself to his own scope a second time", async () => {
          const { rt, statements } = await runtime()
          const second = randomUUID()
          expect(
            await refusal(
              rt.run(actor().session, [
                {
                  action: "create",
                  object: MEMBERS,
                  id: second,
                  values: { org: home.id, user: actor().user },
                },
                await updateOf(plain),
                {
                  action: "markDeletion",
                  object: MEMBERS,
                  id: second,
                  expectedVersion: 1,
                  mark: true,
                },
              ])
            )
          ).toEqual({
            code: "command.constraint",
            kind: "unique",
            attributes: ["org", "user"],
          })
          expect(touching(statements, TICKET_TABLE)).toEqual([])
          expect(await rowOf("org_member", second)).toBe(undefined)
        })

        // Рядок учасника без призначення — уже в «моїх скоупах» і серед моїх
        // учасників, але роль скоупу тримає призначення, а `own` і вимір
        // парують скоуп ролі; «кожен користувач» скоуплених об'єктів не
        // відкриває. Контроль — ті самі ролі в `home` пишуть свої рядки.
        it("a member row without an assignment opens no data of its scope", async () => {
          const { rt } = await runtime()
          await rt.run(actor().session, await updateOf(owned))
          await rt.run(actor().session, await updateOf(regional))
          expect(
            await rt.read(actor().session, { object: TICKET, id: away.ticket })
          ).toEqual([])
          expect(
            await refusal(rt.run(actor().session, await updateOf(away.ticket)))
          ).toEqual({ code: "command.forbidden", reason: "no-right" })
          expect(await rowOf(TICKET_TABLE, away.ticket)).toMatchObject({
            description: null,
          })
        })
      })
    })
  })

  // Читання без xid не платить за знімок (спека прав §7): гілку знімка
  // функції фактів обирають за `txid_current_if_assigned()`, тож без xid
  // таблиць знімка не торкається жоден оператор. DB, бо рахує Postgres.
  // Судить план, а не лише лічильник сканів: btree з ключем `NULL`
  // (`xid = txid_current_if_assigned()`) виходить до лічильника `idx_scan`,
  // тож `EXISTS` по заголовку без охорони `CASE` лічильник не бачить.
  it("reads through rights functions in a read only transaction without an xid", async () => {
    const home = await seedOrg(env.owner, { reader: [TICKET_WRITER_ID] })
    const row = randomUUID()
    await env.owner.query(
      `INSERT INTO public.${TICKET_TABLE} (id, org_id) VALUES ($1, $2)`,
      [row, home.id]
    )
    const tables = Object.values(SNAPSHOT_TABLES).map((t) => t.name)
    const client = new pg.Client({ connectionString: env.url })
    await client.connect()
    // Плани читання з вкладеними операторами тіл функцій прав (`auto_explain`
    // з аналізом, як у гейті планів): вузол, якого не виконано, має 0 циклів.
    const plans: unknown[] = []
    const onNotice = (notice: { severity?: string; message?: string }) => {
      const message = notice.message ?? ""
      const start = message.indexOf("plan:")
      if (notice.severity === "LOG" && start >= 0)
        plans.push(JSON.parse(message.slice(start + "plan:".length)))
    }
    client.on("notice", onNotice)
    /** Читання `X` актором у поточній транзакції; скани таблиць знімка. */
    const readAs = async () => {
      await client.query("SELECT set_config($1, $2, true)", [
        SESSION_CLAIMS_SETTING,
        JSON.stringify(home.people.reader!.session),
      ])
      for (const setting of [
        "auto_explain.log_min_duration = 0",
        "auto_explain.log_nested_statements = on",
        "auto_explain.log_analyze = on",
        "auto_explain.log_format = 'json'",
        "client_min_messages = log",
      ])
        await client.query(`SET LOCAL ${setting}`)
      plans.length = 0
      await client.query(`SET LOCAL ROLE ${REQUEST_ROLE}`)
      const read = await client.query(
        `SELECT id FROM public.${TICKET_TABLE} WHERE id = $1`,
        [row]
      )
      // Вузли над таблицями знімка — до службових запитів нижче
      const snapshotNodes = plans
        .flatMap(planNodes)
        .filter((n) => n.relation !== undefined && tables.includes(n.relation))
      const xid = await client.query<{ xid: string | null }>(
        "SELECT txid_current_if_assigned()::text AS xid"
      )
      await client.query("RESET ROLE")
      const stats = await client.query<{ relname: string; scans: string }>(
        `SELECT relname, (COALESCE(seq_scan, 0) + COALESCE(idx_scan, 0))::text AS scans
           FROM pg_stat_xact_user_tables
          WHERE schemaname = $1 AND relname = ANY ($2)`,
        [SNAPSHOT_TABLES.header.schema, tables]
      )
      return {
        rows: read.rowCount,
        xid: xid.rows[0]!.xid,
        scans: stats.rows,
        loops: snapshotNodes.map((n) => [n.relation, n.loops] as const),
      }
    }
    try {
      await client.query("BEGIN READ ONLY")
      const readOnly = await readAs()
      await client.query("ROLLBACK")
      expect(readOnly.rows).toBe(1)
      expect(readOnly.xid).toBeNull()
      expect(readOnly.scans).toHaveLength(tables.length)
      expect(readOnly.scans.every((t) => t.scans === "0")).toBe(true)
      // Вузли над таблицями знімка в плані є (гілки `CASE`), але жоден не
      // виконаний
      expect(readOnly.loops.length).toBeGreaterThan(0)
      expect(readOnly.loops.filter(([, loops]) => loops !== 0)).toEqual([])
      // Контроль: з xid, призначеним до читання, гілка знімка читає його таблиці.
      await client.query("BEGIN")
      await client.query("SELECT txid_current()")
      const assigned = await readAs()
      await client.query("ROLLBACK")
      expect(assigned.rows).toBe(1)
      expect(assigned.xid).not.toBeNull()
      expect(assigned.scans.some((t) => t.scans !== "0")).toBe(true)
      expect(
        assigned.loops.some(([, loops]) => loops !== undefined && loops > 0)
      ).toBe(true)
    } finally {
      await client.end()
    }
  })

  // Пакет очистки складається лише з переліку плану (Р-A4-3): плану не
  // змінено, тож він `unchanged`, а перелік — дані цілі, які читає лише план.
  describe("rights orphans", () => {
    const plan = async (): Promise<RightsOrphans> => {
      const r = await runTool(
        toolByName("plan")!,
        { _: [env.dir], format: "json" },
        () => Promise.resolve(""),
        process.cwd(),
        { [ENV]: env.url }
      )
      expect(r.exitCode, r.stderr + r.stdout).toBe(0)
      const data = JSON.parse(r.stdout) as {
        unchanged?: boolean
        artifacts: string[]
        rightsOrphans: RightsOrphans
      }
      expect(data).toMatchObject({ unchanged: true, artifacts: [] })
      return data.rightsOrphans
    }

    // Кроки сценарію йдуть по черзі й беруть стан попередніх. Роль входу
    // рантайму живе лише в блоках команд: поки вона член ролі команд, план
    // відмовляє `plan.platform-role-shape`.
    const [gone, orphanRole, orphanAssignment, direct, liveRole] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ]
    const [inside, outside] = [randomUUID(), randomUUID()]
    let org: Org
    let orphans: RightsOrphans

    /** Роль входу на час одного блоку команд сценарію. */
    const withCommands = (body: (pools: () => Pools) => void) => {
      const login = heldLogin(() => env.url)
      let pools: Pools
      beforeAll(async () => {
        pools = await login.open()
      }, 60_000)
      afterAll(() => login.close(), 60_000)
      body(() => pools)
    }

    const runtimeOf = (pools: Pools) =>
      createCommandRuntime({
        database: fromPgPool(pools.direct),
        catalog: env.catalog,
      })

    it("the plan lists every orphan with its version", async () => {
      org = await seedOrg(env.owner, { admin: [RIGHTS_ADMIN_ID], peer: [] })
      const peer = org.people.peer!.member
      const deltaRow = (
        id: string,
        parent: string,
        line: number,
        object: string
      ) => ({
        id,
        parent_id: parent,
        line_number: line,
        object,
        action: "read",
        extent: "any",
        effect: "allow",
      })
      // Сироти — рядки, які запис уже не пропустив би: так їх лишає зміна
      // коду. Архетипу `gone` метаданих не мають; об'єкт `unknown` — поза
      // доменом.
      await committed(env.owner, async () => {
        const orphan = (table: string, values: Record<string, unknown>) =>
          insertOrphan(env.owner, table, { org_id: org.id, ...values })
        await orphan("org_roles", { id: orphanRole, archetype: gone })
        await orphan(
          "org_roles_delta",
          deltaRow(randomUUID(), orphanRole, 1, "task")
        )
        await orphan("org_role_assignments", {
          id: orphanAssignment,
          subject: peer,
          custom_role: orphanRole,
        })
        await orphan("org_roles", { id: liveRole, archetype: TASK_VIEWER_ID })
        await orphan("org_roles_delta", deltaRow(inside, liveRole, 1, "task"))
        await orphan(
          "org_roles_delta",
          deltaRow(outside, liveRole, 2, "unknown")
        )
        await orphan("org_role_assignments", {
          id: direct,
          subject: peer,
          archetype: gone,
        })
      })
      const scope = org.id
      orphans = await plan()
      expect(orphans).toEqual({
        roles: [{ object: ROLES, id: orphanRole, version: 1, scope }],
        assignments: [
          {
            object: ASSIGNMENTS,
            id: orphanAssignment,
            version: 1,
            scope,
            role: orphanRole,
          },
          { object: ASSIGNMENTS, id: direct, version: 1, scope },
        ].sort((a, b) => (a.id < b.id ? -1 : 1)),
        deltas: [
          { object: ROLES, role: liveRole, id: outside, version: 1, scope },
        ],
      })
    }, 60_000)

    describe("while the orphan role is assigned", () => {
      withCommands((pools) => {
        it("a command cannot mark it: role-in-use", async () => {
          const rt = await runtimeOf(pools())
          expect(
            await refusal(
              rt.run(org.people.admin!.session, {
                action: "markDeletion",
                object: ROLES,
                id: orphanRole,
                expectedVersion: 1,
                mark: true,
              })
            )
          ).toEqual({ code: "command.forbidden", reason: "role-in-use" })
        })
      })
    })

    it("the plan lists the same orphans again", async () => {
      expect(await plan()).toEqual(orphans)
    }, 60_000)

    describe("a batch built from the list alone", () => {
      withCommands((pools) => {
        it("cleans every orphan and keeps the rest of the delta", async () => {
          // Рядки дельти, що лишаються, клієнт читає сам (читання ТЧ — П4-B)
          const kept = await env.owner.query<Record<string, string | null>>(
            "SELECT id, parent_id, object, action, extent, dimension, effect FROM public.org_roles_delta WHERE parent_id = ANY($1) AND NOT id = ANY($2) ORDER BY line_number",
            [orphans.deltas.map((d) => d.role), orphans.deltas.map((d) => d.id)]
          )
          const roles = new Map(orphans.deltas.map((d) => [d.role, d]))
          const rt = await runtimeOf(pools())
          // Порядок Р-A4-3: зняти призначення → позначити ролі → дельти
          await rt.run(org.people.admin!.session, [
            ...orphans.assignments.map((a): Operation => ({
              action: "delete",
              object: a.object,
              id: a.id,
              expectedVersion: a.version,
            })),
            ...orphans.roles.map((r): Operation => ({
              action: "markDeletion",
              object: r.object,
              id: r.id,
              expectedVersion: r.version,
              mark: true,
            })),
            ...[...roles.values()].map((d): Operation => ({
              action: "update",
              object: d.object,
              id: d.role,
              expectedVersion: d.version,
              tabularSections: {
                delta: kept.rows
                  .filter((row) => row.parent_id === d.role)
                  .map(({ id, object, action, extent, dimension, effect }) => ({
                    ref: id,
                    object,
                    action,
                    extent,
                    effect,
                    ...(dimension === null ? {} : { dimension }),
                  })),
              },
            })),
          ])
          const delta = await env.owner.query(
            "SELECT id FROM public.org_roles_delta WHERE parent_id = $1",
            [liveRole]
          )
          expect(delta.rows).toEqual([{ id: inside }])
        })
      })
    })

    it("the plan then lists no orphans", async () => {
      expect(await plan()).toEqual({ roles: [], assignments: [], deltas: [] })
    }, 60_000)
  })
})
