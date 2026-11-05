import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  type CommandError,
  type DatabaseProvider,
  type MetadataRef,
  type Operation,
} from "simetra/model"
import { desiredForApply } from "simetra/schema"
import { readRoleOf } from "simetra/server"
import { runTool } from "../cli/command"
import {
  DATA_GUARD_FACTS_SQL,
  dataGuardFactsParams,
  dataResource,
} from "../io/data"
import { readMetadataDir } from "../io/metadata-dir"
import {
  dataCommandTool,
  dataReadTool,
  type DataCommandData,
  type DataReadData,
  type JsonRow,
} from "../tools/data-tools"
import { invoke } from "../tools/invoke"
import type { Tool, ToolResult } from "../tools/types"
import {
  GAUGE_FILE,
  GAUGE_LOG_FILE,
  GAUGE_LOG_TABLE,
  GAUGE_TABLE,
  GAUGE_WRITER_ID,
  acceptDebt,
  policyDomain,
  runtimeValuesLayer,
  testRoleName,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import { withObjectModule } from "./helpers/object-module"
import {
  asSuperuser,
  dropRoles,
  heldResource,
  inTarget,
  markDevelopmentDatabase,
  query,
  seedMarker,
  seedRuntimeActor,
  withCopy,
  withRuntimeLogin,
  type RuntimeActor,
} from "./support/db"

/**
 * Інструменти даних (`data-read`, `data-command`) над тінню рушія: RLS і
 * права ядра, звірку хешу, читання `pg_db_role_setting` і факти ролі входу
 * вирішує Postgres — порт-фейк unit-тестів цього не доводить. Ціль одна на
 * файл; кейси послідовні, бо перші два йдуть до засіву ознаки бази
 * розробника, а решта — після.
 */

const ENV = "APP_DATA"
const GAUGE: MetadataRef = { kind: "Catalog", name: "Gauge" }
const GAUGE_LOG: MetadataRef = { kind: "Catalog", name: "GaugeLog" }
const ASSIGNMENTS: MetadataRef = {
  kind: "Catalog",
  name: "OrgRoleAssignments",
}
const REQUEST_ROLE = readRoleOf("supabase")!

interface Env {
  dir: string
  model: CompiledModel
  provider: DatabaseProvider
  /** Ціль від імені мігратора (власник схеми `simetra`). */
  url: string
  owner: pg.Client
  /** Роль входу у формі `simetra_runtime`: роль команд і роль запиту. */
  login: string
  me: RuntimeActor
  other: RuntimeActor
  /** Рядки `Gauge` кожного актора й `GaugeLog` організації `me`. */
  mine: string
  foreign: string
  log: string
}

/** Корінь проєкту з текою метаданих; `GaugeLog` — об'єкт із модулем. */
async function writeProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-data-tools-"))
  const dir = join(root, "metadata")
  const files = await acceptDebt(
    withObjectModule(policyDomain(runtimeValuesLayer()), GAUGE_LOG_FILE)
  )
  for (const [path, content] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return dir
}

async function seedRow(
  owner: pg.Client,
  table: string,
  org: string
): Promise<string> {
  const id = randomUUID()
  await owner.query(
    `INSERT INTO public.${table} (id, org_id) VALUES ($1, $2)`,
    [id, org]
  )
  return id
}

const heldEnv = () =>
  heldResource<Env>(async (use) => {
    const dir = await writeProject()
    try {
      const compiled = await compile(await readMetadataDir(dir))
      expect(compiled.diagnostics).toEqual([])
      const model = compiled.model!
      // Фікстура має те, на чому стоять кейси 8 і 9
      expect(model.objects.map((o) => o.name)).toContain(ASSIGNMENTS.name)
      expect(model.moduleFiles).toHaveLength(1)
      const desired = await desiredForApply(model)
      await inTarget(desired.sql, desired.scope, async (url) => {
        const owner = new pg.Client({ connectionString: url })
        await owner.connect()
        try {
          await seedMarker(owner, model.hash)
          const me = await seedRuntimeActor(owner)
          const other = await seedRuntimeActor(owner)
          const mine = await seedRow(owner, GAUGE_TABLE, me.org)
          const foreign = await seedRow(owner, GAUGE_TABLE, other.org)
          const log = await seedRow(owner, GAUGE_LOG_TABLE, me.org)
          await withRuntimeLogin(
            url,
            [PLATFORM_ROLES.command, REQUEST_ROLE],
            (login) =>
              use({
                dir,
                model,
                provider: model.project.database.provider,
                url,
                owner,
                login,
                me,
                other,
                mine,
                foreign,
                log,
              })
          )
        } finally {
          await owner.end()
        }
      })
    } finally {
      await rm(dirname(dir), { recursive: true, force: true })
    }
  })

interface GuardFacts {
  rolsuper: boolean
  rolbypassrls: boolean
  command: boolean
  migrator: boolean
  service: boolean
}

/** Порушення фактів ролі входу — те, за що запобіжник відмовляє. */
const violations = (f: GuardFacts): string[] =>
  Object.entries({
    rolsuper: f.rolsuper,
    rolbypassrls: f.rolbypassrls,
    migrator: f.migrator,
    service: f.service,
    "no-command": !f.command,
  })
    .filter(([, v]) => v)
    .map(([k]) => k)

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`

const errorOf = (r: ToolResult): CommandError => {
  const data = r.data as { error?: CommandError } | undefined
  expect(data?.error, JSON.stringify(r)).toBeDefined()
  return data!.error!
}

const rowsOf = (r: ToolResult): JsonRow[] => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r.data as Extract<DataReadData, { rows: unknown }>).rows
}

const resultOf = (r: ToolResult) => {
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return (r.data as Extract<DataCommandData, { result: unknown }>).result
}

describe("data tools over a real database", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 180_000)
  afterAll(() => target.close(), 60_000)

  /** Виклик через MCP-канал, як його робить агент. */
  const call = (
    tool: Tool,
    input: unknown,
    o: {
      url?: string
      as?: string
      agent?: string
      allowDataWrite?: boolean
      allowRightsWrite?: boolean
    } = {}
  ) =>
    invoke(tool, input, {
      dir: env.dir,
      readOnly: false,
      allowDatabaseWrite: false,
      allowDataWrite: o.allowDataWrite ?? true,
      allowRightsWrite: o.allowRightsWrite ?? false,
      dryRun: false,
      confirmed: false,
      channel: "mcp",
      data: dataResource(
        { [ENV]: o.url ?? env.login },
        {
          urlEnv: ENV,
          as: o.as ?? env.me.user,
          ...(o.agent === undefined ? {} : { agent: o.agent }),
        }
      ),
      dataEnv: ENV,
    })

  const readGauges = (o: Parameters<typeof call>[2] = {}) =>
    call(dataReadTool, { query: { object: GAUGE, where: {}, limit: 200 } }, o)

  const command = (
    operations: Operation[],
    o: Parameters<typeof call>[2] = {}
  ) => call(dataCommandTool, { operations }, o)

  /** Версія рядка — читанням власника, повз інструмент. */
  const versionOf = async (table: string, id: string): Promise<number> =>
    (
      await env.owner.query<{ version: number }>(
        `SELECT version::int AS version FROM public.${table} WHERE id = $1`,
        [id]
      )
    ).rows[0]!.version

  const factsAs = async (loginUrl: string): Promise<GuardFacts> =>
    (
      await query<GuardFacts>(
        loginUrl,
        DATA_GUARD_FACTS_SQL,
        dataGuardFactsParams(env.provider)
      )
    )[0]!

  describe("before the database is marked as a development one", () => {
    it("a database without the development setting is refused: session options and role settings do not count", async () => {
      const refusal = async (url: string) => (await readGauges({ url })).refusal
      const notDevelopment = { reason: "data-guard", detail: "not-development" }
      expect(await refusal(env.login)).toMatchObject(notDevelopment)

      // Сесійне налаштування задає сам рядок підключення
      const withOptions = new URL(env.login)
      withOptions.searchParams.set(
        "options",
        "-c simetra.environment=development"
      )
      expect(await refusal(withOptions.toString())).toMatchObject(
        notDevelopment
      )

      // Налаштування ролі (`setrole ≠ 0`) — не ознака бази
      const role = decodeURIComponent(new URL(env.login).username)
      const database = decodeURIComponent(new URL(env.url).pathname.slice(1))
      await query(
        testSuperuserUrl(),
        `alter role ${quoted(role)} in database ${quoted(database)} set simetra.environment = 'development'`
      )
      try {
        expect(await refusal(env.login)).toMatchObject(notDevelopment)
      } finally {
        await query(
          testSuperuserUrl(),
          `alter role ${quoted(role)} in database ${quoted(database)} reset simetra.environment`
        )
      }

      // Ознака іншої бази кластера — не ознака цілі: `pg_db_role_setting`
      // спільний для кластера, тож рядок чужої бази видно й з цілі
      await withCopy("", async (otherUrl) => {
        await markDevelopmentDatabase(otherUrl)
        expect(await refusal(env.login)).toMatchObject(notDevelopment)
      })
    })

    /**
     * Власником схеми `simetra` на час `fn` стає тегована `NOLOGIN`-роль без
     * членств провайдера: власник цілі (`postgres`) — ще й член сервісної
     * ролі з `BYPASSRLS`, тож член його не дав би одного факту.
     */
    const withSchemaOwner = async <T>(
      fn: (schemaOwner: string) => Promise<T>
    ): Promise<T> => {
      const su = asSuperuser(env.url)
      const [{ owner }] = (await query<{ owner: string }>(
        su,
        "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname = 'simetra'"
      )) as [{ owner: string }]
      const name = testRoleName("data_schema_owner")
      await query(testSuperuserUrl(), `create role ${quoted(name)} nologin`)
      try {
        await query(su, `alter schema simetra owner to ${quoted(name)}`)
        try {
          return await fn(name)
        } finally {
          await query(su, `alter schema simetra owner to ${owner}`)
        }
      } finally {
        await dropRoles(name)
      }
    }

    it.each([
      {
        label: "data_bypass",
        violation: "rolbypassrls",
        memberOf: () => [PLATFORM_ROLES.command],
        bypassRls: true,
      },
      {
        label: "data_service",
        violation: "service",
        memberOf: () => [PLATFORM_ROLES.command, "service_role"],
      },
      {
        label: "data_owner_member",
        violation: "migrator",
        schemaOwner: true,
        memberOf: (schemaOwner?: string) => [
          PLATFORM_ROLES.command,
          schemaOwner!,
        ],
      },
      {
        label: "data_no_command",
        violation: "no-command",
        memberOf: () => [REQUEST_ROLE],
      },
    ])(
      "a login role with $violation is refused",
      async ({ label, violation, memberOf, bypassRls, schemaOwner }) => {
        const scenario = (owner?: string) =>
          withRuntimeLogin(
            env.url,
            memberOf(owner),
            async (login) => {
              // Рівно один факт-порушення: змішана побудова не доводила б,
              // що відмовляє саме він
              expect(violations(await factsAs(login))).toEqual([violation])
              expect((await readGauges({ url: login })).refusal).toMatchObject({
                reason: "data-guard",
                detail: "login-refused",
              })
            },
            label,
            { bypassRls: bypassRls === true }
          )
        await (schemaOwner === true ? withSchemaOwner(scenario) : scenario())
      }
    )

    it("the migrator of the target is refused", async () => {
      expect(violations(await factsAs(env.url))).toEqual(
        expect.arrayContaining(["rolbypassrls", "migrator", "service"])
      )
      expect((await readGauges({ url: env.url })).refusal).toMatchObject({
        reason: "data-guard",
        detail: "login-refused",
      })
    })

    it("a wrong password is refused without the login name or a password in the result", async () => {
      const wrong = new URL(env.login)
      const password = randomBytes(12).toString("hex")
      wrong.password = password
      const r = await readGauges({ url: wrong.toString() })
      expect(r.ok).toBe(false)
      const shown = JSON.stringify(r)
      expect(shown).not.toContain(decodeURIComponent(wrong.username))
      expect(shown).not.toContain(password)
      expect(shown).not.toContain(new URL(env.login).password)
    })
  })

  describe("on a development database", () => {
    beforeAll(() => markDevelopmentDatabase(env.url))

    it("data-read returns the rows of the --as user and hides foreign ones", async () => {
      const ids = rowsOf(await readGauges()).map((r) => r.ref)
      expect(ids).toContain(env.mine)
      expect(ids).not.toContain(env.foreign)
    })

    it("data-command update with expectedVersion bumps the version; a stale version is command.conflict", async () => {
      const [row] = rowsOf(
        await call(dataReadTool, { query: { object: GAUGE, id: env.mine } })
      )
      const version = row!.version as number
      const update = {
        action: "update",
        object: GAUGE,
        id: env.mine,
        expectedVersion: version,
        values: { reading: 1 },
      } satisfies Operation
      expect(resultOf(await command([update])).changes[0]?.version).toBe(
        version + 1
      )
      expect(errorOf(await command([update]))).toMatchObject({
        code: "command.conflict",
        reason: "version",
      })
    })

    it("an update of a foreign row is command.forbidden no-right", async () => {
      const r = await command([
        {
          action: "update",
          object: GAUGE,
          id: env.foreign,
          expectedVersion: 1,
          values: { reading: 1 },
        },
      ])
      expect(errorOf(r)).toMatchObject({
        code: "command.forbidden",
        reason: "no-right",
      })
    })

    // `Gauge` не веде автора, тож що права дає `sub`, а не `act`, видно з
    // відмови: агент із правами на організацію не позичає їх користувачеві
    it("rights come from --as, not from --agent", async () => {
      const create = (): Operation => ({
        action: "create",
        object: GAUGE,
        id: randomUUID(),
        values: { org: env.me.org },
      })
      expect(
        resultOf(
          await command([create()], { as: env.me.user, agent: env.other.user })
        ).changes
      ).toHaveLength(1)
      expect(
        errorOf(
          await command([create()], { as: env.other.user, agent: env.me.user })
        )
      ).toMatchObject({ code: "command.forbidden", reason: "no-right" })
    })

    it("an object with a module is command.invalid object-module and stays unchanged", async () => {
      const before = await versionOf(GAUGE_LOG_TABLE, env.log)
      const r = await command([
        {
          action: "update",
          object: GAUGE_LOG,
          id: env.log,
          expectedVersion: before,
          values: { note: "changed" },
        },
      ])
      expect(errorOf(r)).toMatchObject({
        code: "command.invalid",
        reason: "object-module",
      })
      const [row] = (
        await env.owner.query<{ note: string | null; version: number }>(
          `SELECT note, version::int AS version FROM public.${GAUGE_LOG_TABLE} WHERE id = $1`,
          [env.log]
        )
      ).rows
      expect(row).toEqual({ note: null, version: before })
    })

    // Призначення змінюють права, тож без прапорця — відмова до бази. З ним
    // вирішує база: власного призначення `me` не бачить (у `GaugeWriter`
    // немає ні читання, ні `administerRights` довідника). `create` тут не
    // годиться: посилання на учасника, якого `me` не читає, — `command.invalid`
    // раніше за права
    it("a rights catalog needs --allow-rights-write; with it the database decides", async () => {
      const [assignment] = (
        await env.owner.query<{ id: string }>(
          "SELECT a.id FROM public.org_role_assignments a WHERE a.subject = $1 AND a.archetype = $2",
          [env.me.member, GAUGE_WRITER_ID]
        )
      ).rows
      const unassign: Operation[] = [
        {
          action: "markDeletion",
          object: ASSIGNMENTS,
          id: assignment!.id,
          expectedVersion: 1,
          mark: true,
        },
      ]
      expect((await command(unassign)).refusal?.reason).toBe(
        "rights-write-disabled"
      )
      expect(
        errorOf(await command(unassign, { allowRightsWrite: true }))
      ).toMatchObject({ code: "command.forbidden", reason: "no-right" })
    })

    it("without --allow-data-write MCP refuses the write, the CLI writes", async () => {
      const before = await versionOf(GAUGE_TABLE, env.mine)
      const update = {
        action: "update",
        object: GAUGE,
        id: env.mine,
        expectedVersion: before,
        values: { reading: 2 },
      } satisfies Operation
      const mcp = await command([update], { allowDataWrite: false })
      expect(mcp.refusal?.reason).toBe("data-write-disabled")
      expect(await versionOf(GAUGE_TABLE, env.mine)).toBe(before)

      // Запис у CLI вирішує людина, що запускає команду (Р-A5-10)
      const cli = await runTool(
        dataCommandTool,
        {
          _: [JSON.stringify({ operations: [update] }), env.dir],
          "data-url-env": ENV,
          as: env.me.user,
          format: "json",
        },
        () => Promise.resolve(""),
        process.cwd(),
        { [ENV]: env.login }
      )
      expect(cli.exitCode, cli.stderr + cli.stdout).toBe(0)
      expect(await versionOf(GAUGE_TABLE, env.mine)).toBe(before + 1)
    })

    it("a model change between calls is command.model-mismatch until it is undone", async () => {
      // (а) Тека змінилася: наступний виклик компілює нову модель
      const file = join(env.dir, GAUGE_FILE)
      const original = await readFile(file, "utf8")
      const meta = JSON.parse(original) as { attributes: unknown[] }
      meta.attributes.push({
        id: randomUUID(),
        name: "extra",
        physicalName: "extra",
        type: "Integer",
      })
      await writeFile(file, JSON.stringify(meta, null, 2))
      try {
        const changed = await compile(await readMetadataDir(env.dir))
        expect(changed.diagnostics).toEqual([])
        expect(changed.model!.hash).not.toBe(env.model.hash)
        expect(errorOf(await readGauges()).code).toBe("command.model-mismatch")
      } finally {
        await writeFile(file, original)
      }
      rowsOf(await readGauges())

      // (б) Змінився застосований хеш: рантайм на виклик звіряє його знову
      await seedMarker(env.owner, "0".repeat(64))
      try {
        expect(errorOf(await readGauges()).code).toBe("command.model-mismatch")
      } finally {
        await seedMarker(env.owner, env.model.hash)
      }
      rowsOf(await readGauges())
    })
  })
})
