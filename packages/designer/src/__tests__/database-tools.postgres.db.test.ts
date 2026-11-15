import { describe, expect, it } from "vitest"
import { testDatabaseUrl } from "../../../simetra/test/support"
import {
  call,
  errors,
  introspected,
  options,
  useDatabaseToolsCleanup,
} from "./database-tools.support"

/**
 * Напарник кейса `diff` з окремим сервером тіні
 * (`database-tools.supabase.db.test.ts`): профіль `postgres` будує тінь із
 * шаблону бази цілі, тож `--shadow-url-env` відмовляється, а ціль лишається
 * недоторканою.
 */

useDatabaseToolsCleanup()

describe("sessions", () => {
  it("a shadow on another server is refused with the postgres profile", async () => {
    await introspected(async (dir, env) => {
      const r = await call(
        "diff",
        {},
        options(dir, { ...env, SHADOW_URL: testDatabaseUrl() }, "SHADOW_URL")
      )
      expect(errors(r)).toEqual([])
      expect(r.data).toBeUndefined()
      expect(r.refusal?.message).toContain(
        "A separate shadow server is not supported with the postgres profile"
      )
    })
  })
})
