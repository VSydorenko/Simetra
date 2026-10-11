import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  APPLY_STATE_FORMAT,
  compareWithDesired,
  desiredForApply,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  PLATFORM_VERSION,
  readApplyState,
  writeApplyStateStatements,
  type ApplyRecord,
  type ApplyState,
  type CatalogFingerprint,
  type FingerprintSection,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  catalog,
  metaFiles,
  project,
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../../simetra/test/support"

/**
 * Стан застосування в схемі `simetra` (план П3-1, задача 5): DDL marker і
 * ledger, їх читання й запис. Ціль кожного тесту — окрема база від
 * `withDesiredShadow`; база стеку лише читається.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

async function partyModel(): Promise<CompiledModel> {
  const compiled = await compile(
    metaFiles({
      "project.meta.json": project(),
      "catalogs/Party/Party.meta.json": catalog("Party"),
    })
  )
  expect(compiled.diagnostics).toEqual([])
  return compiled.model!
}

/** Ціль із бажаним станом застосування моделі без «Користувачів». */
async function inAppliedTarget<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const desired = await desiredForApply(await partyModel())
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    desired.sql,
    desired.scope,
    (target) => fn(target.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

const read = (url: string): Promise<ApplyState> =>
  createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    readApplyState
  )

const write = (url: string, sql: string): Promise<void> =>
  createApplyDatabase({ readOnly: false }).transaction(
    { url },
    "commit",
    async (tx) => {
      await tx.query(sql)
    }
  )

function fingerprint(tag: string): CatalogFingerprint {
  return {
    version: FINGERPRINT_VERSION,
    sections: Object.fromEntries(
      FINGERPRINT_SECTIONS.map((s) => [s, `${tag}-${s}`])
    ) as Record<FingerprintSection, string>,
  }
}

const record: ApplyRecord = {
  planHash: "p".repeat(64),
  fromHash: null,
  toHash: "t".repeat(64),
  snapshot: { tables: [{ schema: "app", name: "party" }] },
  scope: { schemas: ["app", "simetra"], provider: "supabase" },
  catalog: {
    tables: [],
    enumTypes: [],
    units: [
      {
        class: "view",
        identity: "view:app.v",
        schema: "app",
        name: "v",
        sql: "CREATE VIEW app.v AS SELECT 1",
      },
    ],
  },
  engine: { name: "pg-delta", version: "1.0.0-alpha.56" },
  targetFingerprint: fingerprint("target"),
  resultFingerprint: fingerprint("result"),
  allow: ["drop:table:app.old"],
  applyId: "6f1c1e8e-3d7a-4c3e-9f55-0b7f0a2d9c11",
}

async function applied(url: string): Promise<void> {
  await createApplyDatabase({ readOnly: false }).transaction(
    { url },
    "commit",
    async (tx) => {
      for (const s of writeApplyStateStatements(record))
        await tx.query(s.sql, s.params)
    }
  )
}

describe("desiredForApply", () => {
  it("loads into a shadow and reconciles with itself", async () => {
    const model = await partyModel()
    const desired = await desiredForApply(model)
    expect(desired.scope.schemas).toContain("simetra")
    const result = await inAppliedTarget((url) =>
      compareWithDesired(
        engine,
        { target: { url } },
        desired.sql,
        desired.scope,
        desired.diagnostics
      )
    )
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    expect(result.plan.actions).toEqual([])
    expect(result.differences).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.empty).toBe(true)
  })
})

describe("readApplyState", () => {
  it("is fresh on a database without the state tables", async () => {
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      "create schema app;",
      { schemas: ["app"], provider: "supabase" },
      (target) => read(target.url)
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    expect(outcome.value).toEqual({ status: "fresh" })
  })

  it("is fresh while both state tables are empty", async () => {
    expect(await inAppliedTarget(read)).toEqual({ status: "fresh" })
  })

  it("reads back what was written", async () => {
    const state = await inAppliedTarget(async (url) => {
      await applied(url)
      return read(url)
    })
    expect(state).toEqual({
      status: "applied",
      marker: {
        format: APPLY_STATE_FORMAT,
        snapshotHash: record.toHash,
        scope: record.scope,
        catalog: record.catalog,
        engine: record.engine,
        fingerprint: record.resultFingerprint,
        platformVersion: PLATFORM_VERSION,
        planHash: record.planHash,
      },
    })
  })

  it("a second apply replaces the marker and appends to the ledger", async () => {
    const rows = await inAppliedTarget(async (url) => {
      await applied(url)
      await createApplyDatabase({ readOnly: false }).transaction(
        { url },
        "commit",
        async (tx) => {
          const next = writeApplyStateStatements({
            ...record,
            fromHash: record.toHash,
            toHash: "u".repeat(64),
            applyId: "0d9e3a52-5b8f-4f0e-8a54-2c1f2f7b6a90",
          })
          for (const s of next) await tx.query(s.sql, s.params)
        }
      )
      return createApplyDatabase({ readOnly: true }).transaction(
        { url },
        "rollback",
        async (tx) => ({
          marker: await tx.query<{ snapshot_hash: string }>(
            "SELECT snapshot_hash FROM simetra.marker"
          ),
          ledger: await tx.query<{ from_hash: string | null }>(
            "SELECT from_hash FROM simetra.ledger ORDER BY id"
          ),
        })
      )
    })
    expect(rows.marker).toEqual([{ snapshot_hash: "u".repeat(64) }])
    expect(rows.ledger).toEqual([
      { from_hash: null },
      { from_hash: record.toHash },
    ])
  })

  it("a ledger without a marker is corrupt, not fresh", async () => {
    const state = await inAppliedTarget(async (url) => {
      await applied(url)
      await write(url, "DELETE FROM simetra.marker")
      return read(url)
    })
    expect(state.status).toBe("corrupt")
    if (state.status !== "corrupt") return
    expect(state.diagnostic).toMatchObject({
      code: "apply.ledger-without-marker",
      severity: "error",
    })
  })

  it("an unknown state format is corrupt", async () => {
    const state = await inAppliedTarget(async (url) => {
      await applied(url)
      await write(url, "UPDATE simetra.marker SET format = 99")
      return read(url)
    })
    expect(state.status).toBe("corrupt")
    if (state.status !== "corrupt") return
    expect(state.diagnostic).toMatchObject({
      code: "apply.state-format",
      severity: "error",
      params: { found: 99 },
    })
    expect(state.diagnostic.message).toContain("99")
  })
})
