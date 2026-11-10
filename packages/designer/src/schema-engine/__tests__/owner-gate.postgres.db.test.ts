import { withDatabaseName } from "@supabase/pg-delta"
import pg from "pg"
import { canonicalSnapshot, compile } from "simetra/compiler"
import {
  buildPlan,
  ensurePostgresCluster,
  executePlan,
  type PlanArtifact,
  type PostgresClusterSet,
} from "simetra/schema"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  dropTaggedCluster,
  prepareStackIdentity,
  readReferenceDomain,
  roleUrl,
  setTestPasswords,
  taggedClusterSet,
  testSuperuserUrl,
} from "../../../../simetra/test/support"
import { createApplyDatabase, createPgDeltaEngine } from ".."

/**
 * Гейт `plan.owner-not-bypassrls` (Р10) на живому кластері профілю
 * `postgres`. DB-рівень, бо атрибути ролі (`rolbypassrls`) і їх зміну між
 * планом і застосуванням бачить лише сервер.
 */
const set: PostgresClusterSet = taggedClusterSet("ownergate")
const superuserUrl = testSuperuserUrl()
const engine = createPgDeltaEngine()
const dbs = {
  reader: createApplyDatabase({ readOnly: true }),
  scratch: createApplyDatabase({ readOnly: false }),
}
const writer = createApplyDatabase({ readOnly: false })
const targetDb = (): string => withDatabaseName(superuserUrl, set.database)

async function admin<T>(
  url: string,
  fn: (c: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  const result = await ensurePostgresCluster(
    writer,
    {
      maintenance: { url: withDatabaseName(superuserUrl, "postgres") },
      target: { url: targetDb() },
      template: { url: withDatabaseName(superuserUrl, set.template) },
    },
    set
  )
  if (!result.ok)
    throw new Error(`roles refused: ${result.error.map((d) => d.code)}`)
  await setTestPasswords(set)
  await prepareStackIdentity({
    superuserUrl: targetDb(),
    authUrl: roleUrl(set, set.auth),
    auth: set.auth,
    owner: set.owner,
  })
})

afterAll(() => dropTaggedCluster(set))

async function modelOf() {
  const files = readReferenceDomain()
  const project = JSON.parse(files.get("project.meta.json")!) as {
    database: { provider: string }
  }
  project.database.provider = "postgres"
  files.set("project.meta.json", JSON.stringify(project))
  const compiled = await compile(files)
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return compiled.model!
}

const options = (role: string) => ({
  target: { url: roleUrl(set, role) },
  shadowTemplate: set.template,
})

describe("owner gate on the postgres profile", () => {
  // Один сценарій: роль входу без BYPASSRLS, потім власник, що втрачає
  // BYPASSRLS між планом і застосуванням
  it("refuses a plan from a role without BYPASSRLS, and an apply after the owner loses it", async () => {
    const model = await modelOf()
    // Роль `auth` профілю створена без BYPASSRLS (її атрибути задає `roles`)
    const refused = await buildPlan(engine, dbs, model, options(set.auth), [])
    expect(refused.status).toBe("refused")
    expect(refused.diagnostics.map((d) => d.code)).toContain(
      "plan.owner-not-bypassrls"
    )

    const planned = await buildPlan(engine, dbs, model, options(set.owner), [])
    if (planned.status !== "planned")
      throw new Error(
        `${planned.status}: ${planned.diagnostics.map((d) => d.code).join(",")}`
      )
    const artifact: PlanArtifact = planned.artifact

    await admin(targetDb(), (c) =>
      c.query(`alter role "${set.owner}" nobypassrls`)
    )
    const outcome = await executePlan(
      writer,
      { url: roleUrl(set, set.owner) },
      artifact,
      {
        mode: "apply",
        planHash: artifact.planHash,
        allow: artifact.requiredPermissions,
        snapshot: canonicalSnapshot(model),
      }
    )
    expect(outcome).toMatchObject({
      status: "refused",
      diagnostics: [{ code: "plan.owner-not-bypassrls" }],
    })
    // Ні кроку, ні маркера, ні ledger
    await admin(targetDb(), async (c) => {
      const found = await c.query<{ found: string | null }>(
        "select to_regclass('simetra.marker')::text as found"
      )
      expect(found.rows[0]?.found).toBeNull()
    })
  })
})
