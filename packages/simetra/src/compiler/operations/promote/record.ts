import type {
  PhysicalColumn,
  PhysicalTable,
  StandardColumnDef,
} from "simetra/model"
import type { CompiledModel } from "../../compile"
import { compareStrings } from "../../diagnostics"
import { standardElementId } from "../../stages/identity"
import type { ConversionClass, PromoteInput } from "../inputs"
import type { OperationResult } from "../types"
import type { PlacedColumn, PromotedTable } from "./mapping"

/**
 * Запис промоції (спека промоції §7.1, рішення плану 2): перегляд «що на що
 * перетворюється» і вхід плану бази П3. Мапінг у `metadata/` не лишається
 * (§4), тож усе, що П3 має знати про старий стан, несе цей запис. Імена
 * таблиць і колонок — фізичні; де стан імен не названо явно, це імена після
 * перейменувань (`retired` і `dataSteps` — до них).
 */
export interface PromotionRecord {
  objectId: string
  kind: "Catalog" | "Document" | "InformationRegister"
  kindLabel?: string
  labelDropped: boolean
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
    kind: "repair" | "conversion" | "split" | "backfill"
  }[]
  retired: { schema: string; table: string; column: string }[] // старі імена
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
  conversions: { subject: string; class: ConversionClass }[]
  movedUnits: { identity: string; from: string; to: string }[]
  rewrittenUnits: { identity: string; file: string }[]
  contractChanges: {
    identity: string
    file: string
    line: number
    reason: string
    via?: string[]
  }[] // via — ланцюжок викликачів
}

export interface PromoteResult extends OperationResult {
  record?: PromotionRecord // record — лише коли ok
}

/** Таблиця об'єкта в знімку: основна (без `section`) чи таблиця ТЧ. */
function tableOf(
  model: CompiledModel,
  objectId: string,
  section?: string
): PhysicalTable | undefined {
  return model.physical.tables.find(
    ({ origin }) =>
      origin.objectId === objectId &&
      origin.tabularSectionId === section &&
      origin.part === undefined
  )
}

/**
 * Колонка виду, якою стала прийнята колонка, разом з id, що його бачить
 * планувальник: так перейменування розпізнається з ідентичності (§5).
 * `ownerId` — власник стандартних реквізитів: об'єкт чи ТЧ.
 */
function successor(
  table: PhysicalTable,
  ownerId: string,
  { column, fate }: PlacedColumn
): { id: string; column: PhysicalColumn } | undefined {
  const found = (
    predicate: (c: PhysicalColumn) => boolean,
    id: (c: PhysicalColumn) => string
  ) => {
    const c = table.columns.find(predicate)
    // Розміщена колонка без наступника — розбіжність файлу виду й знімка.
    if (c === undefined) throw new Error(`${column.name} has no successor`)
    return { id: id(c), column: c }
  }
  switch (fate.to) {
    case "standard":
      return found(
        (c) => c.name === fate.def.physicalName,
        () => standardElementId(ownerId, fate.def)
      )
    case "attribute":
      return found(
        (c) => c.origin.elementId === column.id,
        () => column.id!
      )
    case "scope":
      // Додана колонка скоупу не має ні елемента, ні стандартного імені.
      return found(
        (c) =>
          c.origin.scopeKindId !== undefined &&
          c.origin.elementId === undefined &&
          c.origin.standard === undefined,
        (c) => c.origin.scopeKindId!
      )
    case "retire":
      return undefined
    default: {
      const unhandled: never = fate
      throw new Error(`unknown column fate ${JSON.stringify(unhandled)}`)
    }
  }
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
 * Запис з моделей до й після (крок 9): фізичні імена після — ті, що
 * призначило доповнення, тож запис не повторює правила імен. SQL-одиниці й
 * переклад міток додає задача 9.
 */
export function promotionRecord(
  input: PromoteInput,
  before: CompiledModel,
  after: CompiledModel,
  main: PromotedTable,
  sections: readonly RecordedTable[] = [],
  steps: readonly PlannedStep[] = []
): PromotionRecord {
  const objectId = main.object.id
  const record: PromotionRecord = {
    objectId,
    kind: input.into.kind,
    labelDropped: false,
    tables: [],
    columns: [],
    typeChanges: [],
    dataSteps: [],
    retired: [],
    relaxed: [],
    tightened: [],
    rowLevelSecurity: [],
    deleteSemantics: [],
    conversions: Object.entries(input.conversions)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([subject, cls]) => ({ subject, class: cls })),
    movedUnits: [],
    rewrittenUnits: [],
    contractChanges: [],
  }
  const promotedObject = after.objects.find((o) => o.id === objectId)
  const kindLabel = (promotedObject?.data as { kindLabel?: string } | undefined)
    ?.kindLabel
  if (kindLabel !== undefined) record.kindLabel = kindLabel
  record.labelDropped =
    main.table.kindLabel !== undefined && kindLabel === undefined

  // Старі й нові таблиці одиниці, з мапою «стара колонка → нова».
  const pairs: {
    was: PhysicalTable
    now: PhysicalTable
    renames: Map<string, string>
  }[] = []
  for (const { promoted, section } of [{ promoted: main }, ...sections]) {
    const was = tableOf(before, promoted.object.id)
    const now = tableOf(after, objectId, section)
    if (was === undefined || now === undefined) {
      throw new Error(`promoted table ${promoted.object.id} has no table`)
    }
    const renames = new Map<string, string>()
    pairs.push({ was, now, renames })
    recordTable(record, promoted, section ?? objectId, was, now, renames)
  }

  for (const step of steps) {
    const pair = pairs.find(
      (p) => p.now === tableOf(after, objectId, step.section)
    )!
    record.dataSteps.push({
      names: "beforeRenames",
      schema: step.schema,
      table: step.table,
      key: step.key,
      column: targetColumn(step, pair.now, promotedObject?.data),
      expression: step.expression,
      kind: step.kind,
    })
  }

  record.deleteSemantics = deleteSemantics(after, objectId, pairs)
  return record
}

/** Таблиця одиниці в записі: перейменування, колонки, обмеження, RLS. */
function recordTable(
  record: PromotionRecord,
  promoted: PromotedTable,
  ownerId: string,
  was: PhysicalTable,
  now: PhysicalTable,
  renames: Map<string, string>
): void {
  const { schema } = now
  record.tables.push({ id: ownerId, schema, from: was.name, to: now.name })
  if (was.rowLevelSecurity !== now.rowLevelSecurity) {
    // Вид 1С має RLS увімкненим завжди (реєстр видів), рядки ТЧ — RLS
    // власника: інший режим після промоції — розбіжність, а не стан, який
    // запис уміє назвати.
    if (
      was.rowLevelSecurity === "enabled" ||
      now.rowLevelSecurity !== "enabled"
    ) {
      throw new Error(`unexpected RLS change on ${schema}.${was.name}`)
    }
    record.rowLevelSecurity.push({
      schema: was.schema,
      table: was.name,
      from: was.rowLevelSecurity,
      to: now.rowLevelSecurity,
    })
  }
  for (const placed of promoted.columns) {
    const old = was.columns.find((c) => c.origin.elementId === placed.column.id)
    if (old === undefined) {
      throw new Error(`column ${placed.column.name} is missing in the snapshot`)
    }
    const next = successor(now, ownerId, placed)
    if (next === undefined) {
      record.retired.push({
        schema: was.schema,
        table: was.name,
        column: old.name,
      })
      continue
    }
    renames.set(old.name, next.column.name)
    const at = { schema, table: now.name, column: next.column.name }
    record.columns.push({
      id: next.id,
      schema,
      table: now.name,
      from: old.name,
      to: next.column.name,
    })
    if (old.type !== next.column.type) {
      record.typeChanges.push({ ...at, from: old.type, to: next.column.type })
    }
    if (old.notNull && !next.column.notNull) {
      record.relaxed.push({ ...at, constraint: "notNull" })
    }
    if (!old.notNull && next.column.notNull) {
      record.tightened.push({ ...at, constraint: "notNull" })
    }
  }
}

/** Нове фізичне ім'я колонки-цілі кроку. */
function targetColumn(
  step: PlannedStep,
  now: PhysicalTable,
  data: unknown
): string {
  const { target } = step
  if ("placed" in target) {
    return successor(
      now,
      step.section ?? step.promoted.object.id,
      target.placed
    )!.column.name
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
 * одиницею в таблицю одиниці — дія та сама, але контроль посилань П3 мусить
 * її бачити.
 */
function deleteSemantics(
  after: CompiledModel,
  objectId: string,
  pairs: readonly {
    was: PhysicalTable
    now: PhysicalTable
    renames: ReadonlyMap<string, string>
  }[]
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
  const unit = new Set(pairs.map(({ now }) => `${now.schema}.${now.name}`))
  for (const table of after.physical.tables) {
    if (table.origin.objectId === objectId) continue
    for (const fk of table.foreignKeys) {
      const target = `${fk.references.schema}.${fk.references.table}`
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
