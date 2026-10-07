import {
  changesBetween,
  compile,
  completeFiles,
  diagnostic,
  sortDiagnostics,
  type CompiledModel,
  type Diagnostic,
  type SourceObject,
  type FileChange,
  type IdSource,
  type SchemaPathResolver,
  type SqlParser,
} from "simetra/compiler"
import {
  KIND_REGISTRY,
  formatProjectFile,
  type AttributeCase,
  type CatalogModel,
  type CatalogTable,
  type DatabaseProvider,
  type PhysicalColumn,
} from "simetra/model"
import {
  GENERATED_KINDS,
  PROJECT_FILE,
  isGeneratedPath,
  objectKey,
  readExisting,
  type ExistingFolder,
} from "./identity"
import { columnNames, objectNames } from "./names"
import {
  customTableData,
  pgEnumData,
  unrepresentableEnum,
  unrepresentableTable,
  type TableNames,
  type TablesContext,
} from "./tables"
import { layoutUnits } from "./units"

export interface ReverseOptions {
  /** Проєкт нової теки; наявний `project.meta.json` не переписується. */
  project: {
    name: string
    defaultSchema: string
    attributeCase: AttributeCase
    databaseProvider: DatabaseProvider
  }
  /** Наявна тека метаданих: шлях відносно `metadata/` → вміст. */
  existing: ReadonlyMap<string, string>
  newId: IdSource
  schemaPath: SchemaPathResolver
  parse: SqlParser
}

export interface ReverseResult {
  /** Підсумкова тека після злиття — саме її компілює генератор. */
  files: Map<string, string>
  /** Зміни відносно `existing`; порожні, коли є хоч одна помилка. */
  changes: FileChange[]
  /** Помилки генератора й компіляції підсумкової теки. */
  diagnostics: Diagnostic[]
}

const qualified = (schema: string, name: string) => `${schema}.${name}`
const META = ".meta.json"

const pathOf = (kind: (typeof GENERATED_KINDS)[number], name: string) =>
  `${KIND_REGISTRY[kind].dir}/${name}/${name}`

/** Що в базі вже описують файли теки поза генератором. */
interface Elsewhere {
  /** Таблиці й енам-типи збережених об'єктів (`schema.name`). */
  relations: Set<string>
  /** Ідентичності одиниць їхніх `.sql` і обгорток рухів. */
  units: Set<string>
  /** Основні таблиці збережених об'єктів — цілі `MetadataRef` для FK. */
  targets: Map<string, TableNames>
  /** Обробники збережених підписок (`schema.name`): їх кличе збережений файл. */
  handlers: Set<string>
}

/**
 * Що в базі вже описує тека поза файлами генератора: таблиці видів 1С та
 * одиниці їхніх `.sql` і обгортки рухів. Їх не можна описати вдруге — інакше
 * підсумкова тека мала б два описи одного об'єкта. Тека, що не компілюється,
 * цього не каже; тоді причину назве компіляція результату.
 */
async function describedElsewhere(
  existing: ReadonlyMap<string, string>
): Promise<Elsewhere> {
  const found: Elsewhere = {
    relations: new Set(),
    units: new Set(),
    targets: new Map(),
    handlers: new Set(),
  }
  if (
    ![...existing.keys()].some((p) => p !== PROJECT_FILE && !isGeneratedPath(p))
  )
    return found
  const compiled = await compile(existing)
  const model: CompiledModel | undefined = compiled.model
  if (model === undefined) return found
  const kept = new Map(
    model.objects
      .filter((o) => !(GENERATED_KINDS as readonly string[]).includes(o.kind))
      .map((o) => [o.id, o])
  )
  for (const item of model.physical.enumTypes)
    if (kept.has(item.origin.objectId))
      found.relations.add(qualified(item.schema, item.name))
  for (const table of model.physical.tables) {
    const object = kept.get(table.origin.objectId)
    if (object === undefined) continue
    const key = qualified(table.schema, table.name)
    found.relations.add(key)
    // Таблиця ТЧ чи похідна таблиця регістра `MetadataRef` не має: посилання
    // на об'єкт — це його основна таблиця.
    if (table.origin.tabularSectionId !== undefined || table.origin.part)
      continue
    found.targets.set(key, {
      kind: object.kind,
      object: object.name,
      columns: keptColumns(object, table.columns),
    })
  }
  for (const unit of model.sqlUnits)
    if (unit.file === undefined || !isGeneratedPath(unit.file))
      found.units.add(unit.identity)
  for (const { handler } of model.contracts.eventSubscriptions)
    found.handlers.add(qualified(handler.schema, handler.name))
  return found
}

/**
 * Логічні імена колонок збереженого об'єкта: стандартна — за `origin.standard`
 * (уже в стилі проєкту), решта — ім'я елемента за `origin.elementId`. Колонка
 * без жодного (додана скоуп-колонка) імені не має, тож FK на неї невиражений.
 */
function keptColumns(
  object: SourceObject,
  columns: readonly PhysicalColumn[]
): Map<string, string> {
  const elements = new Map<string, string>()
  const data = object.data as Record<string, unknown>
  for (const field of KIND_REGISTRY[object.kind].columnFields)
    for (const element of (data[field] as Record<string, unknown>[]) ?? [])
      if (typeof element.id === "string" && typeof element.name === "string")
        elements.set(element.id, element.name)
  const result = new Map<string, string>()
  for (const column of columns) {
    const name =
      column.origin.standard ??
      (column.origin.elementId === undefined
        ? undefined
        : elements.get(column.origin.elementId))
    if (name !== undefined) result.set(column.name, name)
  }
  return result
}

/**
 * FK на таблицю моделі пишеться `MetadataRef` (одна форма посилання); ціль,
 * яку тека описує, але без такого посилання (таблиця ТЧ, похідна таблиця
 * регістра, колонка без логічного імені), — невиражена.
 */
function foreignKeyDiagnostics(
  table: CatalogTable,
  elsewhere: Elsewhere,
  targets: ReadonlyMap<string, TableNames>
): Diagnostic[] {
  const result: Diagnostic[] = []
  for (const fk of table.foreignKeys) {
    const { schema, table: name, columns } = fk.references
    const key = qualified(schema, name)
    const target = targets.get(key)
    const missing =
      target === undefined
        ? elsewhere.relations.has(key)
        : columns.some((c) => !target.columns.has(c))
    if (missing)
      result.push(
        diagnostic("introspect.unrepresentable", "", "", {
          object: `${qualified(table.schema, table.name)}.${fk.name}`,
          property: "references",
          detail: `${key}(${columns.join(", ")}) has no metadata reference form`,
        })
      )
  }
  return result
}

/**
 * Розбіжність наявного проєкту з запитом: файл проєкту не переписується, тож
 * діють його `name`, `defaultSchema`, `naming.attributeCase` і
 * `database.provider`, а виклик має
 * про це знати, а не отримати інші імена й схеми мовчки.
 */
function projectMismatch(
  folder: ExistingFolder,
  requested: ReverseOptions["project"]
): Diagnostic[] {
  const project = folder.project
  if (project === undefined) return []
  const fields = [
    ["name", "/name", project.name, requested.name],
    [
      "defaultSchema",
      "/defaultSchema",
      project.defaultSchema,
      requested.defaultSchema,
    ],
    [
      "naming.attributeCase",
      "/naming/attributeCase",
      project.attributeCase,
      requested.attributeCase,
    ],
    [
      "database.provider",
      "/database/provider",
      project.databaseProvider,
      requested.databaseProvider,
    ],
  ] as const
  return fields
    .filter(([, , own, asked]) => own !== asked)
    .map(([field, pointer, own, asked]) =>
      diagnostic("introspect.project-mismatch", PROJECT_FILE, pointer, {
        field,
        project: own,
        requested: asked,
      })
    )
}

/**
 * Identity sequence names are derived by the compiler, not declared; a
 * database sequence the compiler would name differently cannot be described.
 */
function sequenceDiagnostics(
  model: CompiledModel,
  tables: readonly CatalogTable[]
): Diagnostic[] {
  const compiled = new Map(
    model.physical.tables.map((t) => [qualified(t.schema, t.name), t])
  )
  const result: Diagnostic[] = []
  for (const table of tables) {
    const own = compiled.get(qualified(table.schema, table.name))
    for (const column of table.columns) {
      if (column.identity === undefined) continue
      const derived = own?.columns.find((c) => c.name === column.name)?.identity
        ?.sequence
      if (derived === column.identity.sequence) continue
      result.push(
        diagnostic("introspect.unrepresentable", "", "", {
          object: `${qualified(table.schema, table.name)}.${column.name}`,
          property: "identity.sequence",
          detail: `sequence ${column.identity.sequence} would be created as ${derived ?? "none"}`,
        })
      )
    }
  }
  return result
}

/**
 * Reverse generation (P2 spec §9): turns the catalog model of a live database
 * into `CustomTable`, `PgEnum` and verbatim `*.sql` files, merged into an
 * existing metadata folder. Identity is kept by `(kind, schema, physicalName)`
 * for objects and by physical name within a table for columns; generated
 * files whose object is gone are deleted, other files are left alone. The
 * merged folder is compiled; any error leaves `changes` empty.
 */
export async function reverseGenerate(
  model: CatalogModel,
  o: ReverseOptions
): Promise<ReverseResult> {
  const folder = readExisting(o.existing, o.project.defaultSchema)
  const defaultSchema = folder.project?.defaultSchema ?? o.project.defaultSchema
  const style = folder.project?.attributeCase ?? o.project.attributeCase
  const diagnostics: Diagnostic[] = [
    ...folder.diagnostics,
    ...projectMismatch(folder, o.project),
  ]
  const elsewhere = await describedElsewhere(o.existing)
  const existingOf = (kind: string, schema: string, physical: string) =>
    folder.objects.get(objectKey(kind, schema, physical))

  const candidates = model.tables.filter(
    (t) => !elsewhere.relations.has(qualified(t.schema, t.name))
  )
  const enumCandidates = model.enumTypes.filter(
    (e) => !elsewhere.relations.has(qualified(e.schema, e.name))
  )
  for (const table of candidates)
    diagnostics.push(...unrepresentableTable(table))
  for (const type of enumCandidates)
    diagnostics.push(...unrepresentableEnum(type))
  const broken = new Set(
    diagnostics
      .filter((d) => d.code === "introspect.unrepresentable")
      .map((d) => d.params?.object)
  )
  const tables = candidates.filter(
    (t) => !broken.has(qualified(t.schema, t.name))
  )
  const enumTypes = enumCandidates.filter(
    (e) => !broken.has(qualified(e.schema, e.name))
  )

  const names = objectNames([
    ...tables.map((t) => ({
      key: objectKey("CustomTable", t.schema, t.name),
      schema: t.schema,
      physical: t.name,
      preserved: existingOf("CustomTable", t.schema, t.name)?.raw.name as
        string | undefined,
    })),
    ...enumTypes.map((e) => ({
      key: objectKey("PgEnum", e.schema, e.name),
      schema: e.schema,
      physical: e.name,
      preserved: existingOf("PgEnum", e.schema, e.name)?.raw.name as
        string | undefined,
    })),
  ])
  const unnamed = (object: string) =>
    diagnostic("introspect.unrepresentable", "", "", {
      object,
      property: "name",
      detail: "the physical name has no valid logical name",
    })

  const tableNames = new Map<string, TableNames>()
  for (const table of tables) {
    const object = names.get(objectKey("CustomTable", table.schema, table.name))
    if (object === undefined) {
      diagnostics.push(unnamed(qualified(table.schema, table.name)))
      continue
    }
    const existing = existingOf("CustomTable", table.schema, table.name)
    const columns = columnNames(
      table.columns.map((c) => ({
        key: c.name,
        schema: "",
        physical: c.name,
        preserved: existing?.columns.get(c.name)?.name as string | undefined,
      })),
      style
    )
    const missing = table.columns.filter(
      (c) => columns.get(c.name) === undefined
    )
    for (const c of missing)
      diagnostics.push(
        unnamed(`${qualified(table.schema, table.name)}.${c.name}`)
      )
    if (missing.length === 0)
      tableNames.set(qualified(table.schema, table.name), {
        kind: "CustomTable",
        object,
        columns: columns as Map<string, string>,
      })
  }
  const enumNames = new Map<string, string>()
  for (const type of enumTypes) {
    const name = names.get(objectKey("PgEnum", type.schema, type.name))
    if (name === undefined)
      diagnostics.push(unnamed(qualified(type.schema, type.name)))
    else enumNames.set(qualified(type.schema, type.name), name)
  }

  const targets = new Map([...elsewhere.targets, ...tableNames])
  for (const table of tables)
    diagnostics.push(...foreignKeyDiagnostics(table, elsewhere, targets))
  const ctx: TablesContext = {
    defaultSchema,
    tables: targets,
    enums: enumNames,
  }
  const generated = new Map<string, string>()
  const sidecars = new Map<string, string>()
  for (const table of tables) {
    const key = qualified(table.schema, table.name)
    const own = tableNames.get(key)
    if (own === undefined) continue
    const base = pathOf("CustomTable", own.object)
    sidecars.set(key, `${base}.sql`)
    const data = customTableData(
      table,
      own,
      ctx,
      existingOf("CustomTable", table.schema, table.name)
    )
    generated.set(`${base}${META}`, JSON.stringify(data))
  }
  for (const type of enumTypes) {
    const name = enumNames.get(qualified(type.schema, type.name))
    if (name === undefined) continue
    const data = pgEnumData(
      type,
      name,
      defaultSchema,
      existingOf("PgEnum", type.schema, type.name)
    )
    generated.set(`${pathOf("PgEnum", name)}${META}`, JSON.stringify(data))
  }
  // Виклики тригерної функції рахуються й серед одиниць збережених файлів і
  // збережених підписок: функція, яку кличе ще й тригер чи підписка
  // довідника, не належить одній таблиці.
  const laid = layoutUnits(model.units, {
    parse: o.parse,
    defaultSchema,
    sidecars,
    described: elsewhere.units,
    handlers: elsewhere.handlers,
  })
  diagnostics.push(...laid.diagnostics)
  for (const [path, text] of laid.files) generated.set(path, text)

  // Підсумкова тека: файли генератора замінюються повністю; модуль таблиці —
  // ручний файл, тож лишається, поки лишається його таблиця.
  const merged = new Map<string, string>()
  for (const [path, text] of o.existing) {
    if (!isGeneratedPath(path)) merged.set(path, text)
    else if (
      path.endsWith(".module.ts") &&
      generated.has(path.replace(/\.module\.ts$/, META))
    )
      merged.set(path, text)
  }
  for (const [path, text] of generated) merged.set(path, text)
  const writable = new Set(
    [...generated.keys()].filter((path) => path.endsWith(META))
  )
  if (!o.existing.has(PROJECT_FILE)) {
    merged.set(
      PROJECT_FILE,
      formatProjectFile({
        name: o.project.name,
        defaultSchema: o.project.defaultSchema,
        database: { provider: o.project.databaseProvider },
        naming: { attributeCase: o.project.attributeCase },
      })
    )
    writable.add(PROJECT_FILE)
  }
  const completed = completeFiles(
    merged,
    { schemaPath: o.schemaPath, newId: o.newId },
    writable
  )
  const files = completed.files
  const compiled = await compile(files)
  diagnostics.push(...completed.diagnostics, ...compiled.diagnostics)
  if (compiled.model !== undefined)
    diagnostics.push(
      ...sequenceDiagnostics(
        compiled.model,
        tables.filter((t) => tableNames.has(qualified(t.schema, t.name)))
      )
    )

  const sorted = sortDiagnostics(diagnostics)
  return {
    files,
    changes: sorted.some((d) => d.severity === "error")
      ? []
      : changesBetween(o.existing, files),
    diagnostics: sorted,
  }
}
