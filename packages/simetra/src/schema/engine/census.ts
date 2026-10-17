import { localize } from "simetra/compiler"
import type { EngineDiagnostic } from "./port"

/**
 * Класи перепису — значення `class` рядків запиту до каталогу. Що двигун
 * робить з об'єктами кожного класу, знає адаптер (`EngineCoverage`), а не
 * перепис.
 */
export type CensusClass =
  | "table"
  | "view"
  | "materializedView"
  | "sequence"
  | "foreignTable"
  | "index"
  | "type.enum"
  | "type.composite"
  | "type.range"
  | "type.base"
  | "type.shell"
  | "domain"
  | "function"
  | "procedure"
  | "aggregate"
  | "constraint.exclusion"
  | "constraint.trigger"
  | "trigger"
  | "policy"
  | "rule"
  | "collation"
  | "conversion"
  | "operator"
  | "operatorClass"
  | "operatorFamily"
  | "cast"
  | "textSearchConfiguration"
  | "textSearchDictionary"
  | "textSearchParser"
  | "textSearchTemplate"
  | "statistics"
  | "transform"
  | "publicationRel"
  | "publicationSchema"
  | "defaultPrivilege"
  | "extension"
  | "language"
  | "accessMethod"
  | "eventTrigger"
  | "foreignDataWrapper"
  | "server"
  | "subscription"

export interface CensusCount {
  class: CensusClass
  count: number
}

/**
 * Що двигун робить з об'єктами класу: `compared` — факт є, лічильник
 * звіряється з фактами extract; `uncompared` — факт є, але лічильники не
 * порівнювані; `unmodeled` — факту немає, тиха втрата; `unmodeledGlobal` —
 * факту немає, а клас без схеми: межа не каже, чий об'єкт, тож лише
 * попередження.
 */
export type ClassCoverage =
  "compared" | "uncompared" | "unmodeled" | "unmodeledGlobal"

/** Покриття кожного класу перепису двигуном; дає адаптер двигуна. */
export type EngineCoverage = Readonly<Record<CensusClass, ClassCoverage>>

function classesCovered(
  coverage: EngineCoverage,
  ...kinds: ClassCoverage[]
): CensusClass[] {
  return (Object.keys(coverage) as CensusClass[]).filter((c) =>
    kinds.includes(coverage[c])
  )
}

/**
 * Звірка перепису з фактами двигуна тієї ж бази за кожним порівнюваним
 * класом: відсутній клас — нуль. Розбіжність — пропущені двигуном (або
 * зайві) об'єкти покритого класу, яких модель тихо не мала б.
 */
export function reconcileCensus(
  census: readonly CensusCount[],
  facts: ReadonlyMap<CensusClass, number>,
  coverage: EngineCoverage
): EngineDiagnostic[] {
  const counted = new Map(census.map((c) => [c.class, c.count]))
  return classesCovered(coverage, "compared").flatMap((c) => {
    const inCensus = counted.get(c) ?? 0
    const inEngine = facts.get(c) ?? 0
    return inCensus === inEngine
      ? []
      : [
          diagnostic("engine.census-mismatch", "error", {
            class: c,
            census: inCensus,
            engine: inEngine,
          }),
        ]
  })
}

/** Фізична властивість зберігання й лічильник об'єктів із нетиповим значенням. */
export interface PropertyCount {
  property: string
  count: number
}

function diagnostic(
  code:
    | "engine.unmodeled-class"
    | "engine.census-mismatch"
    | "engine.unmodeled-property",
  severity: EngineDiagnostic["severity"],
  params: Record<string, string | number>
): EngineDiagnostic {
  return {
    code,
    severity,
    message: localize({ code, params }, "en").message,
    params,
  }
}

/** Класи з об'єктами в межі, яких двигун не бачить: кожен — тиха втрата. */
export function unmodeledClasses(
  census: readonly CensusCount[],
  coverage: EngineCoverage
): Set<CensusClass> {
  const unmodeled = new Set(
    classesCovered(coverage, "unmodeled", "unmodeledGlobal")
  )
  return new Set(census.map((c) => c.class).filter((c) => unmodeled.has(c)))
}

/**
 * Діагностики перепису: клас без факту двигуна з об'єктами в межі — тиха
 * втрата; розбіжність лічильника покритого класу з фактами — пропуск окремих
 * об'єктів; нетипова фізична властивість — стан, якого двигун не читає. Усі — error,
 * інакше звірка назвала б базу рівною бажаному стану; виняток — глобальні
 * класи без схеми (`unmodeledGlobal`).
 */
export function censusDiagnostics(
  census: readonly CensusCount[],
  facts: ReadonlyMap<CensusClass, number>,
  coverage: EngineCoverage,
  properties: readonly PropertyCount[]
): EngineDiagnostic[] {
  const unmodeled = unmodeledClasses(census, coverage)
  const out = census
    .filter((c) => unmodeled.has(c.class))
    .map((c) => {
      const global = coverage[c.class] === "unmodeledGlobal"
      return diagnostic(
        "engine.unmodeled-class",
        global ? "warning" : "error",
        { class: c.class, count: c.count }
      )
    })
  out.push(...reconcileCensus(census, facts, coverage))
  for (const p of properties)
    out.push(
      diagnostic("engine.unmodeled-property", "error", {
        property: p.property,
        count: p.count,
      })
    )
  return out
}
