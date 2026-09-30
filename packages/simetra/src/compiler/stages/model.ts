import {
  KIND_REGISTRY,
  chooseConstraintName,
  pgEnumTypeName,
  pgTypeOf,
  quoteIdent,
  standardLogicalName,
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
  type StandardColumnDef,
  type TabularSection,
  type ValueType,
} from "simetra/model"
import { compareStrings } from "../diagnostics"
import { objectKey, type ParsedObject } from "./files"

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
}

/** Як фізично виражена ціль посилання. */
type Target =
  | { form: "foreignKey"; schema: string; table: string; column: string }
  | { form: "label"; labels: string[] }
  | { form: "pair"; discriminators: string[] }
  | { form: "none" }

/** Реквізит чи стандартна колонка до розкладу на колонки й обмеження. */
interface Field {
  name: string
  type: string
  array: boolean
  notNull: boolean
  default?: string
  check?: string
  primaryKey: boolean
  indexed: boolean
  unique: boolean
  target: Target
  onDelete: FkAction
  origin: PhysicalColumn["origin"]
  pointer?: string
}

/** Таблиця до призначення імен: `name` обмеження лише явне. */
interface PendingTable {
  schema: string
  name: string
  comment?: string
  origin: PhysicalTable["origin"]
  columns: PhysicalColumn[]
  identityColumns: string[]
  primaryKey?: { name?: string; columns: string[] }
  uniques: { name?: string; columns: string[]; nullsNotDistinct: boolean }[]
  /** `column` — єдина колонка виразу, що дає її ім'я в назві обмеження. */
  checks: { name?: string; column?: string; expression: string }[]
  foreignKeys: (Omit<ForeignKey, "name"> & { name?: string })[]
  indexes: (Omit<Index, "name"> & { name?: string })[]
}

/**
 * Стадія 3 (спека П2 §5, §8.2–§8.3): фізичний знімок з реєстру видів —
 * стандартні колонки виду, колонки реквізитів, ключі, обмеження й індекси,
 * а також таблиці `CustomTable` і енам-типи `PgEnum` як є. Імена похідних
 * обмежень — за алгоритмом Postgres, тож збігаються з тими, що дала б сама БД.
 * Вхід — без помилок стадій 1–2: id, physicalName і цілі посилань є.
 */
export function buildModel(
  objects: readonly ParsedObject[],
  project: Project
): ModelStageResult {
  const builder = new SnapshotBuilder(objects, project)
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

  constructor(
    objects: readonly ParsedObject[],
    private readonly project: Project
  ) {
    this.byKey = new Map(objects.map((o) => [objectKey(o.kind, o.name), o]))
    this.style = project.naming.attributeCase
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
    if (Array.isArray(data.columns)) {
      this.addDeclaredTable(object, data as unknown as CustomTable)
      return
    }

    const main = this.pendingTable(schema, name, origin)
    const fields = def
      .standardColumns(data)
      .map((column) => this.standardField(column, object, main))
    // Порядок ролей регістра — виміри, ресурси, реквізити; у решти видів є
    // лише реквізити.
    for (const role of ["dimensions", "resources", "attributes"]) {
      const list = (data[role] ?? []) as Attribute[]
      list.forEach((attribute, index) => {
        fields.push(this.attributeField(attribute, `/${role}/${index}`))
        this.declare(
          object.file,
          `/${role}/${index}/physicalName`,
          attribute.physicalName!
        )
      })
    }
    this.addTable(main, fields, object.file, "/physicalName")

    const sections = (data.tabularSections ?? []) as TabularSection[]
    sections.forEach((section, index) => {
      const pointer = `/tabularSections/${index}`
      const table = this.pendingTable(schema, section.physicalName!, {
        ...origin,
        tabularSectionId: section.id ?? "",
      })
      const sectionFields = (def.tabularSectionColumns?.(data) ?? []).map(
        (column) => this.standardField(column, object, main)
      )
      section.attributes.forEach((attribute, i) => {
        sectionFields.push(
          this.attributeField(attribute, `${pointer}/attributes/${i}`)
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

  finish(): ModelStageResult {
    // Імена призначаються в порядку знімка: рендер, що йде тим самим
    // порядком, отримає від Postgres ті самі імена навіть за колізій.
    const pending = [...this.tables].sort(bySchemaAndName)
    const tables = assignNames(pending)
    return {
      physical: {
        tables,
        enumTypes: [...this.enumTypes].sort(bySchemaAndName),
      },
      sources: this.sources,
      declaredNames: this.declaredNames,
    }
  }

  // --- Таблиці видів ------------------------------------------------------

  private pendingTable(
    schema: string,
    name: string,
    origin: PhysicalTable["origin"]
  ): PendingTable {
    return {
      schema,
      name,
      origin,
      columns: [],
      identityColumns: [],
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: [],
    }
  }

  private addTable(
    table: PendingTable,
    fields: Field[],
    file: string,
    pointer: string
  ): void {
    const source: PhysicalSource = {
      schema: table.schema,
      name: table.name,
      file,
      pointer,
      columns: [],
      explicitNames: [],
    }
    for (const field of fields) {
      for (const column of addField(table, field)) {
        source.columns.push({
          name: column,
          ...(field.pointer !== undefined ? { pointer: field.pointer } : {}),
        })
      }
    }
    this.tables.push(table)
    this.sources.push(source)
  }

  private standardField(
    column: StandardColumnDef,
    object: ParsedObject,
    ownTable: PendingTable
  ): Field {
    const resolved =
      "raw" in column.type
        ? { type: column.type.raw, array: false, target: NONE }
        : this.resolveValue(column.type)
    let target = resolved.target
    if (column.ref !== undefined) {
      const refs = this.standardTargets(column, object)
      target =
        column.polymorphic !== undefined
          ? { form: "pair", discriminators: refs.map(physicalNameOf) }
          : column.ref === "self" || column.ref === "owningObject"
            ? // Ключ власної таблиці: рядок ТЧ і батько ієрархії посилаються
              // на таблицю самого об'єкта.
              this.keyTarget(object, ownTable)
            : refs[0] === undefined
              ? NONE
              : this.tableTarget(refs[0])
    }
    return {
      name: column.physicalName,
      type: resolved.type,
      array: resolved.array,
      notNull: column.notNull,
      ...(column.default !== undefined ? { default: column.default } : {}),
      ...(column.check !== undefined ? { check: column.check } : {}),
      primaryKey: column.primaryKey === true,
      indexed: column.indexed === true,
      unique: column.unique === true,
      target,
      onDelete: column.onDelete ?? "noAction",
      origin: { standard: standardLogicalName(column, this.style) },
    }
  }

  /** Цілі стандартного посилання: список з налаштувань виду. */
  private standardTargets(
    column: StandardColumnDef,
    object: ParsedObject
  ): ParsedObject[] {
    const data = object.data as Element
    const refs =
      column.ref === "owners"
        ? data.owners
        : column.ref === "recorders"
          ? data.recorderTypes
          : []
    return ((refs ?? []) as MetadataRef[]).map((ref) => this.lookup(ref))
  }

  private attributeField(attribute: Attribute, pointer: string): Field {
    const resolved = this.resolveValue(attribute)
    return {
      name: attribute.physicalName!,
      ...resolved,
      notNull: attribute.required,
      ...(attribute.defaultValue !== undefined
        ? { default: sqlLiteral(attribute.defaultValue) }
        : {}),
      primaryKey: false,
      indexed: attribute.indexed,
      unique: attribute.unique,
      onDelete: "noAction",
      origin: { elementId: attribute.id ?? "" },
      pointer: `${pointer}/physicalName`,
    }
  }

  /** Тип колонки й фізична форма цілі для логічного типу. */
  private resolveValue(value: ValueType): {
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
        physicalName?: string
      }[]
      return {
        type,
        array,
        target: {
          form: "label",
          labels: values.map((v) => v.physicalName ?? ""),
        },
      }
    }
    // FK на елементи масиву Postgres не має (спека §4).
    return { type, array, target: array ? NONE : this.tableTarget(target) }
  }

  private tableTarget(target: ParsedObject): Target {
    const column = keyColumnOf(target)
    if (column === undefined) return NONE
    return {
      form: "foreignKey",
      schema: this.schemaOf(target),
      table: physicalNameOf(target),
      column,
    }
  }

  private keyTarget(object: ParsedObject, table: PendingTable): Target {
    const column = keyColumnOf(object)
    if (column === undefined) return NONE
    return {
      form: "foreignKey",
      schema: table.schema,
      table: table.name,
      column,
    }
  }

  // --- CustomTable --------------------------------------------------------

  private addDeclaredTable(object: ParsedObject, data: CustomTable): void {
    const table = this.pendingTable(
      this.schemaOf(object),
      physicalNameOf(object),
      { objectId: object.id ?? "" }
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

    const own = declaredColumnMap(data)
    const map = (names: readonly string[], columns = own) =>
      names.map((n) => columns.get(n) ?? n)
    const physicalColumns = new Set(own.values())

    if (data.primaryKey !== undefined) {
      table.primaryKey = {
        ...explicit(data.primaryKey.name, "/primaryKey/name"),
        columns: map(data.primaryKey.columns),
      }
    }
    data.uniques.forEach((unique, i) => {
      table.uniques.push({
        ...explicit(unique.name, `/uniques/${i}/name`),
        columns: map(unique.columns),
        nullsNotDistinct: unique.nullsNotDistinct,
      })
    })
    data.checks.forEach((check, i) => {
      const column = soleColumnOf(check.expression, physicalColumns)
      table.checks.push({
        ...explicit(check.name, `/checks/${i}/name`),
        ...(column !== undefined ? { column } : {}),
        expression: check.expression,
      })
    })
    data.foreignKeys.forEach((foreignKey, i) => {
      const { references } = foreignKey
      let target: ForeignKey["references"]
      if ("object" in references) {
        const object = this.lookup(references.object)
        target = {
          schema: this.schemaOf(object),
          table: physicalNameOf(object),
          columns: map(references.columns, this.columnMapOf(object)),
        }
      } else {
        target = { ...references.external }
      }
      table.foreignKeys.push({
        ...explicit(foreignKey.name, `/foreignKeys/${i}/name`),
        columns: map(foreignKey.columns),
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
        keys: index.keys.map((key) =>
          "column" in key ? { column: own.get(key.column) ?? key.column } : key
        ),
        include: map(index.include),
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
    const value = { ...column, type: column.type }
    // Прийнята таблиця нічого не виводить: `Ref` дає лише тип, без FK (спека §4).
    const target =
      column.ref !== undefined ? this.lookup(column.ref).kind : undefined
    return pgTypeOf(value, target)
  }

  /** Логічне ім'я колонки → фізичне для таблиці цілі FK. */
  private columnMapOf(object: ParsedObject): Map<string, string> {
    const data = object.data as Element
    if (Array.isArray(data.columns)) {
      return declaredColumnMap(data as unknown as CustomTable)
    }
    const map = new Map<string, string>()
    for (const column of KIND_REGISTRY[object.kind].standardColumns(data)) {
      if (column.polymorphic === undefined) {
        map.set(standardLogicalName(column, this.style), column.physicalName)
      }
    }
    for (const role of ["dimensions", "resources", "attributes"]) {
      for (const attribute of (data[role] ?? []) as Attribute[]) {
        map.set(attribute.name, attribute.physicalName!)
      }
    }
    return map
  }

  // --- Допоміжне ----------------------------------------------------------

  private lookup(ref: MetadataRef): ParsedObject {
    // Стадія 2 без помилок гарантує, що кожне посилання резолвиться.
    return this.byKey.get(objectKey(ref.kind, ref.name))!
  }

  private schemaOf(object: ParsedObject): string {
    return (
      ((object.data as Element).schema as string | undefined) ??
      this.project.defaultSchema
    )
  }

  private declare(file: string, pointer: string, name: string): void {
    this.declaredNames.push({ file, pointer, name })
  }
}

const NONE: Target = { form: "none" }

function physicalNameOf(object: ParsedObject): string {
  return (object.data as { physicalName: string }).physicalName
}

function declaredColumnMap(data: CustomTable): Map<string, string> {
  return new Map(data.columns.map((c) => [c.name, c.physicalName!]))
}

/**
 * Колонка, на яку може посилатися FK з `Ref`: одноколонковий uuid-ключ.
 * У видів ключ дає реєстр, у прийнятої таблиці — її опис; без такого ключа
 * `Ref` на ціль неможливий (стадія 4, `reference.custom-table-key`).
 */
export function keyColumnOf(object: ParsedObject): string | undefined {
  const data = object.data as Element
  if (Array.isArray(data.columns)) {
    const table = data as unknown as CustomTable
    const key = table.primaryKey?.columns
    if (key?.length !== 1) return undefined
    const column = table.columns.find((c) => c.name === key[0])
    if (column === undefined || column.array === true) return undefined
    const isUuid =
      column.type === "UUID" ||
      (column.type === "Raw" && column.pgType?.toLowerCase() === "uuid")
    return isUuid ? column.physicalName : undefined
  }
  const keys = KIND_REGISTRY[object.kind]
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
  // Порожня множина не дає CHECK: `IN ()` — не SQL, а порожній список
  // реєстраторів означає «будь-який документ».
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
    table.uniques.push({ columns: names, nullsNotDistinct: false })
  }
  if (target.form === "foreignKey") {
    table.foreignKeys.push({
      columns: names,
      references: {
        schema: target.schema,
        table: target.table,
        columns: [target.column],
      },
      onDelete: field.onDelete,
      onUpdate: "noAction",
      deferrable: "no",
    })
  }
  // UNIQUE і первинний ключ уже мають індекс; FK — ні, тож одиночне
  // посилання індексується завжди.
  const needsIndex = field.indexed || target.form === "foreignKey"
  if (needsIndex && !field.unique && !field.primaryKey) {
    table.indexes.push({
      unique: false,
      method: "btree",
      keys: names.map((column) => ({ column })),
      include: [],
      nullsNotDistinct: false,
    })
  }
  return names
}

/** Значення за замовчуванням реквізиту як SQL-літерал. */
function sqlLiteral(value: string | number | boolean): string {
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`
  return String(value)
}

/**
 * Єдина колонка таблиці, яку згадує вираз CHECK, — як у Postgres, що називає
 * обмеження `<таблиця>_<колонка>_check` лише для виразу над однією колонкою.
 * Наближення: Postgres рахує змінні дерева виразу, тут — ідентифікатори
 * тексту поза рядковими літералами, що збігаються з колонками таблиці.
 */
function soleColumnOf(
  expression: string,
  columns: ReadonlySet<string>
): string | undefined {
  const found = new Set<string>()
  const token = /'(?:[^']|'')*'|"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*)/g
  for (const match of expression.matchAll(token)) {
    const name =
      match[1] !== undefined
        ? match[1].replaceAll('""', '"')
        : match[2]?.toLowerCase()
    if (name !== undefined && columns.has(name)) found.add(name)
  }
  return found.size === 1 ? [...found][0] : undefined
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

function assignNames(pending: readonly PendingTable[]): PhysicalTable[] {
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

  return pending.map((table) => {
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
    const checks = table.checks.map(({ name, column, expression }) => ({
      name: name ?? choose(column, "check", names.constraints, false, true),
      expression,
    }))
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
      columns: table.columns,
      ...(primaryKey !== undefined ? { primaryKey } : {}),
      uniques: uniques.sort(byName),
      checks: checks.sort(byName),
      foreignKeys: foreignKeys.sort(byName),
      indexes: indexes.sort(byName),
    }
    return result
  })
}

function byName(a: { name: string }, b: { name: string }): number {
  return compareStrings(a.name, b.name)
}

/**
 * Імена колонок індексу як у `ChooseIndexColumnNames`: вираз — `expr`, а
 * повтор імені отримує числовий суфікс (`expr1`, …). INCLUDE теж входить.
 */
function indexColumnNames(index: Omit<Index, "name">): string[] {
  const result: string[] = []
  const all = [
    ...index.keys.map((key) => ("column" in key ? key.column : "expr")),
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
