import { diagnostic, type Diagnostic } from "simetra/compiler"
import {
  KIND_REGISTRY,
  projectSchema,
  type AttributeCase,
  type DatabaseProvider,
} from "simetra/model"

export const PROJECT_FILE = "project.meta.json"

/** Види, файли яких пише зворотний генератор. */
export const GENERATED_KINDS = ["CustomTable", "PgEnum"] as const
export type GeneratedKind = (typeof GENERATED_KINDS)[number]

const GENERATED_DIRS: ReadonlySet<string> = new Set(
  GENERATED_KINDS.map((kind) => KIND_REGISTRY[kind].dir)
)

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Об'єкт наявної теки з ключем `(kind, schema, physicalName)`. */
export interface ExistingObject {
  file: string
  raw: Json
  /** Колонки `CustomTable` за фізичним іменем. */
  columns: ReadonlyMap<string, Json>
}

export interface ExistingFolder {
  project?: {
    name: string
    defaultSchema: string
    attributeCase: AttributeCase
    databaseProvider: DatabaseProvider
  }
  objects: ReadonlyMap<string, ExistingObject>
  diagnostics: Diagnostic[]
}

export const objectKey = (kind: string, schema: string, physical: string) =>
  `${kind}\0${schema}\0${physical}`

/**
 * Файл, яким володіє зворотний генератор: опис і супутні файли
 * `CustomTable`/`PgEnum` та спільний дослівний SQL. Файли видів 1С і решта
 * ручних файлів йому не належать (план E2b, рішення 6).
 */
export function isGeneratedPath(path: string): boolean {
  const segments = path.split("/")
  if (segments.length !== 3) return false
  if (segments[0] === "sql") return segments[2]!.endsWith(".sql")
  return GENERATED_DIRS.has(segments[0]!)
}

function parseJson(text: string | undefined): Json | undefined {
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

const physicalOf = (element: Json) =>
  typeof element.physicalName === "string" ? element.physicalName : undefined

/**
 * Ідентичність наявної теки (рішення 6): об'єкти за `(kind, schema,
 * physicalName)`, колонки — за фізичним іменем у своїй таблиці. Дублікат
 * ключа — `introspect.identity-conflict`: котрий з двох id зберегти, вирішує
 * автор, а не порядок обходу.
 */
export function readExisting(
  files: ReadonlyMap<string, string>,
  requestedSchema: string
): ExistingFolder {
  const diagnostics: Diagnostic[] = []
  const parsedProject = projectSchema.safeParse(
    parseJson(files.get(PROJECT_FILE))
  )
  const project = parsedProject.success
    ? {
        name: parsedProject.data.name,
        defaultSchema: parsedProject.data.defaultSchema,
        attributeCase: parsedProject.data.naming.attributeCase,
        databaseProvider: parsedProject.data.database.provider,
      }
    : undefined
  const defaultSchema = project?.defaultSchema ?? requestedSchema
  const objects = new Map<string, ExistingObject>()
  for (const path of [...files.keys()].sort()) {
    const segments = path.split("/")
    const kind = GENERATED_KINDS.find(
      (k) => KIND_REGISTRY[k].dir === segments[0]
    )
    if (
      kind === undefined ||
      segments.length !== 3 ||
      segments[2] !== `${segments[1]}.meta.json`
    )
      continue
    const raw = parseJson(files.get(path))
    if (raw?.kind !== kind) continue
    const physical = physicalOf(raw)
    // Без фізичного імені ключа немає: новий опис мовчки замінив би id
    // наявного, тож спершу ім'я має дати автор чи `simetra fix`.
    if (physical === undefined) {
      diagnostics.push(diagnostic("identity.physical-name-missing", path, ""))
      continue
    }
    const schema = typeof raw.schema === "string" ? raw.schema : defaultSchema
    const key = objectKey(kind, schema, physical)
    const earlier = objects.get(key)
    if (earlier !== undefined) {
      diagnostics.push(
        diagnostic("introspect.identity-conflict", path, "/physicalName", {
          key: `${kind} ${schema}.${physical}`,
          other: earlier.file,
        })
      )
      continue
    }
    const columns = new Map<string, Json>()
    const list = Array.isArray(raw.columns) ? (raw.columns as unknown[]) : []
    list.forEach((column, index) => {
      if (!isRecord(column)) return
      const name = physicalOf(column)
      if (name === undefined) {
        diagnostics.push(
          diagnostic(
            "identity.physical-name-missing",
            path,
            `/columns/${index}`
          )
        )
        return
      }
      if (columns.has(name))
        diagnostics.push(
          diagnostic(
            "introspect.identity-conflict",
            path,
            `/columns/${index}/physicalName`,
            { key: `column ${schema}.${physical}.${name}`, other: path }
          )
        )
      else columns.set(name, column as Json)
    })
    objects.set(key, { file: path, raw, columns })
  }
  return { ...(project === undefined ? {} : { project }), objects, diagnostics }
}
