import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { UsageError } from "../../io/usage-error"
import { introspectTool } from "../database-tools"

/**
 * Межа «чужих» схем береться з провайдера проєкту й перевіряється до доступу
 * до бази: тест без ресурсу бази бачить або `UsageError` (відмова), або
 * помилку відсутньої бази (перевірку пройдено).
 */
async function introspect(
  schemas: string[],
  provider: "supabase" | "postgres"
) {
  const dir = await mkdtemp(join(tmpdir(), "introspect-"))
  return introspectTool.run(
    { dir, root: dir },
    { schemas, project: { database: { provider } } }
  )
}

describe("introspect provider schemas", () => {
  it("postgres refuses better_auth before touching the database", async () => {
    await expect(introspect(["better_auth"], "postgres")).rejects.toThrow(
      UsageError
    )
  })

  it("postgres does not treat auth as a provider schema", async () => {
    await expect(introspect(["auth"], "postgres")).rejects.toThrow(
      /passes the database/
    )
  })

  it("supabase refuses auth", async () => {
    await expect(introspect(["auth"], "supabase")).rejects.toThrow(UsageError)
  })
})
