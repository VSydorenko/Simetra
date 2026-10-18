import { describe, expect, it } from "vitest"
import {
  canonicalSnapshot,
  compile,
  promotionRecordHash,
  type CompiledModel,
  type PromotionRecord,
} from "simetra/compiler"
import {
  APPLY_STATE_FORMAT,
  buildPlan,
  compareWithDesired,
  desiredForApply,
  executePlan,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  PLATFORM_VERSION,
  readApplyState,
  readAppliedPromotions,
  readLedgerHead,
  writeApplyStateStatements,
  type ApplyRecord,
  type ApplyState,
  type CatalogFingerprint,
  type DriftReport,
  type FingerprintSection,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  catalog,
  metaFiles,
  project,
  testDatabaseUrl,
} from "../../../../simetra/test/support"
import { inTarget } from "../../__tests__/support/db"

/**
 * Стан застосування в схемі `simetra` (план П3-1, задача 5): DDL marker і
 * ledger, їх читання й запис. Ціль кожного тесту — окрема база від
 * `withDesiredShadow`; база стеку лише читається.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

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

/**
 * Ціль із бажаним станом застосування моделі без «Користувачів». Обгортка над
 * спільним `inTarget`: бажаний SQL і межу дає модель, а не викликач.
 */
async function inAppliedTarget<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const desired = await desiredForApply(await partyModel())
  return inTarget(desired.sql, desired.scope, fn)
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
  drift: null,
  promotion: null,
  rehearsalHash: null,
  applyId: "6f1c1e8e-3d7a-4c3e-9f55-0b7f0a2d9c11",
}

const RECORD: PromotionRecord = {
  format: 1,
  base: "0".repeat(64),
  result: "1".repeat(64),
  objectId: "00000000-0000-4000-8000-000000000001",
  kind: "Catalog",
  tables: [],
  columns: [],
  typeChanges: [],
  dataSteps: [],
  retired: [],
  relaxed: [],
  tightened: [],
  rowLevelSecurity: [],
  deleteSemantics: [],
  conversions: [],
  movedUnits: [],
  rewrittenUnits: [],
  contractChanges: [],
}

/** Дрейф, прийнятий другим застосуванням тесту ledger. */
const drift: DriftReport = {
  reason: "drift",
  sections: ["owner", "relations"],
  paths: ["tables.app.party.columns.note"],
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
        snapshot: record.snapshot,
        scope: record.scope,
        catalog: record.catalog,
        engine: record.engine,
        fingerprint: record.resultFingerprint,
        platformVersion: PLATFORM_VERSION,
        planHash: record.planHash,
      },
    })
  })

  it("a second apply replaces the marker and appends to the ledger, with the accepted drift", async () => {
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
            allow: ["drift"],
            drift,
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
          // Текстом, як і marker: розбір не залежить від типів адаптера;
          // SQL NULL лишається `null`, а JSON null дав би рядок "null"
          ledger: await tx.query<{
            from_hash: string | null
            allowed: string
            drift: string | null
          }>(
            "SELECT from_hash, allowed::text AS allowed, drift::text AS drift FROM simetra.ledger ORDER BY id"
          ),
        })
      )
    })
    expect(rows.marker).toEqual([{ snapshot_hash: "u".repeat(64) }])
    expect(
      rows.ledger.map((r) => ({
        from_hash: r.from_hash,
        allowed: JSON.parse(r.allowed) as unknown,
        drift: r.drift === null ? null : (JSON.parse(r.drift) as unknown),
      }))
    ).toEqual([
      { from_hash: null, allowed: record.allow, drift: null },
      { from_hash: record.toHash, allowed: ["drift"], drift },
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

describe("readLedgerHead", () => {
  const head = (url: string): Promise<string | null> =>
    createApplyDatabase({ readOnly: true }).transaction(
      { url },
      "rollback",
      readLedgerHead
    )

  it("reads the head of the ledger", async () => {
    const second = "0d9e3a52-5b8f-4f0e-8a54-2c1f2f7b6a90"
    const heads = await inAppliedTarget(async (url) => {
      // Таблиці стану є, але порожні
      const empty = await head(url)
      await applied(url)
      const first = await head(url)
      await createApplyDatabase({ readOnly: false }).transaction(
        { url },
        "commit",
        async (tx) => {
          for (const s of writeApplyStateStatements({
            ...record,
            fromHash: record.toHash,
            toHash: "u".repeat(64),
            applyId: second,
          }))
            await tx.query(s.sql, s.params)
        }
      )
      return { empty, first, last: await head(url) }
    })
    expect(heads).toEqual({
      empty: null,
      first: record.applyId,
      last: second,
    })
    // База без стану — `null`, без помилки відсутньої таблиці
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      "create schema app;",
      { schemas: ["app"], provider: "supabase" },
      (target) => head(target.url)
    )
    expect(outcome).toMatchObject({ status: "loaded", value: null })
  })
})

describe("readAppliedPromotions", () => {
  const promotions = (url: string): Promise<Set<string>> =>
    createApplyDatabase({ readOnly: true }).transaction(
      { url },
      "rollback",
      readAppliedPromotions
    )

  it("is empty on a ledger without the promotion column", async () => {
    const hashes = await inAppliedTarget(async (url) => {
      await applied(url)
      // Форма ledger до промоцій
      await write(url, "ALTER TABLE simetra.ledger DROP COLUMN promotion")
      return promotions(url)
    })
    expect(hashes).toEqual(new Set())
  })

  it("is empty when no applied plan carried a promotion", async () => {
    const hashes = await inAppliedTarget(async (url) => {
      await applied(url)
      return promotions(url)
    })
    expect(hashes).toEqual(new Set())
  })

  it("is empty on a database without the state tables", async () => {
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      "create schema app;",
      { schemas: ["app"], provider: "supabase" },
      (target) => promotions(target.url)
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    expect(outcome.value).toEqual(new Set())
  })

  it("reads the hashes of applied promotion records", async () => {
    const promotion = { hash: "h".repeat(64), record: RECORD }
    const stored = await inAppliedTarget(async (url) => {
      await createApplyDatabase({ readOnly: false }).transaction(
        { url },
        "commit",
        async (tx) => {
          for (const s of writeApplyStateStatements({ ...record, promotion }))
            await tx.query(s.sql, s.params)
        }
      )
      return {
        hashes: await promotions(url),
        row: await createApplyDatabase({ readOnly: true }).transaction(
          { url },
          "rollback",
          (tx) =>
            tx.query<{ promotion: string }>(
              "SELECT promotion::text AS promotion FROM simetra.ledger"
            )
        ),
      }
    })
    expect(stored.hashes).toEqual(new Set(["h".repeat(64)]))
    expect(stored.row.map((r) => JSON.parse(r.promotion) as unknown)).toEqual([
      promotion,
    ])
  })

  // Рішення 11 плану П3-2a: колонку додає той самий план, що пише стан
  it("adds the column to an older ledger in the same plan that records the promotion", async () => {
    const model = await partyModel()
    const outcome = await inAppliedTarget(async (url) => {
      await write(url, "ALTER TABLE simetra.ledger DROP COLUMN promotion")
      const plan = await buildPlan(
        engine,
        {
          reader: createApplyDatabase({ readOnly: true }),
          scratch: createApplyDatabase({ readOnly: false }),
        },
        model,
        { target: { url } },
        []
      )
      if (plan.status !== "planned")
        throw new Error(
          `expected planned, got ${plan.status}: ${plan.diagnostics.map((d) => d.message).join("; ")}`
        )
      const { artifact } = plan
      // `COMMIT` промоції до П3-2b відхиляється (рішення 12), а прогін
      // `proof` комітить: ним рядок ledger і пишеться
      const run = await executePlan(
        createApplyDatabase({ readOnly: false }),
        { url },
        {
          ...artifact,
          promotion: {
            recordHash: await promotionRecordHash(RECORD),
            record: RECORD,
            permissionItems: [],
            preservation: [],
            columns: [],
            canonicalNames: [],
            conversions: [],
            data: [],
          },
        },
        {
          mode: "proof",
          planHash: artifact.planHash,
          allow: artifact.requiredPermissions,
          snapshot: canonicalSnapshot(model),
        }
      )
      return { artifact, run, hashes: await promotions(url) }
    })
    expect(outcome.artifact.steps.map((s) => s.sql)).toContainEqual(
      expect.stringMatching(
        /^ALTER TABLE "?simetra"?\."?ledger"? ADD COLUMN "?promotion"? jsonb$/
      )
    )
    expect(outcome.run).toMatchObject({ status: "committed" })
    expect(outcome.hashes).toEqual(new Set([await promotionRecordHash(RECORD)]))
  })

  // Рішення 7 плану П3-2b-3: колонку хешу звіту додає той самий план, що
  // пише стан; план без промоції пише SQL NULL
  it("adds the rehearsal column to an older ledger in an applied plan", async () => {
    const model = await partyModel()
    const outcome = await inAppliedTarget(async (url) => {
      await write(url, "ALTER TABLE simetra.ledger DROP COLUMN rehearsal_hash")
      const plan = await buildPlan(
        engine,
        {
          reader: createApplyDatabase({ readOnly: true }),
          scratch: createApplyDatabase({ readOnly: false }),
        },
        model,
        { target: { url } },
        []
      )
      if (plan.status !== "planned")
        throw new Error(
          `expected planned, got ${plan.status}: ${plan.diagnostics.map((d) => d.message).join("; ")}`
        )
      const { artifact } = plan
      expect(artifact.promotion).toBeNull()
      const run = await executePlan(
        createApplyDatabase({ readOnly: false }),
        { url },
        artifact,
        {
          mode: "apply",
          planHash: artifact.planHash,
          allow: artifact.requiredPermissions,
          snapshot: canonicalSnapshot(model),
        }
      )
      const rows = await createApplyDatabase({ readOnly: true }).transaction(
        { url },
        "rollback",
        (tx) =>
          tx.query<{ hash: string | null }>(
            "SELECT rehearsal_hash AS hash FROM simetra.ledger"
          )
      )
      // Дописана колонка стоїть після інших, а не на місці скинутої: стан
      // ledger від цього не мусить відрізнятися від бажаного
      const again = await buildPlan(
        engine,
        {
          reader: createApplyDatabase({ readOnly: true }),
          scratch: createApplyDatabase({ readOnly: false }),
        },
        model,
        { target: { url } },
        []
      )
      return { artifact, run, rows, again }
    })
    expect(outcome.artifact.steps.map((s) => s.sql)).toContainEqual(
      expect.stringMatching(
        /^ALTER TABLE "?simetra"?\."?ledger"? ADD COLUMN "?rehearsal_hash"? text$/
      )
    )
    expect(outcome.run).toMatchObject({ status: "committed" })
    expect(outcome.rows).toEqual([{ hash: null }])
    expect(outcome.again).toMatchObject({ status: "unchanged" })
  })
})
