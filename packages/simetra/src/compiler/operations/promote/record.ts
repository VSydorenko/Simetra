import { z } from "zod"
import {
  SQL_UNIT_CLASSES,
  standardLogicalName,
  type AttributeCase,
  type PhysicalColumn,
  type PhysicalSnapshot,
  type PhysicalTable,
  type StandardColumnDef,
} from "simetra/model"
import { canonicalize, sha256Hex } from "../../canonical"
import type { CompiledModel } from "../../compile"
import { compareStrings } from "../../diagnostics"
import type { UnitSubjectKey } from "../../sql/unit-target"
import { standardElementId } from "../../stages/identity"
import {
  conversionClass,
  type ConversionClass,
  type PromoteInput,
} from "../inputs"
import type { OperationResult } from "../types"
import type { PlacedColumn, PromotedTable } from "./mapping"

/** Форма файлу запису; читач порівнює її з поточною, а не вгадує. */
export const PROMOTION_RECORD_FORMAT = 1

/** Види кроку даних (рішення 12): одне джерело для запису й секції плану T2. */
export const DATA_STEP_KINDS = [
  "repair",
  "conversion",
  "split",
  "backfill",
] as const

/**
 * Об'єкт бази, який покриває клас конверсії (рішення 7 плану П3-2a): з ним
 * T2 зіставляє обмеження, індекси, значення, коментарі й одиниці, що зникли
 * з бажаного стану. Імена — старі, як у знімку до промоції.
 */
export type PromotionObject =
  | {
      kind: "constraint" | "index"
      schema: string
      table: string
      name: string
    }
  | { kind: "default"; schema: string; table: string; column: string }
  | { kind: "comment"; schema: string; table: string; column?: string }
  | ({ kind: "unit" } & UnitSubjectKey)

/**
 * Запис промоції (спека промоції §7.1, рішення плану 2): перегляд «що на що
 * перетворюється» і вхід плану бази П3. Мапінг у `metadata/` не лишається
 * (§4), тож усе, що П3 має знати про старий стан, несе цей запис. Імена
 * таблиць і колонок — фізичні; де стан імен не названо явно, це імена після
 * перейменувань (`retired` і `dataSteps` — до них).
 */
export interface PromotionRecord {
  format: typeof PROMOTION_RECORD_FORMAT
  /** Хеш компіляції до `promote`: прив'язка до `marker.snapshot_hash`. */
  base: string
  /** Хеш компіляції після `promote`. */
  result: string
  objectId: string
  kind: "Catalog" | "Document" | "InformationRegister"
  kindLabel?: string
  // Лише коли consumerLabels не порожній: кроки перекладу виводить П3 (рішення 4).
  labelTranslation?: {
    from: string[]
    to: string
    columns: { schema: string; table: string; column: string }[]
  }
  tables: { id: string; schema: string; from: string; to: string }[]
  /**
   * `id` — id реквізиту (перенесений id колонки), синтетичний id стандартного
   * реквізиту (`<objectId>#<канонічне ім'я>`) або, для носія скоупу, id виду
   * скоупу: саме так походження колонки називає фізичний знімок.
   */
  columns: {
    id: string
    /**
     * Id прийнятої колонки: для стандартного реквізиту старий UUID з
     * метаданих зникає, тож без нього T2 не звірить мапу колонок.
     */
    sourceId: string
    schema: string
    table: string
    from: string
    to: string
  }[] // table — нове ім'я
  /** Типи — у формі `format_type()` фізичного знімка; імена — нові. */
  typeChanges: {
    schema: string
    table: string
    column: string
    from: string
    to: string
  }[]
  // Вираз і table — у старих іменах, крок виконується до перейменувань (рішення 12); column — нове фізичне ім'я цілі.
  dataSteps: {
    names: "beforeRenames"
    schema: string
    table: string
    key: string
    column: string
    expression: string
    kind: (typeof DATA_STEP_KINDS)[number]
  }[]
  retired: {
    sourceId: string
    schema: string
    table: string
    column: string
  }[] // старі імена
  /** Імена — нові. */
  relaxed: {
    schema: string
    table: string
    column: string
    constraint: "notNull"
  }[]
  /**
   * Імена — нові (рішення 15). Посилення можливе лише з кроком `fill` на цю
   * колонку: інакше операція відмовляє (`promote.fill-missing`).
   */
  tightened: {
    schema: string
    table: string
    column: string
    constraint: "notNull"
  }[]
  /**
   * Старі імена; рішення 15. Кожна таблиця об'єкта, чий режим RLS не
   * `enabled`: `off → enabled` звужує читання, `forced → enabled` розширює
   * доступ власника. Зміну доступу дозволяє П3 (гейт еквівалентності).
   */
  rowLevelSecurity: {
    schema: string
    table: string
    from: "off" | "forced"
    to: "enabled"
  }[]
  /**
   * Будь-який бік (§9.5, Пр8); для "incoming" дія не змінюється (to === from),
   * але потребує дозволу. Імена — нові; `from: "none"` — FK у прийнятій
   * таблиці не було, а вид додає його з каскадом.
   */
  deleteSemantics: {
    direction: "own" | "incoming"
    schema: string
    table: string
    constraint?: string
    columns: string[]
    target: string
    from: string
    to: string
  }[]
  /** `objects` — об'єкти бази, які покриває клас (рішення 7 плану П3-2a). */
  conversions: {
    subject: string
    class: ConversionClass
    objects: PromotionObject[]
  }[]
  movedUnits: { identity: string; from: string; to: string }[]
  rewrittenUnits: { identity: string; file: string }[]
  /**
   * Місця — після промоції (файл і рядок, де функція лежить тепер); `via` —
   * ланцюжок від викликача до функції, чия сигнатура змінилась (рішення 13).
   */
  contractChanges: {
    identity: string
    file: string
    line: number
    reason: string
    detail?: string
    via?: string[]
  }[]
}

export interface PromoteResult extends OperationResult {
  record?: PromotionRecord // record — лише коли ok
}

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const at = { schema: z.string(), table: z.string() }
const atColumn = { ...at, column: z.string() }
const notNullChange = z.strictObject({
  ...atColumn,
  constraint: z.literal("notNull"),
})

const promotionObjectSchema = z.union([
  z.strictObject({
    kind: z.enum(["constraint", "index"]),
    ...at,
    name: z.string(),
  }),
  z.strictObject({ kind: z.literal("default"), ...atColumn }),
  z.strictObject({
    kind: z.literal("comment"),
    ...at,
    column: z.string().optional(),
  }),
  z.strictObject({
    kind: z.literal("unit"),
    class: z.enum(SQL_UNIT_CLASSES),
    ...at,
    name: z.string(),
  }),
])

/**
 * Строга схема файлу запису (рішення 1 плану П3-2a): T2 читає запис з
 * `plans/`, тож невідомий ключ чи інша форма — відмова, а не мовчазна
 * втрата факту. Інтерфейс вище — його опис; схема тримає ту саму форму.
 */
export const promotionRecordSchema: z.ZodType<PromotionRecord> = z.strictObject(
  {
    format: z.literal(PROMOTION_RECORD_FORMAT),
    base: hash,
    result: hash,
    objectId: z.string(),
    kind: z.enum(["Catalog", "Document", "InformationRegister"]),
    kindLabel: z.string().optional(),
    labelTranslation: z
      .strictObject({
        from: z.array(z.string()),
        to: z.string(),
        columns: z.array(z.strictObject(atColumn)),
      })
      .optional(),
    tables: z.array(
      z.strictObject({
        id: z.string(),
        schema: z.string(),
        from: z.string(),
        to: z.string(),
      })
    ),
    columns: z.array(
      z.strictObject({
        id: z.string(),
        sourceId: z.string(),
        ...at,
        from: z.string(),
        to: z.string(),
      })
    ),
    typeChanges: z.array(
      z.strictObject({ ...atColumn, from: z.string(), to: z.string() })
    ),
    dataSteps: z.array(
      z.strictObject({
        names: z.literal("beforeRenames"),
        ...atColumn,
        key: z.string(),
        expression: z.string(),
        kind: z.enum(DATA_STEP_KINDS),
      })
    ),
    retired: z.array(z.strictObject({ sourceId: z.string(), ...atColumn })),
    relaxed: z.array(notNullChange),
    tightened: z.array(notNullChange),
    rowLevelSecurity: z.array(
      z.strictObject({
        ...at,
        from: z.enum(["off", "forced"]),
        to: z.literal("enabled"),
      })
    ),
    deleteSemantics: z.array(
      z.strictObject({
        direction: z.enum(["own", "incoming"]),
        ...at,
        constraint: z.string().optional(),
        columns: z.array(z.string()),
        target: z.string(),
        from: z.string(),
        to: z.string(),
      })
    ),
    conversions: z.array(
      z.strictObject({
        subject: z.string(),
        class: conversionClass,
        objects: z.array(promotionObjectSchema),
      })
    ),
    movedUnits: z.array(
      z.strictObject({ identity: z.string(), from: z.string(), to: z.string() })
    ),
    rewrittenUnits: z.array(
      z.strictObject({ identity: z.string(), file: z.string() })
    ),
    contractChanges: z.array(
      z.strictObject({
        identity: z.string(),
        file: z.string(),
        line: z.number().int(),
        reason: z.string(),
        detail: z.string().optional(),
        via: z.array(z.string()).optional(),
      })
    ),
  }
)

/** Hex SHA-256 канонічної форми запису: під `planHash` разом із самим записом. */
export function promotionRecordHash(record: PromotionRecord): Promise<string> {
  return sha256Hex(canonicalize(record))
}

/** Файл запису в `plans/`: один на об'єкт, повторний `promote` його перезаписує. */
export function promotionFileName(objectId: string): string {
  return `${objectId}.promotion.json`
}

/**
 * Факти запису, які T2 не бере на віру, а виводить сам зі знімків до й після
 * (рішення 1 плану П3-2a). `deleteSemantics` — разом із вхідними: T2 звіряє
 * лише власні, вхідні виводить із бажаної моделі.
 */
export type PromotionFacts = Pick<
  PromotionRecord,
  | "tables"
  | "columns"
  | "typeChanges"
  | "retired"
  | "relaxed"
  | "tightened"
  | "rowLevelSecurity"
  | "deleteSemantics"
>

/** Невиводне з ідентичності: які таблиці й колонки на що перетворились. */
export interface PromotionMapping {
  objectId: string
  /** id таблиць «до» (`CustomTable`); той самий id — власник «після» (об'єкт чи ТЧ). */
  tables: string[]
  /** Прийнята колонка → наступник: id реквізиту, синтетичний id стандартного, id виду скоупу або `null` (виведено). */
  columns: { sourceId: string; successorId: string | null }[]
}

export type DerivedFacts =
  | { ok: true; facts: PromotionFacts }
  // Неочікуваний стан: T2 робить з нього `plan.promotion-record-mismatch`.
  | { ok: false; detail: string }

/** Мапа запису — те, з чого T2 виводить факти й порівнює їх із записом. */
export function promotionMapping(record: PromotionRecord): PromotionMapping {
  return {
    objectId: record.objectId,
    tables: record.tables.map((t) => t.id),
    columns: [
      ...record.columns.map((c) => ({
        sourceId: c.sourceId,
        successorId: c.id,
      })),
      ...record.retired.map((c) => ({
        sourceId: c.sourceId,
        successorId: null,
      })),
    ],
  }
}

/** Розбіжність знімків із мапою — значення, а не виняток: її звітує викликач. */
class Mismatch extends Error {}

/**
 * Факти запису з двох фізичних знімків і мапи (рішення 1 плану П3-2a): одна
 * чиста функція для `promote` і для T2, тож запис і звірка не розходяться
 * правилами. Колонки — у порядку оголошення таблиці «до», тож порядок
 * фактів детермінований. Стиль імен стандартних реквізитів — моделі «після».
 */
export function derivePromotionFacts(
  before: Pick<PhysicalSnapshot, "tables">,
  after: {
    physical: Pick<PhysicalSnapshot, "tables">
    attributeCase: AttributeCase
  },
  mapping: PromotionMapping
): DerivedFacts {
  try {
    return { ok: true, facts: derive(before, after, mapping) }
  } catch (error) {
    if (error instanceof Mismatch) return { ok: false, detail: error.message }
    throw error
  }
}

function derive(
  before: Pick<PhysicalSnapshot, "tables">,
  after: {
    physical: Pick<PhysicalSnapshot, "tables">
    attributeCase: AttributeCase
  },
  mapping: PromotionMapping
): PromotionFacts {
  const { objectId } = mapping
  const facts: PromotionFacts = {
    tables: [],
    columns: [],
    typeChanges: [],
    retired: [],
    relaxed: [],
    tightened: [],
    rowLevelSecurity: [],
    deleteSemantics: [],
  }
  const successors = new Map<string, string | null>()
  for (const { sourceId, successorId } of mapping.columns) {
    if (successors.has(sourceId)) {
      throw new Mismatch(`column ${sourceId} is mapped twice`)
    }
    successors.set(sourceId, successorId)
  }
  const seen = new Set<string>()
  const pairs: TablePair[] = []
  for (const id of mapping.tables) {
    const was = single(
      before.tables.filter(
        ({ origin }) =>
          origin.objectId === id &&
          origin.tabularSectionId === undefined &&
          origin.part === undefined
      ),
      `adopted table ${id} before the promotion`
    )
    // Той самий id — власник після: основна таблиця об'єкта чи таблиця ТЧ.
    const now = single(
      after.physical.tables.filter(
        ({ origin }) =>
          origin.objectId === objectId &&
          origin.part === undefined &&
          origin.tabularSectionId === (id === objectId ? undefined : id)
      ),
      `table of ${id} after the promotion`
    )
    const renames = new Map<string, string>()
    pairs.push({ was, now, renames })
    const { schema } = now
    facts.tables.push({ id, schema, from: was.name, to: now.name })
    if (was.rowLevelSecurity !== now.rowLevelSecurity) {
      // Вид 1С має RLS увімкненим завжди (реєстр видів), рядки ТЧ — RLS
      // власника: інший режим після промоції — розбіжність, а не стан, який
      // запис уміє назвати.
      if (
        was.rowLevelSecurity === "enabled" ||
        now.rowLevelSecurity !== "enabled"
      ) {
        throw new Mismatch(
          `row-level security of ${was.schema}.${was.name} changes from ${was.rowLevelSecurity} to ${now.rowLevelSecurity}`
        )
      }
      facts.rowLevelSecurity.push({
        schema: was.schema,
        table: was.name,
        from: was.rowLevelSecurity,
        to: now.rowLevelSecurity,
      })
    }
    for (const old of was.columns) {
      const sourceId = old.origin.elementId
      const where = `${was.schema}.${was.name}.${old.name}`
      if (sourceId === undefined || !successors.has(sourceId)) {
        throw new Mismatch(`column ${where} has no mapping`)
      }
      seen.add(sourceId)
      const successorId = successors.get(sourceId)!
      if (successorId === null) {
        // Виведена колонка не має наступника: її id зникає з моделі «після».
        if (
          after.physical.tables.some((t) =>
            t.columns.some((c) => c.origin.elementId === sourceId)
          )
        ) {
          throw new Mismatch(`retired column ${where} is still in the model`)
        }
        facts.retired.push({
          sourceId,
          schema: was.schema,
          table: was.name,
          column: old.name,
        })
        continue
      }
      const next = successor(
        now,
        id,
        sourceId,
        successorId,
        after.attributeCase
      )
      if (next === undefined) {
        throw new Mismatch(
          `column ${where} has no successor ${successorId} in ${now.schema}.${now.name}`
        )
      }
      renames.set(old.name, next.name)
      const place = { schema, table: now.name, column: next.name }
      facts.columns.push({
        id: successorId,
        sourceId,
        schema,
        table: now.name,
        from: old.name,
        to: next.name,
      })
      if (old.type !== next.type) {
        facts.typeChanges.push({ ...place, from: old.type, to: next.type })
      }
      if (old.notNull && !next.notNull) {
        facts.relaxed.push({ ...place, constraint: "notNull" })
      }
      if (!old.notNull && next.notNull) {
        facts.tightened.push({ ...place, constraint: "notNull" })
      }
    }
  }
  const unknown = [...successors.keys()].filter((id) => !seen.has(id))
  if (unknown.length > 0) {
    throw new Mismatch(
      `the mapping names columns the adopted tables lack: ${unknown.join(", ")}`
    )
  }
  facts.deleteSemantics = deleteSemantics(after.physical, objectId, pairs)
  return facts
}

/** Рівно одна таблиця; інакше — розбіжність знімка з мапою. */
function single(tables: PhysicalTable[], what: string): PhysicalTable {
  if (tables.length !== 1) {
    throw new Mismatch(`${what}: ${tables.length} tables instead of one`)
  }
  return tables[0]!
}

/**
 * Колонка, якою стала прийнята колонка, — за ідентичністю наступника, як її
 * бачить планувальник (§5): власний реквізит зберігає id колонки,
 * стандартний має синтетичний id `<власник>#<канонічне ім'я>` і в знімку
 * несе логічне ім'я в стилі проєкту, решта — id виду скоупу.
 */
function successor(
  now: PhysicalTable,
  ownerId: string,
  sourceId: string,
  successorId: string,
  style: AttributeCase
): PhysicalColumn | undefined {
  if (successorId === sourceId) {
    return now.columns.find((c) => c.origin.elementId === sourceId)
  }
  const prefix = `${ownerId}#`
  if (successorId.startsWith(prefix)) {
    const name = standardLogicalName(
      { logicalName: successorId.slice(prefix.length) },
      style
    )
    return now.columns.find(
      (c) => c.origin.elementId === undefined && c.origin.standard === name
    )
  }
  // Додана колонка скоупу не має ні елемента, ні стандартного імені.
  return now.columns.find(
    (c) =>
      c.origin.scopeKindId === successorId &&
      c.origin.elementId === undefined &&
      c.origin.standard === undefined
  )
}

interface TablePair {
  was: PhysicalTable
  now: PhysicalTable
  renames: ReadonlyMap<string, string>
}

/** Ціль кроку `fill`, розв'язана до запису. */
export type PlannedTarget =
  | { placed: PlacedColumn }
  | { standard: StandardColumnDef }
  | { attribute: string }

/**
 * Крок `fill`, перевірений до запису (рішення 12): вид виведено, таблиця й
 * ключ — у старих іменах. Нове ім'я колонки-цілі дає модель результату.
 */
export interface PlannedStep {
  promoted: PromotedTable
  /** id ТЧ; немає — основна таблиця. */
  section?: string
  target: PlannedTarget
  expression: string
  kind: PromotionRecord["dataSteps"][number]["kind"]
  schema: string
  table: string
  key: string
}

/** Таблиця одиниці: прийнята таблиця й, для ТЧ, id табличної частини. */
export interface RecordedTable {
  promoted: PromotedTable
  section?: string
}

const WIDENING: ReadonlySet<string> = new Set([
  "cascade",
  "setNull",
  "setDefault",
])

/**
 * Мапа одиниці з розміщених колонок: наступник кожної прийнятої колонки за
 * її долею. Id виду скоупу дає знімок «до»: колонка `scopeColumn` несе його
 * разом з id елемента.
 */
function unitMapping(
  before: CompiledModel,
  objectId: string,
  tables: readonly RecordedTable[]
): PromotionMapping {
  const columns: PromotionMapping["columns"] = []
  for (const { promoted, section } of tables) {
    const ownerId = section ?? objectId
    for (const { column, fate } of promoted.columns) {
      const sourceId = column.id!
      let successorId: string | null
      switch (fate.to) {
        case "standard":
          successorId = standardElementId(ownerId, fate.def)
          break
        case "attribute":
          successorId = sourceId
          break
        case "scope": {
          const scopeKindId = before.physical.tables
            .flatMap((t) => t.columns)
            .find((c) => c.origin.elementId === sourceId)?.origin.scopeKindId
          if (scopeKindId === undefined) {
            throw new Error(`scope column ${column.name} has no scope kind`)
          }
          successorId = scopeKindId
          break
        }
        case "retire":
          successorId = null
          break
        default: {
          const unhandled: never = fate
          throw new Error(`unknown column fate ${JSON.stringify(unhandled)}`)
        }
      }
      columns.push({ sourceId, successorId })
    }
  }
  return {
    objectId,
    tables: tables.map(({ promoted }) => promoted.object.id),
    columns,
  }
}

/**
 * Запис з моделей до й після (крок 9): факти виводить `derivePromotionFacts`
 * — те саме, що звірить T2, — а фізичні імена після — ті, що призначило
 * доповнення, тож запис не повторює правила імен. `objects` — об'єкти бази
 * кожного предмета класу. SQL-одиниці й переклад міток дописує
 * `promoteObject` з плану одиниць (`sql.ts`).
 */
export function promotionRecord(
  input: PromoteInput,
  before: CompiledModel,
  after: CompiledModel,
  main: PromotedTable,
  objects: ReadonlyMap<string, PromotionObject[]>,
  sections: readonly RecordedTable[] = [],
  steps: readonly PlannedStep[] = []
): PromotionRecord {
  const objectId = main.object.id
  const derived = derivePromotionFacts(
    before.physical,
    {
      physical: after.physical,
      attributeCase: after.project.naming.attributeCase,
    },
    unitMapping(before, objectId, [{ promoted: main }, ...sections])
  )
  // Для `promote` обидві моделі — його власні: розбіжність тут — помилка
  // самої операції, а не стан, який можна звітувати.
  if (!derived.ok) throw new Error(`promotion facts: ${derived.detail}`)
  const { facts } = derived
  const record: PromotionRecord = {
    format: PROMOTION_RECORD_FORMAT,
    base: before.hash,
    result: after.hash,
    objectId,
    kind: input.into.kind,
    ...facts,
    dataSteps: [],
    conversions: Object.entries(input.conversions)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([subject, cls]) => ({
        subject,
        class: cls,
        objects: objects.get(subject) ?? [],
      })),
    movedUnits: [],
    rewrittenUnits: [],
    contractChanges: [],
  }
  const promotedObject = after.objects.find((o) => o.id === objectId)
  const kindLabel = (promotedObject?.data as { kindLabel?: string } | undefined)
    ?.kindLabel
  if (kindLabel !== undefined) record.kindLabel = kindLabel

  for (const step of steps) {
    record.dataSteps.push({
      names: "beforeRenames",
      schema: step.schema,
      table: step.table,
      key: step.key,
      column: targetColumn(step, facts, promotedObject?.data),
      expression: step.expression,
      kind: step.kind,
    })
  }
  return record
}

/** Нове фізичне ім'я колонки-цілі кроку. */
function targetColumn(
  step: PlannedStep,
  facts: PromotionFacts,
  data: unknown
): string {
  const { target } = step
  if ("placed" in target) {
    const found = facts.columns.find(
      (c) => c.sourceId === target.placed.column.id
    )
    if (found === undefined) {
      throw new Error(`fill target ${target.placed.column.name} has no column`)
    }
    return found.to
  }
  if ("standard" in target) return target.standard.physicalName
  // Реквізит, якого колонки не несли, — з файлу виду: ім'я дало доповнення.
  const elements = (owner: unknown): unknown[] =>
    Object.values(owner as Record<string, unknown>).flatMap((v) =>
      Array.isArray(v) ? v : []
    )
  const holder =
    step.section === undefined
      ? data
      : (data as { tabularSections: { id?: string }[] }).tabularSections.find(
          (s) => s.id === step.section
        )
  const found = elements(holder).find(
    (e) => (e as { name?: unknown }).name === target.attribute
  ) as { physicalName?: string } | undefined
  if (found?.physicalName === undefined) {
    throw new Error(`fill target ${target.attribute} has no column`)
  }
  return found.physicalName
}

/**
 * Зміни семантики видалення (рішення 5, §9.5) з двох знімків. Власні FK:
 * дія FK на ті самі колонки до й після, якщо вона змінилась, або новий FK з
 * каскадом, якого не було. Вхідні: FK з `CASCADE`/`SET NULL` таблиці поза
 * одиницею в сам об'єкт — дія та сама, але контроль посилань П3 мусить
 * її бачити.
 */
function deleteSemantics(
  after: Pick<PhysicalSnapshot, "tables">,
  objectId: string,
  pairs: readonly TablePair[]
): PromotionRecord["deleteSemantics"] {
  const found: PromotionRecord["deleteSemantics"] = []
  for (const { was, now, renames } of pairs) {
    for (const fk of now.foreignKeys) {
      const old = was.foreignKeys.find(
        (o) =>
          o.columns.length === fk.columns.length &&
          o.columns.every((c, i) => renames.get(c) === fk.columns[i])
      )
      const from = old?.onDelete ?? "none"
      if (from === fk.onDelete) continue
      if (old === undefined && !WIDENING.has(fk.onDelete)) continue
      found.push({
        direction: "own",
        schema: now.schema,
        table: now.name,
        constraint: fk.name,
        columns: fk.columns,
        target: fk.references.table,
        from,
        to: fk.onDelete,
      })
    }
  }
  // Вхідне посилання ззовні — лише на сам об'єкт: на таблицю ТЧ воно
  // відмовляє ще в каскаді (рішення 5).
  // Ключ — структурний: ім'я з крапкою не злипається зі схемою.
  const unit = new Set(
    pairs.slice(0, 1).map(({ now }) => JSON.stringify([now.schema, now.name]))
  )
  for (const table of after.tables) {
    if (table.origin.objectId === objectId) continue
    for (const fk of table.foreignKeys) {
      const target = JSON.stringify([fk.references.schema, fk.references.table])
      if (!unit.has(target) || !WIDENING.has(fk.onDelete)) continue
      found.push({
        direction: "incoming",
        schema: table.schema,
        table: table.name,
        constraint: fk.name,
        columns: fk.columns,
        target: fk.references.table,
        from: fk.onDelete,
        to: fk.onDelete,
      })
    }
  }
  return found
}
