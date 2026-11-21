import {
  diffCatalogModels,
  type CatalogDifference,
  type CatalogModel,
} from "simetra/model"
import type { EngineDiagnostic, EngineIdentity } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import {
  compareFingerprints,
  type CatalogFingerprint,
  type FingerprintSection,
} from "./fingerprint"
import type { AppliedCatalog, ApplyState } from "./state"

/**
 * `drift` — свідок побачив розбіжність; `versions-changed` — змінились і
 * версія двигуна, і версія відбитка, тож перевірити нічим, і план мусить
 * прийняти це явно, як дрейф; `unverifiable` — двигун той самий, але
 * змінилась версія відбитка, а одиниця marker не читається: свідка теж
 * немає, і це не «дрейф побачено».
 */
export const DRIFT_REASONS = [
  "drift",
  "versions-changed",
  "unverifiable",
] as const

/**
 * Дрейф, який план несе як пункт дозволу (платформна спека §6.2 п.2, §6.6):
 * входить в артефакт під `planHash` і в рядок ledger застосування, що його
 * прийняло.
 */
export interface DriftReport {
  reason: (typeof DRIFT_REASONS)[number]
  /** Секції відбитка, що розійшлися; порожньо, коли відбитки не порівнювались. */
  sections: FingerprintSection[]
  /** Шляхи `diffCatalogModels`, не більше `DRIFT_PATH_LIMIT` і `…`. */
  paths: string[]
}

export type DriftVerdict =
  /**
   * Дрейф не зупиняє планування: `drift` іде в план. `diagnostics` —
   * попередження: перше застосування, звужена перевірка, сам дрейф.
   */
  | {
      ok: true
      fromHash: string | null
      drift: DriftReport | null
      diagnostics: EngineDiagnostic[]
    }
  /** Лише пошкоджений стан: його лагодять вручну, а не дозволом. */
  | { ok: false; diagnostics: EngineDiagnostic[] }

/** Скільки шляхів розбіжності називають звіт і діагностика; решту дає лише `count`. */
const DRIFT_PATH_LIMIT = 20

/** Перші `DRIFT_PATH_LIMIT` шляхів розбіжності, далі `…`, якщо є ще. */
export function differencePaths(
  differences: readonly CatalogDifference[]
): string[] {
  return differences
    .slice(0, DRIFT_PATH_LIMIT)
    .map((d) => d.path)
    .concat(differences.length > DRIFT_PATH_LIMIT ? ["…"] : [])
}

const engineLabel = (engine: EngineIdentity): string =>
  `${engine.name} ${engine.version}`

const sameEngine = (a: EngineIdentity, b: EngineIdentity): boolean =>
  a.name === b.name && a.version === b.version

/**
 * Гейт дрейфу на час плану (платформна спека §6.2 п.2). `current` — модель, відбиток і двигун цілі, знятої під межею з
 * marker (`marker.scope`), а не під межею нової моделі: інакше звуження чи
 * розширення межі виглядало б дрейфом. `applied` — застосований каталог
 * (`appliedCatalog`): ідентичності одиниць marker перевиведено з їхнього
 * `sql`, збережені не читаються.
 *
 * Свідків два. SQL-відбиток (усі секції, з власником) бачить те, чого модель
 * каталогу як проєкція для зворотної генерації не несе: власників, партиції,
 * успадкування, `CACHE` і `OWNED BY` послідовностей. Модель каталогу дає
 * читабельні шляхи, але лише між моделями того самого двигуна і лише коли
 * кожна одиниця marker читається: без нечитної одиниці модель показала б
 * її зникнення як дрейф, а вгадана ідентичність сховала б справжній. Тож
 * свідки діють за версіями: та сама версія відбитка — відбиток; той самий
 * двигун і читні одиниці — ще й модель, інакше попередження
 * `apply.drift-partial` з причиною; змінились обидві версії — свідка
 * немає, і це дрейф із причиною `versions-changed`; нечитна одиниця разом
 * з іншою версією відбитка — так само без свідка, дрейф із причиною
 * `unverifiable`.
 */
export function driftGate(
  state: ApplyState,
  applied: AppliedCatalog | undefined,
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
      drift: null,
      diagnostics: [applyDiagnostic("apply.first-apply", "warning")],
    }
  if (state.status === "corrupt")
    return { ok: false, diagnostics: [state.diagnostic] }
  // Застосований стан без перевиведеного каталогу — помилка виклику: гейт
  // не має права впасти назад на збережені ідентичності
  if (applied === undefined)
    throw new Error("internal: driftGate needs the applied catalog")
  const { marker } = state
  const fromHash = marker.snapshotHash
  const sameEngineVersion = sameEngine(marker.engine, current.engine)
  const comparison = compareFingerprints(
    marker.fingerprint,
    current.fingerprint,
    { owner: true }
  )
  const versions = {
    fingerprintFrom: marker.fingerprint.version,
    fingerprintTo: current.fingerprint.version,
  }
  if (!sameEngineVersion && !comparison.comparable)
    return {
      ok: true,
      fromHash,
      drift: { reason: "versions-changed", sections: [], paths: [] },
      diagnostics: [
        applyDiagnostic("apply.versions-changed", "warning", {
          engineFrom: engineLabel(marker.engine),
          engineTo: engineLabel(current.engine),
          ...versions,
        }),
      ],
    }
  // Модель іншого двигуна свідком не буває й так; нечитні одиниці
  // вимикають її лише за того самого двигуна
  const unreadable = sameEngineVersion ? applied.unreadable.length : 0
  if (unreadable > 0 && !comparison.comparable)
    // Ні відбитка, ні моделі: перевірити нічим, тож дрейф до прийняття
    return {
      ok: true,
      fromHash,
      drift: { reason: "unverifiable", sections: [], paths: [] },
      diagnostics: [
        applyDiagnostic("apply.drift-unverifiable", "warning", {
          ...versions,
          count: unreadable,
        }),
      ],
    }
  // Інша версія відбитка — інша формула секцій: їх рівність нічого не
  // доводить, тож лишається модель, і перевірка про це попереджає. Нечитна
  // одиниця marker — навпаки: лишається відбиток
  const diagnostics = !comparison.comparable
    ? [
        applyDiagnostic("apply.drift-partial", "warning", {
          reason: "fingerprint",
          ...versions,
        }),
      ]
    : unreadable > 0
      ? [
          applyDiagnostic("apply.drift-partial", "warning", {
            reason: "units",
            count: unreadable,
          }),
        ]
      : []
  const sections = comparison.comparable ? comparison.differing : []
  const differences =
    sameEngineVersion && unreadable === 0
      ? // Marker описує саму ціль, а ціль порядку колонок сама не змінює
        diffCatalogModels(applied.catalog, current.model, { columnOrder: true })
      : []
  if (sections.length === 0 && differences.length === 0)
    return { ok: true, fromHash, drift: null, diagnostics }
  const paths = differencePaths(differences)
  return {
    ok: true,
    fromHash,
    drift: { reason: "drift", sections, paths },
    diagnostics: [
      ...diagnostics,
      applyDiagnostic("apply.drift", "warning", {
        sections: sections.join(", "),
        count: differences.length,
        paths: paths.join(", "),
      }),
    ],
  }
}
