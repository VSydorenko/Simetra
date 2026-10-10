import {
  KIND_REGISTRY,
  singleUuidKeyColumn,
  standardLogicalName,
  type CustomTable,
  type MetadataRef,
} from "simetra/model"
import type { CompiledModel } from "../../compile"
import { diagnostic, type Diagnostic } from "../../diagnostics"
import type { Json } from "../../object-files"
import type { PromoteInput } from "../inputs"
import type { PromotedTable } from "./mapping"

/** Поля типу, які колонка логічного типу ділить із реквізитом. */
const TYPE_FIELDS = [
  "type",
  "length",
  "precision",
  "scale",
  "ref",
  "allowedTypes",
  "array",
] as const

/**
 * Ідентичність і фізика нового об'єкта — з прийнятої таблиці, а не з
 * `into.data`: схема, мітка й скоуп призначені раз (Пр18), тож дані виду їх
 * не перевизначають, а `physicalName` доповнення призначає канонічно
 * (рішення 10).
 */
const ASSIGNED_KEYS = [
  "id",
  "kind",
  "name",
  "physicalName",
  "kindLabel",
  "schema",
  "scope",
] as const

export interface KindFileContext {
  model: CompiledModel
  into: PromoteInput["into"]
  /**
   * Прийняті таблиці одиниці → посилання на їхні нові об'єкти: `Ref` і FK на
   * них стають посиланнями на вид, а на `CustomTable` поза одиницею — відмова
   * (§11).
   */
  unit: ReadonlyMap<string, MetadataRef>
}

/**
 * Файл виду з прийнятої таблиці (спека промоції §7.1): шапка й `into.data`,
 * реквізити з колонок у порядку колонок із перенесеними id. Фізичних імен
 * немає — їх дає доповнення.
 */
export function kindFile(
  ctx: KindFileContext,
  promoted: PromotedTable
): { raw: Json; problems: Diagnostic[] } {
  const { model, into } = ctx
  const { object, table } = promoted
  const def = KIND_REGISTRY[into.kind]
  const problems: Diagnostic[] = []

  const raw: Json = { ...into.data }
  for (const key of ASSIGNED_KEYS) delete raw[key]
  Object.assign(raw, { id: object.id, kind: into.kind, name: into.name })
  if (table.schema !== undefined) raw.schema = table.schema
  if (def.scope !== "absent" && table.scope !== undefined) {
    raw.scope = table.scope
  }
  // Мітка переходить без змін (§9.11); вид без мітки її не має.
  if (def.kindLabel === true && table.kindLabel !== undefined) {
    raw.kindLabel = table.kindLabel
  }
  if (raw.title === undefined && table.title !== undefined) {
    raw.title = table.title
  }
  if (raw.description === undefined && table.comment !== undefined) {
    raw.description = { [model.project.defaultLocale]: table.comment }
  }

  const collections = new Map<string, Json[]>()
  for (const { index, column, fate } of promoted.columns) {
    if (fate.to !== "attribute") continue
    const typed =
      fate.element.type === undefined
        ? columnType(ctx, promoted, index, problems)
        : {}
    const attribute: Json = {
      ...(column.title !== undefined ? { title: column.title } : {}),
      ...(column.comment !== undefined
        ? { description: { [model.project.defaultLocale]: column.comment } }
        : {}),
      ...typed,
      required: column.notNull,
      ...fate.element,
      id: column.id,
    }
    const items = collections.get(fate.collection) ?? []
    items.push(attribute)
    collections.set(fate.collection, items)
  }
  for (const [collection, items] of collections) {
    const extra = raw[collection]
    raw[collection] = [...items, ...(Array.isArray(extra) ? extra : [])]
  }
  return { raw, problems }
}

/**
 * Тип реквізиту з колонки: поля логічного типу як є, FK однієї колонки —
 * `Ref` на об'єкт цілі. Посилання на прийняту таблицю переводяться на її вид
 * або відмовляють, якщо таблиця поза одиницею.
 */
function columnType(
  ctx: KindFileContext,
  promoted: PromotedTable,
  index: number,
  problems: Diagnostic[]
): Json {
  const { object, table } = promoted
  const column = table.columns[index]!
  const typed: Json = {}
  for (const field of TYPE_FIELDS) {
    if (column[field] !== undefined) typed[field] = column[field]
  }
  const retarget = (ref: MetadataRef, pointer: string): MetadataRef => {
    if (ref.kind !== "CustomTable") return ref
    const promotedRef = ctx.unit.get(ref.name)
    if (promotedRef !== undefined) return promotedRef
    problems.push(
      diagnostic("promote.reference-not-promoted", object.file, pointer, {
        table: object.name,
        target: `${ref.kind} ${ref.name}`,
      })
    )
    return ref
  }
  if (column.ref !== undefined) {
    typed.ref = retarget(column.ref, `/columns/${index}/ref`)
  }
  if (column.allowedTypes !== undefined) {
    typed.allowedTypes = column.allowedTypes.map((ref, i) =>
      retarget(ref, `/columns/${index}/allowedTypes/${i}`)
    )
  }

  table.foreignKeys.forEach((foreignKey, i) => {
    if (!foreignKey.columns.includes(column.name)) return
    const unsupported = (detail: string) =>
      problems.push(
        diagnostic(
          "promote.type-unsupported",
          object.file,
          `/columns/${index}`,
          {
            table: object.name,
            column: column.name,
            detail,
          }
        )
      )
    const { references } = foreignKey
    if (foreignKey.columns.length > 1) {
      unsupported(
        `it is part of the composite foreign key ${foreignKey.name ?? i}`
      )
      return
    }
    if (!("object" in references)) {
      unsupported(
        `its foreign key references ${references.external.schema}.${references.external.table} outside the metadata`
      )
      return
    }
    const target = ctx.model.objects.find(
      (o) =>
        o.kind === references.object.kind && o.name === references.object.name
    )
    if (target === undefined) return
    if (references.columns[0] !== keyColumnName(ctx, target)) {
      unsupported(
        `its foreign key references ${references.columns[0]} of ${target.name}, not its key`
      )
      return
    }
    typed.type = "Ref"
    typed.ref = retarget(
      references.object,
      `/foreignKeys/${i}/references/object`
    )
  })
  return typed
}

/**
 * Логічне ім'я ключа цілі FK: єдиний uuid-ключ прийнятої таблиці чи ключова
 * стандартна колонка виду в стилі проєкту. `Ref` веде саме на ключ, тож FK на
 * іншу колонку реквізитом-посиланням не стає.
 */
function keyColumnName(
  ctx: KindFileContext,
  target: CompiledModel["objects"][number]
): string | undefined {
  const def = KIND_REGISTRY[target.kind]
  if (def.declared) {
    return singleUuidKeyColumn(target.data as CustomTable)?.name
  }
  const key = def
    .standardColumns(target.data)
    .find((column) => column.primaryKey === true)
  return key === undefined
    ? undefined
    : standardLogicalName(key, ctx.model.project.naming.attributeCase)
}
