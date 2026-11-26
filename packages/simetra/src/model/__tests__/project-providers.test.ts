import { describe, expect, expectTypeOf, it } from "vitest"
import {
  DATABASE_PROVIDERS,
  LOGIN_ROLE_PARENTS,
  LOGIN_ROLE_SETTINGS,
  LOGIN_ROLE_REQUEST_PURPOSES,
  PLATFORM_LOGIN_ROLES,
  PLATFORM_ROLES,
  PLATFORM_ROLES_NOT_PURPOSES,
  PROVIDER_API_ROLES,
  PROVIDER_EVENT_SOURCES,
  PROVIDER_EXPRESSION_FUNCTIONS,
  PROVIDER_FUNCTIONS,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
  PROVIDER_SCHEMAS,
  loginRoleParentNames,
  projectSchema,
  type GrantPurpose,
  type PlatformRolePurpose,
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
  [
    "PROVIDER_EXPRESSION_FUNCTIONS",
    PROVIDER_EXPRESSION_FUNCTIONS,
    [
      { name: "extensions.moddatetime", extension: "moddatetime" },
      { name: "extensions.soundex", extension: "fuzzystrmatch" },
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
    expect(LOGIN_ROLE_PARENTS).toEqual({
      runtime: ["command", "files", "request"],
      signals: ["signalConsumer"],
    })
  })

  it("signals: only the signal consumer group in both profiles", () => {
    expect(PLATFORM_ROLES.signalConsumer).toBe("simetra_signal_consumer")
    expect(PLATFORM_LOGIN_ROLES.signals).toBe("simetra_signals")
    for (const provider of ["supabase", "postgres"] as const)
      expect(loginRoleParentNames("signals", provider)).toEqual([
        "simetra_signal_consumer",
      ])
    expect(LOGIN_ROLE_SETTINGS).toEqual({
      signals: { role: "simetra_signal_consumer" },
    })
  })

  it("the consumer and files roles are not grant purposes", () => {
    expectTypeOf<PlatformRolePurpose>().toEqualTypeOf<"command">()
    expectTypeOf<"signalConsumer">().not.toExtend<GrantPurpose>()
    expectTypeOf<"files">().not.toExtend<GrantPurpose>()
    expect(PLATFORM_ROLES_NOT_PURPOSES).toEqual(["signalConsumer", "files"])
  })

  it("postgres: command role, then the request roles", () => {
    expect(loginRoleParentNames("runtime", "postgres")).toEqual([
      "simetra_command",
      "simetra_files",
      "simetra_user",
      "simetra_anon",
    ])
  })

  it("supabase: command role, then the request roles", () => {
    expect(loginRoleParentNames("runtime", "supabase")).toEqual([
      PLATFORM_ROLES.command,
      PLATFORM_ROLES.files,
      "authenticated",
      "anon",
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

describe("projectSchema selfSignUp", () => {
  it.each([
    ["absent", undefined, true, undefined],
    ["true", true, true, true],
    ["false", false, true, false],
    ["a string", "true", false, undefined],
    ["a number", 1, false, undefined],
    ["null", null, false, undefined],
  ])("%s", (_name, value, ok, expected) => {
    const result = projectSchema.safeParse({
      name: "App",
      database: { provider: "postgres" },
      ...(value === undefined ? {} : { selfSignUp: value }),
    })
    expect(result.success).toBe(ok)
    if (result.success) expect(result.data.selfSignUp).toBe(expected)
  })
})
