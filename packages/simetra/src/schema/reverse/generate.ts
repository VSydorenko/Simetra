import {
  changesBetween,
  compile,
  completeFiles,
  diagnostic,
  sortDiagnostics,
  type CompiledModel,
  type Diagnostic,
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
  project: { name: string; defaultSchema: string; attributeCase: AttributeCase }
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

/**
 * Що в базі вже описує тека поза файлами генератора: таблиці видів 1С та
 * одиниці їхніх `.sql` і обгортки рухів. Їх не можна описати вдруге — інакше
 * підсумкова тека мала б два описи одного об'єкта. Тека, що не компілюється,
 * цього не каже; тоді причину назве компіляція результату.
 */
async function describedElsewhere(
  existing: ReadonlyMap<string, string>
): Promise<{ relations: Set<string>; units: Set<string> }> {
  const relations = new Set<string>()
  const units = new Set<string>()
  if (
    ![...existing.keys()].some((p) => p !== PROJECT_FILE && !isGeneratedPath(p))
  )
    return { relations, units }
  const compiled = await compile(existing)
  const model: CompiledModel | undefined = compiled.model
  if (model === undefined) return { relations, units }
  const generated = new Set(
    model.objects
      .filter((o) => (GENERATED_KINDS as readonly string[]).includes(o.kind))
      .map((o) => o.id)
  )
  for (const item of [...model.physical.tables, ...model.physical.enumTypes])
    if (!generated.has(item.origin.objectId))
      relations.add(qualified(item.schema, item.name))
  for (const unit of model.sqlUnits)
    if (unit.file === undefined || !isGeneratedPath(unit.file))
      units.add(unit.identity)
  return { relations, units }
}

/** Розбіжність наявного проєкту з запитом — межа, яку бачить виклик. */
function projectMismatch(
  folder: ExistingFolder,
  requested: ReverseOptions["project"]
): Diagnostic[] {
  const project = folder.project
  if (
    project === undefined ||
    project.defaultSchema === requested.defaultSchema
  )
    return []
  return [
    diagnostic("introspect.project-mismatch", PROJECT_FILE, "/defaultSchema", {
      field: "defaultSchema",
      project: project.defaultSchema,
      requested: requested.defaultSchema,
    }),
  ]
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

  const ctx: TablesContext = {
    defaultSchema,
    tables: tableNames,
    enums: enumNames,
  }
  const generated = new Map<string, string>()
  const sidecars = new Map<string, string>()
  const objects: Record<string, unknown>[] = []
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
    objects.push(data)
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
  const laid = layoutUnits(
    model.units.filter((u) => !elsewhere.units.has(u.identity)),
    { parse: o.parse, defaultSchema, sidecars }
  )
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
