import type { PhysicalColumn, PhysicalTable } from "simetra/model"
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
  // Будь-який бік (§9.5, Пр8); для "incoming" дія не змінюється (to === from), але потребує дозволу.
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

/** Основна таблиця об'єкта у фізичному знімку (без ТЧ і похідних таблиць). */
function mainTable(
  model: CompiledModel,
  objectId: string
): PhysicalTable | undefined {
  return model.physical.tables.find(
    ({ origin }) =>
      origin.objectId === objectId &&
      origin.tabularSectionId === undefined &&
      origin.part === undefined
  )
}

/**
 * Колонка виду, якою стала прийнята колонка, разом з id, що його бачить
 * планувальник: так перейменування розпізнається з ідентичності (§5).
 */
function successor(
  table: PhysicalTable,
  objectId: string,
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
        () => standardElementId(objectId, fate.def)
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

/**
 * Запис з моделей до й після (крок 9): фізичні імена після — ті, що
 * призначило доповнення, тож запис не повторює правила імен. Кроки даних,
 * семантику видалення, SQL-одиниці й переклад міток додають задачі 8–9.
 */
export function promotionRecord(
  input: PromoteInput,
  before: CompiledModel,
  after: CompiledModel,
  main: PromotedTable
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
  const kindLabel = (
    after.objects.find((o) => o.id === objectId)?.data as
      { kindLabel?: string } | undefined
  )?.kindLabel
  if (kindLabel !== undefined) record.kindLabel = kindLabel
  record.labelDropped =
    main.table.kindLabel !== undefined && kindLabel === undefined

  const was = mainTable(before, objectId)
  const now = mainTable(after, objectId)
  if (was === undefined || now === undefined) {
    throw new Error(`promoted object ${objectId} has no table`)
  }
  const { schema } = now
  record.tables.push({ id: objectId, schema, from: was.name, to: now.name })
  if (was.rowLevelSecurity !== now.rowLevelSecurity) {
    // Вид 1С має RLS увімкненим завжди (реєстр видів): інший режим після
    // промоції — розбіжність, а не стан, який запис уміє назвати.
    if (
      was.rowLevelSecurity === "enabled" ||
      now.rowLevelSecurity !== "enabled"
    ) {
      throw new Error(`unexpected RLS change on ${schema}.${was.name}`)
    }
    record.rowLevelSecurity.push({
      schema,
      table: was.name,
      from: was.rowLevelSecurity,
      to: now.rowLevelSecurity,
    })
  }
  for (const placed of main.columns) {
    const old = was.columns.find((c) => c.origin.elementId === placed.column.id)
    if (old === undefined) {
      throw new Error(`column ${placed.column.name} is missing in the snapshot`)
    }
    const next = successor(now, objectId, placed)
    if (next === undefined) {
      record.retired.push({ schema, table: was.name, column: old.name })
      continue
    }
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
  return record
}
