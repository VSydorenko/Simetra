import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { SESSION_CLAIMS_SETTING, type Operation } from "simetra/model"
import type { RightsOrphans } from "simetra/schema"
import { createCommandRuntime, fromPgPool } from "simetra/server"
import { runTool } from "../cli/command"
import { toolByName } from "../tools/catalog"
import {
  RIGHTS_ADMIN_ID,
  SNAPSHOT_TABLES,
  TASK_VIEWER_ID,
  TICKET_TABLE,
  TICKET_WRITER_ID,
  insertOrphan,
  planNodes,
} from "../../../simetra/test/support"
import { committed } from "./support/db"

import {
  ASSIGNMENTS,
  commandsCases,
  ENV,
  type Env,
  heldEnv,
  heldLogin,
  type Org,
  type Pools,
  refusal,
  REQUEST_ROLE,
  ROLES,
  seedOrg,
} from "./rights-admin-commands.support"

/**
 * Команди адміністрування прав (спека П4 §6.12) через `runtime.run` над
 * ціллю, розгорнутою справжніми `plan` + `apply`: marker з канонічним знімком
 * потрібен і рантайму, і плану. Запобіжники прав судять на `COMMIT` у
 * справжній транзакції з закоміченими даними, а план читає дані цілі — цього
 * порт-фейк unit-тестів T3 не доводить. Кейси команд — прямим портом, у своїй
 * організації зі своїми акторами; ті самі кейси через пулер Supavisor (П4
 * §7.3) — `rights-admin-commands.supabase.db.test.ts`, спільна підготовка —
 * `rights-admin-commands.support.ts`. Ціль одна на файл (одне розгортання),
 * кейси йдуть послідовно.
 */

describe("rights administration commands over a planned and applied target", () => {
  const target = heldEnv()
  let env: Env

  beforeAll(async () => {
    env = await target.open()
  }, 180_000)
  afterAll(() => target.close(), 60_000)

  describe("commands", () => {
    const login = heldLogin(() => env.url)
    let pools: Pools
    beforeAll(async () => {
      pools = await login.open()
    }, 60_000)
    afterAll(() => login.close(), 60_000)

    describe.each([["direct", (p: Pools) => p.direct]] as const)(
      "%s",
      (_, poolOf) => {
        commandsCases({ env: () => env, pools: () => pools }, poolOf)
      }
    )
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
              // Рядки-сироти видаляються явно: масив ТЧ — повна заміна.
              deleteIds: {
                delta: orphans.deltas
                  .filter((o) => o.role === d.role)
                  .map((o) => o.id),
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
