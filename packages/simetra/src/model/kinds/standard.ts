import type { z } from "zod"
import type { Attribute } from "../schemas/attribute"
import type { FkAction } from "../schemas/custom-table"
import { toSnakeCase, type AttributeCase } from "../schemas/identity"
import type { LocalizedString } from "../schemas/localized-string"
import type { MetadataKind } from "../schemas/metadata-kind"
import type { MetadataRef } from "../schemas/metadata-ref"
import type { TabularSection } from "../schemas/tabular-section"
import type { ValueType } from "../schemas/value-type"

/**
 * Хто призначає ключ і як пишуться рядки (спека П2 §5): довідник —
 * оптимістично з клієнта, документ і регістри — лише через сервер; у видів
 * без рядків даних патерну немає.
 */
export type WritePattern = "optimistic" | "server" | "none"

/**
 * Стандартний реквізит разом із фізичними фактами. Ці факти — частина моделі,
 * а не знання генератора: рендер наступних шарів про види не знає (спека §5).
 */
export interface StandardColumnDef {
  /** Канонічне camelCase-ім'я; стиль проєкту застосовує standardLogicalName. */
  logicalName: string
  /**
   * Ім'я прототипу. Для поліморфної колонки — основа пари
   * `<основа>_type` + `<основа>_id`.
   */
  physicalName: string
  type: ValueType | { raw: string }
  notNull: boolean
  /** SQL-вираз значення за замовчуванням. */
  default?: string
  /** Вираз CHECK колонки (без обгортки `CHECK (...)`). */
  check?: string
  primaryKey?: true
  /**
   * Ключ рядка-одинака: ключ без жодної частини — глобальна константа,
   * регістр без вимірів і періоду, підсумки регістра без вимірів. Колонка
   * існує лише в нескоупленій формі таблиці; у скоупленій рядок один на
   * значення скоупу, тож скоуп-колонка перебирає роль ключа цієї колонки
   * (PK чи UNIQUE), а сама вона (з її CHECK) не матеріалізується.
   */
  singleton?: true
  /**
   * Значення дає оболонка проведення, а не запит рухів (реєстратор, номер
   * рядка, активність), тож колонки немає в `RETURNS TABLE` запиту (спека §7).
   */
  filledByShell?: true
  indexed?: true
  unique?: true
  /** Ціль посилання; сама колонка має тип UUID. */
  ref?: "self" | "owningObject" | "owners" | "recorders"
  /** Дія FK при видаленні цілі — лише там, де вона не типова. */
  onDelete?: FkAction
  /**
   * `whenMany` — пара лише за кількох цілей (як поліморфний Ref), `always` —
   * пара за будь-якої кількості цілей (реєстратор).
   */
  polymorphic?: "whenMany" | "always"
  title: LocalizedString
}

/**
 * Роль посилання у файлі — для індексу посилань і правил стадій. Перелік
 * відкритий: вирази конструктора рухів додадуть свої ролі.
 */
export type ReferenceRole =
  | "attribute.ref"
  | "attribute.allowedType"
  | "constant.ref"
  | "constant.allowedType"
  | "catalog.owner"
  | "register.recorder"
  | "register.balanceControl"
  | "document.registerMovement"
  | "posting.register"
  | "posting.registerField"
  | "posting.docField"
  | "posting.rowField"
  | "posting.tabularSection"
  | "posting.movementsBlock"
  | "customTable.foreignKey"
  | "customTable.pgEnum"
  | "customTable.scopeColumn"
  | "object.scope"
  | "scopeKind.root"

export interface FoundReference {
  /** JSON Pointer (RFC 6901) на місце посилання у файлі. */
  pointer: string
  ref: MetadataRef
  role: ReferenceRole
}

/**
 * Ключі таблиць регістра (спека П2 §7, «Ключі й індекси регістрів»): факт
 * виду, тож стадія 3 будує ключі за ним, а не за назвою виду.
 */
export interface RegisterKeySpec {
  /**
   * PK таблиці рухів: `recorder` — `(recorder_type, recorder_id, line_number)`,
   * бо оболонка переписує рухи за реєстратором; `dimensions` —
   * `(носій скоупу, виміри…, period)` без відсутніх частин.
   */
  movementsPrimaryKey: "recorder" | "dimensions"
  /**
   * `UNIQUE (носій скоупу, виміри…, period)` поруч із PK реєстратора. Той
   * самий ключ запису служить і зрізу останніх/перших за ключем.
   */
  dimensionsUnique: boolean
  /**
   * Індекси рухів `(носій, виміри…, period)` і `(носій, period)` — для
   * залишків за ключем і оборотів за період; регістру відомостей їх дає ключ
   * запису, а оборотів у нього немає.
   */
  movementIndexes: boolean
  /** «Порожній» вимір — порожнє значення, а не NULL: виміри входять у ключі. */
  dimensionsNotNull: true
  /** Таблиця поточних підсумків `<регістр>_totals`. */
  totals: boolean
  /**
   * Ресурси сумуються (регістр накопичення): кожен рух дає значення кожного
   * ресурсу, і `NULL` його не заступить. Ресурс регістра відомостей —
   * значення, тож обов'язковий лише `required`.
   */
  additiveResources: boolean
}

export interface KindDefinition {
  kind: MetadataKind
  /** Тека виду в `metadata/` (спека §3). */
  dir: string
  schema: z.ZodType
  /** Порядок ключів верхнього рівня для канонічного форматера. */
  keyOrder: readonly string[]
  referenceable: boolean
  writePattern: WritePattern
  actions: readonly string[]
  materializes: "table" | "enumType" | "none"
  /**
   * Політика скоупу виду: `required` — об'єкт має вказати вид скоупу або
   * `none`, `noneOnly` — допустиме лише `none`, `absent` — поля немає.
   */
  scope: "required" | "noneOnly" | "absent"
  /**
   * Фізичну форму файл описує як є (спека §4): прийнята таблиця й енам-тип
   * нічого не виводять із виду, тож стадія 3 бере їх з опису.
   */
  declared: boolean
  /**
   * Поля з дочірніми елементами, що стають колонками основної таблиці, — у
   * порядку колонок (спека §8.1). Разом із табличними частинами вони ділять
   * простір імен об'єкта.
   */
  columnFields: readonly string[]
  /**
   * Значення виду — елементи з ідентичністю (id, physicalName), а не голі
   * мітки: вони мають власний простір імен, але колонок не дають.
   */
  valueElements: boolean
  /**
   * Види, що можуть бути власником об'єкта цього виду (`owners`). Є лише у
   * видів із підпорядкуванням власнику: як у 1С, власник довідника — довідник.
   */
  ownerKinds?: readonly MetadataKind[]
  /** Стандартні колонки основної таблиці для розібраного файлу виду. */
  standardColumns(obj: unknown): StandardColumnDef[]
  /**
   * Стандартні колонки рядка табличної частини. Є лише у видів, яким
   * дозволені ТЧ, тож його наявність і є цим дозволом.
   */
  tabularSectionColumns?(obj: unknown): StandardColumnDef[]
  references(obj: unknown): FoundReference[]
  /** Ключі таблиць регістра; є лише у видів-регістрів. */
  registerKeys?(obj: unknown): RegisterKeySpec
}

/**
 * Логічне ім'я стандартного реквізиту в стилі проєкту (спека §3, М16). Ключ
 * `ref` однаковий в обох стилях, решта в snake_case — пряма зміна регістру.
 */
export function standardLogicalName(
  def: StandardColumnDef,
  style: AttributeCase
): string {
  if (style === "camelCase" || def.logicalName === "ref") return def.logicalName
  return toSnakeCase(def.logicalName)
}

/** Спільна шапка файлу завжди йде першою, щоб файли всіх видів читалися однаково. */
const HEADER_KEY_ORDER = [
  "$schema",
  "id",
  "kind",
  "name",
  "physicalName",
  "schema",
  "scope",
  "title",
  "description",
] as const

/**
 * Порядок ключів — шапка, далі решта полів у порядку оголошення в схемі виду:
 * так порядок форматера не може розійтися зі схемою.
 */
export function keyOrderOf(schema: z.ZodObject): readonly string[] {
  const header: readonly string[] = HEADER_KEY_ORDER
  const keys = Object.keys(schema.shape)
  // У виду може не бути частини шапки (PgEnum без `scope`).
  return [
    ...header.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !header.includes(key)),
  ]
}

// --- Будівельні блоки стандартних колонок ---------------------------------

export function keyColumn(withDefault: boolean): StandardColumnDef {
  return {
    logicalName: "ref",
    physicalName: "id",
    type: { type: "UUID" },
    notNull: true,
    primaryKey: true,
    // Оптимістичний патерн: id дає клієнт, тож серверного DEFAULT немає.
    ...(withDefault ? { default: "gen_random_uuid()" } : {}),
    title: { uk: "Посилання", en: "Reference" },
  }
}

export function deletionMarkColumn(): StandardColumnDef {
  return {
    logicalName: "deletionMark",
    physicalName: "deletion_mark",
    type: { type: "Boolean" },
    notNull: true,
    default: "false",
    title: { uk: "Позначка видалення", en: "Deletion mark" },
  }
}

export function serviceDateColumns(): StandardColumnDef[] {
  return [
    {
      logicalName: "createdAt",
      physicalName: "created_at",
      type: { type: "DateTime" },
      notNull: true,
      default: "now()",
      title: { uk: "Дата створення", en: "Created at" },
    },
    {
      logicalName: "updatedAt",
      physicalName: "updated_at",
      type: { type: "DateTime" },
      notNull: true,
      default: "now()",
      title: { uk: "Дата оновлення", en: "Updated at" },
    },
  ]
}

/** Номер чи код: рядок заданої довжини або ціле число. */
export function numberingType(
  kind: "String" | "Number",
  length: number
): ValueType {
  return kind === "String" ? { type: "String", length } : { type: "Integer" }
}

/**
 * Окремого індексу на `period` немає: період входить в індекси рухів і в
 * ключ регістра (стадія 3 за `registerKeys`).
 */
export function periodColumn(): StandardColumnDef {
  return {
    logicalName: "period",
    physicalName: "period",
    type: { type: "DateTime" },
    notNull: true,
    title: { uk: "Період", en: "Period" },
  }
}

/**
 * Ключ рядка-одинака: колонка, що може мати лише значення true. `unique` —
 * одинак як ключ запису поруч з іншим PK (підлеглий регістр відомостей).
 */
export function singletonColumn(
  role: "primaryKey" | "unique" = "primaryKey"
): StandardColumnDef {
  return {
    logicalName: "singleton",
    physicalName: "singleton",
    type: { type: "Boolean" },
    notNull: true,
    ...(role === "primaryKey" ? { primaryKey: true } : { unique: true }),
    singleton: true,
    default: "true",
    check: "singleton",
    title: { uk: "Одинак", en: "Singleton" },
  }
}

/** Реєстратор, номер рядка й активність рухів — разом, як у 1С. */
export function recorderColumns(): StandardColumnDef[] {
  return [
    {
      logicalName: "recorder",
      physicalName: "recorder",
      type: { type: "UUID" },
      notNull: true,
      ref: "recorders",
      polymorphic: "always",
      filledByShell: true,
      title: { uk: "Реєстратор", en: "Recorder" },
    },
    // Номер рядка ТЧ — дані рядка; номер рядка рухів нумерує оболонка.
    { ...lineNumberColumn(), filledByShell: true },
    {
      logicalName: "active",
      physicalName: "active",
      type: { type: "Boolean" },
      notNull: true,
      default: "true",
      filledByShell: true,
      title: { uk: "Активність", en: "Active" },
    },
  ]
}

function lineNumberColumn(): StandardColumnDef {
  return {
    logicalName: "lineNumber",
    physicalName: "line_number",
    type: { type: "Integer" },
    notNull: true,
    title: { uk: "Номер рядка", en: "Line number" },
  }
}

/** Рядок ТЧ живе й помирає разом із власником — звідси каскад. */
export function tabularRowColumns(keyDefault: boolean): StandardColumnDef[] {
  return [
    keyColumn(keyDefault),
    {
      logicalName: "parent",
      physicalName: "parent_id",
      type: { type: "UUID" },
      notNull: true,
      ref: "owningObject",
      onDelete: "cascade",
      indexed: true,
      title: { uk: "Власник рядка", en: "Owning object" },
    },
    lineNumberColumn(),
  ]
}

// --- Пошук посилань -------------------------------------------------------

type TypedField = Pick<ValueType, "ref" | "allowedTypes">

/** Посилання одного поля з типом (реквізит, вимір, ресурс, колонка). */
export function valueTypeReferences(
  field: TypedField,
  pointer: string,
  roles: { ref: ReferenceRole; allowedType: ReferenceRole }
): FoundReference[] {
  const found: FoundReference[] = []
  if (field.ref !== undefined) {
    found.push({ pointer: `${pointer}/ref`, ref: field.ref, role: roles.ref })
  }
  field.allowedTypes?.forEach((ref, index) => {
    found.push({
      pointer: `${pointer}/allowedTypes/${index}`,
      ref,
      role: roles.allowedType,
    })
  })
  return found
}

export const ATTRIBUTE_ROLES = {
  ref: "attribute.ref",
  allowedType: "attribute.allowedType",
} as const

export function fieldListReferences(
  fields: readonly TypedField[],
  pointer: string
): FoundReference[] {
  return fields.flatMap((field, index) =>
    valueTypeReferences(field, `${pointer}/${index}`, ATTRIBUTE_ROLES)
  )
}

export function refListReferences(
  refs: readonly MetadataRef[],
  pointer: string,
  role: ReferenceRole
): FoundReference[] {
  return refs.map((ref, index) => ({
    pointer: `${pointer}/${index}`,
    ref,
    role,
  }))
}

/** Реквізити об'єкта й реквізити його табличних частин. */
export function objectFieldReferences(obj: {
  attributes: readonly Attribute[]
  tabularSections: readonly TabularSection[]
}): FoundReference[] {
  return [
    ...fieldListReferences(obj.attributes, "/attributes"),
    ...obj.tabularSections.flatMap((section, index) =>
      fieldListReferences(
        section.attributes,
        `/tabularSections/${index}/attributes`
      )
    ),
  ]
}
