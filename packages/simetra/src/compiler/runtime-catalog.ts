import {
  CAST_TYPES,
  DEFAULT_MAIN_PRESENTATION,
  KIND_REGISTRY,
  effectiveMaxBytes,
  isObjectTable,
  type MetadataRef,
  type PhysicalTable,
  type CatalogRightsCarrier,
  type CatalogRightsSubject,
  type RuntimeAttribute,
  type RuntimeCatalog,
  type Storage,
  type RuntimeConstraint,
  type RuntimeObject,
  type RuntimeOperationTarget,
  type RuntimeRootCreate,
  type RuntimeSection,
  type ObjectTable,
} from "simetra/model"
import { isSignalObject, readBoundaries } from "./access-units"
import { canonicalize } from "./canonical"
import { compareStrings } from "./diagnostics"
import type {
  CatalogCommandContract,
  CommandReference,
} from "./catalog-command/contracts"
import type { CompiledModel, SourceObject } from "./compile"
import type { CarrierContract, QualifiedName } from "./contracts"
import {
  entityFields,
  objectEntity,
  type EntityContext,
  type EntityField,
  type ValueSource,
} from "./entity-fields"
import type { PresentationBlock } from "./presentation"
import { hasRightsFunctions, hasVisibleUsers } from "./rights/functions"
import { carrierColumn } from "./rights/predicates"
import { triggeredRelationTable } from "./rights/relation-table"
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
      model.checkColumns.map((c) => [checkKey(c.table, c.check), c.columns])
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
      // Рядок ТЧ, похідна таблиця й таблиця платформи — не ціль `Ref`.
      return table === undefined ||
        !isObjectTable(table) ||
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
    ...(hasRightsFunctions(model.contracts, model.project.database.provider)
      ? { rightsSnapshot: true as const, ...adoptedFactsOf(model) }
      : {}),
    objects: model.objects.flatMap((object): RuntimeObject[] => {
      const contract = contracts.get(object.id)
      if (contract === undefined) return []
      return [runtimeObject(object, contract, facts)]
    }),
  }
}

/**
 * Факти прийнятих джерел (спека П4-B §8.2): тригера сигналу прав на прийнятій
 * таблиці немає (спека прав §4.7), тож клієнт мусить знати, що вони свіжіють
 * за інтервалом. Призначення — будь-якого рівня, зокрема контейнера.
 */
function adoptedFactsOf(
  model: CompiledModel
): Pick<RuntimeCatalog, "adoptedFacts"> {
  const { membershipSources, assignmentSources } = model.contracts
  if (membershipSources.length === 0 && assignmentSources.length === 0)
    return {}
  return {
    adoptedFacts: {
      membershipKinds: [
        ...new Set(membershipSources.map((s) => s.scopeKindId)),
      ].sort(compareStrings),
      ...(assignmentSources.length > 0 ? { assignments: true as const } : {}),
    },
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

// Роль — з `access.publicRead` (призначення ролей запиту): `anonymous` є лише
// в `anon`, який відкриває обидві ролі; решта — `authenticated`.
function publicReadOf(
  model: CompiledModel,
  objectId: string,
  table: QualifiedName
): Pick<RuntimeObject, "publicRead"> {
  // Основна таблиця: ТЧ того ж об'єкта мають власні записи доступу.
  const purposes =
    model.contracts.access.find(
      (a) =>
        a.objectId === objectId &&
        a.table.schema === table.schema &&
        a.table.name === table.name
    )?.publicRead ?? []
  if (purposes.length === 0) return {}
  return {
    publicRead: purposes.includes("anonymous") ? "anon" : "authenticated",
  }
}

// Межа файлу — з метаданих об'єкта як є: окремого виводу немає.
function storageOf(object: SourceObject): Pick<RuntimeObject, "storage"> {
  const { storage } = object.data as { storage?: Storage }
  if (storage === undefined) return {}
  // Поля читаються по одному: так їх бачить ратчет метамоделі.
  return {
    storage: {
      maxBytes: storage.maxBytes,
      mediaTypes: [...storage.mediaTypes],
    },
  }
}

interface Facts {
  model: CompiledModel
  /** Колонки CHECK за `checkKey`, у порядку колонок таблиці. */
  checkColumns: ReadonlyMap<string, readonly string[]>
  /** Значення перерахування-цілі `Ref`; `undefined` — ціль не перерахування. */
  enumValues: (ref: MetadataRef) => RuntimeAttribute["enumValues"]
  objectRef: (table: ObjectTable) => MetadataRef
  /** Основна таблиця об'єкта за іменем; `undefined` — таблиця не основна. */
  mainTable: (schema: string, name: string) => ObjectTable | undefined
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
  // Ключ — лише з `op.id`, версія — з `expectedVersion`: реквізитами вони не є.
  const header = attributes(
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
  )
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
    ...publicReadOf(facts.model, object.id, table),
    ...storageOf(object),
    ...rightsOf(object.id, header, contract, facts),
    ...presentationOf(
      facts.model.presentation.objects.find((p) => p.objectId === object.id),
      fields
    ),
    ...(scope?.origin.scopeKindId === undefined
      ? {}
      : { scopeKindId: scope.origin.scopeKindId, scopeColumn: scope.name }),
    ...(membership === undefined
      ? {}
      : { membership: { userColumn: membership.userColumn } }),
    attributes: header,
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

/**
 * Контракт прав запису (спека П4-B §9.2) — з `RightsContract` і контракту
 * доступу основної таблиці. Носій — колонка основної таблиці
 * (`carrierColumn`), названа реквізитом шапки чи ключем: клієнт читає носій
 * із рядка сховища за логічним ім'ям.
 */
function rightsOf(
  objectId: string,
  header: readonly RuntimeAttribute[],
  command: CatalogCommandContract,
  facts: Facts
): Pick<RuntimeObject, "rights"> {
  const { model } = facts
  const { contracts, objects, project } = model
  const contract = contracts.rights.find((r) => r.objectId === objectId)
  if (contract === undefined) return {}
  const main = command.table
  const carrierOf = (carrier: CarrierContract): CatalogRightsCarrier => {
    const column = carrierColumn(contract, carrier, main, main)
    if (column === command.key) return { key: true }
    const attribute = header.find((a) => a.column === column)
    // Носій поза реквізитами й ключем клієнт не прочитав би з рядка: краще
    // гучна помилка компіляції, ніж мовчазне `unknown` чи чужа колонка.
    if (attribute === undefined) {
      throw new Error(
        `internal: rights carrier ${column} of ${contract.kindLabel} is neither an attribute nor the key`
      )
    }
    return { attribute: attribute.name }
  }
  const subjectOf = (
    target: { users: true } | { membership: string }
  ): CatalogRightsSubject =>
    "users" in target ? { users: true } : { scopeKind: target.membership }
  const access = must(
    contracts.access.find(
      (a) =>
        a.objectId === objectId &&
        a.table.schema === main.schema &&
        a.table.name === main.name
    ),
    `access contract of ${contract.kindLabel}`
  )
  const scopeKindId = access.scope?.scopeKindId
  return {
    rights: {
      actions: contract.actions.map((a) => ({
        action: a.action,
        extents: a.extents.map((e) => ({ ...e })),
      })),
      ownership: contract.ownership.map((o) => ({
        carrier: carrierOf(o),
        owner: subjectOf(o.owner),
      })),
      access: contract.access.map(({ dimensionId, carrier }) => {
        const dimension = must(
          contracts.accessDimensions.find((d) => d.dimensionId === dimensionId),
          `access dimension ${dimensionId}`
        )
        const relation =
          "relation" in dimension.values ? dimension.values.relation : undefined
        // Свіжий — зв'язок, на який платформа ставить тригер сигналу прав
        // (та сама умова, що в генераторах); функція виміру — ні.
        const fresh =
          relation !== undefined &&
          triggeredRelationTable(relation, model.physical, objects) !==
            undefined
        return {
          dimensionId,
          carrier: carrierOf(carrier),
          fresh,
          ...(relation === undefined
            ? {}
            : { subject: subjectOf(relation.subjectTarget) }),
        }
      }),
      ...(contract.binding === undefined
        ? {}
        : {
            binding: {
              containerId: contract.binding.containerId,
              carrier: carrierOf(contract.binding.carrier),
            },
          }),
      readBoundary: [
        ...readBoundaries(
          access,
          hasVisibleUsers(contracts, project.database.provider)
        ),
      ],
      ...(contract.root === true
        ? {
            root:
              contract.rootAuthor === undefined
                ? {}
                : {
                    author: carrierOf({
                      column: contract.rootAuthor,
                      value: contract.rootAuthor,
                    }),
                  },
          }
        : {}),
      ...(scopeKindId === undefined
        ? {}
        : {
            scopeSet: contracts.membership.some(
              (m) =>
                m.scopeKindId === scopeKindId && m.setFunction !== undefined
            )
              ? "membership"
              : "verbatim",
          }),
    },
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

// Основне представлення — з блоку подання (`mainPresentation`, типово
// `Description`) і стандартних колонок виду, а не з імені реквізиту: власний
// реквізит `description` у виду без стандартного найменування його не підміняє.
function presentationOf(
  block: PresentationBlock | undefined,
  fields: readonly EntityField[]
): { presentation?: { attribute: string } } {
  const logicalName =
    (block?.mainPresentation ?? DEFAULT_MAIN_PRESENTATION) === "Code"
      ? "code"
      : "description"
  const attribute = fields.find(
    (f) => f.standard?.logicalName === logicalName
  )?.name
  return attribute === undefined ? {} : { presentation: { attribute } }
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
  const copies = facts.model.copyColumns.get(`${table.schema}.${table.name}`)
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
      ...(field.notNull ? { notNull: true as const } : {}),
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
      ...(field.columns.some((c) => copies?.has(c) === true)
        ? { copy: true as const }
        : {}),
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
    // Колонки — з компілятора за призначеним іменем: CHECK реквізиту —
    // його колонка, правило рядка — колонки, які воно читає. CHECK, якого
    // компілятор не розібрав, колонок не має.
    ...table.checks.map((c) => ({
      name: c.name,
      kind: "check" as const,
      columns: [...(facts.checkColumns.get(checkKey(table, c.name)) ?? [])],
    })),
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
