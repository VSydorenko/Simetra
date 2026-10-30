import { describe, expect, it } from "vitest"
import { compile, loadSqlParser } from "simetra/compiler"
import { PLATFORM_LOGIN_ROLES, PLATFORM_ROLES } from "simetra/model"
import {
  desiredForApply,
  ApplyDbError,
  ensurePlatformRoles,
  platformRoleRefusals,
  platformRoleSet,
  requiredPlatformRoles,
  type ApplyDatabase,
  type PlatformRoleRow,
} from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
} from "../../../compiler/__tests__/helpers"
import {
  compileRights,
  rightsFiles,
} from "../../../compiler/__tests__/fixtures/rights"

type Member = PlatformRoleRow["members"][number]

const member = (over: Partial<Member> = {}): Member => ({
  role: "migrator",
  admin: true,
  inherit: false,
  set: false,
  manager: true,
  ...over,
})

type Membership = PlatformRoleRow["memberOf"][number]

const row = (
  over: {
    name?: string
    attributes?: Partial<PlatformRoleRow["attributes"]>
    memberOf?: Membership[]
    members?: Member[]
    requestPath?: string[]
  } = {}
): PlatformRoleRow => ({
  name: over.name ?? PLATFORM_ROLES.command,
  attributes: {
    login: false,
    inherit: false,
    superuser: false,
    bypassRls: false,
    createRole: false,
    createDb: false,
    replication: false,
    ...over.attributes,
  },
  memberOf: over.memberOf ?? [],
  members: over.members ?? [],
  requestPath: over.requestPath ?? [],
})

const RUNTIME = PLATFORM_LOGIN_ROLES.runtime
const COMMAND = PLATFORM_ROLES.command

/** Рядок `pg_auth_members` ролі входу: типово — пара §6.2 від `postgres`. */
const pair = (role: string, over: Partial<Membership> = {}): Membership => ({
  role,
  grantor: "postgres",
  admin: false,
  inherit: false,
  set: true,
  ...over,
})

/** Роль входу рантайму безпечної форми з батьками `parents`. */
const loginRow = (
  over: {
    attributes?: Partial<PlatformRoleRow["attributes"]>
    memberOf?: Membership[]
    members?: Member[]
    requestPath?: string[]
  } = {}
): PlatformRoleRow =>
  row({
    name: RUNTIME,
    attributes: { login: true, ...over.attributes },
    memberOf: over.memberOf ?? [pair(COMMAND), pair("authenticated")],
    members: over.members ?? [member()],
    requestPath: over.requestPath ?? [],
  })

/** Роль команд, членом якої є роль входу з членствами `rows`. */
const commandWith = (rows: Partial<Member>[] = [{}]): PlatformRoleRow =>
  row({
    members: [
      member(),
      ...rows.map((over) =>
        member({
          role: RUNTIME,
          admin: false,
          set: true,
          manager: false,
          ...over,
        })
      ),
    ],
  })

const LOGIN = { name: RUNTIME, memberOf: [COMMAND, "authenticated"] }

describe("platformRoleRefusals", () => {
  it.each([
    { case: "absent", found: [], codes: ["plan.platform-role-missing"] },
    {
      case: "login",
      found: [row({ attributes: { login: true } })],
      codes: ["plan.platform-role-shape"],
      violation: "login",
    },
    {
      case: "inherit",
      found: [row({ attributes: { inherit: true } })],
      codes: ["plan.platform-role-shape"],
      violation: "inherit",
    },
    {
      case: "superuser",
      found: [row({ attributes: { superuser: true } })],
      codes: ["plan.platform-role-shape"],
      violation: "superuser",
    },
    {
      case: "bypassRls",
      found: [row({ attributes: { bypassRls: true } })],
      codes: ["plan.platform-role-shape"],
      violation: "bypassRls",
    },
    {
      case: "createRole",
      found: [row({ attributes: { createRole: true } })],
      codes: ["plan.platform-role-shape"],
      violation: "createRole",
    },
    {
      case: "createDb",
      found: [row({ attributes: { createDb: true } })],
      codes: ["plan.platform-role-shape"],
      violation: "createDb",
    },
    {
      case: "replication",
      found: [row({ attributes: { replication: true } })],
      codes: ["plan.platform-role-shape"],
      violation: "replication",
    },
    {
      case: "member-of",
      found: [row({ memberOf: [pair("pg_read_all_data")] })],
      codes: ["plan.platform-role-shape"],
      violation: "member-of:pg_read_all_data",
    },
    {
      case: "set-member",
      found: [row({ members: [member({ set: true })] })],
      codes: ["plan.platform-role-shape"],
      violation: "member:migrator",
    },
    {
      case: "inherit-member",
      found: [row({ members: [member({ inherit: true })] })],
      codes: ["plan.platform-role-shape"],
      violation: "member:migrator",
    },
    {
      case: "admin-without-power",
      found: [row({ members: [member({ manager: false })] })],
      codes: ["plan.platform-role-shape"],
      violation: "member:migrator",
    },
    {
      case: "member-without-admin",
      found: [row({ members: [member({ admin: false })] })],
      codes: ["plan.platform-role-shape"],
      violation: "member:migrator",
    },
    {
      case: "admin-manager",
      found: [row({ members: [member({})] })],
      codes: [],
    },
    { case: "ok", found: [row({})], codes: [] },
  ])(
    "refuses a plan when the command role is $case",
    ({ found, codes, violation }) => {
      const refusals = platformRoleRefusals(
        [PLATFORM_ROLES.command],
        found,
        "shadow"
      )
      expect(refusals.map((d) => [d.code, d.params?.server])).toEqual(
        codes.map((c) => [c, "shadow"])
      )
      if (violation !== undefined)
        expect(refusals[0]?.params?.violation).toBe(violation)
    }
  )

  // §6.16 п. 2: роль запиту й платформна роль не члени одна одної в жодній
  // формі — навіть ADMIN-керівник з CREATEROLE видав би запиту членство
  it.each([
    {
      case: "an ADMIN manager request role",
      found: [row({ members: [member(), member({ role: "authenticated" })] })],
      violation: "request-role:authenticated",
    },
    {
      case: "a SET member request role",
      found: [
        row({
          members: [
            member(),
            member({ role: "anon", admin: false, set: true, manager: false }),
          ],
        }),
      ],
      violation: "request-role:anon",
    },
    {
      case: "a member of a request role",
      found: [row({ memberOf: [pair("service_role", { set: false })] })],
      violation: "request-role:service_role",
    },
  ])("refuses the command role with $case", ({ found, violation }) => {
    expect(
      platformRoleRefusals([COMMAND], found, "target").map((d) => [
        d.code,
        d.params?.role,
        d.params?.violation,
      ])
    ).toEqual([["plan.platform-role-shape", COMMAND, violation]])
  })

  it("refuses a request role that manages the login role", () => {
    const login = loginRow({
      members: [member(), member({ role: "authenticated" })],
    })
    expect(
      platformRoleRefusals([COMMAND], [commandWith(), login], "target").map(
        (d) => [d.params?.role, d.params?.violation]
      )
    ).toEqual([[RUNTIME, "request-role:authenticated"]])
  })

  // Роль запиту, з якої будь-яким ребром досяжний керівник ролі
  // платформи чи суперкористувач, через `SET ROLE` на посередника змінює її.
  it.each([
    {
      case: "a manager of the command role",
      found: [row({ requestPath: ["tagged_manager"] })],
      role: COMMAND,
      violation: "request-path:tagged_manager",
    },
    {
      case: "a manager of the login role",
      found: [commandWith(), loginRow({ requestPath: ["tagged_manager"] })],
      role: RUNTIME,
      violation: "request-path:tagged_manager",
    },
    {
      case: "a superuser",
      found: [row({ requestPath: ["tagged_super"] })],
      role: COMMAND,
      violation: "request-path:tagged_super",
    },
  ])("refuses a request path to $case", ({ found, role, violation }) => {
    expect(
      platformRoleRefusals([COMMAND], found, "target").map((d) => [
        d.code,
        d.params?.role,
        d.params?.violation,
      ])
    ).toEqual([["plan.platform-role-shape", role, violation]])
  })

  it("accepts a manager the request roles do not reach", () => {
    expect(
      platformRoleRefusals([COMMAND], [commandWith(), loginRow()], "target")
    ).toEqual([])
  })

  it("checks the request roles it is given instead of the provider ones", () => {
    const found = [row({ members: [member(), member({ role: "tagged_req" })] })]
    expect(
      platformRoleRefusals([COMMAND], found, "target", undefined, undefined, [
        "tagged_req",
      ]).map((d) => d.params?.violation)
    ).toEqual(["request-role:tagged_req"])
  })

  it("names the first violation in a fixed order", () => {
    const refusals = platformRoleRefusals(
      [PLATFORM_ROLES.command],
      [row({ attributes: { login: true }, members: [member({ set: true })] })],
      "target"
    )
    expect(refusals.map((d) => d.params?.violation)).toEqual(["login"])
  })

  it("asks for nothing when the model needs no platform role", () => {
    expect(platformRoleRefusals([], [], "target")).toEqual([])
  })

  // Повна звірка ролі входу (`login` передано, як кличе `roles`)
  it.each([
    { case: "the safe shape", found: loginRow(), violation: undefined },
    {
      case: "an inherit attribute",
      found: loginRow({ attributes: { inherit: true } }),
      violation: "inherit",
    },
    {
      case: "no LOGIN",
      found: loginRow({ attributes: { login: false } }),
      violation: "login",
    },
    {
      case: "a missing request role",
      found: loginRow({ memberOf: [pair(COMMAND)] }),
      violation: "membership-missing:authenticated",
    },
    {
      case: "an extra parent",
      found: loginRow({
        memberOf: [pair(COMMAND), pair("authenticated"), pair("anon")],
      }),
      violation: "member-of:anon",
    },
    {
      case: "a second grantor with INHERIT",
      found: loginRow({
        memberOf: [
          pair(COMMAND),
          pair(COMMAND, { grantor: "mgr", inherit: true }),
          pair("authenticated"),
        ],
      }),
      violation: `membership-option:${COMMAND}`,
    },
    {
      case: "an ADMIN membership",
      found: loginRow({
        memberOf: [pair(COMMAND), pair("authenticated", { admin: true })],
      }),
      violation: "membership-option:authenticated",
    },
    {
      case: "a member with SET",
      found: loginRow({ members: [member({ role: "x", set: true })] }),
      violation: "member:x",
    },
  ])("checks the login role with $case", ({ found, violation }) => {
    const refusals = platformRoleRefusals(
      [RUNTIME],
      [found],
      "target",
      [RUNTIME],
      LOGIN
    )
    expect(refusals.map((d) => [d.params?.role, d.params?.violation])).toEqual(
      violation === undefined ? [] : [[RUNTIME, violation]]
    )
  })

  // Роль команд з членом-роллю входу (без `login`, як кличе `checkPlatformRoles`)
  it.each([
    {
      case: "accepts the pair of a safe login role",
      found: [commandWith(), loginRow()],
      loginNames: [RUNTIME],
      refusals: [],
    },
    {
      case: "a second grantor of the pair with INHERIT",
      found: [commandWith([{}, { inherit: true }]), loginRow()],
      loginNames: [RUNTIME],
      refusals: [[COMMAND, `member:${RUNTIME}`]],
    },
    {
      case: "the pair of a role that is not a platform login",
      found: [commandWith(), loginRow()],
      loginNames: ["other_login"],
      refusals: [[COMMAND, `member:${RUNTIME}`]],
    },
    {
      case: "a SET member of the login role",
      found: [
        commandWith(),
        loginRow({ members: [member(), member({ role: "x", set: true })] }),
      ],
      loginNames: [RUNTIME],
      refusals: [[RUNTIME, "member:x"]],
    },
    {
      case: "the pair without the login role row",
      found: [commandWith()],
      loginNames: [RUNTIME],
      refusals: [[COMMAND, `member:${RUNTIME}`]],
    },
    {
      case: "a request role membership with INHERIT",
      found: [
        commandWith(),
        loginRow({
          memberOf: [pair(COMMAND), pair("authenticated", { inherit: true })],
        }),
      ],
      loginNames: [RUNTIME],
      refusals: [[RUNTIME, "membership-option:authenticated"]],
    },
    {
      case: "a login role with CREATEROLE",
      found: [commandWith(), loginRow({ attributes: { createRole: true } })],
      loginNames: [RUNTIME],
      refusals: [[RUNTIME, "createRole"]],
    },
    {
      case: "a login role in a parent outside the platform and request roles",
      found: [
        commandWith(),
        loginRow({
          memberOf: [
            pair(COMMAND),
            pair("authenticated"),
            pair("service_role"),
          ],
        }),
      ],
      loginNames: [RUNTIME],
      refusals: [[RUNTIME, "member-of:service_role"]],
    },
  ])("the command role: $case", ({ found, loginNames, refusals }) => {
    expect(
      platformRoleRefusals([COMMAND], found, "target", loginNames).map((d) => [
        d.params?.role,
        d.params?.violation,
      ])
    ).toEqual(refusals)
  })

  it("accepts the pair of the platform login role by default", () => {
    expect(
      platformRoleRefusals([COMMAND], [commandWith(), loginRow()], "target")
    ).toEqual([])
  })
})

describe("platformRoleSet", () => {
  it("adds the runtime login role only when the provider is known", () => {
    expect(platformRoleSet("supabase")).toEqual({
      names: Object.values(PLATFORM_ROLES),
      login: { name: RUNTIME, memberOf: [COMMAND, "authenticated"] },
    })
    expect(platformRoleSet(undefined)).toEqual({
      names: Object.values(PLATFORM_ROLES),
    })
  })
})

describe("requiredPlatformRoles", () => {
  it("finds the command role in the apply state of a project without users", async () => {
    const parse = await loadSqlParser()
    // Без «Користувачів» гранти схеми `simetra` вставляє стан застосування
    const plain = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Party/Party.meta.json": catalog("Party"),
      })
    )
    expect(plain.diagnostics).toEqual([])
    const withoutUsers = await desiredForApply(plain.model!)
    expect(requiredPlatformRoles(withoutUsers.sql, parse)).toEqual([
      PLATFORM_ROLES.command,
    ])
    // З «Користувачами» ті самі гранти дає платформний шар
    const users = await compileRights(rightsFiles())
    expect(users.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const withUsers = await desiredForApply(users.model!)
    expect(requiredPlatformRoles(withUsers.sql, parse)).toEqual([
      PLATFORM_ROLES.command,
    ])
  })
})

/**
 * Фейковий кластер ролей: кожен сервер — URL, `shared` зводить кілька URL в
 * один кластер. Відповідає лише на запити `ensurePlatformRoles`.
 */
function fakeCluster(o: {
  canCreate: Record<string, boolean>
  roles?: Record<string, PlatformRoleRow[]>
  shared?: boolean
  /** Ролі, на які роль сесії має `ADMIN` (`pg_has_role`). */
  admin?: readonly string[]
  /**
   * Роль, що з'являється між фазами: `read` — до першої транзакції запису
   * (її бачить читання фази запису), `create` — разом із чужим
   * `CREATE ROLE`, тож власний падає `42710`.
   */
  appear?: { row: PlatformRoleRow; on: "read" | "create" }
}): { dbs: ApplyDatabase; writes: { url: string; sql: string }[] } {
  const roles = new Map<string, PlatformRoleRow[]>(
    Object.entries(o.roles ?? {})
  )
  const clusterOf = (url: string) => (o.shared === true ? "cluster" : url)
  const writes: { url: string; sql: string }[] = []
  let pending = o.appear
  const arrive = (key: string) => {
    if (pending === undefined) return
    roles.set(key, [...(roles.get(key) ?? []), pending.row])
    pending = undefined
  }
  const dbs: ApplyDatabase = {
    transaction: async (db, end, fn) => {
      if (end === "commit" && pending?.on === "read") arrive(clusterOf(db.url))
      return fn({
        query: async <R extends Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[]
        ) => {
          const key = clusterOf(db.url)
          const cluster = roles.get(key) ?? []
          if (sql.includes("rolcreaterole OR"))
            return [{ allowed: o.canCreate[db.url] ?? false }] as unknown as R[]
          if (sql.includes("pg_has_role"))
            return (params?.[0] as string[]).map((role) => ({
              role,
              present: cluster.some((r) => r.name === role),
              admin: o.admin?.includes(role) ?? false,
            })) as unknown as R[]
          if (sql.includes("pg_auth_members")) {
            const names = params?.[0] as string[]
            return cluster.filter((r) =>
              names.includes(r.name)
            ) as unknown as R[]
          }
          if (end !== "commit")
            throw new Error(`write in a read transaction: ${sql}`)
          writes.push({ url: db.url, sql })
          const created = /^CREATE ROLE "?([a-z0-9_]+)"?( LOGIN)?/.exec(sql)
          if (created !== null && pending?.on === "create") {
            arrive(key)
            throw new ApplyDbError("role already exists", "42710")
          }
          if (created !== null)
            roles.set(key, [
              ...cluster,
              row({
                name: created[1]!,
                attributes: { login: created[2] !== undefined },
                members: [member()],
              }),
            ])
          const granted = /^GRANT "?([a-z0-9_]+)"? TO "?([a-z0-9_]+)"?/.exec(
            sql
          )
          if (granted !== null) {
            const child = cluster.find((r) => r.name === granted[2])
            child?.memberOf.push(pair(granted[1]!))
          }
          return [] as R[]
        },
        extract: () => Promise.reject(new Error("no extract expected")),
      })
    },
  }
  return { dbs, writes }
}

const TARGET = { url: "postgres://target" }
const SHADOW = { url: "postgres://shadow" }
const BOTH = [
  { server: "target" as const, db: TARGET },
  { server: "shadow" as const, db: SHADOW },
]
const NAMES = { names: [COMMAND] }
const WITH_LOGIN = { names: [COMMAND], login: LOGIN }

describe("ensurePlatformRoles", () => {
  it("checks CREATEROLE on every server before creating anything", async () => {
    const { dbs, writes } = fakeCluster({
      canCreate: { [TARGET.url]: true, [SHADOW.url]: false },
    })
    const outcome = await ensurePlatformRoles(dbs, BOTH, NAMES)
    expect(outcome).toMatchObject({
      created: [],
      refusal: [
        {
          code: "roles.create-role-denied",
          params: { role: COMMAND, server: "shadow" },
        },
      ],
    })
    expect(writes).toEqual([])
  })

  it("reports a present role of the wrong shape instead of present", async () => {
    const { dbs, writes } = fakeCluster({
      canCreate: { [TARGET.url]: true },
      roles: { [TARGET.url]: [row({ attributes: { login: true } })] },
    })
    const outcome = await ensurePlatformRoles(dbs, [BOTH[0]!], NAMES)
    expect(outcome).toMatchObject({
      refusal: [
        {
          code: "plan.platform-role-shape",
          params: { server: "target", violation: "login" },
        },
      ],
    })
    expect(writes).toEqual([])
  })

  it("reports a violation of the present login role once", async () => {
    // Роль входу звіряють і виняток пари ролі команд, і повна звірка `roles`
    const { dbs } = fakeCluster({
      canCreate: { [TARGET.url]: true },
      roles: {
        [TARGET.url]: [
          commandWith(),
          loginRow({ members: [member(), member({ role: "x", set: true })] }),
        ],
      },
    })
    const outcome = await ensurePlatformRoles(dbs, [BOTH[0]!], WITH_LOGIN)
    expect(
      (outcome.refusal ?? []).map((d) => [d.code, d.params?.violation])
    ).toEqual([["plan.platform-role-shape", "member:x"]])
  })

  it("creates once when target and shadow share a cluster", async () => {
    const { dbs, writes } = fakeCluster({
      canCreate: { [TARGET.url]: true, [SHADOW.url]: true },
      shared: true,
    })
    expect(await ensurePlatformRoles(dbs, BOTH, NAMES)).toEqual({
      created: [
        { server: "target", name: COMMAND, outcome: "created" },
        { server: "shadow", name: COMMAND, outcome: "present" },
      ],
    })
    expect(writes.filter((w) => w.sql.startsWith("CREATE ROLE"))).toEqual([
      { url: TARGET.url, sql: expect.stringContaining("NOLOGIN NOINHERIT") },
    ])
  })

  it.each(["read", "create"] as const)(
    "checks the shape of a role that appeared between the phases (on %s)",
    async (on) => {
      const { dbs } = fakeCluster({
        canCreate: { [TARGET.url]: true },
        appear: { row: row({ attributes: { login: true } }), on },
      })
      expect(await ensurePlatformRoles(dbs, [BOTH[0]!], NAMES)).toMatchObject({
        refusal: [
          {
            code: "plan.platform-role-shape",
            params: { server: "target", violation: "login" },
          },
        ],
      })
    }
  )

  it("creates the login role on the target only, after the grant roles", async () => {
    const { dbs, writes } = fakeCluster({
      canCreate: { [TARGET.url]: true, [SHADOW.url]: true },
      roles: { [TARGET.url]: [row({ name: "authenticated" })] },
      admin: ["authenticated"],
    })
    expect(await ensurePlatformRoles(dbs, BOTH, WITH_LOGIN)).toEqual({
      created: [
        { server: "target", name: COMMAND, outcome: "created" },
        { server: "target", name: RUNTIME, outcome: "created" },
        { server: "shadow", name: COMMAND, outcome: "created" },
      ],
    })
    expect(
      writes.filter((w) => w.url === TARGET.url).map((w) => w.sql)
    ).toEqual(
      expect.arrayContaining([
        `CREATE ROLE ${RUNTIME} LOGIN NOINHERIT`,
        `GRANT ${COMMAND} TO ${RUNTIME} WITH INHERIT FALSE, SET TRUE`,
        `GRANT authenticated TO ${RUNTIME} WITH INHERIT FALSE, SET TRUE`,
      ])
    )
    expect(
      writes.filter((w) => w.url === SHADOW.url).map((w) => w.sql)
    ).not.toContain(`CREATE ROLE ${RUNTIME} LOGIN NOINHERIT`)
  })

  it("refuses the login role without ADMIN on a parent but still creates the grant roles", async () => {
    // Батько поза `names` без ADMIN; `COMMAND` цей виклик створює сам, тож
    // його ADMIN не перевіряється
    const { dbs, writes } = fakeCluster({
      canCreate: { [TARGET.url]: true },
      roles: { [TARGET.url]: [row({ name: "authenticated" })] },
    })
    expect(await ensurePlatformRoles(dbs, [BOTH[0]!], WITH_LOGIN)).toEqual({
      created: [{ server: "target", name: COMMAND, outcome: "created" }],
      refusal: [
        expect.objectContaining({
          code: "roles.admin-option-missing",
          params: { role: "authenticated", server: "target" },
        }),
      ],
    })
    expect(writes.map((w) => w.sql)).toContain(
      `CREATE ROLE ${COMMAND} NOLOGIN NOINHERIT`
    )
    expect(writes.filter((w) => w.sql.includes(RUNTIME))).toEqual([])
  })

  it("refuses the login role when a parent the call does not create is absent", async () => {
    const { dbs, writes } = fakeCluster({ canCreate: { [TARGET.url]: true } })
    expect(
      await ensurePlatformRoles(dbs, [BOTH[0]!], WITH_LOGIN)
    ).toMatchObject({
      refusal: [
        {
          code: "roles.admin-option-missing",
          params: { role: "authenticated" },
        },
      ],
    })
    expect(writes.filter((w) => w.sql.includes(RUNTIME))).toEqual([])
  })

  it("checks ADMIN on a present grant role that is a parent of the login role", async () => {
    const { dbs, writes } = fakeCluster({
      canCreate: { [TARGET.url]: true },
      roles: {
        [TARGET.url]: [
          row({ members: [member()] }),
          row({ name: "authenticated" }),
        ],
      },
      admin: ["authenticated"],
    })
    expect(await ensurePlatformRoles(dbs, [BOTH[0]!], WITH_LOGIN)).toEqual({
      created: [{ server: "target", name: COMMAND, outcome: "present" }],
      refusal: [
        expect.objectContaining({
          code: "roles.admin-option-missing",
          params: { role: COMMAND, server: "target" },
        }),
      ],
    })
    expect(writes.filter((w) => w.sql.includes(RUNTIME))).toEqual([])
  })

  it("refuses an absent login role without CREATEROLE", async () => {
    const { dbs, writes } = fakeCluster({
      canCreate: { [TARGET.url]: false },
      roles: { [TARGET.url]: [row({ members: [member()] })] },
      admin: [COMMAND, "authenticated"],
    })
    expect(
      await ensurePlatformRoles(dbs, [BOTH[0]!], WITH_LOGIN)
    ).toMatchObject({
      refusal: [
        {
          code: "roles.create-role-denied",
          params: { role: RUNTIME, server: "target" },
        },
      ],
    })
    expect(writes).toEqual([])
  })
})
