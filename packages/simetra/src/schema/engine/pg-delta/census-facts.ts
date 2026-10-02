import type { FactKind } from "@supabase/pg-delta"
import type { CensusClass, ClassCoverage, EngineCoverage } from "../census"

/**
 * Що двигун робить з об'єктами класу перепису (спайк E2a, крок 4,
 * «Відповідність класів перепису фактам двигуна»):
 * - `kind` — вид факту закріпленого двигуна; `match` — поле payload, що
 *   відрізняє клас, коли кілька класів ділять вид. Об'єкт класу з фактом
 *   мапер не губить: кожен факт стає полем моделі, SQL-одиницею або
 *   `engine.unrepresentable` з ім'ям об'єкта (`mapModel`, гілка «інакше»).
 *   Лічильник перепису звіряється з кількістю фактів класу — так ловиться
 *   пропуск окремих об'єктів покритого класу.
 * - `uncompared` — факт є, але лічильники принципово не порівнювані (причина).
 * - `kind: null` — факту немає: двигун класу не бачить зовсім, це тиха втрата.
 *   `global` — клас без схеми: межа не каже, чий об'єкт (застосунку чи
 *   провайдера), тож лише попередження, доки пресет провайдера не перелічить
 *   свої об'єкти класу.
 * Тип `FactKind` прив'язує таблицю до видів закріпленої версії: вид, якого
 * двигун не має, — помилка компіляції, а не тиха розбіжність. Ключі — рівно
 * класи перепису (`CensusClass`): клас без запису чи запис без класу теж не
 * компілюється.
 */
type CensusFact =
  | { kind: FactKind; match?: { field: string; value: string } }
  | { kind: FactKind; uncompared: string }
  | { kind: null; global?: true }

const CENSUS_FACTS = {
  table: { kind: "table" },
  view: { kind: "view" },
  materializedView: { kind: "materializedView" },
  sequence: { kind: "sequence" },
  foreignTable: { kind: "foreignTable" },
  index: { kind: "index" },
  "type.enum": { kind: "type", match: { field: "variant", value: "enum" } },
  "type.composite": {
    kind: "type",
    match: { field: "variant", value: "composite" },
  },
  "type.range": { kind: "type", match: { field: "variant", value: "range" } },
  "type.base": { kind: null },
  // `CREATE TYPE name` без тіла: заготовка під майбутній тип
  "type.shell": { kind: null },
  domain: { kind: "domain" },
  function: { kind: "function" },
  procedure: { kind: "procedure" },
  aggregate: { kind: "aggregate" },
  "constraint.exclusion": {
    kind: "constraint",
    match: { field: "type", value: "x" },
  },
  // Обмеження-тригер двигун тримає фактом `trigger` (рядок pg_trigger), а не
  // `constraint`; той самий рядок перепис уже рахує класом `trigger`
  "constraint.trigger": {
    kind: "trigger",
    uncompared: "the same pg_trigger row is counted and compared as trigger",
  },
  trigger: { kind: "trigger" },
  policy: { kind: "policy" },
  rule: { kind: "rule" },
  collation: { kind: "collation" },
  conversion: { kind: null },
  operator: { kind: null },
  operatorClass: { kind: null },
  operatorFamily: { kind: null },
  cast: { kind: null },
  textSearchConfiguration: { kind: null },
  textSearchDictionary: { kind: null },
  textSearchParser: { kind: null },
  textSearchTemplate: { kind: null },
  statistics: { kind: null },
  transform: { kind: null },
  publicationRel: { kind: "publicationRel" },
  publicationSchema: { kind: "publicationSchema" },
  defaultPrivilege: {
    kind: "defaultPrivilege",
    uncompared:
      "pg_default_acl holds one row per (role, schema, object type) for every grantee, the engine one fact per grantee",
  },
  extension: { kind: "extension" },
  // Факт `language` двигун має лише як ціль грантів; процедурну мову він
  // не витягує, а повідомляє `unmodeled_kind`
  language: { kind: null, global: true },
  accessMethod: { kind: null, global: true },
  eventTrigger: { kind: "eventTrigger" },
  foreignDataWrapper: { kind: "fdw" },
  server: { kind: "server" },
  subscription: { kind: "subscription" },
} as const satisfies Record<CensusClass, CensusFact>

/** Вид факту двигуна для класу перепису; `null` — двигун класу не бачить. */
export function factKindOf(censusClass: CensusClass): FactKind | null {
  return CENSUS_FACTS[censusClass].kind
}

const TABLE_CLASSES = Object.keys(CENSUS_FACTS) as CensusClass[]

/**
 * Класи перепису, об'єкти яких доходять до мапера фактами двигуна: їх
 * покриває модель (поле, одиниця або гучне `engine.unrepresentable`).
 * Похідне від `CENSUS_FACTS`, а не другий перелік.
 */
export const COVERED_CLASSES: readonly CensusClass[] = TABLE_CLASSES.filter(
  (c) => CENSUS_FACTS[c].kind !== null
)

/** Покриті класи, лічильник яких звіряється з фактами двигуна. */
const COMPARED_CLASSES: readonly CensusClass[] = COVERED_CLASSES.filter(
  (c) => !("uncompared" in CENSUS_FACTS[c])
)

/** Покриття класів перепису закріпленим двигуном — вхід звірки перепису. */
export const CENSUS_COVERAGE: EngineCoverage = Object.fromEntries(
  TABLE_CLASSES.map((c): [CensusClass, ClassCoverage] => {
    const entry: CensusFact = CENSUS_FACTS[c]
    if (entry.kind === null)
      return [c, "global" in entry ? "unmodeledGlobal" : "unmodeled"]
    return [c, "uncompared" in entry ? "uncompared" : "compared"]
  })
) as EngineCoverage

/**
 * Клас перепису, яким звіряється факт двигуна; `undefined` — факт не
 * рахується окремим класом (частина, сателіт, непорівнюваний клас).
 */
export function censusClassOfFact(fact: {
  id: { kind: string }
  payload: Record<string, unknown>
}): CensusClass | undefined {
  return COMPARED_CLASSES.find((c) => {
    const entry: CensusFact = CENSUS_FACTS[c]
    if (entry.kind !== fact.id.kind) return false
    const match = "match" in entry ? entry.match : undefined
    return match === undefined || fact.payload[match.field] === match.value
  })
}

/**
 * `unmodeled_kind` двигуна за міткою `context.kind` → клас перепису. Перепис
 * рахує ці класи в межі керування, тож про клас, який він уже назвав
 * помилкою, сигнал двигуна (бо той — без межі, на всю базу) не повторюється.
 */
const UNMODELED_KIND_CLASS: Readonly<Record<string, CensusClass>> = {
  cast: "cast",
  operator: "operator",
  "operator class": "operatorClass",
  "operator family": "operatorFamily",
  "text search configuration": "textSearchConfiguration",
  "text search dictionary": "textSearchDictionary",
  "text search parser": "textSearchParser",
  "text search template": "textSearchTemplate",
  "statistics object": "statistics",
  language: "language",
  transform: "transform",
}

export function censusClassOfUnmodeledKind(
  kind: string
): CensusClass | undefined {
  return UNMODELED_KIND_CLASS[kind]
}
