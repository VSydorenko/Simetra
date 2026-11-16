import { randomBytes, randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { withDatabaseName } from "@supabase/pg-delta"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  type CommandError,
  type Operation,
} from "simetra/model"
import { runTool } from "../cli/command"
import { readMetadataDir } from "../io/metadata-dir"
import {
  dataCommandTool,
  dataReadTool,
  type DataCommandData,
  type DataReadData,
  type JsonRow,
} from "../tools/data-tools"
import type { ToolResult } from "../tools/types"
import {
  GAUGE_FILE,
  GAUGE_LOG_TABLE,
  GAUGE_TABLE,
  GAUGE_WRITER_ID,
  testOwnerLoginUrl,
  testRoleName,
  testSuperuserUrl,
  withSessionOptions,
} from "../../../simetra/test/support"
import {
  asSuperuser,
  dropRoles,
  markDevelopmentDatabase,
  query,
  seedMarker,
  withCopy,
  withRuntimeLogin,
} from "./support/db"
import {
  ASSIGNMENTS,
  dataToolsHelpers,
  ENV,
  GAUGE,
  GAUGE_LOG,
  heldEnv,
  quoted,
  REQUEST_ROLE,
  violations,
  type Env,
} from "./data-tools.support"

/**
 * Інструменти даних (`data-read`, `data-command`) над тінню рушія: RLS і
 * права ядра, звірку хешу, читання `pg_db_role_setting` і факти ролі входу
 * вирішує Postgres — порт-фейк unit-тестів цього не доводить. Ціль одна на
 * файл; кейси послідовні, бо перші два йдуть до засіву ознаки бази
 * розробника, а решта — після.
 */

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

  const { call, readGauges, command, versionOf, factsAs } = dataToolsHelpers(
    () => env
  )

  describe("before the database is marked as a development one", () => {
    it("a database without the development setting is refused: session options and role settings do not count", async () => {
      const refusal = async (url: string) => (await readGauges({ url })).refusal
      const notDevelopment = { reason: "data-guard", detail: "not-development" }
      expect(await refusal(env.login)).toMatchObject(notDevelopment)

      // Сесійне налаштування задає сам рядок підключення
      expect(
        await refusal(
          withSessionOptions(env.login, "-c simetra.environment=development")
        )
      ).toMatchObject(notDevelopment)

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
      // Вхід власника цілі, а не адреса тестів: на `postgres` вона — вхід
      // суперкористувача з `-c role=`, а запобіжник судить `session_user`
      const migrator = withDatabaseName(
        testOwnerLoginUrl(),
        decodeURIComponent(new URL(env.url).pathname.slice(1))
      )
      expect(violations(await factsAs(migrator))).toContain("migrator")
      expect((await readGauges({ url: migrator })).refusal).toMatchObject({
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
      // Версія з послідовності: лише «більша за попередню», не `+1`
      expect(
        resultOf(await command([update])).changes[0]?.version as number
      ).toBeGreaterThan(version)
      expect(errorOf(await command([update]))).toMatchObject({
        code: "command.conflict",
        reason: "version",
      })
    })

    // MCP шле масив ТЧ без опції повного масиву: наявний рядок, якого агент
    // не назвав, рантайм не видаляє мовчки (спека П4-B §7.1)
    it("data-command with a tabular array leaving out an existing row is tabular-rows-missing; deleteIds names it", async () => {
      const id = randomUUID()
      const [kept, dropped] = [randomUUID(), randomUUID()]
      const created = resultOf(
        await command([
          {
            action: "create",
            object: GAUGE,
            id,
            values: { org: env.me.org },
            tabularSections: { lines: [{ ref: kept }, { ref: dropped }] },
          },
        ])
      )
      const update = {
        action: "update",
        object: GAUGE,
        id,
        expectedVersion: created.changes[0]!.version,
        tabularSections: { lines: [{ ref: kept }] },
      } satisfies Operation
      expect(errorOf(await command([update]))).toEqual({
        code: "command.invalid",
        reason: "tabular-rows-missing",
        object: GAUGE,
        path: "lines",
      })
      resultOf(await command([{ ...update, deleteIds: { lines: [dropped] } }]))
      const { rows } = await env.owner.query<{ id: string }>(
        "SELECT id FROM public.gauge_lines WHERE parent_id = $1",
        [id]
      )
      expect(rows).toEqual([{ id: kept }])
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

      // Запис у CLI вирішує людина, що запускає команду
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
      // Версія з послідовності: лише «більша за попередню», не `+1`
      expect(await versionOf(GAUGE_TABLE, env.mine)).toBeGreaterThan(before)
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
