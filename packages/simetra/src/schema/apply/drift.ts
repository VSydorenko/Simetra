import { localize, type RuleCode, type Severity } from "simetra/compiler"
import { diffCatalogModels, type CatalogModel } from "simetra/model"
import type { EngineDiagnostic, EngineIdentity } from "../engine"
import { compareFingerprints, type CatalogFingerprint } from "./fingerprint"
import type { ApplyState } from "./state"

export type DriftVerdict =
  /** `diagnostics` — попередження першого застосування. */
  | { ok: true; fromHash: string | null; diagnostics: EngineDiagnostic[] }
  | { ok: false; diagnostics: EngineDiagnostic[] }

/** Скільки шляхів дрейфу називає діагностика; решту дає лише `count`. */
const DRIFT_PATH_LIMIT = 20

function applyDiagnostic(
  code: RuleCode,
  severity: Severity,
  params: Record<string, string | number> = {}
): EngineDiagnostic {
  return {
    code,
    severity,
    message: localize({ code, params }, "en").message,
    params,
  }
}

const refuse = (
  code: RuleCode,
  params: Record<string, string | number>
): DriftVerdict => ({
  ok: false,
  diagnostics: [applyDiagnostic(code, "error", params)],
})

const engineLabel = (engine: EngineIdentity): string =>
  `${engine.name} ${engine.version}`

const sameEngine = (a: EngineIdentity, b: EngineIdentity): boolean =>
  a.name === b.name && a.version === b.version

/**
 * Гейт дрейфу на час плану (платформна спека §6.2 п.2, рішення 2 плану
 * П3-1). `current` — модель, відбиток і двигун цілі, знятої під межею з
 * marker (`marker.scope`), а не під межею нової моделі: інакше звуження чи
 * розширення межі виглядало б дрейфом. Фіксацію вибирають версії: той самий
 * двигун — моделі каталогу (вони точніші й дають шляхи); інший двигун — його
 * модель могла змінитися, тож свідок — SQL-відбиток, ціль проти цілі, з
 * власником; змінились обидві версії — порівнювати нічим.
 */
export function driftGate(
  state: ApplyState,
  current: {
    model: CatalogModel
    fingerprint: CatalogFingerprint
    engine: EngineIdentity
  }
): DriftVerdict {
  if (state.status === "fresh")
    return {
      ok: true,
      fromHash: null,
      diagnostics: [applyDiagnostic("apply.first-apply", "warning")],
    }
  if (state.status === "corrupt")
    return { ok: false, diagnostics: [state.diagnostic] }
  const { marker } = state
  const passed: DriftVerdict = {
    ok: true,
    fromHash: marker.snapshotHash,
    diagnostics: [],
  }
  if (sameEngine(marker.engine, current.engine)) {
    const differences = diffCatalogModels(marker.catalog, current.model)
    if (differences.length === 0) return passed
    const paths = differences
      .slice(0, DRIFT_PATH_LIMIT)
      .map((d) => d.path)
      .concat(differences.length > DRIFT_PATH_LIMIT ? ["…"] : [])
    return refuse("apply.drift", {
      count: differences.length,
      paths: paths.join(", "),
    })
  }
  const comparison = compareFingerprints(
    marker.fingerprint,
    current.fingerprint,
    { owner: true }
  )
  // Інша версія відбитка — інша формула секцій: рівність нічого не доводить
  if (!comparison.comparable)
    return refuse("apply.versions-changed", {
      engineFrom: engineLabel(marker.engine),
      engineTo: engineLabel(current.engine),
      fingerprintFrom: marker.fingerprint.version,
      fingerprintTo: current.fingerprint.version,
    })
  if (comparison.differing.length === 0) return passed
  return refuse("apply.drift-fingerprint", {
    sections: comparison.differing.join(", "),
  })
}
