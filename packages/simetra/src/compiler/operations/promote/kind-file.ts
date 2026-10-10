import {
  KIND_REGISTRY,
  singleUuidKeyColumn,
  standardLogicalName,
  type CustomTable,
  type MetadataKind,
  type MetadataRef,
  type StandardColumnDef,
} from "simetra/model"
import type { CompiledModel } from "../../compile"
import { diagnostic, type Diagnostic } from "../../diagnostics"
import { isRecord, type Json } from "../../object-files"
import type { PromoteInput } from "../inputs"
import { referencesProviderUsers } from "./gates"
import type { PlacedColumn, PromotedTable, PromotionTarget } from "./mapping"

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

export interface KindFileContext {
  model: CompiledModel
  into: PromoteInput["into"]
  target: PromotionTarget
  /**
   * Прийняті таблиці одиниці → посилання на їхні нові об'єкти: `Ref` і FK на
   * них стають посиланнями на вид, а на `CustomTable` поза одиницею — відмова
   * (§11).
   */
  unit: ReadonlyMap<string, MetadataRef>
  /**
   * Прийняті таблиці одиниці, що стають табличними частинами: ТЧ не є
   * об'єктом, тож посилання на неї — відмова одиниці, а не «поза одиницею».
   */
  sections: ReadonlySet<string>
  /**
   * Об'єкт-власник рядка: ціль стандартного зв'язку рядка ТЧ з власником.
   * Немає — таблиця основна.
   */
  owner?: MetadataRef
}

/** Вид описує прийняту таблицю: на неї посилаються як на `CustomTable`. */
const isAdoptedTable = (kind: MetadataKind) =>
  KIND_REGISTRY[kind].declared && KIND_REGISTRY[kind].materializes === "table"

const sameRef = (a: MetadataRef, b: MetadataRef) =>
  a.kind === b.kind && a.name === b.name

/** Прийнята таблиця, що стає табличною частиною нового об'єкта. */
export interface PromotedSection {
  /** Логічне ім'я ТЧ. */
  name: string
  /** Інші поля ТЧ із входу. */
  data?: Record<string, unknown>
  promoted: PromotedTable
  target: PromotionTarget
}

/**
 * Файл виду з прийнятої таблиці (спека промоції §7.1): шапка й `into.data`,
 * реквізити з колонок у порядку колонок із перенесеними id, табличні частини
 * з таблиць ТЧ одиниці. Фізичних імен немає — їх дає доповнення (рішення 10).
 * Ідентичність, схему, скоуп і мітку `into.data` не задає — це відхиляє схема
 * входу.
 */
export function kindFile(
  ctx: KindFileContext,
  promoted: PromotedTable,
  sections: readonly PromotedSection[] = []
): { raw: Json; problems: Diagnostic[] } {
  const { model, into } = ctx
  const { object, table } = promoted
  const def = KIND_REGISTRY[into.kind]
  const locale = model.project.defaultLocale
  const problems: Diagnostic[] = []

  const raw: Json = {
    ...into.data,
    id: object.id,
    kind: into.kind,
    name: into.name,
  }
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
    raw.description = { [locale]: table.comment }
  }
  appendElements(raw, columnElements(ctx, promoted, problems))

  if (sections.length > 0) {
    // Рядок ТЧ належить новому об'єкту: стандартний зв'язок з власником веде
    // на нього (§11), а каскад рядка — дія виду, не запис (§9.5).
    const owner = { kind: into.kind, name: into.name }
    const built = sections.map((section) => {
      const element: Json = {
        ...section.data,
        id: section.promoted.object.id,
        name: section.name,
      }
      const title = section.promoted.table.title
      if (element.title === undefined && title !== undefined) {
        element.title = title
      }
      appendElements(
        element,
        columnElements(
          { ...ctx, target: section.target, owner },
          section.promoted,
          problems
        )
      )
      return element
    })
    const extra = raw.tabularSections
    raw.tabularSections = [...built, ...(Array.isArray(extra) ? extra : [])]
  }
  return { raw, problems }
}

/** Реквізити з колонок — перед елементами, які задає сам вхід. */
function appendElements(raw: Json, collections: Map<string, Json[]>): void {
  for (const [collection, items] of collections) {
    const extra = raw[collection]
    raw[collection] = [...items, ...(Array.isArray(extra) ? extra : [])]
  }
}

/** Елементи колекцій з колонок таблиці, у порядку колонок. */
function columnElements(
  ctx: KindFileContext,
  promoted: PromotedTable,
  problems: Diagnostic[]
): Map<string, Json[]> {
  const locale = ctx.model.project.defaultLocale
  const references = new References(ctx, promoted, problems)
  const collections = new Map<string, Json[]>()
  for (const placed of promoted.columns) {
    const { column, fate } = placed
    if (fate.to === "retire" || fate.to === "scope") continue
    const foreign = references.foreignTarget(placed)
    if (fate.to === "standard") {
      if (foreign !== undefined)
        references.checkStandard(placed, fate.def, foreign)
      continue
    }
    const attribute: Json = {
      ...(column.title !== undefined ? { title: column.title } : {}),
      ...(column.comment !== undefined
        ? { description: { [locale]: column.comment } }
        : {}),
      ...(fate.element.type === undefined ? columnType(column) : {}),
      required: column.notNull,
      ...fate.element,
      id: column.id,
    }
    if (foreign !== undefined)
      references.applyForeignKey(placed, attribute, foreign)
    references.retarget(placed, attribute)
    const items = collections.get(fate.collection) ?? []
    items.push(attribute)
    collections.set(fate.collection, items)
  }
  return collections
}

/** Поля логічного типу колонки як є; посилання переводить `retarget`. */
function columnType(column: CustomTable["columns"][number]): Json {
  const typed: Json = {}
  for (const field of TYPE_FIELDS) {
    if (column[field] !== undefined) typed[field] = column[field]
  }
  return typed
}

/**
 * Посилання колонок таблиці одиниці (рішення 6): FK і `Ref` на прийняту
 * таблицю одиниці переходять на її вид, поза одиницею — відмова. FK колонки не
 * губиться мовчки: він стає `Ref` того самого об'єкта або стандартним
 * реквізитом з тією самою ціллю, інакше — відмова.
 */
class References {
  constructor(
    private readonly ctx: KindFileContext,
    private readonly promoted: PromotedTable,
    private readonly problems: Diagnostic[]
  ) {}

  /** Посилання з урахуванням промоції одиниці, без діагностик. */
  private promotedRef(ref: MetadataRef): MetadataRef {
    return isAdoptedTable(ref.kind) ? (this.ctx.unit.get(ref.name) ?? ref) : ref
  }

  private unsupported(placed: PlacedColumn, detail: string): void {
    const { object } = this.promoted
    this.problems.push(
      diagnostic(
        "promote.type-unsupported",
        object.file,
        `/columns/${placed.index}`,
        {
          table: object.name,
          column: placed.column.name,
          reason: "foreignKey",
          detail,
        }
      )
    )
  }

  /**
   * Ціль FK колонки (ще без перекладу на вид) або `undefined`, якщо FK немає.
   * FK, що не стає посиланням (складений, зовнішній, не на ключ), — відмова:
   * `Ref` веде лише на ключ об'єкта метаданих.
   */
  foreignTarget(placed: PlacedColumn): MetadataRef | null | undefined {
    const { column } = placed
    let found: MetadataRef | null | undefined
    this.promoted.table.foreignKeys.forEach((foreignKey, i) => {
      if (!foreignKey.columns.includes(column.name)) return
      const { references } = foreignKey
      if (foreignKey.columns.length > 1) {
        this.unsupported(
          placed,
          `it is part of the composite foreign key ${foreignKey.name ?? i}`
        )
        found = null
        return
      }
      if (!("object" in references)) {
        // FK на користувачів провайдера судить гейт (`promote.provider-user-reference`).
        if (referencesProviderUsers(this.ctx.model, references)) {
          found = null
          return
        }
        this.unsupported(
          placed,
          `its foreign key references ${references.external.schema}.${references.external.table} outside the metadata`
        )
        found = null
        return
      }
      const target = this.ctx.model.objects.find(
        (o) =>
          o.kind === references.object.kind && o.name === references.object.name
      )
      if (
        target === undefined ||
        references.columns[0] !== this.keyColumnName(target)
      ) {
        this.unsupported(
          placed,
          `its foreign key references ${references.columns[0]} of ${references.object.name}, not its key`
        )
        found = null
        return
      }
      found = references.object
    })
    return found
  }

  /**
   * FK колонки, що стає реквізитом: без типу в елементі — `Ref` на ціль FK;
   * елемент може задати лише `Ref` на ту саму ціль.
   */
  applyForeignKey(
    placed: PlacedColumn,
    attribute: Json,
    foreign: MetadataRef | null
  ): void {
    if (foreign === null) return
    if (placed.fate.to !== "attribute") return
    const { element } = placed.fate
    if (element.type === undefined) {
      attribute.type = "Ref"
      attribute.ref = foreign
      return
    }
    const ref = element.ref
    const same =
      element.type === "Ref" &&
      element.allowedTypes === undefined &&
      isRecord(ref) &&
      typeof ref.kind === "string" &&
      typeof ref.name === "string" &&
      Object.hasOwn(KIND_REGISTRY, ref.kind) &&
      sameRef(this.promotedRef(ref as MetadataRef), this.promotedRef(foreign))
    if (!same) {
      this.unsupported(
        placed,
        `its foreign key references ${foreign.kind} ${foreign.name}, and the element sets another type or target`
      )
    }
  }

  /**
   * Стандартний реквізит замість колонки з FK: ціль стандартного реквізиту
   * (сам об'єкт, власник, «Користувачі», власник рядка) має збігатися з ціллю
   * FK, інакше зв'язок мовчки змінив би зміст.
   */
  checkStandard(
    placed: PlacedColumn,
    def: StandardColumnDef,
    foreign: MetadataRef | null
  ): void {
    if (foreign === null) return
    const allowed = this.standardTargets(def)
    const target = this.promotedRef(foreign)
    if (!allowed.some((ref) => sameRef(ref, target))) {
      this.unsupported(
        placed,
        `its foreign key references ${foreign.kind} ${foreign.name}, which standard attribute ${def.logicalName} does not reference`
      )
    }
  }

  private standardTargets(def: StandardColumnDef): MetadataRef[] {
    const { into, model, target, owner } = this.ctx
    switch (def.ref) {
      case "self":
        return [{ kind: into.kind, name: into.name }]
      case "owners":
        return (target.data as { owners?: MetadataRef[] }).owners ?? []
      case "owningObject":
        return owner === undefined ? [] : [owner]
      case "users":
        // Роль, а не ім'я, позначає «Користувачів» (спека користувачів).
        return model.objects
          .filter((o) => (o.data as { role?: string }).role === "users")
          .map((o) => ({ kind: o.kind, name: o.name }))
      case "recorders":
      case undefined:
        return []
      default: {
        const unhandled: never = def.ref
        throw new Error(`unknown standard reference ${String(unhandled)}`)
      }
    }
  }

  /**
   * `ref`/`allowedTypes` реквізиту — з колонки чи з елемента — на прийняту
   * таблицю: одиниця переходить на свій вид, поза одиницею — відмова (§11).
   */
  retarget(placed: PlacedColumn, attribute: Json): void {
    const { object } = this.promoted
    const pointer = `/columns/${placed.index}`
    const one = (value: unknown): unknown => {
      if (
        !isRecord(value) ||
        typeof value.kind !== "string" ||
        typeof value.name !== "string" ||
        !Object.hasOwn(KIND_REGISTRY, value.kind)
      ) {
        return value
      }
      const ref = value as MetadataRef
      if (!isAdoptedTable(ref.kind)) return ref
      const promotedRef = this.ctx.unit.get(ref.name)
      if (promotedRef !== undefined) return promotedRef
      if (this.ctx.sections.has(ref.name)) {
        this.problems.push(
          diagnostic("promote.unit-unsupported", object.file, pointer, {
            kind: ref.kind,
            name: ref.name,
            detail: `it becomes a tabular section, and a column of ${object.name} references it as an object`,
          })
        )
        return ref
      }
      this.problems.push(
        diagnostic("promote.reference-not-promoted", object.file, pointer, {
          table: object.name,
          target: `${ref.kind} ${ref.name}`,
        })
      )
      return ref
    }
    if (attribute.ref !== undefined) attribute.ref = one(attribute.ref)
    if (Array.isArray(attribute.allowedTypes)) {
      attribute.allowedTypes = attribute.allowedTypes.map(one)
    }
  }

  /**
   * Логічне ім'я ключа цілі FK: єдиний uuid-ключ прийнятої таблиці чи ключова
   * стандартна колонка виду в стилі проєкту. `Ref` веде саме на ключ, тож FK на
   * іншу колонку реквізитом-посиланням не стає.
   */
  private keyColumnName(
    target: CompiledModel["objects"][number]
  ): string | undefined {
    const def = KIND_REGISTRY[target.kind]
    if (isAdoptedTable(target.kind)) {
      return singleUuidKeyColumn(target.data as CustomTable)?.name
    }
    const key = def
      .standardColumns(target.data)
      .find((column) => column.primaryKey === true)
    return key === undefined
      ? undefined
      : standardLogicalName(key, this.ctx.model.project.naming.attributeCase)
  }
}
