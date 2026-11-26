import { afterEach, describe, expect, it, vi } from "vitest"
import { agentOauthKeys } from "../../template/src/server/config"
import {
  appServerEnv,
  authSchemaSql,
  connectPrivilegeSql,
} from "./app-database.mts"

describe("connectPrivilegeSql", () => {
  const sql = connectPrivilegeSql("app_db", ["a", "b"])

  it("revokes CONNECT from PUBLIC before any grant", () => {
    expect(sql[0]).toBe('REVOKE CONNECT ON DATABASE "app_db" FROM PUBLIC')
  })

  it("grants CONNECT to exactly the given roles and never to PUBLIC", () => {
    expect(sql.slice(1)).toEqual([
      'GRANT CONNECT ON DATABASE "app_db" TO "a"',
      'GRANT CONNECT ON DATABASE "app_db" TO "b"',
    ])
    expect(sql.filter((s) => /^GRANT.*PUBLIC/i.test(s))).toEqual([])
  })
})

describe("authSchemaSql", () => {
  it("creates every schema of the auth role, owned by it, as roles does", () => {
    expect(authSchemaSql("simetra_auth")).toEqual([
      'CREATE SCHEMA IF NOT EXISTS "better_auth" AUTHORIZATION "simetra_auth"',
      'CREATE SCHEMA IF NOT EXISTS "agent_oauth" AUTHORIZATION "simetra_auth"',
    ])
  })
})

describe("appServerEnv", () => {
  const dsns = {
    SIMETRA_SUPERUSER_DATABASE_URL: "postgres://su@h/db",
    SIMETRA_OWNER_DATABASE_URL: "postgres://o@h/db",
    SIMETRA_AUTH_DATABASE_URL: "postgres://a@h/db",
    SIMETRA_RUNTIME_DATABASE_URL: "postgres://r@h/db",
  }
  const env = () =>
    appServerEnv({
      dsns,
      origin: "http://127.0.0.1:4000",
      port: 4000,
      host: "127.0.0.1",
      secret: "s",
    })

  afterEach(() => vi.unstubAllEnvs())

  it("carries agent authorization server keys that the production start accepts (Р-F4-1)", () => {
    const e = env()
    expect(e.NODE_ENV).toBe("production")
    for (const [k, v] of Object.entries(e)) vi.stubEnv(k, v)
    expect(agentOauthKeys()).toMatchObject({
      signingKey: { kty: "OKP", crv: "Ed25519" },
    })
  })

  it("generates new keys per stand", () => {
    const a = env()
    const b = env()
    expect(a.SIMETRA_AGENT_OAUTH_SIGNING_KEY).not.toBe(
      b.SIMETRA_AGENT_OAUTH_SIGNING_KEY
    )
    expect(a.SIMETRA_AGENT_OAUTH_COOKIE_KEYS).not.toBe(
      b.SIMETRA_AGENT_OAUTH_COOKIE_KEYS
    )
  })
})
