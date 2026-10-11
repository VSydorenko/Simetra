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
    ).toEqual({ ok: true, fromHash: SNAPSHOT, diagnostics: [] })
  })

  it("compares catalog models when the engine version is the same", () => {
    const verdict = driftGate(applied(), {
      model: model(["id", "c"]),
      fingerprint: fingerprint(),
      engine: ENGINE,
    })
    expect(verdict.ok).toBe(false)
    expect(brief(verdict.diagnostics)).toEqual([
      {
        code: "apply.drift",
        severity: "error",
        params: { count: 1, paths: "tables.app.t.columns.c" },
      },
    ])
  })

  it("does not read the fingerprint when the engine version is the same", () => {
    expect(
      driftGate(applied(), {
        model: model(["id"]),
        fingerprint: fingerprint({ owner: "b".repeat(64) }),
        engine: ENGINE,
      }).ok
    ).toBe(true)
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
  })

  it("compares fingerprints when only the engine version changed", () => {
    expect(
      driftGate(applied(), {
        model: model(["id", "c"]),
        fingerprint: fingerprint(),
        engine: NEXT_ENGINE,
      })
    ).toEqual({ ok: true, fromHash: SNAPSHOT, diagnostics: [] })
  })

  it("sees an owner change when only the engine version changed", () => {
    const verdict = driftGate(applied(), {
      model: model(["id"]),
      fingerprint: fingerprint({ owner: "b".repeat(64) }),
      engine: NEXT_ENGINE,
    })
    expect(verdict.ok).toBe(false)
    expect(brief(verdict.diagnostics)).toEqual([
      {
        code: "apply.drift-fingerprint",
        severity: "error",
        params: { sections: "owner" },
      },
    ])
  })

  it("refuses when both the engine and the fingerprint versions changed", () => {
    const verdict = driftGate(applied(), {
      model: model(["id"]),
      fingerprint: fingerprint({}, FINGERPRINT_VERSION + 1),
      engine: NEXT_ENGINE,
    })
    expect(verdict.ok).toBe(false)
    expect(brief(verdict.diagnostics)).toEqual([
      {
        code: "apply.versions-changed",
        severity: "error",
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
      fingerprint: fingerprint(),
      engine: ENGINE,
    }).diagnostics
    expect(diagnostic?.message).toMatch(/tables\.app\.t\.columns\.c/)
  })
})
