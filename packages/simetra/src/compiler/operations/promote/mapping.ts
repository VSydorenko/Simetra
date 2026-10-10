import {
  KIND_REGISTRY,
  singleUuidKeyColumn,
  type CustomTable,
  type MetadataKind,
  type StandardColumnDef,
} from "simetra/model"
import type { CompiledModel, SourceObject } from "../../compile"
import { diagnostic, toPointer, type Diagnostic } from "../../diagnostics"
import { isRecord, type Json } from "../../object-files"
import type { PromoteInput } from "../inputs"

export type TableColumn = CustomTable["columns"][number]
type ColumnMappings = PromoteInput["columns"]

/** Доля колонки після розбору мапінгу. */
export type ColumnFate =
  | { to: "standard"; def: StandardColumnDef }
  | { to: "scope" }
  | { to: "attribute"; collection: string; element: Json }
  | { to: "retire" }

export interface PlacedColumn {
  /** Індекс у `columns` прийнятої таблиці — pointer діагностик. */
  index: number
  column: TableColumn
  fate: ColumnFate
}

/** Прийнята таблиця одиниці промоції з розміщеними колонками. */
export interface PromotedTable {
  object: SourceObject
  table: CustomTable
  columns: PlacedColumn[]
}

/** Ціль промоції: вид і ім'я нового об'єкта з розібраними налаштуваннями. */
export interface PromotionTarget {
  kind: MetadataKind
  name: string
  standard: readonly StandardColumnDef[]
}

/** Ключ `conversions` для значення за замовчуванням колонки (рішення 5). */
export const defaultSubject = (table: string, column: string) =>
  `${table}#default/${column}`

/** Структурні елементи, що потребують класу конверсії (рішення 5). */
const CLASSIFIED_COLLECTIONS = ["uniques", "checks", "indexes"] as const

/**
 * Чому колонку не перенести в реквізит. Сирий тип, генерована й
 * identity-колонка та явна колляція не мають відповідника в реквізиті виду:
 * перенесення мовчки змінило б фізику, тож лишається лише вивести з ужитку.
 */
function unsupportedType(column: TableColumn): string | undefined {
  if (column.type === "Raw") return `raw type ${column.pgType ?? ""}`.trim()
  if (column.generated !== undefined) return "a generated column"
  if (column.identity !== undefined) return "an identity column"
  if (column.collation !== undefined) return "an explicit collation"
  return undefined
}

/**
 * Мітки енаму, яких бракує перерахуванню-цілі (рішення 9). Колонка енаму
 * мапиться лише на `Ref` до виду зі значеннями-елементами, мітки (`physicalName`
 * значень) якого включають усі мітки енаму: так дані колонки лишаються
 * дійсними значеннями без кроку даних (Пр9).
 */
function missingEnumLabels(
  model: CompiledModel,
  column: TableColumn,
  fate: ColumnFate
): { enum: string; labels: string[] } | undefined {
  if (column.type !== "PgEnum" || column.enum === undefined) return undefined
  const pgEnum = model.objects.find(
    (o) => o.kind === "PgEnum" && o.name === column.enum!.name
  )
  const labels = (pgEnum?.data as { values?: string[] } | undefined)?.values
  const all = labels ?? []
  const missing = (have: ReadonlySet<string>) => {
    const lacking = all.filter((label) => !have.has(label))
    return lacking.length === 0
      ? undefined
      : { enum: column.enum!.name, labels: lacking }
  }
  if (fate.to !== "attribute") return missing(new Set())
  const { element } = fate
  const ref = element.ref
  if (
    element.type !== "Ref" ||
    !isRecord(ref) ||
    typeof ref.kind !== "string" ||
    !Object.hasOwn(KIND_REGISTRY, ref.kind) ||
    !KIND_REGISTRY[ref.kind as MetadataKind].valueElements
  ) {
    return missing(new Set())
  }
  const target = model.objects.find(
    (o) => o.kind === ref.kind && o.name === ref.name
  )
  const values = (target?.data as { values?: Json[] } | undefined)?.values
  return missing(
    new Set(
      (values ?? []).flatMap((v) =>
        typeof v.physicalName === "string" ? [v.physicalName] : []
      )
    )
  )
}

/**
 * Розміщує кожну колонку прийнятої таблиці за мапінгом (спека промоції §4):
 * рівно одна доля на колонку, кожна ціль один раз, без евристик.
 * `at` — шлях мапінгу у вході (`["columns"]`), з нього pointer відмов входу.
 */
export function placeColumns(
  model: CompiledModel,
  object: SourceObject,
  mappings: ColumnMappings,
  at: readonly string[],
  target: PromotionTarget,
  conversions: PromoteInput["conversions"]
): { table: PromotedTable; problems: Diagnostic[] } {
  const table = object.data as CustomTable
  const problems: Diagnostic[] = []
  const unknown = (path: readonly string[], detail: string) =>
    problems.push(
      diagnostic("promote.mapping-unknown", "", "", {
        at: toPointer([...at, ...path]),
        detail,
      })
    )
  const onColumn = (
    code: Parameters<typeof diagnostic>[0],
    index: number,
    params: Record<string, string>
  ) =>
    problems.push(
      diagnostic(code, object.file, `/columns/${index}`, {
        table: object.name,
        column: table.columns[index]!.name,
        ...params,
      })
    )

  const names = new Set(table.columns.map((c) => c.name))
  for (const key of Object.keys(mappings)) {
    if (!names.has(key)) unknown([key], `${object.name} has no column ${key}`)
  }

  const def = KIND_REGISTRY[target.kind]
  const key = singleUuidKeyColumn(table)
  const targets = new Map<string, string>()
  const placed: PlacedColumn[] = []
  table.columns.forEach((column, index) => {
    const mapping = mappings[column.name]
    if (mapping === undefined) {
      onColumn("promote.column-unplaced", index, {})
      return
    }
    let fate: ColumnFate
    let targetKey: string | undefined
    switch (mapping.to) {
      case "standard": {
        // Поліморфна стандартна колонка — пара, а не одна колонка.
        const standard = target.standard.find(
          (s) => s.logicalName === mapping.name && s.polymorphic === undefined
        )
        if (standard === undefined) {
          unknown(
            [column.name, "name"],
            `${target.kind} ${target.name} has no standard attribute ${mapping.name} with these settings`
          )
          return
        }
        // Ключ виду несе ідентичність рядка: його дає лише єдиний uuid-ключ.
        if (standard.primaryKey === true && key?.name !== column.name) {
          unknown(
            [column.name, "name"],
            `${mapping.name} is the key of ${target.kind}, and ${column.name} is not the single uuid key of ${object.name}`
          )
          return
        }
        fate = { to: "standard", def: standard }
        targetKey = `standard ${standard.logicalName}`
        break
      }
      case "scope":
        if (table.scopeColumn !== column.name) {
          unknown(
            [column.name],
            `${column.name} is not the scope column of ${object.name}`
          )
          return
        }
        fate = { to: "scope" }
        targetKey = "scope"
        break
      case "attribute":
        if (!def.columnFields.includes(mapping.collection)) {
          unknown(
            [column.name, "collection"],
            `${target.kind} has no collection ${mapping.collection}`
          )
          return
        }
        fate = {
          to: "attribute",
          collection: mapping.collection,
          element: mapping.element,
        }
        targetKey = `attribute ${String(mapping.element.name)}`
        break
      case "retire":
        fate = { to: "retire" }
        break
      default: {
        const unhandled: never = mapping
        throw new Error(`unknown column mapping ${JSON.stringify(unhandled)}`)
      }
    }
    if (targetKey !== undefined) {
      const taken = targets.get(targetKey)
      if (taken !== undefined) {
        unknown(
          [column.name],
          `${targetKey} is already the target of column ${taken}`
        )
        return
      }
      targets.set(targetKey, column.name)
    }

    if (fate.to !== "retire") {
      const reason = unsupportedType(column)
      if (reason !== undefined) {
        onColumn("promote.type-unsupported", index, { detail: reason })
      }
      const enumLabels = missingEnumLabels(model, column, fate)
      if (enumLabels !== undefined) {
        onColumn("promote.enum-labels", index, {
          enum: enumLabels.enum,
          labels: enumLabels.labels.join(", "),
        })
      }
    }
    // Значення стандартної колонки дає вид; власного реквізиту — лише
    // `defaultValue` елемента або явний клас (рішення 5).
    const subject = defaultSubject(object.name, column.name)
    if (
      column.default !== undefined &&
      fate.to === "attribute" &&
      fate.element.defaultValue === undefined &&
      conversions[subject] === undefined
    ) {
      onColumn("promote.default-unplaced", index, { subject })
    }
    placed.push({ index, column, fate })
  })

  // Носій скоупу — колонка виду, похідна від виду скоупу; реквізит поруч з
  // нею дублював би значення.
  const scopeColumn = table.scopeColumn
  const scopeMapping =
    scopeColumn === undefined ? undefined : mappings[scopeColumn]
  if (scopeMapping !== undefined && scopeMapping.to !== "scope") {
    unknown(
      [scopeColumn!],
      `${scopeColumn!} is the scope column of ${object.name} and maps only to the scope`
    )
  }
  return { table: { object, table, columns: placed }, problems }
}

/**
 * Предмети класу конверсії таблиці (рішення 5) з місцем у файлі: прийняті
 * `uniques`/`checks`/`indexes` (ім'я, а без нього — індекс) і значення за
 * замовчуванням колонок, змаплених на власний реквізит. Задача 9 додає до
 * них SQL-одиниці.
 */
export function structuralSubjects(
  promoted: PromotedTable
): { subject: string; file: string; pointer: string; required: boolean }[] {
  const { object, table } = promoted
  const found = CLASSIFIED_COLLECTIONS.flatMap((collection) =>
    table[collection].map((element, index) => ({
      subject: `${object.name}#${collection}/${element.name ?? index}`,
      file: object.file,
      pointer: `/${collection}/${index}`,
      required: true,
    }))
  )
  for (const { index, column, fate } of promoted.columns) {
    if (column.default === undefined || fate.to !== "attribute") continue
    // Обов'язковий клас перевіряє `placeColumns` разом із `defaultValue`.
    found.push({
      subject: defaultSubject(object.name, column.name),
      file: object.file,
      pointer: `/columns/${index}`,
      required: false,
    })
  }
  return found
}

/**
 * Стандартні колонки, яких без мапінгу чи кроку `fill` на непорожній
 * таблиці не створити: `NOT NULL` без значення за замовчуванням і без
 * генерації (рішення 12).
 */
export function missingFills(
  promoted: PromotedTable,
  target: PromotionTarget,
  fill: PromoteInput["fill"]
): Diagnostic[] {
  const mapped = new Set(
    promoted.columns.flatMap(({ fate }) =>
      fate.to === "standard" ? [fate.def.logicalName] : []
    )
  )
  const filled = new Set(
    fill
      .filter((step) => step.table === undefined)
      .flatMap((step) =>
        step.target.to === "standard" ? [step.target.name] : []
      )
  )
  return target.standard
    .filter(
      (column) =>
        column.notNull &&
        column.default === undefined &&
        column.defaultValue === undefined &&
        column.generated === undefined &&
        !mapped.has(column.logicalName) &&
        !filled.has(column.logicalName)
    )
    .map((column) =>
      diagnostic("promote.fill-missing", promoted.object.file, "", {
        column: column.logicalName,
        kind: target.kind,
        name: target.name,
      })
    )
}
