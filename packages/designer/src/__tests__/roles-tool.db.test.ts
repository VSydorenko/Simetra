import type pg from "pg"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
} from "simetra/model"
import {
  ensurePlatformRoles,
  platformRoleGate,
  platformRoleRefusals,
  platformRoleSet,
  readPlatformRoles,
} from "simetra/schema"
import { describe, expect, it } from "vitest"
import {
  rollbackDatabase,
  testDatabaseUrl,
  testProvider,
  testRoleName,
  withRollback,
  asStackSuperuser,
  restoreOwnerRole,
} from "../../../simetra/test/support"

/**
 * Інструмент `roles` (спека designer §3.2). DB-рівень, бо атрибути створеної ролі, грант
 * творцеві й право `CREATEROLE` вирішує Postgres. Кожен кейс — в одній
 * транзакції тесту з роллю під тегом прогону: роль відкочується.
 */
const TARGET = [{ server: "target" as const, db: { url: testDatabaseUrl() } }]

/** Роль сесії тестів: власник профілю. Він може не мати `CREATEROLE`. */
const SESSION_OWNER = PROVIDER_OWNER_ROLES[testProvider()]
const USER_ROLE = PROVIDER_API_ROLES[testProvider()].user

/**
 * Оператор від суперкористувача стека в точці збереження транзакції тесту:
 * роль власника профілю не створює ролей (на `postgres` вона без
 * `CREATEROLE`), а творець ролей — частина умови кейсу, а не предмет.
 */
const asStack = (client: pg.Client, sql: string) =>
  asStackSuperuser(client, () => client.query(sql))

/**
 * Тегований виконавець з CREATEROLE без SUPERUSER і без ADMIN на чужих
 * ролях: так `roles` запускає оператор, а не власник кластера. Сесія
 * переходить у нього; `adminOn` дає йому ADMIN на ролях, на які оператор його
 * має (роль запиту).
 */
const EXECUTOR = testRoleName("roles_exec")
/** Посередник ланцюга запиту: роль з CREATEROLE, до якої сесія переходить `SET ROLE`. */
const MIDDLE = testRoleName("middle")

async function asExecutor(
  client: pg.Client,
  adminOn: readonly string[] = []
): Promise<void> {
  await asStack(client, `CREATE ROLE ${EXECUTOR} NOLOGIN CREATEROLE`)
  await asStack(client, `GRANT ${EXECUTOR} TO ${SESSION_OWNER} WITH SET TRUE`)
  for (const role of adminOn)
    await asStack(
      client,
      `GRANT ${role} TO ${EXECUTOR} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    )
  await client.query(`SET LOCAL ROLE ${EXECUTOR}`)
}

describe("roles", () => {
  it("creates a missing role NOLOGIN NOINHERIT and is idempotent", async () => {
    await withRollback(async (client) => {
      await asExecutor(client)
      const dbs = rollbackDatabase(client)
      const name = testRoleName("command")
      expect(
        await ensurePlatformRoles(dbs, TARGET, { names: [name], login: [] })
      ).toEqual({ created: [{ server: "target", name, outcome: "created" }] })
      const found = await dbs.transaction(TARGET[0]!.db, "rollback", (tx) =>
        readPlatformRoles(tx, [name])
      )
      expect(found).toMatchObject([
        {
          name,
          attributes: {
            login: false,
            inherit: false,
            superuser: false,
            bypassRls: false,
            createRole: false,
            createDb: false,
            replication: false,
          },
          memberOf: [],
        },
      ])
      // Творець — член лише з ADMIN і сам має CREATEROLE: форму не ламає
      expect(platformRoleRefusals([name], found, "target", [])).toEqual([])
      expect(
        await ensurePlatformRoles(dbs, TARGET, { names: [name], login: [] })
      ).toEqual({ created: [{ server: "target", name, outcome: "present" }] })
    })
  })

  it("creates the role with an ADMIN-only self grant whatever createrole_self_grant says", async () => {
    await withRollback(async (client) => {
      // Налаштування діє лише на творця без SUPERUSER: сесія переходить у
      // тегову роль з CREATEROLE тієї ж транзакції
      await asExecutor(client)
      await client.query("SET LOCAL createrole_self_grant = 'set, inherit'")
      const dbs = rollbackDatabase(client)
      const name = testRoleName("command")
      await ensurePlatformRoles(dbs, TARGET, { names: [name], login: [] })
      const found = await dbs.transaction(TARGET[0]!.db, "rollback", (tx) =>
        readPlatformRoles(tx, [name])
      )
      expect(found[0]?.members.length).toBeGreaterThan(0)
      expect(found[0]?.members.filter((m) => m.inherit || m.set)).toEqual([])
    })
  })

  it("refuses without CREATEROLE and creates nothing", async () => {
    await withRollback(async (client) => {
      const dbs = rollbackDatabase(client)
      const name = testRoleName("command")
      await client.query(`SET LOCAL ROLE ${USER_ROLE}`)
      expect(
        await ensurePlatformRoles(dbs, TARGET, { names: [name], login: [] })
      ).toMatchObject({
        refusal: [
          {
            code: "roles.create-role-denied",
            params: { role: name, server: "target" },
          },
        ],
      })
      await restoreOwnerRole(client)
      expect(
        (
          await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [
            name,
          ])
        ).rows
      ).toEqual([])
    })
  })

  // Відповідність атрибута колонці `pg_roles` бачить лише Postgres: модульна
  // таблиця форм подає рядок уже готовим.
  it("reads a role attribute from its own catalog column", async () => {
    await withRollback(async (client) => {
      const name = testRoleName("command")
      await asStack(client, `CREATE ROLE ${name} NOLOGIN NOINHERIT CREATEDB`)
      const found = await rollbackDatabase(client).transaction(
        TARGET[0]!.db,
        "rollback",
        (tx) => readPlatformRoles(tx, [name])
      )
      expect(found[0]?.attributes).toEqual({
        login: false,
        inherit: false,
        superuser: false,
        bypassRls: false,
        createRole: false,
        createDb: true,
        replication: false,
      })
      expect(platformRoleRefusals([name], found, "target", [])).toMatchObject([
        { code: "plan.platform-role-shape", params: { violation: "createDb" } },
      ])
    })
  })

  it("the plan role of the local stack sees the command role", async () => {
    await withRollback(async (client) => {
      // Гейт читає й роль входу: після `roles.sql` її пара з роллю команд
      // допустима лише разом з її власним рядком безпечної форми
      expect(
        await rollbackDatabase(client).transaction(
          TARGET[0]!.db,
          "rollback",
          (tx) =>
            platformRoleGate(
              tx,
              [PLATFORM_ROLES.command],
              platformRoleSet(testProvider()).login,
              "target"
            )
        )
      ).toEqual([])
    })
  })

  // Наявну пару лише звіряють: у підсумку її немає, відмови теж
  it("without a project file an existing login pair is checked, not refused or created", async () => {
    await withRollback(async (client) => {
      // Локальний стек після `roles`: пари runtime → command і signals →
      // група споживача, обидві SET-only; ролі грантів уже є
      expect(
        await ensurePlatformRoles(
          rollbackDatabase(client),
          TARGET,
          platformRoleSet(undefined)
        )
      ).toEqual({
        created: Object.values(PLATFORM_ROLES).map((name) => ({
          server: "target",
          name,
          outcome: "present",
        })),
      })
    })
  })
})

/**
 * Роль входу (спека П4 §6.2). DB-рівень, бо рядки `pg_auth_members` кожного
 * grantor, право `ADMIN` на батьку й типові опції членства вирішує Postgres.
 * Справжні імена ролей платформи кластерні, тож кейси — на тегованих.
 */
describe("roles: the login role", () => {
  const command = testRoleName("command")
  const runtime = testRoleName("runtime")
  const at = (dbs: ReturnType<typeof rollbackDatabase>) =>
    dbs.transaction(TARGET[0]!.db, "rollback", (tx) =>
      readPlatformRoles(tx, [command, runtime])
    )
  const roleExists = async (client: pg.Client, name: string) =>
    (await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]))
      .rows.length > 0

  const asCode = (d: { code: string; params?: Record<string, unknown> }) =>
    `${d.code}:${String(d.params?.role)}:${String(d.params?.violation)}`

  it("creates the grant role and the login role, then finds both present", async () => {
    await withRollback(async (client) => {
      await asExecutor(client)
      const dbs = rollbackDatabase(client)
      const login = [{ name: runtime, memberOf: [command] }]
      expect(
        await ensurePlatformRoles(dbs, TARGET, { names: [command], login })
      ).toEqual({
        created: [
          { server: "target", name: command, outcome: "created" },
          { server: "target", name: runtime, outcome: "created" },
        ],
      })
      expect(
        platformRoleRefusals([command, runtime], await at(dbs), "target", login)
      ).toEqual([])
      expect(
        await ensurePlatformRoles(dbs, TARGET, { names: [command], login })
      ).toEqual({
        created: [
          { server: "target", name: command, outcome: "present" },
          { server: "target", name: runtime, outcome: "present" },
        ],
      })
    })
  })

  it("makes the login role a member of the real request role with INHERIT FALSE, SET TRUE", async () => {
    await withRollback(async (client) => {
      // Виконавець має ADMIN на ролі запиту (спека П4 §6.2)
      await asExecutor(client, [USER_ROLE])
      const dbs = rollbackDatabase(client)
      const login = [{ name: runtime, memberOf: [command, USER_ROLE] }]
      expect(
        await ensurePlatformRoles(dbs, TARGET, { names: [command], login })
      ).toMatchObject({ created: [{ name: command }, { name: runtime }] })
      const row = (await at(dbs)).find((r) => r.name === runtime)
      expect(
        row?.memberOf
          .filter((m) => m.role === USER_ROLE)
          .map((m) => [m.admin, m.inherit, m.set])
      ).toEqual([[false, false, true]])
      expect(
        platformRoleRefusals([command, runtime], await at(dbs), "target", login)
      ).toEqual([])
    })
  })

  // Другий grantor з INHERIT
  it("refuses a second grantor of the pair with INHERIT TRUE", async () => {
    await withRollback(async (client) => {
      await asExecutor(client)
      const dbs = rollbackDatabase(client)
      const login = [{ name: runtime, memberOf: [command] }]
      await ensurePlatformRoles(dbs, TARGET, { names: [command], login })
      const manager = testRoleName("mgr")
      await client.query(`CREATE ROLE ${manager} NOLOGIN CREATEROLE`)
      await client.query(`GRANT ${manager} TO ${EXECUTOR} WITH SET TRUE`)
      await client.query(
        `GRANT ${command} TO ${manager} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
      )
      await client.query(`SET LOCAL ROLE ${manager}`)
      await client.query(`GRANT ${command} TO ${runtime} WITH INHERIT TRUE`)
      await client.query(`SET LOCAL ROLE ${EXECUTOR}`)
      const again = await ensurePlatformRoles(dbs, TARGET, {
        names: [command],
        login,
      })
      expect(again.created).toEqual([])
      expect((again.refusal ?? []).map(asCode)).toEqual([
        `plan.platform-role-shape:${command}:member:${runtime}`,
        `plan.platform-role-shape:${runtime}:membership-option:${command}`,
      ])
      expect(
        platformRoleRefusals([command], await at(dbs), "target", login).map(
          asCode
        )
      ).toEqual([`plan.platform-role-shape:${command}:member:${runtime}`])
    })
  })

  it("refuses the login role without ADMIN on its request role but creates the grant role", async () => {
    await withRollback(async (client) => {
      const request = testRoleName("request")
      await asStack(client, `CREATE ROLE ${request} NOLOGIN`)
      await asExecutor(client)
      const dbs = rollbackDatabase(client)
      expect(
        await ensurePlatformRoles(dbs, TARGET, {
          names: [command],
          login: [{ name: runtime, memberOf: [command, request] }],
        })
      ).toEqual({
        created: [{ server: "target", name: command, outcome: "created" }],
        refusal: [
          expect.objectContaining({
            code: "roles.admin-option-missing",
            params: { role: request, server: "target" },
          }),
        ],
      })
      expect(await roleExists(client, runtime)).toBe(false)
    })
  })

  it("refuses the login role without ADMIN on a grant role another executor created", async () => {
    await withRollback(async (client) => {
      await client.query("SET LOCAL createrole_self_grant = ''")
      await asStack(client, `CREATE ROLE ${command} NOLOGIN NOINHERIT`)
      await asExecutor(client)
      const dbs = rollbackDatabase(client)
      expect(
        await ensurePlatformRoles(dbs, TARGET, {
          names: [command],
          login: [{ name: runtime, memberOf: [command] }],
        })
      ).toEqual({
        created: [{ server: "target", name: command, outcome: "present" }],
        refusal: [
          expect.objectContaining({
            code: "roles.admin-option-missing",
            params: { role: command, server: "target" },
          }),
        ],
      })
      expect(await roleExists(client, runtime)).toBe(false)
    })
  })

  it("the gate reads the login role: a SET member of it is refused", async () => {
    await withRollback(async (client) => {
      await asExecutor(client)
      const dbs = rollbackDatabase(client)
      const login = [{ name: runtime, memberOf: [command] }]
      await ensurePlatformRoles(dbs, TARGET, { names: [command], login })
      const x = testRoleName("x")
      await client.query(`CREATE ROLE ${x} NOLOGIN`)
      await client.query(`GRANT ${runtime} TO ${x} WITH SET TRUE`)
      const gate = await dbs.transaction(TARGET[0]!.db, "rollback", (tx) =>
        platformRoleGate(tx, [command], login, "target")
      )
      expect(gate.map(asCode)).toEqual([
        `plan.platform-role-shape:${runtime}:member:${x}`,
      ])
      const again = await ensurePlatformRoles(dbs, TARGET, {
        names: [command],
        login,
      })
      expect((again.refusal ?? []).map(asCode)).toEqual([
        `plan.platform-role-shape:${runtime}:member:${x}`,
      ])
    })
  })

  // §6.16 п. 2: що член з ADMIN має CREATEROLE, бачить лише каталог Postgres
  it("the gate refuses a request role with CREATEROLE that administers the command role", async () => {
    await withRollback(async (client) => {
      await asExecutor(client)
      const dbs = rollbackDatabase(client)
      await ensurePlatformRoles(dbs, TARGET, { names: [command], login: [] })
      const request = testRoleName("request")
      await asStack(client, `CREATE ROLE ${request} NOLOGIN CREATEROLE`)
      await asStack(
        client,
        `GRANT ${command} TO ${request} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
      )
      const gate = await dbs.transaction(TARGET[0]!.db, "rollback", (tx) =>
        platformRoleGate(
          tx,
          [command],
          [{ name: runtime, memberOf: [command] }],
          "target",
          [request]
        )
      )
      expect(gate.map(asCode)).toEqual([
        `plan.platform-role-shape:${command}:request-role:${request}`,
      ])
    })
  })

  /**
   * Роль запиту → (SET) посередник з CREATEROLE → (членство без SET і
   * INHERIT) керівник з ADMIN на ролі команд. Що з PG16 право керівника йде
   * будь-яким членством, вирішує Postgres, тож і ланцюг, і його наслідок — тут.
   */
  async function requestPath(client: pg.Client) {
    const request = testRoleName("request")
    const manager = testRoleName("manager")
    await asStack(client, `CREATE ROLE ${request} NOLOGIN`)
    await asStack(client, `CREATE ROLE ${MIDDLE} NOLOGIN CREATEROLE`)
    await asStack(client, `CREATE ROLE ${manager} NOLOGIN CREATEROLE`)
    await asStack(
      client,
      `GRANT ${MIDDLE} TO ${request} WITH INHERIT FALSE, SET TRUE`
    )
    await asStack(
      client,
      `GRANT ${manager} TO ${MIDDLE} WITH ADMIN FALSE, INHERIT FALSE, SET FALSE`
    )
    await asStack(
      client,
      `GRANT ${command} TO ${manager} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`
    )
    return { request, manager }
  }

  const gateFor = (
    dbs: ReturnType<typeof rollbackDatabase>,
    requestNames: string[]
  ) =>
    dbs.transaction(TARGET[0]!.db, "rollback", (tx) =>
      platformRoleGate(
        tx,
        [command],
        [{ name: runtime, memberOf: [command] }],
        "target",
        requestNames
      )
    )

  it("the gate refuses a request role that reaches a manager of the command role through any membership", async () => {
    await withRollback(async (client) => {
      await asExecutor(client)
      const dbs = rollbackDatabase(client)
      await ensurePlatformRoles(dbs, TARGET, { names: [command], login: [] })
      const { request, manager } = await requestPath(client)
      expect((await gateFor(dbs, [request])).map(asCode)).toEqual([
        `plan.platform-role-shape:${command}:request-path:${manager}`,
      ])
      // Роль запиту без ребер до керівника — без відмови.
      const alone = testRoleName("alone")
      await asStack(client, `CREATE ROLE ${alone} NOLOGIN`)
      expect(await gateFor(dbs, [alone])).toEqual([])
    })
  })

  // Факт експлуатованості цього ланцюга: посередник із CREATEROLE, звичайний член
  // керівника, у PG16+ — адміністратор ролі команд (`is_admin_of_role` іде
  // всіма членствами). Postgres стека дозволяє `ALTER ROLE` ролі команд;
  // `GRANT` проходить ту саму перевірку, але на PG 17.12 відхиляється звичайною
  // помилкою прав 42501 (ранні мінорні версії падали внутрішньою XX000
  // «no possible grantors»): грантора шукають лише ланцюгом INHERIT.
  // Відмова сервера — не захист, на який спирається платформа: шлях відхиляє гейт.
  it("a CREATEROLE member of the manager administers the command role", async () => {
    await withRollback(async (client) => {
      await asExecutor(client)
      const dbs = rollbackDatabase(client)
      await ensurePlatformRoles(dbs, TARGET, { names: [command], login: [] })
      const { request } = await requestPath(client)
      const x = testRoleName("x")
      await asStack(client, `CREATE ROLE ${x} NOLOGIN`)
      // На Supabase сесія — не суперкористувач: вона входить як роль запиту, а
      // з неї — `SET ROLE` на посередника, тож ланцюг потрібен. На postgres
      // сесія — суперкористувач, і цей грант там не обов'язковий, але
      // нешкідливий: ланцюг лишається спільним для обох профілів.
      await asStack(
        client,
        `GRANT ${request} TO ${SESSION_OWNER} WITH SET TRUE`
      )
      await client.query(`SET LOCAL ROLE ${MIDDLE}`)
      const attempt = async (sql: string) => {
        await client.query("SAVEPOINT attempt")
        try {
          await client.query(sql)
          await client.query("RELEASE SAVEPOINT attempt")
          return "allowed"
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT attempt")
          return (error as { code?: string }).code
        }
      }
      expect({
        alter: await attempt(`ALTER ROLE ${command} CONNECTION LIMIT 1`),
        grant: await attempt(`GRANT ${command} TO ${x}`),
      }).toEqual({ alter: "allowed", grant: "42501" })
    })
  })

  // Цикл членств (A → B → A) Postgres відхиляє сам (`0LP01`), тож обхід на
  // ньому не перевірити; `UNION` у запиті лишається запобіжником.
  it("Postgres refuses a membership cycle the walk would have to end", async () => {
    await withRollback(async (client) => {
      await asExecutor(client)
      const dbs = rollbackDatabase(client)
      await ensurePlatformRoles(dbs, TARGET, { names: [command], login: [] })
      const a = testRoleName("cycle_a")
      const b = testRoleName("cycle_b")
      await asStack(client, `CREATE ROLE ${a} NOLOGIN`)
      await asStack(client, `CREATE ROLE ${b} NOLOGIN`)
      await asStack(client, `GRANT ${b} TO ${a}`)
      await expect(asStack(client, `GRANT ${a} TO ${b}`)).rejects.toMatchObject(
        {
          code: "0LP01",
        }
      )
    })
  })

  it("the gate refuses a request role membership with INHERIT TRUE", async () => {
    await withRollback(async (client) => {
      await asExecutor(client, [USER_ROLE])
      const dbs = rollbackDatabase(client)
      const login = [{ name: runtime, memberOf: [command, USER_ROLE] }]
      await ensurePlatformRoles(dbs, TARGET, {
        names: [command],
        login: [{ name: runtime, memberOf: [command] }],
      })
      await client.query(
        `GRANT ${USER_ROLE} TO ${runtime} WITH INHERIT TRUE, SET TRUE`
      )
      const gate = await dbs.transaction(TARGET[0]!.db, "rollback", (tx) =>
        platformRoleGate(tx, [command], login, "target")
      )
      expect(gate.map(asCode)).toEqual([
        `plan.platform-role-shape:${runtime}:membership-option:${USER_ROLE}`,
      ])
    })
  })
})
