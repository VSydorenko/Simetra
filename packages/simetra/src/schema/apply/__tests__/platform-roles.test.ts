import { describe, expect, it } from "vitest"
import { compile, loadSqlParser } from "simetra/compiler"
import { PLATFORM_ROLES } from "simetra/model"
import {
  desiredForApply,
  ensurePlatformRoles,
  platformRoleRefusals,
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

const row = (
  over: {
    attributes?: Partial<PlatformRoleRow["attributes"]>
    memberOf?: string[]
    members?: Member[]
  } = {}
): PlatformRoleRow => ({
  name: PLATFORM_ROLES.command,
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
})

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
      case: "member-of",
      found: [row({ memberOf: ["authenticated"] })],
      codes: ["plan.platform-role-shape"],
      violation: "member-of:authenticated",
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
}): { dbs: ApplyDatabase; writes: { url: string; sql: string }[] } {
  const roles = new Map<string, PlatformRoleRow[]>(
    Object.entries(o.roles ?? {})
  )
  const clusterOf = (url: string) => (o.shared === true ? "cluster" : url)
  const writes: { url: string; sql: string }[] = []
  const dbs: ApplyDatabase = {
    transaction: async (db, end, fn) =>
      fn({
        query: async <R extends Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[]
        ) => {
          const key = clusterOf(db.url)
          if (sql.includes("rolcreaterole OR"))
            return [{ allowed: o.canCreate[db.url] ?? false }] as unknown as R[]
          if (sql.includes("pg_auth_members")) {
            const names = params?.[0] as string[]
            return (roles.get(key) ?? []).filter((r) =>
              names.includes(r.name)
            ) as unknown as R[]
          }
          if (end !== "commit")
            throw new Error(`write in a read transaction: ${sql}`)
          writes.push({ url: db.url, sql })
          const created = /^CREATE ROLE "?([a-z_]+)"?/.exec(sql)
          if (created !== null)
            roles.set(key, [
              ...(roles.get(key) ?? []),
              row({ members: [member()] }),
            ])
          return [] as R[]
        },
        extract: () => Promise.reject(new Error("no extract expected")),
      }),
  }
  return { dbs, writes }
}

const TARGET = { url: "postgres://target" }
const SHADOW = { url: "postgres://shadow" }
const BOTH = [
  { server: "target" as const, db: TARGET },
  { server: "shadow" as const, db: SHADOW },
]

describe("ensurePlatformRoles", () => {
  it("checks CREATEROLE on every server before creating anything", async () => {
    const { dbs, writes } = fakeCluster({
      canCreate: { [TARGET.url]: true, [SHADOW.url]: false },
    })
    const outcome = await ensurePlatformRoles(dbs, BOTH, [
      PLATFORM_ROLES.command,
    ])
    expect(outcome).toMatchObject({
      refusal: [
        {
          code: "roles.create-role-denied",
          params: { role: PLATFORM_ROLES.command, server: "shadow" },
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
    const outcome = await ensurePlatformRoles(
      dbs,
      [BOTH[0]!],
      [PLATFORM_ROLES.command]
    )
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

  it("creates once when target and shadow share a cluster", async () => {
    const { dbs, writes } = fakeCluster({
      canCreate: { [TARGET.url]: true, [SHADOW.url]: true },
      shared: true,
    })
    expect(
      await ensurePlatformRoles(dbs, BOTH, [PLATFORM_ROLES.command])
    ).toEqual([
      { server: "target", name: PLATFORM_ROLES.command, outcome: "created" },
      { server: "shadow", name: PLATFORM_ROLES.command, outcome: "present" },
    ])
    expect(writes.filter((w) => w.sql.startsWith("CREATE ROLE"))).toEqual([
      { url: TARGET.url, sql: expect.stringContaining("NOLOGIN NOINHERIT") },
    ])
  })
})
