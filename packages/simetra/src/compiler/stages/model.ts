// Portions copied from PostgreSQL (https://github.com/postgres/postgres, branch REL_17_STABLE):
// src/backend/commands/indexcmds.c (ChooseIndexNameAddition,
// ChooseIndexColumnNames), src/backend/commands/tablecmds.c
// (ChooseForeignKeyConstraintNameAddition) — in nameAddition and
// indexColumnNames below.
// Portions Copyright (c) 1996-2024, PostgreSQL Global Development Group
// Portions Copyright (c) 1994, Regents of the University of California
// Licensed under the PostgreSQL License. Modified: translated from C to
// TypeScript; index key expressions are not handled.

import {
  KIND_REGISTRY,
  chooseConstraintName,
  makeObjectName,
  monthColumn,
  pgEnumTypeName,
  pgTypeOf,
  quoteIdent,
  singletonColumn,
  standardLogicalName,
  truncatedPeriodExpression,
  type Attribute,
  type AttributeCase,
  type CustomTable,
  type CustomTableColumn,
  type MetadataRef,
  type PhysicalColumn,
  type PhysicalEnumType,
  type PhysicalSnapshot,
  type PhysicalTable,
  type Project,
  type ReferenceRole,
  type RegisterKeySpec,
  type ScopeKind,
  type StandardColumnDef,
  type TabularSection,
  type ValueType,
} from "simetra/model"
import { compareStrings } from "../diagnostics"
import { objectKey, type ParsedObject } from "./files"
import { standardElementId, type ResolvedReference } from "./identity"

type ForeignKey = PhysicalTable["foreignKeys"][number]
type FkAction = ForeignKey["onDelete"]
type Index = PhysicalTable["indexes"][number]
type Element = Record<string, unknown>

/** NAMEDATALEN Postgres: межа, після якої доповнення з імен колонок не росте. */
const NAMEDATALEN = 64

/**
 * Де у файлах оголошено фізичний об'єкт — для діагностик стадії 4, що
 * вказують на `physicalName` чи явне ім'я обмеження, а не на весь файл.
 */
export interface PhysicalSource {
  schema: string
  name: string
  file: string
  pointer: string
  /** Колонки в порядку таблиці; `pointer` — у колонок з елементів файлу. */
  columns: { name: string; pointer?: string }[]
  /** Явні імена обмежень та індексів. */
  explicitNames: { name: string; pointer: string }[]
}

export interface ModelStageResult {
  physical: PhysicalSnapshot
  /** У порядку файлів, а всередині файлу — в порядку оголошення. */
  sources: PhysicalSource[]
  /** Оголошені у файлах `physicalName` — для перевірки зарезервованих слів. */
  declaredNames: { file: string; pointer: string; name: string }[]
  /**
   * CHECK обов'язковості реквізитів шапки документа з ФАКТИЧНО призначеними
   * іменами — контракт проведення бере їх звідси, а не перераховує вираз.
   */
  requiredChecks: {
    objectId: string
    attributeId: string
    table: { schema: string; name: string }
    check: string
  }[]
}

/**
 * Як фізично виражена ціль посилання. `scope` — складений FK у межах скоупу:
 * `from` — колонка джерела, що несе значення скоупу, `to` — скоуп-колонка цілі.
 */
type Target =
  | {
      form: "foreignKey"
      schema: string
      table: string
      column: string
      scope?: { from: string; to: string }
    }
  | { form: "label"; labels: string[]; labelOf: ReadonlyMap<string, string> }
  | { form: "pair"; discriminators: string[] }
  | { form: "none" }

/** Реквізит чи стандартна колонка до розкладу на колонки й обмеження. */
interface Field {
  name: string
  type: string
  array: boolean
  notNull: boolean
  default?: string
  /** Вираз генерованої колонки (`STORED`); з `default` несумісний. */
  generated?: string
  check?: string
  primaryKey: boolean
  indexed: boolean
  unique: boolean
  /** Умова часткового унікального індексу (див. StandardColumnDef). */
  partialUnique?: string
  /** Скоуп-колонка, що передує колонці в UNIQUE: унікальність у межах скоупу. */
  uniqueWithin?: string
  /** Скоуп-колонка, з якої починається пошуковий індекс поля. */
  indexWithin?: string
  target: Target
  onDelete: FkAction
  origin: PhysicalColumn["origin"]
  pointer?: string
}

/**
 * Скоуп таблиці виду: вид і колонка, що несе значення скоупу. У звичайного
 * скоупленого об'єкта це додана скоуп-колонка (`own`), у кореня — його ключ,
 * у рядка ТЧ кореня — `parent_id`; без такої колонки (`undefined`) складений
 * FK з таблиці неможливий.
 */
interface TableScope {
  kind: ScopeKind
  carrier: string | undefined
  /** Таблиця має власну скоуп-колонку (не корінь). */
  own: boolean
  /**
   * Рядки таблиці належать одному значенню скоупу, тож UNIQUE тримається в
   * його межах. Лише таблиця самого кореня — ні: її рядки і є значеннями.
   */
  partitioned: boolean
}

/** Таблиця до призначення імен: `name` обмеження лише явне. */
interface PendingTable {
  schema: string
  name: string
  comment?: string
  origin: PhysicalTable["origin"]
  rowLevelSecurity: PhysicalTable["rowLevelSecurity"]
  columns: PhysicalColumn[]
  identityColumns: string[]
  primaryKey?: { name?: string; columns: string[] }
  uniques: { name?: string; columns: string[]; nullsNotDistinct: boolean }[]
  /** `column` — єдина колонка виразу, що дає її ім'я в назві обмеження. */
  checks: {
    name?: string
    column?: string
    /** Мітка в імені обмеження; без неї — `check`. */
    label?: string
    /** Реквізит, чию обов'язковість виражає CHECK; для `requiredChecks`. */
    elementId?: string
    expression: string
  }[]
  foreignKeys: (Omit<ForeignKey, "name"> & { name?: string })[]
  indexes: (Omit<Index, "name"> & { name?: string })[]
  /**
   * Похідні індекси виду (колонки в порядку ключа) — стають індексами після
   * всіх ключів таблиці, бо покриття перевіряється за ними всіма.
   */
  derivedIndexes: string[][]
}

/**
 * Стадія 3 (спека П2 §5, §8.2–§8.3): фізичний знімок з реєстру видів —
 * стандартні колонки виду, колонки реквізитів, ключі, обмеження й індекси,
 * скоуп-колонки, `UNIQUE (scope, id)` і складені FK у межах скоупу (§6),
 * а також таблиці `CustomTable` і енам-типи `PgEnum` як є. Імена похідних
 * обмежень — за алгоритмом Postgres над іменами колонок, тож збігаються з
 * тими, що дала б сама БД; ім'я над виразом (безіменні CHECK та індекси з
 * виразом у `CustomTable`) Postgres бере з дерева виразу, тож для них стадія 4
 * вимагає явне ім'я.
 * Вхід — без помилок стадій 1–2: id, physicalName і цілі посилань є, а
 * колонки, названі в описі прийнятої таблиці, вже резолвлені в індексі
 * посилань стадії 2.
 */
export function buildModel(
  objects: readonly ParsedObject[],
  project: Project,
  references: readonly ResolvedReference[]
): ModelStageResult {
  const builder = new SnapshotBuilder(objects, project, references)
  for (const object of objects) builder.add(object)
  return builder.finish()
}

class SnapshotBuilder {
  private readonly byKey: Map<string, ParsedObject>
  private readonly style: AttributeCase
  private readonly tables: PendingTable[] = []
  private readonly enumTypes: PhysicalEnumType[] = []
  private readonly sources: PhysicalSource[] = []
  private readonly declaredNames: ModelStageResult["declaredNames"] = []
  private readonly scopeKinds: Map<string, ScopeKind>
  /** Об'єкт-корінь → вид, чиїм коренем він є. */
  private readonly rootKinds: Map<string, ScopeKind>
  /** `файл\0pointer` → id колонки, яку там названо (індекс стадії 2). */
  private readonly columnRefs: Map<string, string>
  /** id колонки (зокрема синтетичний стандартної) → її фізичне ім'я. */
  private readonly columnNames: Map<string, string>

  constructor(
    objects: readonly ParsedObject[],
    private readonly project: Project,
    references: readonly ResolvedReference[]
  ) {
    this.byKey = new Map(objects.map((o) => [objectKey(o.kind, o.name), o]))
    this.style = project.naming.attributeCase
    this.scopeKinds = new Map(project.scopeKinds.map((k) => [k.name, k]))
    this.rootKinds = new Map(
      project.scopeKinds.flatMap((kind) =>
        "object" in kind.root
          ? [[objectKey(kind.root.object.kind, kind.root.object.name), kind]]
          : []
      )
    )
    this.columnRefs = new Map(
      references
        .filter((r) => COLUMN_ROLES.has(r.role))
        .map((r) => [`${r.from.file}\0${r.from.pointer}`, r.to.id])
    )
    this.columnNames = new Map(objects.flatMap(physicalColumnsById))
  }

  add(object: ParsedObject): void {
    const def = KIND_REGISTRY[object.kind]
    const data = object.data as Element
    const schema = this.schemaOf(object)
    const name = physicalNameOf(object)
    const origin = { objectId: object.id ?? "" }
    // physicalName перерахування — не ідентифікатор БД (таблиці немає), тож
    // перевіряються лише імена того, що матеріалізується.
    if (def.materializes === "none") return
    this.declare(object.file, "/physicalName", name)

    if (def.materializes === "enumType") {
      this.enumTypes.push({
        schema,
        name,
        values: [...(data.values as string[])],
        origin,
      })
      this.sources.push({
        schema,
        name,
        file: object.file,
        pointer: "/physicalName",
        columns: [],
        explicitNames: [],
      })
      return
    }

    // Прийнята таблиця описана фізично повністю (спека §4): нічого не
    // виводиться, тож її форма береться з файлу, а не з виду.
    if (isDeclaredTable(object)) {
      this.addDeclaredTable(object, data as unknown as CustomTable)
      return
    }

    const main = this.pendingTable(schema, name, origin, object)
    const kind = this.scopeKindOf(object)
    const root = kind !== undefined && this.isRoot(object, kind)
    const key = keyColumnOf(object)
    const scope: TableScope | undefined =
      kind === undefined
        ? undefined
        : root
          ? { kind, carrier: key, own: false, partitioned: false }
          : {
              kind,
              carrier: kind.physicalName!,
              own: true,
              partitioned: true,
            }
    const registerKeys = def.registerKeys?.(data)
    const standard = def.standardColumns(data)
    const dimensions =
      registerKeys === undefined ? [] : (data.dimensions as Attribute[])
    const singleton = registerSingletonOf(object)
    const degenerate = singleton !== undefined
    const standardFields = new Map<StandardColumnDef, Field>()
    const fields = this.withScope(
      singleton !== undefined ? [singleton, ...standard] : standard,
      scope,
      (column) => {
        const field = this.standardField(column, object, main, scope)
        standardFields.set(column, field)
        return field
      }
    )
    const dimensionFields: Field[] = []
    const requiredHeader: Field[] = []
    // Колонкові поля й їхній порядок дає реєстр: у регістра — виміри,
    // ресурси, реквізити, у решти видів — лише реквізити.
    for (const field of def.columnFields) {
      const list = data[field] as Attribute[]
      list.forEach((attribute, index) => {
        const built = this.attributeField(
          attribute,
          `/${field}/${index}`,
          scope,
          def.requiredOnPost === true
        )
        if (def.requiredOnPost === true && attribute.required) {
          requiredHeader.push(built)
        }
        // Вимір `NOT NULL` лише за `required` (attributeField): порожнє
        // значення ключа — це `NULL`, а ключ запису його зіставляє.
        if (field === "dimensions" && registerKeys !== undefined) {
          dimensionFields.push(built)
        }
        // Адитивний ресурс сумується в залишки й обороти: порожнє значення
        // зіпсувало б суму, а платформного DEFAULT рух не має — значення дає
        // кожен рух (спека §7).
        if (field === "resources" && registerKeys?.additiveResources === true) {
          built.notNull = true
        }
        fields.push(built)
        this.declare(
          object.file,
          `/${field}/${index}/physicalName`,
          attribute.physicalName!
        )
      })
    }
    const columnsOf = this.addTable(main, fields, object.file, "/physicalName")
    if (requiredHeader.length > 0) {
      const posted = [...standardFields].find(
        ([column]) => column.logicalName === "posted"
      )![1].name
      for (const field of requiredHeader) {
        const columns = columnsOf.get(field)!
        main.checks.push({
          label: REQUIRED_LABEL,
          column: columns[0]!,
          elementId: field.origin.elementId,
          expression: requiredOnPostExpression(posted, columns),
        })
      }
    }
    if (registerKeys !== undefined) {
      const columns = (field: Field | undefined) =>
        field === undefined ? [] : (columnsOf.get(field) ?? [])
      const standardOf = (match: (column: StandardColumnDef) => boolean) =>
        columns([...standardFields].find(([column]) => match(column))?.[1])
      this.addRegisterKeys(main, registerKeys, degenerate, scope, {
        period: standardOf((column) => column.logicalName === PERIOD),
        dimensions: dimensionFields.flatMap(columns),
        recorder: standardOf((column) => column.ref === "recorders"),
        lineNumber: standardOf((column) => column.logicalName === LINE_NUMBER),
      })
      if (registerKeys.totals) {
        this.addTotals(object, schema, name, origin, dimensions, scope)
      }
      if (registerKeys.turnoversMonth !== undefined) {
        this.addTurnoversMonth(
          object,
          schema,
          name,
          origin,
          dimensions,
          scope,
          registerKeys.turnoversMonth.split
        )
      }
    }
    const numbering = def.numbering?.(data)
    if (numbering?.unique === true) {
      // Номер унікальний у межах носія скоупу й періоду; колонки беремо з
      // уже побудованих полів, бо їхні фізичні імена — факт реєстру.
      const named = (logicalName: string | undefined) =>
        logicalName === undefined
          ? []
          : (columnsOf.get(
              [...standardFields].find(
                ([column]) => column.logicalName === logicalName
              )![1]
            ) ?? [])
      main.uniques.push({
        columns: [
          ...(scope?.own === true ? [scope.carrier!] : []),
          ...named(numbering.periodColumn),
          ...named(numbering.column),
        ],
        nullsNotDistinct: false,
      })
    }
    // Ціль складених FK у межах скоупу (спека §6).
    if (scope?.own === true && key !== undefined) {
      main.uniques.push({
        columns: [scope.carrier!, key],
        nullsNotDistinct: false,
      })
    }

    const sections =
      def.tabularSectionColumns === undefined
        ? []
        : (data.tabularSections as TabularSection[])
    sections.forEach((section, index) => {
      const pointer = `/tabularSections/${index}`
      const table = this.pendingTable(
        schema,
        section.physicalName!,
        { ...origin, tabularSectionId: section.id ?? "" },
        object
      )
      const rowColumns = def.tabularSectionColumns?.(data) ?? []
      // Рядок ТЧ кореня несе скоуп у `parent_id` — окрема колонка лише
      // дублювала б його.
      const rowScope: TableScope | undefined =
        scope === undefined || scope.own
          ? scope
          : {
              kind: scope.kind,
              carrier: rowColumns.find((c) => c.ref === "owningObject")
                ?.physicalName,
              own: false,
              partitioned: true,
            }
      const sectionFields = this.withScope(rowColumns, rowScope, (column) =>
        this.standardField(column, object, main, rowScope)
      )
      section.attributes.forEach((attribute, i) => {
        sectionFields.push(
          this.attributeField(
            attribute,
            `${pointer}/attributes/${i}`,
            rowScope,
            def.requiredOnPost === true
          )
        )
        this.declare(
          object.file,
          `${pointer}/attributes/${i}/physicalName`,
          attribute.physicalName!
        )
      })
      this.declare(object.file, `${pointer}/physicalName`, table.name)
      this.addTable(
        table,
        sectionFields,
        object.file,
        `${pointer}/physicalName`
      )
    })
  }

  /**
   * Ключі й індекси таблиці рухів (спека §7): PK реєстратора (за його
   * наявності), UNIQUE NULLS NOT DISTINCT ключа запису і, де їх вимагає вид,
   * індекси рухів `(носій, виміри…, period, recorder_type, recorder_id)` та
   * `(носій, period)`. Реєстратор у кінці індексу: вікно «строго до документа»
   * (`balance` з реєстратором) читає рухи за впорядкованою трійкою
   * `(period, recorder_type, recorder_id)`. Покриті префіксом ключів індекси
   * відкидає materializeIndexes.
   */
  private addRegisterKeys(
    table: PendingTable,
    keys: RegisterKeySpec,
    degenerate: boolean,
    scope: TableScope | undefined,
    columns: {
      period: string[]
      dimensions: string[]
      /** Пара `recorder_type`/`recorder_id` без номера рядка. */
      recorder: string[]
      lineNumber: string[]
    }
  ): void {
    const carrier = scope?.carrier !== undefined ? [scope.carrier] : []
    const { period, dimensions, recorder, lineNumber } = columns
    // Вироджений ключ уже дав одинак (чи скоуп-колонка замість нього).
    // Ключ запису (носій, виміри…, period) служить і унікальності, і зрізу
    // останніх/перших за ключем.
    const recordKey = [...carrier, ...dimensions, ...period]
    if (keys.movementsPrimaryKey === "recorder") {
      if (recorder.length > 0) {
        table.primaryKey = { columns: [...recorder, ...lineNumber] }
      }
    }
    if (keys.recordKeyUnique && !degenerate) {
      table.uniques.push({ columns: recordKey, nullsNotDistinct: true })
    }
    if (keys.movementIndexes && period.length > 0) {
      table.derivedIndexes.push([
        ...carrier,
        ...dimensions,
        ...period,
        ...recorder,
      ])
      table.derivedIndexes.push([...carrier, ...period])
    }
  }

  /**
   * Поточні підсумки регістра залишків (спека §7): носій скоупу, виміри з
   * тими самими FK і ресурси `NOT NULL DEFAULT 0` — рядок з'являється з
   * першим рухом ключа, тож відсутнє значення ресурсу означає нуль.
   * Вимір `NOT NULL` лише за `required`, тож ключ — `UNIQUE NULLS NOT
   * DISTINCT`, а не PK: PK не допускає `NULL`. Без вимірів ключ — одинак (чи
   * скоуп-колонка замість нього).
   * UNIQUE полів і пошукові індекси ресурсів тут не повторюються: підсумки
   * похідні, а рядок знаходять за ключем; `indexed` вимірів лишається.
   */
  private addTotals(
    object: ParsedObject,
    schema: string,
    register: string,
    origin: PhysicalTable["origin"],
    dimensions: readonly Attribute[],
    scope: TableScope | undefined
  ): void {
    const table = this.pendingTable(
      schema,
      makeObjectName(register, undefined, "totals"),
      { ...origin, part: "totals" },
      object
    )
    const standard = dimensions.length === 0 ? [singletonColumn()] : []
    const fields = this.withScope(standard, scope, (column) =>
      this.standardField(column, object, table, scope)
    )
    const dimensionFields = this.derivedDimensions(dimensions, scope)
    const resources = (object.data as Element).resources as Attribute[]
    const resourceFields = resources.map((attribute, index) =>
      this.derivedResource(attribute, index, scope)
    )
    fields.push(...dimensionFields, ...resourceFields)
    const columnsOf = this.addTable(table, fields, object.file, "/physicalName")
    this.addDerivedKey(
      table,
      scope,
      dimensionFields.flatMap((field) => columnsOf.get(field) ?? [])
    )
  }

  /**
   * Місячні обороти регістра накопичення: рядок на `(носій, виміри…, місяць)`.
   * Оборотний регістр веде одне значення ресурсу, регістр залишків — пару
   * прихід/витрата, бо з неї виходять і оборот, і залишок на межі місяця.
   * Місяць рахується за поясом проєкту (`truncatedPeriodExpression`), тож
   * тут лише колонка `date`; вираз лежить у контракті.
   */
  private addTurnoversMonth(
    object: ParsedObject,
    schema: string,
    register: string,
    origin: PhysicalTable["origin"],
    dimensions: readonly Attribute[],
    scope: TableScope | undefined,
    split: boolean
  ): void {
    const table = this.pendingTable(
      schema,
      makeObjectName(register, undefined, "turnovers_month"),
      { ...origin, part: "turnoversMonth" },
      object
    )
    // Скоуп-колонка (за її наявності) іде першою, а ключа-одинака тут немає.
    const fields = this.withScope([], scope, (column) =>
      this.standardField(column, object, table, scope)
    )
    const dimensionFields = this.derivedDimensions(dimensions, scope)
    const month = this.standardField(monthColumn(), object, table, scope)
    const resources = (object.data as Element).resources as Attribute[]
    const resourceFields = resources.flatMap((attribute, index) => {
      const field = this.derivedResource(attribute, index, scope)
      return split
        ? ["receipt", "expense"].map((label) => ({
            ...field,
            name: makeObjectName(attribute.physicalName!, undefined, label),
          }))
        : [field]
    })
    fields.push(...dimensionFields, month, ...resourceFields)
    const columnsOf = this.addTable(table, fields, object.file, "/physicalName")
    this.addDerivedKey(table, scope, [
      ...dimensionFields.flatMap((field) => columnsOf.get(field) ?? []),
      ...(columnsOf.get(month) ?? []),
    ])
  }

  /** Виміри похідної таблиці: `NOT NULL` лише `required`, без UNIQUE полів. */
  private derivedDimensions(
    dimensions: readonly Attribute[],
    scope: TableScope | undefined
  ): Field[] {
    return dimensions.map((attribute, index) => ({
      ...this.attributeField(attribute, `/dimensions/${index}`, scope),
      unique: false,
    }))
  }

  /** Ресурс похідної таблиці: `NOT NULL DEFAULT 0` — відсутнє означає нуль. */
  private derivedResource(
    attribute: Attribute,
    index: number,
    scope: TableScope | undefined
  ): Field {
    return {
      ...this.attributeField(attribute, `/resources/${index}`, scope),
      notNull: true,
      default: "0",
      indexed: false,
      unique: false,
    }
  }

  /**
   * Ключ похідної таблиці: `UNIQUE` носія скоупу й `keyColumns`, завжди
   * `NULLS NOT DISTINCT` (вимір може бути `NULL`, PK його не допускає). Без
   * ключових колонок (підсумки без вимірів) ключ уже дає одинак чи
   * скоуп-колонка (`withScope`), тож тут нічого додавати.
   */
  private addDerivedKey(
    table: PendingTable,
    scope: TableScope | undefined,
    keyColumns: string[]
  ): void {
    if (keyColumns.length === 0) return
    table.uniques.push({
      columns: [
        ...(scope?.carrier !== undefined ? [scope.carrier] : []),
        ...keyColumns,
      ],
      nullsNotDistinct: true,
    })
  }

  finish(): ModelStageResult {
    // Імена призначаються в порядку знімка, а явні імена резервуються наперед
    // в усій схемі, тож знімок самоузгоджений: жодне похідне ім'я не збігається
    // з іншим. Postgres за колізій обрав би інакше (він не знає наперед про
    // явні імена пізніших таблиць), тож рендер не покладається на його вибір і
    // виводить кожне ім'я явно зі знімка.
    for (const table of this.tables) materializeIndexes(table)
    const pending = [...this.tables].sort(bySchemaAndName)
    const { tables, requiredChecks } = assignNames(pending)
    return {
      physical: {
        tables,
        enumTypes: [...this.enumTypes].sort(bySchemaAndName),
      },
      sources: this.sources,
      declaredNames: this.declaredNames,
      requiredChecks,
    }
  }

  // --- Таблиці видів ------------------------------------------------------

  /** RLS — за об'єктом: похідні таблиці й рядки ТЧ мають RLS власника. */
  private pendingTable(
    schema: string,
    name: string,
    origin: PhysicalTable["origin"],
    object: ParsedObject
  ): PendingTable {
    return {
      schema,
      name,
      origin,
      rowLevelSecurity: rowLevelSecurityOf(object),
      columns: [],
      identityColumns: [],
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: [],
      derivedIndexes: [],
    }
  }

  /** Повертає колонки кожного поля: поліморфне поле дає пару. */
  private addTable(
    table: PendingTable,
    fields: Field[],
    file: string,
    pointer: string
  ): Map<Field, string[]> {
    const source: PhysicalSource = {
      schema: table.schema,
      name: table.name,
      file,
      pointer,
      columns: [],
      explicitNames: [],
    }
    const columnsOf = new Map<Field, string[]>()
    for (const field of fields) {
      const columns = addField(table, field)
      columnsOf.set(field, columns)
      for (const column of columns) {
        source.columns.push({
          name: column,
          ...(field.pointer !== undefined ? { pointer: field.pointer } : {}),
        })
      }
    }
    this.tables.push(table)
    this.sources.push(source)
    return columnsOf
  }

  private standardField(
    column: StandardColumnDef,
    object: ParsedObject,
    ownTable: PendingTable,
    scope: TableScope | undefined
  ): Field {
    const resolved =
      "raw" in column.type
        ? { type: column.type.raw, array: false, target: NONE }
        : this.resolveValue(column.type, scope)
    let target = resolved.target
    if (column.ref !== undefined) {
      const refs = this.standardTargets(column, object)
      target =
        column.polymorphic !== undefined
          ? { form: "pair", discriminators: refs.map(physicalNameOf) }
          : column.ref === "self" || column.ref === "owningObject"
            ? // Ключ власної таблиці: рядок ТЧ і батько ієрархії посилаються
              // на таблицю самого об'єкта.
              this.keyTarget(object, ownTable, scope)
            : refs[0] === undefined
              ? NONE
              : this.tableTarget(refs[0], scope, false)
    }
    const logical = standardLogicalName(column, this.style)
    return {
      name: column.physicalName,
      type: resolved.type,
      array: resolved.array,
      notNull: column.notNull,
      ...(column.default !== undefined
        ? { default: column.default }
        : defaultOf(column.defaultValue, target)),
      ...(column.generated !== undefined
        ? {
            generated: truncatedPeriodExpression(
              column.generated.truncate.column,
              column.generated.truncate.unit,
              this.project.timezone
            ),
          }
        : {}),
      ...(column.check !== undefined ? { check: column.check } : {}),
      primaryKey: column.primaryKey === true,
      // Індекс стандартного посилання — похідний індекс його FK на повний
      // набір колонок: у скоупленій таблиці `(scope, parent_id)` замість
      // `parent_id`. `indexed` посилання задовольняє індекс його FK (addField).
      indexed: column.indexed === true && target.form !== "foreignKey",
      unique: column.unique === true,
      ...(column.partialUnique !== undefined
        ? { partialUnique: column.partialUnique }
        : {}),
      ...uniqueWithin(
        column.unique === true || column.partialUnique !== undefined,
        scope
      ),
      ...indexWithin(scope),
      target,
      onDelete: column.onDelete ?? "noAction",
      origin:
        scope?.own === false && column.physicalName === scope.carrier
          ? { standard: logical, scopeKindId: scope.kind.id! }
          : { standard: logical },
    }
  }

  /**
   * Стандартні поля таблиці разом зі скоуп-колонкою: вона йде одразу після
   * ключа (без ключа — першою) і заміняє ключ-одинак у його ролі (PK чи
   * UNIQUE) — рядок один на значення скоупу. Корінь і рядок ТЧ кореня
   * власної колонки не мають.
   */
  private withScope(
    columns: readonly StandardColumnDef[],
    scope: TableScope | undefined,
    toField: (column: StandardColumnDef) => Field
  ): Field[] {
    if (scope?.own !== true) return columns.map(toField)
    const singleton = columns.find((column) => column.singleton === true)
    const kept = columns.filter((column) => column.singleton !== true)
    const fields = kept.map(toField)
    const { kind } = scope
    const scopeField: Field = {
      name: kind.physicalName!,
      type: "uuid",
      array: false,
      notNull: true,
      primaryKey: singleton?.primaryKey === true,
      indexed: false,
      unique: singleton?.unique === true,
      target: this.rootTarget(kind),
      onDelete: kind.onRootDelete,
      origin: { scopeKindId: kind.id! },
      pointer: "/scope",
    }
    const keyIndex = kept.findIndex((column) => column.primaryKey === true)
    fields.splice(keyIndex + 1, 0, scopeField)
    return fields
  }

  /** Ключ кореня виду: PK його таблиці або зовнішня колонка як є. */
  private rootTarget(kind: ScopeKind): Target {
    if ("external" in kind.root) {
      const { schema, table, column } = kind.root.external
      return { form: "foreignKey", schema, table, column }
    }
    // Корінь скоуп-колонки не має: FK на нього лише одноколонковий.
    return this.tableTarget(this.lookup(kind.root.object), undefined, false)
  }

  /** Вид скоупу, який об'єкт оголошує; `none` і відсутнє поле — без скоупу. */
  private scopeKindOf(object: ParsedObject): ScopeKind | undefined {
    const { scope } = object.data as { scope?: string }
    return scope === undefined ? undefined : this.scopeKinds.get(scope)
  }

  /**
   * Корінь — об'єкт, на який вказує вид, що його він і оголошує. Корінь, що
   * оголошує чужий вид, — помилка стадії 4; тут він звичайний скоуплений.
   */
  private isRoot(object: ParsedObject, kind: ScopeKind): boolean {
    return this.rootKinds.get(objectKey(object.kind, object.name)) === kind
  }

  /**
   * Складений FK на ціль можливий, лише коли джерело несе значення того самого
   * виду, а ціль має `UNIQUE (scope, id)` — скоуплений об'єкт виду 1С з
   * uuid-ключем, не корінь (у нього скоуп-колонки немає) і не `CustomTable`
   * (вона нічого не виводить, спека §4). Решта — звичайний FK: заборони
   * звітує стадія 4, а стадія 3 не будує неможливого.
   */
  private scopedKey(
    target: ParsedObject,
    scope: TableScope | undefined,
    crossScope: boolean
  ): { from: string; to: string } | undefined {
    if (scope?.carrier === undefined || crossScope) return undefined
    const kind = this.scopeKindOf(target)
    if (kind !== scope.kind || this.isRoot(target, kind)) return undefined
    if (KIND_REGISTRY[target.kind].declared) return undefined
    if (keyColumnOf(target) === undefined) return undefined
    return { from: scope.carrier, to: kind.physicalName! }
  }

  /** Цілі стандартного посилання: список з налаштувань виду. */
  private standardTargets(
    column: StandardColumnDef,
    object: ParsedObject
  ): ParsedObject[] {
    return standardTargetRefs(column, object.data).map((ref) =>
      this.lookup(ref)
    )
  }

  private attributeField(
    attribute: ColumnElement,
    pointer: string,
    scope: TableScope | undefined,
    requiredOnPost = false
  ): Field {
    const resolved = this.resolveValue(attribute, scope)
    return {
      name: attribute.physicalName!,
      ...resolved,
      // Вид з обов'язковістю при проведенні тримає її не в схемі, а в CHECK
      // шапки й контракті: чернетка може бути неповною.
      notNull: attribute.required === true && !requiredOnPost,
      ...defaultOf(attribute.defaultValue, resolved.target),
      primaryKey: false,
      indexed: attribute.indexed === true,
      unique: attribute.unique === true,
      ...uniqueWithin(attribute.unique === true, scope),
      ...indexWithin(scope),
      onDelete: "noAction",
      origin: { elementId: attribute.id ?? "" },
      pointer: `${pointer}/physicalName`,
    }
  }

  /** Тип колонки й фізична форма цілі для логічного типу. */
  private resolveValue(
    value: ValueType,
    scope: TableScope | undefined
  ): {
    type: string
    array: boolean
    target: Target
  } {
    const array = value.array === true
    if (value.type !== "Ref") {
      return { type: pgTypeOf(value), array, target: NONE }
    }
    if (value.allowedTypes !== undefined) {
      return {
        type: pgTypeOf(value),
        array,
        target: {
          form: "pair",
          discriminators: value.allowedTypes.map((ref) =>
            physicalNameOf(this.lookup(ref))
          ),
        },
      }
    }
    const target = this.lookup(value.ref!)
    const type = pgTypeOf(value, target.kind)
    const def = KIND_REGISTRY[target.kind]
    if (!def.referenceable) return { type, array, target: NONE }
    if (def.materializes !== "table") {
      // Єдина ціль посилання без таблиці — перерахування: зберігається
      // міткою значення з CHECK (спека §5, М15).
      const values = ((target.data as Element).values ?? []) as {
        name: string
        physicalName?: string
      }[]
      return {
        type,
        array,
        target: {
          form: "label",
          labels: values.map((v) => v.physicalName ?? ""),
          labelOf: new Map(values.map((v) => [v.name, v.physicalName ?? ""])),
        },
      }
    }
    // FK на елементи масиву Postgres не має (спека §4).
    return {
      type,
      array,
      target: array
        ? NONE
        : this.tableTarget(target, scope, value.crossScope === true),
    }
  }

  private tableTarget(
    target: ParsedObject,
    scope: TableScope | undefined,
    crossScope: boolean
  ): Target {
    const column = keyColumnOf(target)
    if (column === undefined) return NONE
    const composite = this.scopedKey(target, scope, crossScope)
    return {
      form: "foreignKey",
      schema: this.schemaOf(target),
      table: physicalNameOf(target),
      column,
      ...(composite !== undefined ? { scope: composite } : {}),
    }
  }

  private keyTarget(
    object: ParsedObject,
    table: PendingTable,
    scope: TableScope | undefined
  ): Target {
    const column = keyColumnOf(object)
    if (column === undefined) return NONE
    const composite = this.scopedKey(object, scope, false)
    return {
      form: "foreignKey",
      schema: table.schema,
      table: table.name,
      column,
      ...(composite !== undefined ? { scope: composite } : {}),
    }
  }

  // --- CustomTable --------------------------------------------------------

  private addDeclaredTable(object: ParsedObject, data: CustomTable): void {
    const table = this.pendingTable(
      this.schemaOf(object),
      physicalNameOf(object),
      { objectId: object.id ?? "" },
      object
    )
    if (data.comment !== undefined) table.comment = data.comment
    const source: PhysicalSource = {
      schema: table.schema,
      name: table.name,
      file: object.file,
      pointer: "/physicalName",
      columns: [],
      explicitNames: [],
    }
    const explicit = (name: string | undefined, pointer: string) => {
      if (name !== undefined) source.explicitNames.push({ name, pointer })
      return name !== undefined ? { name } : {}
    }

    data.columns.forEach((column, index) => {
      const name = column.physicalName!
      table.columns.push({
        name,
        type: this.declaredColumnType(column),
        notNull: column.notNull,
        ...(column.default !== undefined ? { default: column.default } : {}),
        ...(column.identity !== undefined ? { identity: column.identity } : {}),
        ...(column.comment !== undefined ? { comment: column.comment } : {}),
        origin: { elementId: column.id ?? "" },
      })
      if (column.identity !== undefined) table.identityColumns.push(name)
      source.columns.push({
        name,
        pointer: `/columns/${index}/physicalName`,
      })
      this.declare(object.file, `/columns/${index}/physicalName`, name)
    })

    // Імена колонок резолвила стадія 2; тут — лише фізичне ім'я за id.
    const column = (pointer: string) => {
      const id = this.columnRefs.get(`${object.file}\0${pointer}`)
      const name = id === undefined ? undefined : this.columnNames.get(id)
      if (name === undefined) {
        throw new Error(`buildModel: unresolved column at ${pointer}`)
      }
      return name
    }
    const map = (names: readonly string[], base: string) =>
      names.map((_, index) => column(`${base}/${index}`))

    if (data.primaryKey !== undefined) {
      table.primaryKey = {
        ...explicit(data.primaryKey.name, "/primaryKey/name"),
        columns: map(data.primaryKey.columns, "/primaryKey/columns"),
      }
    }
    data.uniques.forEach((unique, i) => {
      table.uniques.push({
        ...explicit(unique.name, `/uniques/${i}/name`),
        columns: map(unique.columns, `/uniques/${i}/columns`),
        nullsNotDistinct: unique.nullsNotDistinct,
      })
    })
    // Безіменний CHECK чи індекс з виразом Postgres назвав би за деревом
    // виразу, якого тут немає, тож стадія 4 вимагає для них явне ім'я.
    data.checks.forEach((check, i) => {
      table.checks.push({
        ...explicit(check.name, `/checks/${i}/name`),
        expression: check.expression,
      })
    })
    data.foreignKeys.forEach((foreignKey, i) => {
      const pointer = `/foreignKeys/${i}`
      const { references } = foreignKey
      let target: ForeignKey["references"]
      if ("object" in references) {
        const object = this.lookup(references.object)
        // Ціль без таблиці звітує стадія 4 (`reference.not-referenceable`);
        // колонок у неї немає, тож і FK будувати нема на що.
        if (KIND_REGISTRY[object.kind].materializes !== "table") return
        target = {
          schema: this.schemaOf(object),
          table: physicalNameOf(object),
          columns: map(references.columns, `${pointer}/references/columns`),
        }
      } else {
        // Поля цілі — поіменно: spread зарахував би ратчету полів кожен ключ
        // `external`, і нове поле без споживача пройшло б непоміченим.
        const { schema, table, columns } = references.external
        target = { schema, table, columns }
      }
      table.foreignKeys.push({
        ...explicit(foreignKey.name, `${pointer}/name`),
        columns: map(foreignKey.columns, `${pointer}/columns`),
        references: target,
        onDelete: foreignKey.onDelete,
        onUpdate: foreignKey.onUpdate,
        deferrable: foreignKey.deferrable,
      })
    })
    data.indexes.forEach((index, i) => {
      table.indexes.push({
        ...explicit(index.name, `/indexes/${i}/name`),
        unique: index.unique,
        method: index.method,
        keys: index.keys.map((key, k) =>
          "column" in key
            ? { column: column(`/indexes/${i}/keys/${k}/column`) }
            : key
        ),
        include: map(index.include, `/indexes/${i}/include`),
        ...(index.where !== undefined ? { where: index.where } : {}),
        nullsNotDistinct: index.nullsNotDistinct,
      })
    })

    this.tables.push(table)
    this.sources.push(source)
  }

  private declaredColumnType(column: CustomTableColumn): string {
    if (column.type === "Raw") return column.pgType ?? ""
    if (column.type === "PgEnum") {
      const target = this.lookup(column.enum!)
      const type = pgEnumTypeName(this.schemaOf(target), physicalNameOf(target))
      return column.array === true ? `${type}[]` : type
    }
    // Лише поля типу й поіменно: spread колонки зарахував би ратчету полів
    // кожен її ключ, і нове поле колонки без споживача пройшло б непоміченим.
    const { length, precision, scale, ref, allowedTypes, array } = column
    const value: ValueType = { type: column.type }
    if (length !== undefined) value.length = length
    if (precision !== undefined) value.precision = precision
    if (scale !== undefined) value.scale = scale
    if (ref !== undefined) value.ref = ref
    if (allowedTypes !== undefined) value.allowedTypes = allowedTypes
    if (array !== undefined) value.array = array
    // Прийнята таблиця нічого не виводить: `Ref` дає лише тип, без FK (спека §4).
    const target =
      column.ref !== undefined ? this.lookup(column.ref).kind : undefined
    return pgTypeOf(value, target)
  }

  // --- Допоміжне ----------------------------------------------------------

  private lookup(ref: MetadataRef): ParsedObject {
    // Стадія 2 без помилок гарантує, що кожне посилання резолвиться.
    return this.byKey.get(objectKey(ref.kind, ref.name))!
  }

  private schemaOf(object: ParsedObject): string {
    return objectSchema(object, this.project.defaultSchema)
  }

  private declare(file: string, pointer: string, name: string): void {
    this.declaredNames.push({ file, pointer, name })
  }
}

/** Схема об'єкта: власна чи схема проєкту. */
function objectSchema(object: ParsedObject, defaultSchema: string): string {
  return (
    ((object.data as Element).schema as string | undefined) ?? defaultSchema
  )
}

/**
 * Енам-тип, який матеріалізує об'єкт, за правилом стадії 3 (схема, `physicalName`);
 * `undefined` — вид не дає енам-типу. Єдине місце правила: ним користується й
 * розбір `.sql` до стадії 3.
 */
export function enumTypeOf(
  object: ParsedObject,
  defaultSchema: string
): { schema: string; name: string } | undefined {
  const { physicalName } = object.data as { physicalName?: string }
  return KIND_REGISTRY[object.kind].materializes === "enumType" &&
    physicalName !== undefined
    ? { schema: objectSchema(object, defaultSchema), name: physicalName }
    : undefined
}

/**
 * Типи рядків таблиць знімка (кожна таблиця — ще й складений тип): разом з
 * енам-типами — типи, відомі моделі при розборі `.sql`.
 */
export function rowTypesOf(
  physical: Pick<PhysicalSnapshot, "tables">
): { schema: string; name: string }[] {
  return physical.tables.map(({ schema, name }) => ({ schema, name }))
}

const NONE: Target = { form: "none" }

/** Мітка в імені CHECK обов'язковості при проведенні (`<таблиця>_<колонка>_required`). */
const REQUIRED_LABEL = "required"

/**
 * Вираз CHECK шапки: обов'язковість діє лише у проведеного документа. Пара
 * «тип + id» заповнена обома колонками, інакше посилання напівпорожнє.
 */
function requiredOnPostExpression(
  posted: string,
  columns: readonly string[]
): string {
  const filled = columns.map((c) => `${quoteIdent(c)} IS NOT NULL`)
  const body = filled.length > 1 ? `(${filled.join(" AND ")})` : filled[0]!
  return `NOT ${quoteIdent(posted)} OR ${body}`
}

/** Стандартні реквізити, що входять у ключі регістра (канонічні імена). */
const PERIOD = "period"
const LINE_NUMBER = "lineNumber"

/**
 * Ключ-одинак таблиці рухів регістра: ключ без жодної частини (ні періоду, ні
 * вимірів) — рядок-одинак; скоуп, якщо є, withScope робить ключем замість
 * одинака. Одинак займає місце ключа запису: PK незалежного регістра або
 * UNIQUE поруч із PK реєстратора в підлеглого. Спільний для стадії 3 і
 * обгорток запитів рухів, які його пропускають: значення дає DEFAULT.
 */
export function registerSingletonOf(
  object: Pick<ParsedObject, "kind" | "data">
): StandardColumnDef | undefined {
  const def = KIND_REGISTRY[object.kind]
  const keys = def.registerKeys?.(object.data)
  if (keys === undefined) return undefined
  const data = object.data as Element
  const degenerate =
    (data.dimensions as Attribute[]).length === 0 &&
    !def
      .standardColumns(object.data)
      .some((column) => column.logicalName === PERIOD)
  if (!degenerate) return undefined
  return singletonColumn(
    keys.movementsPrimaryKey === "none" ? "primaryKey" : "unique"
  )
}

/**
 * Цілі стандартного посилання (власники довідника, реєстратори регістра) за
 * налаштуваннями виду. Спільний для стадії 3 і кодогену типів.
 */
export function standardTargetRefs(
  column: StandardColumnDef,
  data: unknown
): MetadataRef[] {
  const { owners, recorderTypes } = data as Element
  const refs =
    column.ref === "owners"
      ? owners
      : column.ref === "recorders"
        ? recorderTypes
        : []
  return (refs ?? []) as MetadataRef[]
}

/**
 * Пошукові індекси таблиці зі скоуп-колонкою починаються з неї: під RLS кожен
 * запит несе предикат скоупу, тож `indexed` («шукаємо за полем») означає
 * пошук у межах скоупу. Індекс FK — ні: він служить перевірці з боку цілі.
 * Корінь і рядок ТЧ кореня власної колонки не мають — їхні індекси як у
 * нескоупленого об'єкта.
 */
function indexWithin(scope: TableScope | undefined): { indexWithin?: string } {
  return scope?.own === true ? { indexWithin: scope.carrier! } : {}
}

/**
 * UNIQUE колонки скоупленої таблиці — у межах значення скоупу: інакше
 * значення одного тенанта заважало б іншому. Таблиця кореня — виняток, її
 * рядки і є значеннями скоупу, тож унікальність там глобальна.
 */
/**
 * Елемент з типом значення, що стає колонкою: реквізит, вимір чи ресурс.
 * Ресурс регістра накопичення (`AccumulationResource`) не має `required`,
 * `indexed`, `unique` і `defaultValue` — їхня відсутність означає «ні»
 * (NOT NULL ресурсу дає адитивність виду, а не прапорець).
 */
type ColumnElement = ValueType &
  Pick<Attribute, "id" | "name" | "physicalName"> &
  Partial<Pick<Attribute, "required" | "indexed" | "unique" | "defaultValue">>

function uniqueWithin(
  unique: boolean,
  scope: TableScope | undefined
): { uniqueWithin?: string } {
  return unique && scope?.partitioned === true && scope.carrier !== undefined
    ? { uniqueWithin: scope.carrier }
    : {}
}

/**
 * Прийнята таблиця описує RLS полем файлу, решта видів — фактом реєстру.
 */
function rowLevelSecurityOf(
  object: ParsedObject
): PhysicalTable["rowLevelSecurity"] {
  if (isDeclaredTable(object)) {
    return (object.data as CustomTable).rowLevelSecurity
  }
  return KIND_REGISTRY[object.kind].rowLevelSecurity ?? "off"
}

function physicalNameOf(object: ParsedObject): string {
  return (object.data as { physicalName: string }).physicalName
}

/**
 * Прийнята таблиця: вид дає таблицю, але її форму описує файл (спека §4).
 * Одного `declared` замало — прийнятий енам-тип теж описаний як є, а стадія 3
 * бачить цілі посилань ще до того, як стадія 4 відкине невідповідні.
 */
export function isDeclaredTable(object: ParsedObject): boolean {
  const def = KIND_REGISTRY[object.kind]
  return def.declared && def.materializes === "table"
}

/** Ролі індексу посилань, що називають колонку прийнятої таблиці чи цілі її FK. */
const COLUMN_ROLES: ReadonlySet<ReferenceRole> = new Set<ReferenceRole>([
  "customTable.column",
  "customTable.foreignKeyTarget",
])

/**
 * id колонки → фізичне ім'я для таблиці об'єкта: елементи колонкових полів і
 * стандартні колонки виду під синтетичним id `<objectId>#<канонічне ім'я>`,
 * як їх резолвить стадія 2 (крім поліморфних пар, що не мають однієї колонки).
 */
function physicalColumnsById(object: ParsedObject): [string, string][] {
  const def = KIND_REGISTRY[object.kind]
  if (def.materializes !== "table") return []
  const data = object.data as Element
  const found: [string, string][] = []
  for (const column of def.standardColumns(data)) {
    if (column.polymorphic === undefined) {
      found.push([
        standardElementId(object.id ?? "", column),
        column.physicalName,
      ])
    }
  }
  for (const field of def.columnFields) {
    for (const element of data[field] as Attribute[]) {
      found.push([element.id ?? "", element.physicalName!])
    }
  }
  return found
}

/**
 * Колонка, на яку може посилатися FK з `Ref`: одноколонковий uuid-ключ.
 * У видів ключ дає реєстр, у прийнятої таблиці — її опис; без такого ключа
 * `Ref` на ціль неможливий (стадія 4, `reference.custom-table-key`).
 */
export function keyColumnOf(object: ParsedObject): string | undefined {
  const def = KIND_REGISTRY[object.kind]
  const data = object.data as Element
  if (isDeclaredTable(object)) {
    const table = data as unknown as CustomTable
    const key = table.primaryKey?.columns
    if (key?.length !== 1) return undefined
    const column = table.columns.find((c) => c.name === key[0])
    return column !== undefined && isUuidColumn(column)
      ? column.physicalName
      : undefined
  }
  const keys = def
    .standardColumns(data)
    .filter((column) => column.primaryKey === true)
  const key = keys[0]
  return keys.length === 1 &&
    key !== undefined &&
    !("raw" in key.type) &&
    key.type.type === "UUID"
    ? key.physicalName
    : undefined
}

/** Скалярна колонка типу uuid: логічного `UUID` або `Raw` з `pgType` uuid. */
export function isUuidColumn(column: CustomTable["columns"][number]): boolean {
  return (
    column.array !== true &&
    (column.type === "UUID" ||
      (column.type === "Raw" && column.pgType?.toLowerCase() === "uuid"))
  )
}

/**
 * Розкладає поле на колонки та їхні обмеження. Повертає імена доданих
 * колонок: поліморфне поле дає пару `<ім'я>_type` + `<ім'я>_id` (спека §5).
 */
function addField(table: PendingTable, field: Field): string[] {
  const suffix = field.array ? "[]" : ""
  const { target } = field
  const columns: PhysicalColumn[] =
    target.form === "pair"
      ? [
          {
            name: `${field.name}_type`,
            type: `text${suffix}`,
            notNull: field.notNull,
            origin: field.origin,
          },
          {
            name: `${field.name}_id`,
            type: `uuid${suffix}`,
            notNull: field.notNull,
            origin: field.origin,
          },
        ]
      : [
          {
            name: field.name,
            type: field.type,
            notNull: field.notNull,
            ...(field.default !== undefined ? { default: field.default } : {}),
            ...(field.generated !== undefined
              ? { generated: { expression: field.generated } }
              : {}),
            origin: field.origin,
          },
        ]
  table.columns.push(...columns)
  const names = columns.map((c) => c.name)
  const first = names[0]!

  if (field.check !== undefined) {
    table.checks.push({ column: first, expression: field.check })
  }
  const labels =
    target.form === "label"
      ? target.labels
      : target.form === "pair"
        ? target.discriminators
        : []
  // Порожня множина не дає CHECK: `IN ()` — не SQL. Порожній перелік
  // реєстраторів означає «жоден документ не пише регістр»: рухів від
  // документів немає, тож і обмежувати нема чого.
  if (labels.length > 0) {
    const list = labels.map(sqlLiteral).join(", ")
    table.checks.push({
      column: first,
      expression: field.array
        ? `${quoteIdent(first)} <@ ARRAY[${list}]`
        : `${quoteIdent(first)} IN (${list})`,
    })
  }

  if (field.primaryKey) table.primaryKey = { columns: names }
  if (field.unique) {
    table.uniques.push({
      columns:
        field.uniqueWithin !== undefined
          ? [field.uniqueWithin, ...names]
          : names,
      nullsNotDistinct: false,
    })
  }
  if (field.partialUnique !== undefined) {
    // Частковий унікальний індекс: UNIQUE-обмеження умови не має. Скоуп-колонка
    // веде ключ, бо предвизначені елементи унікальні в межах тенанта.
    table.indexes.push({
      unique: true,
      method: "btree",
      keys: (field.uniqueWithin !== undefined
        ? [field.uniqueWithin, ...names]
        : names
      ).map((column) => ({ column })),
      include: [],
      where: field.partialUnique,
      nullsNotDistinct: false,
    })
  }
  if (target.form === "foreignKey") {
    // Складений FK тримає обидва кінці в одному значенні скоупу (спека §6).
    const { scope } = target
    const columns = scope !== undefined ? [scope.from, ...names] : names
    table.foreignKeys.push({
      columns,
      references: {
        schema: target.schema,
        table: target.table,
        columns:
          scope !== undefined ? [scope.to, target.column] : [target.column],
      },
      onDelete: field.onDelete,
      onUpdate: "noAction",
      deferrable: "no",
    })
    // FK сам індексу не має, а перевірка при DELETE/UPDATE ключа цілі шукає
    // рядки рівно за колонками FK — тож індекс саме на них, у порядку FK.
    table.derivedIndexes.push(columns)
  } else if (field.indexed) {
    // Пошуковий індекс; `indexed` посилання вже задоволено індексом його FK.
    table.derivedIndexes.push(withinScope(names, field.indexWithin))
  }
  return names
}

/**
 * Похідний індекс не будується, якщо його колонки вже є префіксом (у тому ж
 * порядку) первинного ключа, UNIQUE чи іншого похідного індексу — B-дерево
 * того ключа вже обслуговує такі пошуки. З однакових лишається перший.
 */
function materializeIndexes(table: PendingTable): void {
  const keys = [
    ...(table.primaryKey !== undefined ? [table.primaryKey.columns] : []),
    ...table.uniques.map((unique) => unique.columns),
  ]
  const { derivedIndexes: candidates } = table
  candidates.forEach((columns, i) => {
    const covered =
      keys.some((key) => startsWith(key, columns)) ||
      candidates.some(
        (other, j) =>
          j !== i &&
          startsWith(other, columns) &&
          (other.length > columns.length || j < i)
      )
    if (covered) return
    table.indexes.push({
      unique: false,
      method: "btree",
      keys: columns.map((column) => ({ column })),
      include: [],
      nullsNotDistinct: false,
    })
  })
}

/** Колонки індексу з провідною скоуп-колонкою, якщо її там ще немає. */
function withinScope(columns: string[], scope: string | undefined): string[] {
  return scope === undefined || columns[0] === scope
    ? columns
    : [scope, ...columns]
}

function startsWith(key: readonly string[], prefix: readonly string[]) {
  return prefix.length <= key.length && prefix.every((c, i) => key[i] === c)
}

/**
 * `DEFAULT` з типового значення метаданих — один шлях для реквізиту й
 * константи (спека §5). Для перерахування значення — логічне ім'я, а в
 * колонці лежить мітка, тож ім'я перекладається тим самим переліком, що й
 * `CHECK`; невідоме ім'я звітує стадія 4.
 */
function defaultOf(
  value: string | number | boolean | undefined,
  target: Target
): { default?: string } {
  if (value === undefined) return {}
  const label =
    target.form === "label" && typeof value === "string"
      ? target.labelOf.get(value)
      : undefined
  return { default: sqlLiteral(label ?? value) }
}

/** Значення за замовчуванням реквізиту як SQL-літерал. */
function sqlLiteral(value: string | number | boolean): string {
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`
  return String(value)
}

function bySchemaAndName(
  a: { schema: string; name: string },
  b: { schema: string; name: string }
): number {
  return compareStrings(a.schema, b.schema) || compareStrings(a.name, b.name)
}

// --- Імена обмежень та індексів ---------------------------------------------

/**
 * Простори імен PG-схеми. Індекс — відношення; первинний ключ і UNIQUE — і
 * відношення (свій індекс), і обмеження; CHECK і FK — лише обмеження. Postgres
 * уникає колізій саме з цими множинами (`ChooseRelationName`,
 * `ChooseConstraintName`), тож і ми.
 */
interface SchemaNames {
  relations: Set<string>
  constraints: Set<string>
  /** Об'єднання двох множин — для ключів, що займають обидва простори. */
  both: Set<string>
}

function assignNames(pending: readonly PendingTable[]): {
  tables: PhysicalTable[]
  requiredChecks: ModelStageResult["requiredChecks"]
} {
  const requiredChecks: ModelStageResult["requiredChecks"] = []
  const namespaces = new Map<string, SchemaNames>()
  const namesOf = (schema: string): SchemaNames => {
    let names = namespaces.get(schema)
    if (names === undefined) {
      names = { relations: new Set(), constraints: new Set(), both: new Set() }
      namespaces.set(schema, names)
    }
    return names
  }
  const take = (
    names: SchemaNames,
    name: string,
    relation: boolean,
    constraint: boolean
  ) => {
    if (relation) names.relations.add(name)
    if (constraint) names.constraints.add(name)
    names.both.add(name)
  }

  // Явні імена й імена таблиць зайняті до вибору будь-якого похідного імені.
  for (const table of pending) {
    const names = namesOf(table.schema)
    take(names, table.name, true, false)
    if (table.primaryKey?.name !== undefined) {
      take(names, table.primaryKey.name, true, true)
    }
    for (const unique of table.uniques) {
      if (unique.name !== undefined) take(names, unique.name, true, true)
    }
    for (const item of [...table.checks, ...table.foreignKeys]) {
      if (item.name !== undefined) take(names, item.name, false, true)
    }
    for (const index of table.indexes) {
      if (index.name !== undefined) take(names, index.name, true, false)
    }
  }

  const tables = pending.map((table) => {
    const names = namesOf(table.schema)
    const choose = (
      name2: string | undefined,
      label: string,
      avoid: Set<string>,
      relation: boolean,
      constraint: boolean
    ) => {
      const name = chooseConstraintName(table.name, name2, label, avoid)
      take(names, name, relation, constraint)
      return name
    }

    // Порядок — як у CREATE TABLE Postgres: послідовності identity, CHECK,
    // первинний ключ, UNIQUE, потім FK і окремі CREATE INDEX.
    for (const column of table.identityColumns) {
      choose(column, "seq", names.relations, true, false)
    }
    const checks = table.checks.map(
      ({ name, column, label, elementId, expression }) => {
        const assigned =
          name ??
          choose(column, label ?? "check", names.constraints, false, true)
        if (elementId !== undefined) {
          requiredChecks.push({
            objectId: table.origin.objectId ?? "",
            attributeId: elementId,
            table: { schema: table.schema, name: table.name },
            check: assigned,
          })
        }
        return { name: assigned, expression }
      }
    )
    const primaryKey =
      table.primaryKey === undefined
        ? undefined
        : {
            name:
              table.primaryKey.name ??
              choose(undefined, "pkey", names.both, true, true),
            columns: table.primaryKey.columns,
          }
    const uniques = table.uniques.map((unique) => ({
      name:
        unique.name ??
        choose(nameAddition(unique.columns), "key", names.both, true, true),
      columns: unique.columns,
      nullsNotDistinct: unique.nullsNotDistinct,
    }))
    const foreignKeys = table.foreignKeys.map((foreignKey) => ({
      ...foreignKey,
      name:
        foreignKey.name ??
        choose(
          nameAddition(foreignKey.columns),
          "fkey",
          names.constraints,
          false,
          true
        ),
    }))
    const indexes = table.indexes.map((index) => ({
      ...index,
      name:
        index.name ??
        choose(
          nameAddition(indexColumnNames(index)),
          "idx",
          names.relations,
          true,
          false
        ),
    }))

    const result: PhysicalTable = {
      schema: table.schema,
      name: table.name,
      ...(table.comment !== undefined ? { comment: table.comment } : {}),
      origin: table.origin,
      rowLevelSecurity: table.rowLevelSecurity,
      columns: table.columns,
      ...(primaryKey !== undefined ? { primaryKey } : {}),
      uniques: uniques.sort(byName),
      checks: checks.sort(byName),
      foreignKeys: foreignKeys.sort(byName),
      indexes: indexes.sort(byName),
    }
    return result
  })
  return { tables, requiredChecks }
}

function byName(a: { name: string }, b: { name: string }): number {
  return compareStrings(a.name, b.name)
}

/**
 * Імена колонок індексу як у `ChooseIndexColumnNames`: повтор імені отримує
 * числовий суфікс (`dd`, `dd1`), INCLUDE теж входить. Ключ-вираз сюди не
 * доходить: безіменний індекс з виразом — помилка стадії 4.
 */
function indexColumnNames(index: Omit<Index, "name">): string[] {
  const result: string[] = []
  const all = [
    ...index.keys.flatMap((key) => ("column" in key ? [key.column] : [])),
    ...index.include,
  ]
  for (const original of all) {
    let candidate = original
    for (let i = 1; result.includes(candidate); i++) {
      candidate = `${original}${i}`
    }
    result.push(candidate)
  }
  return result
}

/**
 * Доповнення з імен колонок як у `ChooseForeignKeyConstraintNameAddition` і
 * `ChooseIndexNameAddition`: імена з'єднуються через `_`, доки буфер не
 * досягне NAMEDATALEN байтів, — далі Postgres імен не дописує, решту обрізає
 * `makeObjectName`.
 */
function nameAddition(columns: readonly string[]): string {
  const encoder = new TextEncoder()
  let result = ""
  let bytes = 0
  for (const column of columns) {
    if (bytes > 0) {
      result += "_"
      bytes += 1
    }
    result += column
    bytes += encoder.encode(column).length
    if (bytes >= NAMEDATALEN) break
  }
  return result
}
