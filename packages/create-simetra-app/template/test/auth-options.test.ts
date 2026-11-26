import { getAuthTables } from "better-auth/db"
import type { Pool } from "pg"
import { describe, expect, it } from "vitest"
import { authOptions } from "../src/server/auth"
import type { MailTransport } from "../src/server/mail"
import { authSchemaOptions } from "../scripts/auth-options.mjs"

// `db-setup` мігрує схему за опціями скрипта, а рантайм працює за
// `src/server/auth.ts`: розбіжність у формі схеми лишила б рантайм без
// таблиці (так було з `rateLimit`).
const pool = {} as Pool
const ORIGIN = "https://app.test"
const mail: MailTransport = { send: () => Promise.resolve() }
// Усі плагіни рантайму: `emailOTP` додається лише з `email-code`
const runtimeOptions = authOptions(
  pool,
  ORIGIN,
  "secret",
  { signUp: "closed", password: true, emailCode: true, providers: [] },
  mail
)

/** Форма схеми: таблиця → її колонки. */
function shape(options: Parameters<typeof getAuthTables>[0]) {
  return Object.fromEntries(
    Object.entries(getAuthTables(options))
      .map(([key, table]) => [
        `${key}:${table.modelName}`,
        Object.entries(table.fields)
          .map(([field, attribute]) => `${field}:${attribute.type}`)
          .sort(),
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  )
}

describe("script Better Auth options", () => {
  const runtime = shape(runtimeOptions)

  it("shape the same schema as the runtime options", () => {
    expect(
      shape(authSchemaOptions(pool, { origin: ORIGIN, secret: "secret" }))
    ).toEqual(runtime)
    expect(
      shape(
        authSchemaOptions(pool, {
          origin: ORIGIN,
          secret: "secret",
          signUp: true,
        })
      )
    ).toEqual(runtime)
  })

  it("include the rate-limit table that the runtime limiter uses", () => {
    expect(Object.keys(runtime).some((k) => k.startsWith("rateLimit"))).toBe(
      true
    )
  })
})
