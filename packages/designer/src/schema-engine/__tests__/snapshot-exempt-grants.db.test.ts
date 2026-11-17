import { describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import { PLATFORM_ROLES } from "simetra/model"
import {
  readReferenceDomain,
  testProvider,
} from "../../../../simetra/test/support"
import { query } from "../../__tests__/support/db"
import {
  applyArtifact,
  EMPTY,
  establish,
  inTarget,
  plan,
  planned,
  useBuildPlanRoles,
} from "./build-plan.support"

/**
 * Живий грант запису на таблицю-виняток знімка актора (спека прав §7),
 * виданий поза SQL застосунку. Компілятор його не бачить, тож тримає гейт
 * дрейфу: грант — дрейф секції `acl`, а план знімає його кроком `REVOKE`, і
 * після застосування роль команд у виняток не пише. Виняток —
 * `simetra.identities` еталонного домену з функціями прав.
 */

useBuildPlanRoles()

const COMMAND = PLATFORM_ROLES.command
const IDENTITIES = "simetra.identities"

async function referenceModel(): Promise<CompiledModel> {
  const files = readReferenceDomain()
  const project = JSON.parse(files.get("project.meta.json")!) as {
    database: { provider: string }
  }
  project.database.provider = testProvider()
  files.set("project.meta.json", JSON.stringify(project))
  const compiled = await compile(files)
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  // Без каталогів прав знімка актора немає, і `identities` не виняток
  expect(compiled.model!.contracts.rightsCatalogs.length).toBeGreaterThan(0)
  return compiled.model!
}

/** Чи може роль команд писати виняток — з урахуванням `PUBLIC`. */
const commandWrites = async (url: string) =>
  (
    await query<{ writes: boolean }>(
      url,
      `select has_table_privilege($1, $2, 'INSERT, UPDATE, DELETE, TRUNCATE') as writes`,
      [COMMAND, IDENTITIES]
    )
  )[0]!.writes

describe.concurrent("live write grants on a snapshot-exempt table", () => {
  it.each([
    ["the command role", COMMAND, `"${COMMAND}"`],
    ["PUBLIC", "public", "PUBLIC"],
  ])(
    "takes a grant to %s as drift and revokes it",
    async (_name, grantee, revoked) => {
      const model = await referenceModel()
      await inTarget(EMPTY, async (url) => {
        await establish(url, model)
        await query(url, `grant insert on ${IDENTITIES} to ${grantee}`)
        expect(await commandWrites(url)).toBe(true)
        const outcome = await plan(url, model)
        const artifact = planned(outcome)
        expect(artifact.drift).toMatchObject({
          reason: "drift",
          sections: ["acl"],
        })
        expect(artifact.steps.map((s) => s.sql)).toContain(
          `REVOKE ALL ON TABLE "simetra"."identities" FROM ${revoked}`
        )
        await applyArtifact(url, artifact, model)
        expect(await commandWrites(url)).toBe(false)
      })
    }
  )
})
