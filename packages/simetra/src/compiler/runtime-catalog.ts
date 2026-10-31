import {
  CAST_TYPES,
  KIND_REGISTRY,
  type MetadataRef,
  type PhysicalTable,
  type RuntimeAttribute,
  type RuntimeCatalog,
  type RuntimeConstraint,
  type RuntimeObject,
  type RuntimeOperationTarget,
  type RuntimeSection,
} from "simetra/model"
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

interface Facts {
  model: CompiledModel
  /** Значення перерахування-цілі `Ref`; `undefined` — ціль не перерахування. */
  enumValues: (ref: MetadataRef) => RuntimeAttribute["enumValues"]
  objectRef: (table: PhysicalTable) => MetadataRef
}

function runtimeObject(
  object: SourceObject,
  contract: CatalogCommandContract,
  facts: Facts
): RuntimeObject {
  const entity = must(objectEntity(facts.model, object), object.name)
  const { table, key, versionColumn, actions, functions } = contract
  const fields = entityFields(facts.model, table, {
    standard: entity.standard,
    elements: entity.elements,
  })
  const scope = table.columns.find((c) => c.name === contract.scopeColumn)
  const target = (
    fn: QualifiedName,
    context: string
  ): RuntimeOperationTarget => ({
    function: { schema: fn.schema, name: fn.name },
    context,
  })
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
    ...(scope?.origin.scopeKindId === undefined
      ? {}
      : { scopeKindId: scope.origin.scopeKindId, scopeColumn: scope.name }),
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
        name: source.name,
        table: { schema: section.table.schema, name: section.table.name },
        key: section.key,
        keyName: fieldOf(rows, section.key).name,
        parent: section.parent,
        lineNumber: section.lineNumber,
        attributes: attributes(
          rows.filter((f) => !fixed.has(f.columns[0])),
          section.table,
          {
            insert: new Set(section.rowKeys),
            update: new Set(section.updateColumns),
            references: section.references,
          },
          facts
        ),
        constraints: constraints(section.table),
      }
    }),
    operations: {
      ...(actions.create === undefined
        ? {}
        : { create: target(functions.save, actions.create) }),
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
    },
    constraints: constraints(table),
  }
}

function attributes(
  fields: readonly EntityField[],
  table: PhysicalTable,
  keys: {
    insert: ReadonlySet<string>
    update: ReadonlySet<string>
    references: readonly CommandReference[]
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
    }
  })
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
function constraints(table: PhysicalTable): RuntimeConstraint[] {
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
    ...table.checks.map((c) => ({
      name: c.name,
      kind: "check" as const,
      columns: [],
    })),
    ...table.foreignKeys.map((f) => ({
      name: f.name,
      kind: "foreignKey" as const,
      columns: [...f.columns],
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

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`internal: runtime catalog misses ${what}`)
  }
  return value
}
