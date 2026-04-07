/**
 * Shared Metadata IO layer — чисті TS-функції для parsing/serialization
 * файлової структури метаданих. Без залежностей від Node.js API або browser API.
 *
 * Використовується в: apps/web (WebStorage), packages/cli, apps/runtime (Phase 3).
 */

import type { MetadataKind, MetadataObject, ProjectModel, Project } from './schemas'
import {
  projectSchema,
  projectModelSchema,
  metadataObjectSchema,
  constantSchema,
  constantsFileSchema,
  catalogSchema,
  documentSchema,
  enumerationSchema,
  informationRegisterSchema,
  accumulationRegisterSchema,
  customTableSchema,
  formSchema,
} from './schemas'
import type { FormSchema } from './schemas'
import { KIND_TO_KEY } from './find-references'
import {
  serializeMetadataObject,
  serializeProject,
  enrichSchemaUrl,
  enrichProjectSchemaUrl,
  buildConstantsSchemaUrl,
  serializeForm,
  buildFormSchemaUrl,
} from './serialization'

// --- Типи ---

/** Попередження при парсингу/валідації файлу */
export interface FileWarning {
  filePath: string
  errors: string[]
}

/** Файловий entry для серіалізації */
export interface FileEntry {
  path: string
  content: string
}

/** Проміжний результат парсингу файлів */
export interface ParsedFiles {
  project?: unknown
  objects: ParsedObject[]
  forms: ParsedForm[]
}

/** Розпізнаний об'єкт метаданих */
export interface ParsedObject {
  kind: MetadataKind
  data: unknown
  filePath: string
}

/** Розпізнана форма (Phase 3) */
export interface ParsedForm {
  /** Slug (kebab-case) каталогу об'єкта-власника */
  objectSlug: string
  /** Kind об'єкта-власника */
  objectKind: MetadataKind
  /** Ім'я файлу форми (наприклад, "item.form.json") */
  formFileName: string
  /** Parsed JSON data */
  data: unknown
  /** Відносний шлях до файлу */
  filePath: string
}

/** Результат побудови ProjectModel */
export interface BuildModelResult {
  model: ProjectModel
  forms: Map<string, unknown>
  warnings: FileWarning[]
}

// --- Маппінг MetadataKind ↔ назва каталогу (BRD §7.2) ---

export const KIND_TO_DIR: Record<MetadataKind, string> = {
  Catalog: 'catalogs',
  Document: 'documents',
  Enumeration: 'enumerations',
  InformationRegister: 'information-registers',
  AccumulationRegister: 'accumulation-registers',
  Constant: 'constants',
  CustomTable: 'custom-tables',
}

export const DIR_TO_KIND: Record<string, MetadataKind> = Object.fromEntries(
  Object.entries(KIND_TO_DIR).map(([k, v]) => [v, k as MetadataKind]),
) as Record<string, MetadataKind>

// Маппінг директорій → Zod-схема (для strict-валідації за kind)
const DIR_TO_SCHEMA: Record<string, import('zod').ZodTypeAny> = {
  catalogs: catalogSchema,
  documents: documentSchema,
  enumerations: enumerationSchema,
  'information-registers': informationRegisterSchema,
  'accumulation-registers': accumulationRegisterSchema,
  'custom-tables': customTableSchema,
}

// Ключі ProjectModel → MetadataKind
const MODEL_KEY_TO_KIND: Record<string, MetadataKind> = {
  catalogs: 'Catalog',
  documents: 'Document',
  enumerations: 'Enumeration',
  informationRegisters: 'InformationRegister',
  accumulationRegisters: 'AccumulationRegister',
  constants: 'Constant',
  customTables: 'CustomTable',
}

// --- PascalCase → kebab-case ---

/** PascalCase → kebab-case: SalesOrder → sales-order */
export function toKebabCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

// --- Парсинг файлової структури ---

/**
 * Парсить Map файлів у проміжну структуру ParsedFiles.
 * Pure function — без залежностей від I/O.
 *
 * @param files Map<відносний_шлях, текстовий_вміст>
 * @returns Parsed результат з warnings
 */
export function parseMetadataFiles(files: Map<string, string>): {
  parsed: ParsedFiles
  warnings: FileWarning[]
} {
  const warnings: FileWarning[] = []
  const parsed: ParsedFiles = { objects: [], forms: [] }

  for (const [path, content] of files) {
    // project.meta.json
    if (path === 'project.meta.json') {
      try {
        parsed.project = JSON.parse(content)
      } catch (e) {
        warnings.push({
          filePath: path,
          errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`],
        })
      }
      continue
    }

    // Визначити тип за назвою каталогу
    const parts = path.split('/')
    if (parts.length < 2) continue

    const dirName = parts[0]
    const kind = DIR_TO_KIND[dirName]
    if (!kind) {
      warnings.push({
        filePath: path,
        errors: [`Unknown metadata directory: ${dirName}`],
      })
      continue
    }

    // forms/*.form.json — Phase 3: форми об'єктів
    // Формат: {kind-dir}/{object-kebab}/forms/{form-name}.form.json
    if (parts.length >= 4 && parts[parts.length - 2] === 'forms') {
      const fileName = parts[parts.length - 1]
      if (!fileName.endsWith('.form.json')) continue

      try {
        const data = JSON.parse(content)
        parsed.forms.push({
          objectSlug: parts[1],
          objectKind: kind,
          formFileName: fileName,
          data,
          filePath: path,
        })
      } catch (e) {
        warnings.push({
          filePath: path,
          errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`],
        })
      }
      continue
    }

    // Файл має закінчуватись на .meta.json
    const fileName = parts[parts.length - 1]
    if (!fileName.endsWith('.meta.json')) continue

    try {
      const data = JSON.parse(content)

      if (kind === 'Constant') {
        // constants.meta.json — object wrapper або legacy array (backward compat)
        let items: unknown[] | null = null
        if (Array.isArray(data)) {
          items = data
        } else {
          const wrapperResult = constantsFileSchema.safeParse(data)
          if (wrapperResult.success) {
            // Happy path — wrapper валідує всі constants одразу
            items = wrapperResult.data.constants
          } else if (
            data !== null &&
            typeof data === 'object' &&
            'constants' in data &&
            Array.isArray((data as Record<string, unknown>).constants)
          ) {
            // Wrapper schema failed — graceful degradation: парсимо кожен constant окремо
            const rawConstants = (data as Record<string, unknown>).constants as unknown[]
            items = []
            for (let i = 0; i < rawConstants.length; i++) {
              const itemResult = constantSchema.safeParse(rawConstants[i])
              if (itemResult.success) {
                items.push(itemResult.data)
              } else {
                warnings.push({
                  filePath: path,
                  errors: itemResult.error.issues.map(
                    (issue) =>
                      `constants[${i}].${issue.path.join('.')}: ${issue.message}`,
                  ),
                })
              }
            }
          }
        }
        if (items) {
          for (const item of items) {
            parsed.objects.push({ kind, data: item, filePath: path })
          }
        } else {
          // Не wrapper формат — кладемо як є, buildProjectModelFromParsed дасть warning
          parsed.objects.push({ kind, data, filePath: path })
        }
      } else {
        parsed.objects.push({ kind, data, filePath: path })
      }
    } catch (e) {
      warnings.push({
        filePath: path,
        errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`],
      })
    }
  }

  return { parsed, warnings }
}

// --- Побудова ProjectModel ---

export interface BuildModelOptions {
  /**
   * strict=true — помилка валідації кидає Error (CLI-поведінка).
   * strict=false — помилки збираються у warnings (Web-поведінка).
   * За замовчуванням: false
   */
  strict?: boolean
}

/**
 * Будує ProjectModel з проміжних ParsedFiles.
 *
 * @param parsed Проміжний результат parseMetadataFiles
 * @param options Опції побудови (strict mode для CLI)
 * @returns ProjectModel + forms map + warnings
 * @throws Error якщо project.meta.json відсутній або невалідний
 */
export function buildProjectModelFromParsed(
  parsed: ParsedFiles,
  options: BuildModelOptions = {},
): BuildModelResult {
  const { strict = false } = options
  const warnings: FileWarning[] = []

  // Валідація project
  let project: Project | undefined
  if (parsed.project) {
    const result = projectSchema.safeParse(parsed.project)
    if (result.success) {
      project = result.data
    } else {
      const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      warnings.push({ filePath: 'project.meta.json', errors })

      throw new Error(`project.meta.json is invalid: ${errors.join('; ')}`)
    }
  }

  if (!project) {
    throw new Error('project.meta.json is missing or invalid')
  }

  // Валідація об'єктів по типах
  const collections: Record<string, MetadataObject[]> = {
    catalogs: [],
    documents: [],
    enumerations: [],
    informationRegisters: [],
    accumulationRegisters: [],
    constants: [],
    customTables: [],
  }

  for (const { kind, data, filePath } of parsed.objects) {
    if (kind === 'Constant') {
      const result = constantSchema.safeParse(data)
      if (result.success) {
        collections.constants.push(result.data as unknown as MetadataObject)
      } else {
        const errors = result.error.issues.map(
          (i) => `${i.path.join('.')}: ${i.message}`,
        )
        if (strict) {
          throw new Error(`Помилка валідації ${filePath}:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
        }
        warnings.push({ filePath, errors })
      }
    } else {
      // Для strict mode — валідуємо за kind-specific schema
      const schema = strict
        ? DIR_TO_SCHEMA[KIND_TO_DIR[kind]]
        : metadataObjectSchema
      const result = schema
        ? schema.safeParse(data)
        : metadataObjectSchema.safeParse(data)

      if (result.success) {
        const key = KIND_TO_KEY[kind]
        collections[key].push(result.data as MetadataObject)
      } else {
        const errors = result.error.issues.map(
          (i) => `${i.path.join('.')}: ${i.message}`,
        )
        if (strict) {
          throw new Error(`Помилка валідації ${filePath}:\n${errors.map((e) => `  - ${e}`).join('\n')}`)
        }
        warnings.push({ filePath, errors })
      }
    }
  }

  // Валідація forms: slug → objectName resolution + formSchema
  const validatedForms: FormSchema[] = []
  for (const parsedForm of parsed.forms) {
    const { objectSlug, objectKind, formFileName, data, filePath } = parsedForm

    // Визначити kind форми за ім'ям файлу
    let formKind: string | undefined
    if (formFileName === 'item.form.json') formKind = 'ItemForm'
    else if (formFileName === 'list.form.json') formKind = 'ListForm'

    if (!formKind) {
      warnings.push({
        filePath,
        errors: [`Невідомий тип форми: ${formFileName}`],
      })
      continue
    }

    // Резолвінг objectSlug → objectName через пошук в колекціях
    const collKey = KIND_TO_KEY[objectKind]
    const objectsInCollection = collections[collKey] ?? []
    const matchingObj = objectsInCollection.find(
      (obj) => toKebabCase((obj as { name: string }).name) === objectSlug,
    )

    if (!matchingObj) {
      warnings.push({
        filePath,
        errors: [
          `Не знайдено об'єкт "${objectKind}" зі slug "${objectSlug}"`,
        ],
      })
      continue
    }

    const objectName = (matchingObj as { name: string }).name

    // Побудувати FormSchema об'єкт і валідувати
    const formData = {
      ...(typeof data === 'object' && data !== null ? data : {}),
      kind: formKind,
      objectRef: { kind: objectKind, name: objectName },
    }
    const result = formSchema.safeParse(formData)
    if (result.success) {
      validatedForms.push(result.data)
    } else {
      const errors = result.error.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`,
      )
      if (strict) {
        throw new Error(
          `Помилка валідації ${filePath}:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
        )
      }
      warnings.push({ filePath, errors })
    }
  }

  const model = strict
    ? projectModelSchema.parse({
        project,
        ...collections,
        forms: validatedForms,
      })
    : (() => {
        const result = projectModelSchema.safeParse({
          project,
          ...collections,
          forms: validatedForms,
        })
        if (result.success) return result.data
        // Lenient mode: form-related issues → warnings, retry без forms
        const formIssues = result.error.issues.filter(
          (i) => i.path[0] === 'forms',
        )
        const otherIssues = result.error.issues.filter(
          (i) => i.path[0] !== 'forms',
        )
        if (otherIssues.length > 0) {
          throw new Error(
            `ProjectModel validation failed:\n${otherIssues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`,
          )
        }
        // Лише form-related помилки — зберігаємо як warnings, будуємо модель без forms
        if (formIssues.length > 0) {
          warnings.push({
            filePath: 'forms',
            errors: formIssues.map(
              (i) => `${i.path.join('.')}: ${i.message}`,
            ),
          })
        }
        return projectModelSchema.parse({
          project,
          ...collections,
          forms: [],
        })
      })()

  // Forms map: ключ = filePath (backward compat для web-storage/cli)
  const forms = new Map<string, unknown>()
  for (const form of parsed.forms) {
    forms.set(form.filePath, form.data)
  }

  return { model, forms, warnings }
}

// --- Серіалізація ProjectModel → файлова структура ---

/**
 * Серіалізувати ProjectModel у масив файлів (path → content).
 * Pure function — не залежить від I/O.
 */
export function serializeToFiles(model: ProjectModel): FileEntry[] {
  const files: FileEntry[] = []
  const schemaVersion = model.project.schemaVersion

  // project.meta.json — enrich $schema before serialization
  const enrichedProject = enrichProjectSchemaUrl(model.project, schemaVersion)
  files.push({
    path: 'project.meta.json',
    content: serializeProject(enrichedProject),
  })

  // Кожен тип метаданих
  for (const [modelKey, kind] of Object.entries(MODEL_KEY_TO_KIND)) {
    const objects = model[modelKey as keyof ProjectModel] as MetadataObject[]
    if (!objects || objects.length === 0) continue

    const dirName = KIND_TO_DIR[kind]

    if (kind === 'Constant') {
      // Усі константи — в одному файлі, object wrapper (BRD §7.2 + §7.6)
      const enrichedConstants = objects.map((obj) => enrichSchemaUrl(obj, schemaVersion))
      const serializedItems = enrichedConstants.map((obj) =>
        serializeMetadataObject(obj).trimEnd(),
      )
      const indentedItems = serializedItems.map((item) =>
        item
          .split('\n')
          .map((line) => '    ' + line)
          .join('\n'),
      )
      const constantsJson =
        '{\n' +
        `  "$schema": "${buildConstantsSchemaUrl(schemaVersion)}",\n` +
        '  "constants": [\n' +
        indentedItems.join(',\n') +
        '\n  ]\n}\n'
      files.push({
        path: `${dirName}/constants.meta.json`,
        content: constantsJson,
      })
    } else {
      // Один файл на об'єкт — enrich $schema
      for (const obj of objects) {
        const enriched = enrichSchemaUrl(obj, schemaVersion)
        const kebabName = toKebabCase(obj.name)
        files.push({
          path: `${dirName}/${kebabName}/${kebabName}.meta.json`,
          content: serializeMetadataObject(enriched),
        })
      }
    }
  }

  // Forms → окремі файли (Phase 3)
  if (model.forms && model.forms.length > 0) {
    for (const form of model.forms) {
      const dirName = KIND_TO_DIR[form.objectRef.kind as MetadataKind]
      if (!dirName) continue
      const kebabName = toKebabCase(form.objectRef.name)
      const formKindKebab = form.kind === 'ItemForm' ? 'item' : 'list'
      const enrichedForm = { ...form, $schema: buildFormSchemaUrl(schemaVersion) }
      files.push({
        path: `${dirName}/${kebabName}/forms/${formKindKebab}.form.json`,
        content: serializeForm(enrichedForm),
      })
    }
  }

  return files
}
