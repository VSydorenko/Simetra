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
import type { ConversionClass, PromoteInput } from "../inputs"

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
  /** Розібрані налаштування виду (`into.data` зі значеннями за замовчуванням). */
  data: unknown
  standard: readonly StandardColumnDef[]
  /**
   * Колекції елементів, що стають колонками таблиці: поля виду з реєстру для
   * основної таблиці, реквізити — для рядка ТЧ.
   */
  collections: readonly string[]
}

/** Ключ `conversions` для значення за замовчуванням колонки (рішення 5). */
export const defaultSubject = (table: string, column: string) =>
  `${table}#default/${column}`

/** Ключ `conversions` для коментаря колонки, що його вид не несе (рішення 15). */
export const commentSubject = (table: string, column?: string) =>
  column === undefined ? `${table}#comment` : `${table}#comment/${column}`

/**
 * Коментар без місця у виді лише знімається: опис стандартного реквізиту дає
 * вид, тож іншої долі в нього немає (рішення 15).
 */
const COMMENT_CLASSES: readonly ConversionClass[] = ["removed"]

/** Структурні елементи, що потребують класу конверсії (рішення 5). */
const CLASSIFIED_COLLECTIONS = ["uniques", "checks", "indexes"] as const

/**
 * Чому колонку не перенести в реквізит. Сирий тип, генерована й
 * identity-колонка та явна колляція не мають відповідника в реквізиті виду:
 * перенесення мовчки змінило б фізику, тож лишається лише вивести з ужитку.
 */
function unsupportedType(
  column: TableColumn
): { reason: string; detail: string } | undefined {
  if (column.type === "Raw") {
    return {
      reason: "raw",
      detail: `raw type ${column.pgType ?? ""}`.trim(),
    }
  }
  if (column.generated !== undefined) {
    return { reason: "generated", detail: "a generated column" }
  }
  if (column.identity !== undefined) {
    return { reason: "identity", detail: "an identity column" }
  }
  if (column.collation !== undefined) {
    return { reason: "collation", detail: "an explicit collation" }
  }
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
  const enumRef = column.enum
  if (enumRef === undefined) return undefined
  // Об'єкт енаму шукається за посиланням колонки, а не за іменем виду.
  const pgEnum = model.objects.find(
    (o) => o.kind === enumRef.kind && o.name === enumRef.name
  )
  const all = (pgEnum?.data as { values?: string[] } | undefined)?.values ?? []
  const refused = (labels: string[]) => ({ enum: enumRef.name, labels })
  // Не `Ref` до виду зі значеннями-елементами — відмова за будь-якого набору
  // міток: інакше енам без значень пройшов би з будь-яким мапінгом.
  if (fate.to !== "attribute") return refused(all)
  const { element } = fate
  const ref = element.ref
  if (
    element.type !== "Ref" ||
    !isRecord(ref) ||
    typeof ref.kind !== "string" ||
    !Object.hasOwn(KIND_REGISTRY, ref.kind) ||
    !KIND_REGISTRY[ref.kind as MetadataKind].valueElements
  ) {
    return refused(all)
  }
  const target = model.objects.find(
    (o) => o.kind === ref.kind && o.name === ref.name
  )
  if (target === undefined) return refused(all)
  const values = (target.data as { values?: Json[] }).values ?? []
  const have = new Set(
    values.flatMap((v) =>
      typeof v.physicalName === "string" ? [v.physicalName] : []
    )
  )
  const lacking = all.filter((label) => !have.has(label))
  return lacking.length === 0 ? undefined : refused(lacking)
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
        // Колонка скоупу виду — NOT NULL, а `fill` скоуп не адресує:
        // призначення тенанта — рішення про належність даних, тож його
        // приймає звичайний конвеєр до промоції, а не крок даних.
        if (!column.notNull) {
          onColumn("promote.type-unsupported", index, {
            reason: "nullable-scope",
            detail: "the scope column allows NULL",
          })
        }
        fate = { to: "scope" }
        targetKey = "scope"
        break
      case "attribute":
        if (!target.collections.includes(mapping.collection)) {
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
      const unsupported = unsupportedType(column)
      if (unsupported !== undefined) {
        onColumn("promote.type-unsupported", index, unsupported)
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

/** Предмет класу конверсії з місцем у файлі прийнятої таблиці. */
export interface ConversionSubject {
  subject: string
  file: string
  pointer: string
  /** Відсутній клас — відмова `promote.unclassified`. */
  required: boolean
  /** Допустимі класи; немає — будь-який. */
  allowed?: readonly ConversionClass[]
}

/** Опис за мовою проєкту, як його з коментаря пише файл виду. */
const describes = (description: unknown, locale: string, comment: string) =>
  isRecord(description) && description[locale] === comment

/**
 * Предмети класу конверсії таблиці (рішення 5, 15) з місцем у файлі:
 * прийняті `uniques`/`checks`/`indexes` (ім'я, а без нього — індекс),
 * значення за замовчуванням колонок, змаплених на власний реквізит, і
 * коментарі, яким у виді немає місця. Задача 9 додає до них SQL-одиниці.
 * `description` — опис, який вхід задає елементу таблиці: `undefined` —
 * описом стає коментар, `null` — опису в елемента немає (таблична частина).
 */
export function structuralSubjects(
  promoted: PromotedTable,
  description: unknown,
  locale: string
): ConversionSubject[] {
  const { object, table } = promoted
  const found: ConversionSubject[] = CLASSIFIED_COLLECTIONS.flatMap(
    (collection) =>
      table[collection].map((element, index) => ({
        subject: `${object.name}#${collection}/${element.name ?? index}`,
        file: object.file,
        pointer: `/${collection}/${index}`,
        required: true,
      }))
  )
  // Коментар таблиці стає описом виду, якщо вхід не задає іншого; у ТЧ
  // опису немає, тож коментар її таблиці лише знімається.
  if (
    table.comment !== undefined &&
    description !== undefined &&
    (description === null || !describes(description, locale, table.comment))
  ) {
    found.push({
      subject: commentSubject(object.name),
      file: object.file,
      pointer: "/comment",
      required: true,
      allowed: COMMENT_CLASSES,
    })
  }
  for (const { index, column, fate } of promoted.columns) {
    const pointer = `/columns/${index}`
    if (column.default !== undefined && fate.to === "attribute") {
      // Обов'язковий клас перевіряє `placeColumns` разом із `defaultValue`.
      found.push({
        subject: defaultSubject(object.name, column.name),
        file: object.file,
        pointer,
        required: false,
      })
    }
    // Коментар виведеної колонки йде разом із нею; коментар реквізиту стає
    // його описом, якщо елемент не задає іншого.
    const comment = column.comment
    if (comment === undefined || fate.to === "retire") continue
    if (
      fate.to === "attribute" &&
      (fate.element.description === undefined ||
        describes(fate.element.description, locale, comment))
    ) {
      continue
    }
    found.push({
      subject: commentSubject(object.name, column.name),
      file: object.file,
      pointer: `${pointer}/comment`,
      required: true,
      allowed: COMMENT_CLASSES,
    })
  }
  return found
}

/**
 * Колонки виду `NOT NULL`, яких не створити без кроку `fill` (рішення 12,
 * 15): незмаплена стандартна колонка без значення за замовчуванням і без
 * генерації (`unmapped`) та ціль, джерело якої допускає `NULL`
 * (`nullable-source`). `DEFAULT` наявних `NULL` не заповнює, тож для
 * змапленої колонки значення виду не звільняє від кроку. `section` — ім'я
 * прийнятої таблиці ТЧ: крок `fill` адресує її полем `table`.
 */
export function missingFills(
  promoted: PromotedTable,
  target: PromotionTarget,
  fill: PromoteInput["fill"],
  section?: string
): Diagnostic[] {
  const { object } = promoted
  const filled = new Set(
    fill
      .filter((step) => step.table === section)
      .map((step) => `${step.target.to} ${step.target.name}`)
  )
  const problems: Diagnostic[] = []
  const mapped = new Set<string>()
  for (const { index, column, fate } of promoted.columns) {
    let required: { to: string; name: string } | undefined
    if (fate.to === "standard") {
      mapped.add(fate.def.logicalName)
      if (fate.def.notNull) {
        required = { to: "standard", name: fate.def.logicalName }
      }
    } else if (fate.to === "attribute" && fate.element.required === true) {
      required = { to: "attribute", name: String(fate.element.name) }
    }
    if (
      required === undefined ||
      column.notNull ||
      filled.has(`${required.to} ${required.name}`)
    ) {
      continue
    }
    problems.push(
      diagnostic("promote.fill-missing", object.file, `/columns/${index}`, {
        column: required.name,
        kind: target.kind,
        name: target.name,
        reason: "nullable-source",
        source: column.name,
      })
    )
  }
  for (const column of target.standard) {
    if (
      column.notNull &&
      column.default === undefined &&
      column.defaultValue === undefined &&
      column.generated === undefined &&
      !mapped.has(column.logicalName) &&
      !filled.has(`standard ${column.logicalName}`)
    ) {
      problems.push(
        diagnostic("promote.fill-missing", object.file, "", {
          column: column.logicalName,
          kind: target.kind,
          name: target.name,
          reason: "unmapped",
        })
      )
    }
  }
  return problems
}
