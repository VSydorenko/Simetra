import { describe, expect, it } from "vitest"
import { loadSqlParser } from "simetra/compiler"
import type { CatalogModel, CatalogTable, CatalogUnit } from "simetra/model"
import {
  appliedCatalog,
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

const ENGINE: EngineIdentity = { name: "pg-delta", version: "1.0.0-alpha.60" }
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
    rowVersionEpoch: true,
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

const parse = await loadSqlParser()

/**
 * Гейт так, як його кличе план: застосований каталог — з `appliedCatalog`
 * над каталогом marker, а не сам каталог marker.
 */
const gate = (state: ApplyState, current: Parameters<typeof driftGate>[2]) =>
  driftGate(
    state,
    state.status === "applied"
      ? appliedCatalog(state.marker.catalog, parse)
      : undefined,
    current
  )

const brief = (diagnostics: EngineDiagnostic[]) =>
  diagnostics.map((d) => ({
    code: d.code,
    severity: d.severity,
    params: d.params,
  }))

describe("driftGate", () => {
  it("passes a first apply with a warning", () => {
    const verdict = gate(
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
      gate(
        { status: "corrupt", diagnostic },
        { model: model(["id"]), fingerprint: fingerprint(), engine: ENGINE }
      )
    ).toEqual({ ok: false, diagnostics: [diagnostic] })
  })

  it("passes an unchanged target from the marker's snapshot", () => {
    expect(
      gate(applied(), {
        model: model(["id"]),
        fingerprint: fingerprint(),
        engine: ENGINE,
      })
    ).toEqual({ ok: true, fromHash: SNAPSHOT, drift: null, diagnostics: [] })
  })

  it("reports model drift as a warning and keeps planning", () => {
    const verdict = gate(applied(), {
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
    const verdict = gate(applied(), {
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
    const verdict = gate(applied(), {
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
    const verdict = gate(applied(), {
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
    const verdict = gate(applied(), {
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
    const verdict = gate(applied(), {
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
      gate(applied(), {
        model: model(["id", "c"]),
        fingerprint: fingerprint(),
        engine: NEXT_ENGINE,
      })
    ).toEqual({ ok: true, fromHash: SNAPSHOT, drift: null, diagnostics: [] })
  })

  it("sees an owner change when only the engine version changed", () => {
    const verdict = gate(applied(), {
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
    const clean = gate(applied(), {
      model: model(["id"]),
      fingerprint: next,
      engine: ENGINE,
    })
    expect(clean).toMatchObject({ ok: true, drift: null })
    const partial = {
      code: "apply.drift-partial",
      severity: "warning",
      params: {
        reason: "fingerprint",
        fingerprintFrom: FINGERPRINT_VERSION,
        fingerprintTo: FINGERPRINT_VERSION + 1,
      },
    }
    expect(brief(clean.diagnostics)).toEqual([partial])
    const drifted = gate(applied(), {
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
    const verdict = gate(applied(), {
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
          engineFrom: "pg-delta 1.0.0-alpha.60",
          engineTo: "pg-delta 1.0.0-alpha.57",
          fingerprintFrom: FINGERPRINT_VERSION,
          fingerprintTo: FINGERPRINT_VERSION + 1,
        },
      },
    ])
  })

  it("speaks English in the message", () => {
    const [diagnostic] = gate(applied(), {
      model: model(["id", "c"]),
      fingerprint: fingerprint({ owner: "b".repeat(64) }),
      engine: ENGINE,
    }).diagnostics
    expect(diagnostic?.message).toMatch(/tables\.app\.t\.columns\.c/)
    expect(diagnostic?.message).toMatch(/owner/)
  })
})

describe("driftGate over the applied catalog (decision R10)", () => {
  // Ідентичності marker — похідні: рядок, записаний за старим правилом
  // (`(numeric)`, таблиця у верхньому регістрі без лапок), на незмінній цілі
  // не дає дрейфу, бо гейт читає ідентичності, перевиведені з `sql`
  const FN_SQL =
    "CREATE FUNCTION public.f(a numeric) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$"
  const TRIGGER_SQL =
    'CREATE TRIGGER tr BEFORE UPDATE ON app."Items" FOR EACH ROW EXECUTE FUNCTION app.touch()'
  const unit = (
    cls: CatalogUnit["class"],
    identity: string,
    schema: string,
    name: string,
    sql: string
  ): CatalogUnit => ({ class: cls, identity, schema, name, sql })
  /** Рядок marker до правила ідентичності #297. */
  const STORED = [
    unit("function", "function:public.f(numeric)", "public", "f", FN_SQL),
    unit("trigger", "trigger:app.Items.tr", "app", "tr", TRIGGER_SQL),
  ]
  /** Ті самі об'єкти, як їх сьогодні класифікує двигун. */
  const CURRENT = [
    unit("function", 'function:public.f("numeric")', "public", "f", FN_SQL),
    unit("trigger", 'trigger:app."Items".tr', "app", "tr", TRIGGER_SQL),
  ]
  const withUnits = (units: CatalogUnit[]): CatalogModel => ({
    ...model(["id"]),
    units,
  })
  const target = {
    model: withUnits(CURRENT),
    fingerprint: fingerprint(),
    engine: ENGINE,
  }

  it("re-derives every identity from the unit's sql", () => {
    expect(appliedCatalog(withUnits(STORED), parse)).toEqual({
      catalog: withUnits(CURRENT),
      unreadable: [],
    })
  })

  it("passes an unchanged target recorded in the older identity form", () => {
    expect(gate(applied({ catalog: withUnits(STORED) }), target)).toEqual({
      ok: true,
      fromHash: SNAPSHOT,
      drift: null,
      diagnostics: [],
    })
  })

  const OUTSIDE = unit(
    "trigger",
    "trigger:app.t.x",
    "app",
    "x",
    "CREATE TRIGGER x ???"
  )
  const TWO = unit(
    "function",
    "function:public.g()",
    "public",
    "g",
    `${FN_SQL}; ${FN_SQL.replace("public.f", "public.g")}`
  )
  const TWIN = unit(
    "function",
    "function:public.f(numeric) twin",
    "public",
    "f",
    FN_SQL
  )

  it.each([
    ["a statement outside the unit language", [OUTSIDE], 1],
    ["sql with two units", [TWO], 1],
    // Обидві одиниці з однією ідентичністю: жодна не вгадується
    ["two units with one identity", [TWIN], 2],
  ])("limits the check to the fingerprint for %s", (_name, extra, count) => {
    const catalog = withUnits([...STORED, ...extra])
    expect(appliedCatalog(catalog, parse).unreadable).toHaveLength(count)
    const verdict = gate(applied({ catalog }), target)
    expect(verdict).toMatchObject({ ok: true, drift: null })
    expect(brief(verdict.diagnostics)).toEqual([
      {
        code: "apply.drift-partial",
        severity: "warning",
        params: { reason: "units", count },
      },
    ])
  })

  it("still sees drift through the fingerprint with an unreadable unit", () => {
    const verdict = gate(
      applied({ catalog: withUnits([...STORED, OUTSIDE]) }),
      {
        ...target,
        fingerprint: fingerprint({ owner: "b".repeat(64) }),
      }
    )
    expect(verdict.ok && verdict.drift).toEqual({
      reason: "drift",
      sections: ["owner"],
      paths: [],
    })
    expect(brief(verdict.diagnostics).map((d) => d.code)).toEqual([
      "apply.drift-partial",
      "apply.drift",
    ])
  })

  it("does not warn about units when the engine changed: its model is no witness anyway", () => {
    const verdict = gate(
      applied({ catalog: withUnits([...STORED, OUTSIDE]) }),
      { ...target, engine: NEXT_ENGINE }
    )
    expect(verdict).toEqual({
      ok: true,
      fromHash: SNAPSHOT,
      drift: null,
      diagnostics: [],
    })
  })

  it("carries unverifiable drift to accept when neither witness can check", () => {
    const verdict = gate(
      applied({ catalog: withUnits([...STORED, OUTSIDE]) }),
      { ...target, fingerprint: fingerprint({}, FINGERPRINT_VERSION + 1) }
    )
    // Нічим перевірити — не «дрейф побачено»: причина `unverifiable`
    expect(verdict.ok && verdict.drift).toEqual({
      reason: "unverifiable",
      sections: [],
      paths: [],
    })
    expect(brief(verdict.diagnostics)).toEqual([
      {
        code: "apply.drift-unverifiable",
        severity: "warning",
        params: {
          fingerprintFrom: FINGERPRINT_VERSION,
          fingerprintTo: FINGERPRINT_VERSION + 1,
          count: 1,
        },
      },
    ])
    expect(verdict.diagnostics[0]?.message).toMatch(/cannot be checked/)
  })

  it("speaks the units reason in its own message", () => {
    const [diagnostic] = gate(
      applied({ catalog: withUnits([...STORED, OUTSIDE]) }),
      target
    ).diagnostics
    expect(diagnostic?.message).toMatch(
      /1 SQL units .* limited to the catalog fingerprint/
    )
  })
})
