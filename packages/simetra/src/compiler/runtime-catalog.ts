import {
  CAST_TYPES,
  KIND_REGISTRY,
  effectiveMaxBytes,
  type MetadataRef,
  type PhysicalTable,
  type RuntimeAttribute,
  type RuntimeCatalog,
  type RuntimeConstraint,
  type RuntimeObject,
  type RuntimeOperationTarget,
  type RuntimeRootCreate,
  type RuntimeSection,
} from "simetra/model"
import { isSignalObject } from "./access-units"
import { canonicalize } from "./canonical"
import type {
  CatalogCommandContract,
  CommandReference,
} from "./catalog-command/contracts"
import type { CompiledModel, SourceObject } from "./compile"
import type { QualifiedName } from "./contracts"
import {
  entityFields,
  objectEntity,
  type EntityContext,
  type EntityField,
  type ValueSource,
} from "./entity-fields"
import { sha256HexSync } from "./sha256"

/**
 * Каталог рантайму (спека П4 §6.3) — проєкція скомпільованої моделі: лише
 * довідники з контрактом ядра команд (`CompiledModel.catalogCommands`), у
 * порядку `model.objects`. Поля — тим самим обходом `entityFields`, що й тип
 * сутності кодогену, тож рядок рантайму й тип `defineObjectModule<Entity>`
 * не розходяться; прапорці `insert`/`update` — з ключів `p_item` контракту,
 * тобто з гранту ролі команд.
 */
export function buildRuntimeCatalog(model: CompiledModel): RuntimeCatalog {
  const contracts = new Map(model.catalogCommands.map((c) => [c.objectId, c]))
  const byRef = new Map(model.objects.map((o) => [refKey(o), o]))
  const byId = new Map(model.objects.map((o) => [o.id, o]))
  const facts: Facts = {
    model,
    checkColumns: new Map(
      model.checkColumns.map((c) => [checkKey(c.table, c.check), c.column])
    ),
    enumValues: (ref) => {
      const target = byRef.get(refKey(ref))
      // Значення-елементи (мітка бази ≠ логічне ім'я) — факт реєстру.
      if (target === undefined || !KIND_REGISTRY[target.kind].valueElements) {
        return undefined
      }
      const { values } = target.data as {
        values: { name: string; physicalName?: string }[]
      }
      return values.map((v) => ({
        name: v.name,
        label: must(v.physicalName, `${target.name}.${v.name}`),
      }))
    },
    objectRef: (table) => {
      const object = must(byId.get(table.origin.objectId), table.name)
      return { kind: object.kind, name: object.name }
    },
    mainTable: (schema, name) => {
      const table = model.physical.tables.find(
        (t) => t.schema === schema && t.name === name
      )
      // Рядок ТЧ і похідна таблиця — не ціль `Ref`: у них немає об'єкта.
      return table === undefined ||
        table.origin.tabularSectionId !== undefined ||
        table.origin.part !== undefined
        ? undefined
        : table
    },
  }
  return {
    format: 1,
    snapshotHash: model.hash,
    provider: model.project.database.provider,
    objects: model.objects.flatMap((object): RuntimeObject[] => {
      const contract = contracts.get(object.id)
      if (contract === undefined) return []
      return [runtimeObject(object, contract, facts)]
    }),
  }
}

/**
 * The kernel contract hash of a catalog entry (P4-B spec Рд12): SHA-256 of
 * the canonical form of its operations — command functions and contexts.
 * An entry without operations hashes the empty form.
 */
export function kernelHashOf(operations: RuntimeObject["operations"]): string {
  // Лише форма ядра: перейменування, подання, права й новий реквізит хешу не
  // змінюють, тож стара збірка після сумісної зміни пише далі.
  return sha256HexSync(canonicalize(operations ?? {}))
}

interface Facts {
  model: CompiledModel
  /** Колонка CHECK за `checkKey`. */
  checkColumns: ReadonlyMap<string, string>
  /** Значення перерахування-цілі `Ref`; `undefined` — ціль не перерахування. */
  enumValues: (ref: MetadataRef) => RuntimeAttribute["enumValues"]
  objectRef: (table: PhysicalTable) => MetadataRef
  /** Основна таблиця об'єкта за іменем; `undefined` — таблиця не основна. */
  mainTable: (schema: string, name: string) => PhysicalTable | undefined
}

function runtimeObject(
  object: SourceObject,
  contract: CatalogCommandContract,
  facts: Facts
): RuntimeObject {
  const entity = must(objectEntity(facts.model, object), object.name)
  const { table, key, versionColumn } = contract
  const fields = entityFields(facts.model, table, {
    standard: entity.standard,
    elements: entity.elements,
  })
  const scope = table.columns.find((c) => c.name === contract.scopeColumn)
  const membership = facts.model.contracts.membership.find(
    (m) => m.objectId === object.id
  )
  const operations = operationsOf(object.id, contract, facts.model)
  // Той самий UUID, що в ядра кореня: клієнт мапить `creatorMember`
  // записом довідника членства без `operations` (В8).
  const creatorMembership = operations.create?.root?.membership
  return {
    id: object.id,
    name: object.name,
    kind: object.kind,
    kindLabel: contract.kindLabel,
    table: { schema: table.schema, name: table.name },
    key,
    keyName: fieldOf(fields, key).name,
    versionColumn,
    versionName: fieldOf(fields, versionColumn).name,
    signal: isSignalObject(facts.model, object.id),
    ...(scope?.origin.scopeKindId === undefined
      ? {}
      : { scopeKindId: scope.origin.scopeKindId, scopeColumn: scope.name }),
    ...(membership === undefined
      ? {}
      : { membership: { userColumn: membership.userColumn } }),
    // Ключ — лише з `op.id`, версія — з `expectedVersion`: реквізитами вони не є.
    attributes: attributes(
      fields.filter(
        (f) => f.columns[0] !== key && f.columns[0] !== versionColumn
      ),
      table,
      {
        insert: new Set(contract.createKeys),
        update: new Set(contract.updateKeys),
        references: contract.references,
        header: true,
      },
      facts
    ),
    tabularSections: contract.tabularSections.map((section): RuntimeSection => {
      const source = must(
        entity.sections.find(
          (s) => s.id === section.table.origin.tabularSectionId
        ),
        section.table.name
      )
      const context: EntityContext = {
        standard: source.standard,
        elements: entity.elements,
      }
      const rows = entityFields(facts.model, section.table, context)
      const fixed = new Set([section.key, section.parent, section.lineNumber])
      return {
        id: must(section.table.origin.tabularSectionId, section.table.name),
        name: source.name,
        table: { schema: section.table.schema, name: section.table.name },
        key: section.key,
        keyName: fieldOf(rows, section.key).name,
        parent: section.parent,
        parentName: fieldOf(rows, section.parent).name,
        lineNumber: section.lineNumber,
        lineNumberName: fieldOf(rows, section.lineNumber).name,
        parentConstraint: parentConstraint(
          section.table,
          section.parent,
          table
        ),
        attributes: attributes(
          rows.filter((f) => !fixed.has(f.columns[0])),
          section.table,
          {
            insert: new Set(section.rowKeys),
            update: new Set(section.updateColumns),
            references: section.references,
            header: false,
          },
          facts
        ),
        constraints: constraints(section.table, facts),
      }
    }),
    ...(creatorMembership === undefined ? {} : { creatorMembership }),
    kernelHash: kernelHashOf(operations),
    operations,
    constraints: constraints(table, facts),
  }
}

/** Операції запису — з функцій і дій контракту ядра команд. */
function operationsOf(
  objectId: string,
  contract: CatalogCommandContract,
  model: CompiledModel
): NonNullable<RuntimeObject["operations"]> {
  const { actions, functions } = contract
  const target = (
    fn: QualifiedName,
    context: string
  ): RuntimeOperationTarget => ({
    function: { schema: fn.schema, name: fn.name },
    context,
  })
  return {
    ...(actions.create === undefined
      ? {}
      : { create: target(functions.save, actions.create) }),
    // Корінь виду скоупу створює окреме ядро (спека П4 §6.13); `save`
    // кореня гілки створення не має, тож обидві форми не збігаються.
    ...(functions.createRoot === undefined || actions.createRoot === undefined
      ? {}
      : {
          create: {
            ...target(functions.createRoot, actions.createRoot),
            root: rootCreate(objectId, model),
          },
        }),
    update: target(functions.save, actions.update),
    ...(functions.markDeletion === undefined ||
    actions.markDeletion === undefined
      ? {}
      : {
          markDeletion: target(functions.markDeletion, actions.markDeletion),
        }),
    ...(functions.delete === undefined || actions.delete === undefined
      ? {}
      : { delete: target(functions.delete, actions.delete) }),
  }
}

/**
 * Довідник членства кореня — лише на виді з роллю `rootCreator` (Рх19): на
 * виді без неї ядро кореня відхиляє `creatorMember`.
 */
function rootCreate(rootId: string, model: CompiledModel): RuntimeRootCreate {
  const creator = model.scopeKinds.find(
    (k) => "objectId" in k.root && k.root.objectId === rootId
  )?.rootCreator
  return creator === undefined ? {} : { membership: creator.membership }
}

function attributes(
  fields: readonly EntityField[],
  table: PhysicalTable,
  keys: {
    insert: ReadonlySet<string>
    update: ReadonlySet<string>
    references: readonly CommandReference[]
    /** Шапка, а не ТЧ: лише в шапці реквізит буває лінивим (Рд25). */
    header: boolean
  },
  facts: Facts
): RuntimeAttribute[] {
  return fields.map((field): RuntimeAttribute => {
    // У пари значення несе колонка `_id`; `_type` — дискримінатор цілі.
    const column = must(
      table.columns.find((c) => c.name === field.columns.at(-1)),
      `${table.name}.${field.name}`
    )
    const source: ValueSource | { raw: string } =
      field.standard?.type ??
      field.element ??
      (field.scopeKindId === undefined
        ? { raw: column.type }
        : { type: "UUID" })
    const value = "raw" in source ? undefined : source
    // Недосяжно з метаданих: на `PgEnum` посилається лише колонка
    // `CustomTable`, а каталог будують лише види ядра команд.
    if (value?.type === "PgEnum") {
      throw new Error(`internal: catalog field ${field.name} is a PgEnum`)
    }
    const insert = field.columns.every((c) => keys.insert.has(c))
    const update = field.columns.every((c) => keys.update.has(c))
    const enumValues =
      value?.type === "Ref" && value.ref !== undefined
        ? facts.enumValues(value.ref)
        : undefined
    // Ефективна лінивість — лише реквізиту шапки: явний `load` чи типове за
    // типом (`RichText` додасть блок метаданих разом із тим самим правилом).
    // Стандартні атрибути (ключ, версія, скоуп) лінивими не бувають.
    const load = field.element?.load
    const lazy =
      keys.header &&
      field.element !== undefined &&
      (load === "lazy" || (load === undefined && value?.type === "Bytes"))
    // Межа входу — і стандартному атрибуту: його `Text` теж пише команда, а
    // явної межі стандартному не задати, тож діє типова за типом (П1).
    const maxBytes =
      value === undefined
        ? undefined
        : effectiveMaxBytes({
            type: value.type,
            array: value.array,
            maxBytes: field.element?.maxBytes,
          })
    const ref =
      value?.type === "Ref" &&
      enumValues === undefined &&
      value.array !== true &&
      field.columns.length === 1
        ? refOf(table, column.name, facts)
        : undefined
    return {
      name: field.name,
      column: column.name,
      pgType: column.type,
      castType: castTypeOf(column.type),
      type: value?.type ?? "Raw",
      ...(value?.array === true ? { array: true as const } : {}),
      // Обов'язковість — лише для того, що команда сама вставляє: решту
      // заповнює база чи платформа.
      required:
        insert && field.notNull && !field.hasDefault && !field.generated,
      ...(value?.type === "String" && value.length !== undefined
        ? { maxLength: value.length }
        : {}),
      ...(value?.type === "Numeric" && value.precision !== undefined
        ? { precision: value.precision }
        : {}),
      ...(value?.type === "Numeric" && value.scale !== undefined
        ? { scale: value.scale }
        : {}),
      insert,
      update,
      ...(field.generated ? { generated: true as const } : {}),
      ...(enumValues === undefined ? {} : { enumValues }),
      ...(field.columns.length === 2
        ? { pair: pairOf(field.columns[0], keys.references, facts) }
        : {}),
      ...(ref === undefined ? {} : { ref }),
      ...(lazy ? { load: "lazy" as const } : {}),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    }
  })
}

/**
 * Ціль `Ref` — з FK, чия остання колонка — колонка реквізиту: FK на ціль того
 * самого виду скоупу складений `(скоуп, колонка)`, і його остання колонка
 * цілі — ключ. Без такого FK (ціль без основної таблиці) `ref` немає.
 */
function refOf(
  table: PhysicalTable,
  column: string,
  facts: Facts
): RuntimeAttribute["ref"] {
  for (const fk of table.foreignKeys) {
    if (fk.columns.at(-1) !== column) continue
    const target = facts.mainTable(fk.references.schema, fk.references.table)
    if (target === undefined) continue
    if (fk.references.columns.at(-1) !== target.primaryKey?.columns.at(-1)) {
      continue
    }
    return { object: target.origin.objectId, constraint: fk.name }
  }
  return undefined
}

/** FK рядка ТЧ на основну таблицю власника — за останньою колонкою `parent`. */
function parentConstraint(
  section: PhysicalTable,
  parent: string,
  owner: PhysicalTable
): string {
  const fk = section.foreignKeys.find(
    (f) =>
      f.columns.at(-1) === parent &&
      f.references.schema === owner.schema &&
      f.references.table === owner.name
  )
  // ТЧ ядра завжди має FK власника; його відсутність — дефект компілятора.
  return must(fk, `${section.name} owner foreign key`).name
}

/** Цілі пари — з посилання ядра: ті самі мітки, що їх звіряє `<t>_save`. */
function pairOf(
  typeColumn: string,
  references: readonly CommandReference[],
  facts: Facts
): NonNullable<RuntimeAttribute["pair"]> {
  const reference = references.find(
    (r) => r.form === "pair" && r.typeColumn === typeColumn
  )
  if (reference?.form !== "pair") {
    throw new Error(`internal: polymorphic pair ${typeColumn} has no reference`)
  }
  return {
    typeColumn,
    targets: reference.targets.map((t) => ({
      object: facts.objectRef(t.table),
      label: t.label,
    })),
  }
}

/**
 * Обмеження таблиці — для мапінгу помилок Postgres на реквізит за іменем
 * обмеження. Ключ-вираз унікального індексу колонки не має й пропускається.
 */
function constraints(table: PhysicalTable, facts: Facts): RuntimeConstraint[] {
  return [
    ...(table.primaryKey === undefined
      ? []
      : [
          {
            name: table.primaryKey.name,
            kind: "primaryKey" as const,
            columns: [...table.primaryKey.columns],
          },
        ]),
    ...table.uniques.map((u) => ({
      name: u.name,
      kind: "unique" as const,
      columns: [...u.columns],
    })),
    ...table.indexes
      .filter((i) => i.unique)
      .map((i) => ({
        name: i.name,
        kind: "unique" as const,
        columns: i.keys.flatMap((k) => ("column" in k ? [k.column] : [])),
      })),
    // Колонка — з компілятора за призначеним іменем (Р-A3-21); CHECK над
    // кількома колонками (правило рядка) реквізиту не називає.
    ...table.checks.map((c) => {
      const column = facts.checkColumns.get(checkKey(table, c.name))
      return {
        name: c.name,
        kind: "check" as const,
        columns: column === undefined ? [] : [column],
      }
    }),
    ...table.foreignKeys.map((f) => ({
      name: f.name,
      kind: "foreignKey" as const,
      columns: [...f.columns],
      references: [...f.references.columns],
    })),
  ]
}

const CASTS = new Set<string>(CAST_TYPES)

/**
 * Тип приведення параметра: базовий тип колонки без typmod
 * (`character varying(10)` → `character varying`) — довжину й точність
 * перевіряє T3 до бази, а приведення з typmod мовчки обрізало б значення.
 */
function castTypeOf(pgType: string): string {
  const array = pgType.endsWith("[]") ? "[]" : ""
  const base = (array === "" ? pgType : pgType.slice(0, -2)).replace(
    /\(\d+(?:,\d+)?\)/,
    ""
  )
  if (CASTS.has(base)) return `${base}${array}`
  throw new Error(`internal: no cast type for column type ${pgType}`)
}

function fieldOf(fields: readonly EntityField[], column: string): EntityField {
  return must(
    fields.find((f) => f.columns[0] === column),
    column
  )
}

const refKey = (ref: MetadataRef) => `${ref.kind}.${ref.name}`
const checkKey = (table: QualifiedName, check: string) =>
  `${table.schema}.${table.name}.${check}`

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`internal: runtime catalog misses ${what}`)
  }
  return value
}
