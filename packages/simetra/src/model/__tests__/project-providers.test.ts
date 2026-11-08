import { describe, expect, it } from "vitest"
import {
  DATABASE_PROVIDERS,
  LOGIN_ROLE_PARENTS,
  LOGIN_ROLE_REQUEST_PURPOSES,
  PLATFORM_LOGIN_ROLES,
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_EVENT_SOURCES,
  PROVIDER_EXPRESSION_FUNCTIONS,
  PROVIDER_FUNCTIONS,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
  PROVIDER_SCHEMAS,
  PROVIDER_SQL_TEXT_FUNCTIONS,
  loginRoleParentNames,
  projectSchema,
} from "simetra/model"

// Значення `postgres` — таблиця «Значення пресету `postgres`» спеки профілю
// postgres §4.2 і ролі §3.1.
const POSTGRES_ROWS = [
  [
    "PROVIDER_API_ROLES",
    PROVIDER_API_ROLES,
    {
      user: "simetra_user",
      anonymous: "simetra_anon",
      service: null,
    },
  ],
  [
    "LOGIN_ROLE_REQUEST_PURPOSES",
    LOGIN_ROLE_REQUEST_PURPOSES,
    ["user", "anonymous"],
  ],
  ["PROVIDER_LOGIN_ROLES", PROVIDER_LOGIN_ROLES, ["simetra_auth"]],
  ["PROVIDER_OWNER_ROLES", PROVIDER_OWNER_ROLES, "simetra_owner"],
  [
    "PROVIDER_SCHEMAS",
    PROVIDER_SCHEMAS,
    ["better_auth", "extensions", "information_schema"],
  ],
  ["PROVIDER_FUNCTIONS", PROVIDER_FUNCTIONS, []],
  ["PROVIDER_EXPRESSION_FUNCTIONS", PROVIDER_EXPRESSION_FUNCTIONS, []],
  [
    "PROVIDER_SQL_TEXT_FUNCTIONS",
    PROVIDER_SQL_TEXT_FUNCTIONS,
    [
      "extensions.dblink",
      "extensions.dblink_exec",
      "extensions.dblink_send_query",
      "extensions.dblink_open",
    ],
  ],
  [
    "PROVIDER_IDENTITY_SOURCES",
    PROVIDER_IDENTITY_SOURCES,
    {
      table: { schema: "better_auth", name: "user" },
      keyColumn: "id",
      nameSources: [{ column: "name" }, { column: "email" }],
      anonymousColumn: "isAnonymous",
      providerKey: "better-auth",
      subjectIsUserId: true,
      anonymousClaim: "is_anonymous",
    },
  ],
] as const

describe("provider maps of T0", () => {
  it("DATABASE_PROVIDERS lists both profiles", () => {
    expect(DATABASE_PROVIDERS).toEqual(["supabase", "postgres"])
  })

  it.each(POSTGRES_ROWS)("%s has the postgres row", (_, map, expected) => {
    expect((map as Record<string, unknown>).postgres).toEqual(expected)
  })

  it("identity source has no soft-delete column", () => {
    expect(PROVIDER_IDENTITY_SOURCES.postgres).not.toHaveProperty(
      "deletedAtColumn"
    )
  })

  it("event sources: better_auth.user in the column order of the real migration", () => {
    expect(PROVIDER_EVENT_SOURCES.postgres).toEqual([
      {
        schema: "better_auth",
        table: "user",
        columns: [
          "id",
          "name",
          "email",
          "emailVerified",
          "image",
          "createdAt",
          "updatedAt",
          "isAnonymous",
        ],
      },
    ])
  })

  it("every provider has an owner role", () => {
    expect(PROVIDER_OWNER_ROLES).toEqual({
      supabase: "postgres",
      postgres: "simetra_owner",
    })
  })
})

describe("login role parents", () => {
  it("runtime may be a member of the command role and the request roles", () => {
    expect(LOGIN_ROLE_PARENTS).toEqual({ runtime: ["command", "request"] })
  })

  it("postgres: command role, then the request roles", () => {
    expect(loginRoleParentNames("runtime", "postgres")).toEqual([
      "simetra_command",
      "simetra_user",
      "simetra_anon",
    ])
  })

  it("supabase: as the login role was composed before", () => {
    expect(loginRoleParentNames("runtime", "supabase")).toEqual([
      PLATFORM_ROLES.command,
      "authenticated",
    ])
    expect(PLATFORM_LOGIN_ROLES.runtime).toBe("simetra_runtime")
  })
})

describe("projectSchema database.provider", () => {
  it.each(["supabase", "postgres"])("accepts %s", (provider) => {
    expect(
      projectSchema.parse({ name: "App", database: { provider } }).database
    ).toEqual({ provider })
  })

  it("rejects an unknown provider", () => {
    expect(() =>
      projectSchema.parse({ name: "App", database: { provider: "mysql" } })
    ).toThrow()
  })
})
