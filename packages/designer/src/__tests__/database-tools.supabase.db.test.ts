import { describe, expect, it } from "vitest"
import type { DiffData } from "../tools/database-tools"
import { testDatabaseUrl } from "../../../simetra/test/support"
import {
  call,
  errors,
  introspected,
  options,
  useDatabaseToolsCleanup,
} from "./database-tools.support"

/**
 * Кейс `diff`, прив'язаний до Supabase: окремий сервер тіні дозволений лише
 * там; профіль `postgres` будує тінь із шаблону бази цілі й відмовляє
 * (`database-tools.postgres.db.test.ts`).
 */

useDatabaseToolsCleanup()

describe("sessions", () => {
  it("a shadow on another server of the same major version is accepted", async () => {
    // Другий сервер тієї самої версії локально — той самий стек під іншою
    // змінною: шлях `--shadow-url-env` проходить повністю
    await introspected(async (dir, env) => {
      const r = await call(
        "diff",
        {},
        options(dir, { ...env, SHADOW_URL: testDatabaseUrl() }, "SHADOW_URL")
      )
      expect(errors(r)).toEqual([])
      expect((r.data as DiffData).empty).toBe(true)
    })
  })
})
