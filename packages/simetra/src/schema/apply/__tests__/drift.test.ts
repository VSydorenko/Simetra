import { describe, expect, it } from "vitest"
import type { CatalogModel, CatalogTable } from "simetra/model"
import {
  driftGate,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  PLATFORM_VERSION,
  type ApplyState,
  type CatalogFingerprint,
  type EngineDiagnostic,
  type EngineIdentity,
  type FingerprintSection,
  type MarkerRecord,
} from "simetra/schema"

const ENGINE: EngineIdentity = { name: "pg-delta", version: "1.0.0-alpha.56" }
const NEXT_ENGINE: EngineIdentity = {
  name: "pg-delta",
  version: "1.0.0-alpha.57",
}

function model(columns: string[]): CatalogModel {
  const table: CatalogTable = {
    schema: "app",
    name: "t",
    rowLevelSecurity: "off",
    columns: columns.map((name) => ({ name, type: "text", notNull: false })),
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
  }
  return { tables: [table], enumTypes: [], units: [] }
}

function fingerprint(
  over: Partial<Record<FingerprintSection, string>> = {},
  version = FINGERPRINT_VERSION
): CatalogFingerprint {
  return {
    version,
    sections: {
      ...(Object.fromEntries(
        FINGERPRINT_SECTIONS.map((s) => [s, "a".repeat(64)])
      ) as Record<FingerprintSection, string>),
      ...over,
    },
  }
}

const SNAPSHOT = "5".repeat(64)

function applied(over: Partial<MarkerRecord> = {}): ApplyState {
  return {
    status: "applied",
    marker: {
      format: 1,
      snapshotHash: SNAPSHOT,
      snapshot: {},
      scope: { schemas: ["app", "simetra"], provider: "supabase" },
      catalog: model(["id"]),
      engine: ENGINE,
      fingerprint: fingerprint(),
      platformVersion: PLATFORM_VERSION,
      planHash: "9".repeat(64),
      ...over,
    },
  }
}

const brief = (diagnostics: EngineDiagnostic[]) =>
  diagnostics.map((d) => ({
    code: d.code,
    severity: d.severity,
    params: d.params,
  }))

describe("driftGate", () => {
  it("passes a first apply with a warning", () => {
    const verdict = driftGate(
      { status: "fresh" },
      { model: model(["id"]), fingerprint: fingerprint(), engine: ENGINE }
    )
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.fromHash).toBeNull()
    expect(verdict.drift).toBeNull()
    expect(brief(verdict.diagnostics)).toEqual([
      { code: "apply.first-apply", severity: "warning", params: {} },
    ])
  })

  it("refuses a corrupt state with its diagnostic", () => {
    const diagnostic: EngineDiagnostic = {
      code: "apply.ledger-without-marker",
      severity: "error",
      message: "damaged",
      params: {},
    }
    expect(
      driftGate(
        { status: "corrupt", diagnostic },
        { model: model(["id"]), fingerprint: fingerprint(), engine: ENGINE }
      )
    ).toEqual({ ok: false, diagnostics: [diagnostic] })
  })

  it("passes an unchanged target from the marker's snapshot", () => {
    expect(
      driftGate(applied(), {
        model: model(["id"]),
        fingerprint: fingerprint(),
        engine: ENGINE,
      })
    ).toEqual({ ok: true, fromHash: SNAPSHOT, drift: null, diagnostics: [] })
  })

  it("reports model drift as a warning and keeps planning", () => {
    const verdict = driftGate(applied(), {
      model: model(["id", "c"]),
      fingerprint: fingerprint(),
      engine: ENGINE,
    })
    expect(verdict).toMatchObject({
      ok: true,
      fromHash: SNAPSHOT,
      drift: {
        reason: "drift",
        sections: [],
        paths: ["tables.app.t.columns.c"],
      },
    })
    expect(brief(verdict.diagnostics)).toEqual([
      {
        code: "apply.drift",
        severity: "warning",
        params: { sections: "", count: 1, paths: "tables.app.t.columns.c" },
      },
    ])
  })

  it("sees an owner change with the same engine: the fingerprint is a witness too", () => {
    const verdict = driftGate(applied(), {
      model: model(["id"]),
      fingerprint: fingerprint({ owner: "b".repeat(64) }),
      engine: ENGINE,
    })
    expect(verdict).toMatchObject({
      ok: true,
      drift: { reason: "drift", sections: ["owner"], paths: [] },
    })
    expect(brief(verdict.diagnostics)).toEqual([
      {
        code: "apply.drift",
        severity: "warning",
        params: { sections: "owner", count: 0, paths: "" },
      },
    ])
  })

  it("sees an attached partition the catalog model does not carry", () => {
    const verdict = driftGate(applied(), {
      model: model(["id"]),
      fingerprint: fingerprint({ relations: "b".repeat(64) }),
      engine: ENGINE,
    })
    expect(verdict.ok && verdict.drift).toEqual({
      reason: "drift",
      sections: ["relations"],
      paths: [],
    })
  })

  it("sees a sequence CACHE change the catalog model does not carry", () => {
    const verdict = driftGate(applied(), {
      model: model(["id"]),
      fingerprint: fingerprint({ sequences: "b".repeat(64) }),
      engine: ENGINE,
    })
    expect(verdict.ok && verdict.drift).toEqual({
      reason: "drift",
      sections: ["sequences"],
      paths: [],
    })
  })

  it("names both witnesses when both see drift", () => {
    const verdict = driftGate(applied(), {
      model: model(["id", "c"]),
      fingerprint: fingerprint({ columns: "b".repeat(64) }),
      engine: ENGINE,
    })
    expect(verdict.ok && verdict.drift).toEqual({
      reason: "drift",
      sections: ["columns"],
      paths: ["tables.app.t.columns.c"],
    })
  })

  it("lists at most 20 drifted paths", () => {
    const columns = Array.from({ length: 25 }, (_, i) => `c${i + 10}`)
    const verdict = driftGate(applied(), {
      model: model(["id", ...columns]),
      fingerprint: fingerprint(),
      engine: ENGINE,
    })
    const [diagnostic] = verdict.diagnostics
    expect(diagnostic?.params.count).toBe(25)
    const paths = String(diagnostic?.params.paths).split(", ")
    expect(paths).toHaveLength(21)
    expect(paths.slice(0, 20).every((p) => p.startsWith("tables.app.t."))).toBe(
      true
    )
    expect(paths[20]).toBe("…")
    expect(verdict.ok && verdict.drift?.paths).toEqual(paths)
  })

  it("compares only fingerprints when the engine version changed", () => {
    expect(
      driftGate(applied(), {
        model: model(["id", "c"]),
        fingerprint: fingerprint(),
        engine: NEXT_ENGINE,
      })
    ).toEqual({ ok: true, fromHash: SNAPSHOT, drift: null, diagnostics: [] })
  })

  it("sees an owner change when only the engine version changed", () => {
    const verdict = driftGate(applied(), {
      model: model(["id"]),
      fingerprint: fingerprint({ owner: "b".repeat(64) }),
      engine: NEXT_ENGINE,
    })
    expect(verdict).toMatchObject({
      ok: true,
      drift: { reason: "drift", sections: ["owner"], paths: [] },
    })
    expect(brief(verdict.diagnostics)).toEqual([
      {
        code: "apply.drift",
        severity: "warning",
        params: { sections: "owner", count: 0, paths: "" },
      },
    ])
  })

  it("falls back to the catalog model with a warning when only the fingerprint version changed", () => {
    const next = fingerprint({ owner: "b".repeat(64) }, FINGERPRINT_VERSION + 1)
    const clean = driftGate(applied(), {
      model: model(["id"]),
      fingerprint: next,
      engine: ENGINE,
    })
    expect(clean).toMatchObject({ ok: true, drift: null })
    const partial = {
      code: "apply.drift-partial",
      severity: "warning",
      params: {
        fingerprintFrom: FINGERPRINT_VERSION,
        fingerprintTo: FINGERPRINT_VERSION + 1,
      },
    }
    expect(brief(clean.diagnostics)).toEqual([partial])
    const drifted = driftGate(applied(), {
      model: model(["id", "c"]),
      fingerprint: next,
      engine: ENGINE,
    })
    expect(drifted.ok && drifted.drift).toEqual({
      reason: "drift",
      sections: [],
      paths: ["tables.app.t.columns.c"],
    })
    expect(brief(drifted.diagnostics).map((d) => d.code)).toEqual([
      "apply.drift-partial",
      "apply.drift",
    ])
  })

  it("reports drift, not a refusal, when both versions changed", () => {
    const verdict = driftGate(applied(), {
      model: model(["id"]),
      fingerprint: fingerprint({}, FINGERPRINT_VERSION + 1),
      engine: NEXT_ENGINE,
    })
    expect(verdict).toEqual({
      ok: true,
      fromHash: SNAPSHOT,
      drift: { reason: "versions-changed", sections: [], paths: [] },
      diagnostics: verdict.diagnostics,
    })
    expect(brief(verdict.diagnostics)).toEqual([
      {
        code: "apply.versions-changed",
        severity: "warning",
        params: {
          engineFrom: "pg-delta 1.0.0-alpha.56",
          engineTo: "pg-delta 1.0.0-alpha.57",
          fingerprintFrom: FINGERPRINT_VERSION,
          fingerprintTo: FINGERPRINT_VERSION + 1,
        },
      },
    ])
  })

  it("speaks English in the message", () => {
    const [diagnostic] = driftGate(applied(), {
      model: model(["id", "c"]),
      fingerprint: fingerprint({ owner: "b".repeat(64) }),
      engine: ENGINE,
    }).diagnostics
    expect(diagnostic?.message).toMatch(/tables\.app\.t\.columns\.c/)
    expect(diagnostic?.message).toMatch(/owner/)
  })
})
