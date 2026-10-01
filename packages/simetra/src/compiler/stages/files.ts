import { z, type ZodType } from "zod"
import {
  SCHEMA_RULES,
  kindByDir,
  projectSchema,
  type KindDefinition,
  type MetadataKind,
  type Project,
  type SchemaRule,
  postsMovements,
} from "simetra/model"
import {
  compareStrings,
  diagnostic,
  toPointer,
  type Diagnostic,
} from "../diagnostics"
import { hasLoneSurrogate } from "../canonical"
import { extractMovementBlocks, indentedMarkerLines } from "../movement-blocks"

export const PROJECT_FILE = "project.meta.json"

const META_SUFFIX = ".meta.json"
const MODULE_SUFFIX = ".module.ts"
const SQL_SUFFIX = ".sql"

/** Блок запиту рухів з `.sql` документа; `file` — сам `.sql`. */
export interface ParsedMovementBlock {
  file: string
  register: string
  sql: string
  line: number
}

/** Об'єкт, чий файл пройшов схему виду; id може бути відсутнім до стадії 2. */
export interface ParsedObject {
  kind: MetadataKind
  name: string
  file: string
  id?: string
  /** Вихід Zod-схеми виду — з уже застосованими значеннями за замовчуванням. */
  data: unknown
  /** Блоки запиту рухів з `<Name>.sql` документа, у порядку файлу. */
  movementBlocks?: ParsedMovementBlock[]
}

export interface FilesStageResult {
  project?: Project
  /** Відсортовано за шляхом файлу. */
  objects: ParsedObject[]
  /**
   * Імена об'єктів, чиї файли зламані. Посилання на них не резолвляться, але
   * й не є помилкою посилання: причину вже названо в самому файлі.
   */
  brokenNames: Set<string>
  /**
   * `.sql` об'єкта несе шлях свого `.meta.json`; спільний — PG-схему. Текст
   * їде разом зі шляхом: наступні стадії працюють над результатом стадії 1, а
   * не над мапою файлів.
   */
  sqlFiles: {
    file: string
    text: string
    ownerFile?: string
    schema?: string
  }[]
  moduleFiles: { file: string; ownerFile: string }[]
  diagnostics: Diagnostic[]
}

export function objectKey(kind: string, name: string): string {
  return `${kind}/${name}`
}

type Sidecar = { file: string; ownerFile: string; type: "module" | "sql" }

/**
 * Стадія 1 (спека П2 §8.2): розкладка файлів, JSON і схема виду. Кожен файл
 * перевіряється незалежно, тож прогін повертає всі проблеми, а не першу.
 */
export function readFiles(
  files: ReadonlyMap<string, string>
): FilesStageResult {
  const result: FilesStageResult = {
    objects: [],
    brokenNames: new Set(),
    sqlFiles: [],
    moduleFiles: [],
    diagnostics: [],
  }
  const sidecars: Sidecar[] = []
  // Порядок мапи — випадковість того, хто її зібрав; шлях — ні.
  const paths = [...files.keys()].sort(compareStrings)

  for (const file of paths) {
    const text = files.get(file) ?? ""
    const segments = file.split("/")

    if (file === PROJECT_FILE) {
      result.project = readProject(text, result.diagnostics)
      continue
    }
    if (
      segments.length === 3 &&
      segments[0] === "sql" &&
      hasBase(segments[2]!, SQL_SUFFIX)
    ) {
      result.sqlFiles.push({ file, text, schema: segments[1]! })
      readMovementBlocks(file, text, undefined, result.diagnostics)
      continue
    }

    const def = segments.length === 3 ? kindByDir(segments[0]!) : undefined
    const fileName = segments[2] ?? ""
    const folder = `${segments[0]}/${segments[1]}/`
    if (def !== undefined && hasBase(fileName, META_SUFFIX)) {
      readObject(
        file,
        text,
        def,
        segments[1]!,
        baseOf(fileName, META_SUFFIX),
        result
      )
    } else if (def !== undefined && hasBase(fileName, MODULE_SUFFIX)) {
      const base = baseOf(fileName, MODULE_SUFFIX)
      sidecars.push({
        file,
        ownerFile: `${folder}${base}${META_SUFFIX}`,
        type: "module",
      })
    } else if (def !== undefined && hasBase(fileName, SQL_SUFFIX)) {
      const base = baseOf(fileName, SQL_SUFFIX)
      sidecars.push({
        file,
        ownerFile: `${folder}${base}${META_SUFFIX}`,
        type: "sql",
      })
    } else {
      result.diagnostics.push(diagnostic("file.unknown-path", file, ""))
    }
  }

  if (result.project === undefined && !files.has(PROJECT_FILE)) {
    result.diagnostics.push(diagnostic("project.missing", PROJECT_FILE, ""))
  }

  // Супутній файл належить об'єкту, чий `.meta.json` лежить поруч з тим самим
  // іменем; чи цей файл валідний — окреме питання, про яке звітує він сам.
  const objectsByFile = new Map(result.objects.map((o) => [o.file, o]))
  for (const sidecar of sidecars) {
    if (!files.has(sidecar.ownerFile)) {
      result.diagnostics.push(
        diagnostic("file.orphan", sidecar.file, "", {
          expected: sidecar.ownerFile,
        })
      )
    } else if (sidecar.type === "module") {
      result.moduleFiles.push({
        file: sidecar.file,
        ownerFile: sidecar.ownerFile,
      })
    } else {
      const text = files.get(sidecar.file) ?? ""
      result.sqlFiles.push({
        file: sidecar.file,
        text,
        ownerFile: sidecar.ownerFile,
      })
      // Зламаний власник (його немає серед objects) причину вже назвав сам.
      const owner = objectsByFile.get(sidecar.ownerFile)
      if (owner !== undefined) {
        readMovementBlocks(sidecar.file, text, owner, result.diagnostics)
      }
    }
  }
  return result
}

/**
 * Блоки запиту рухів у `.sql`: лише документ (вид із дією проведення) може їх
 * мати. `owner` відсутній — файл спільний (`sql/<схема>/`).
 */
function readMovementBlocks(
  file: string,
  text: string,
  owner: ParsedObject | undefined,
  diagnostics: Diagnostic[]
): void {
  const { blocks, errors } = extractMovementBlocks(text)
  const report = (detail: string, line: number) =>
    diagnostics.push(
      diagnostic("file.movements-block", file, "", { detail, line })
    )
  for (const error of errors) report(error.message, error.line)
  const postable = owner !== undefined && postsMovements(owner.kind)
  // Попередження лише для документа: в інших файлах маркерів не чекають, і
  // відступ там — звичайний коментар.
  if (postable) {
    for (const line of indentedMarkerLines(text)) {
      diagnostics.push(
        diagnostic("file.movements-marker-indented", file, "", { line })
      )
    }
  }
  if (!postable) {
    for (const block of blocks) {
      report(
        "movement query blocks are allowed only in the .sql file of a document",
        block.line
      )
    }
    return
  }
  const kept: ParsedMovementBlock[] = []
  for (const block of blocks) {
    if (block.sql.trim() === "") {
      // Порожній блок дав би обгортку без запиту, що мовчки не пише рухів.
      report("the block has no query", block.line)
    } else {
      kept.push({ file, ...block })
    }
  }
  if (kept.length > 0) owner.movementBlocks = kept
}

function hasBase(fileName: string, suffix: string): boolean {
  return fileName.length > suffix.length && fileName.endsWith(suffix)
}

function baseOf(fileName: string, suffix: string): string {
  return fileName.slice(0, -suffix.length)
}

function readProject(
  text: string,
  diagnostics: Diagnostic[]
): Project | undefined {
  const json = parseJson(PROJECT_FILE, text, diagnostics)
  if (json === undefined) return undefined
  const parsed = projectSchema.safeParse(json.value)
  if (!parsed.success) {
    diagnostics.push(...zodDiagnostics(PROJECT_FILE, projectSchema, json.value))
    return undefined
  }
  return parsed.data
}

function readObject(
  file: string,
  text: string,
  def: KindDefinition,
  folderName: string,
  fileBase: string,
  result: FilesStageResult
): void {
  const broken = (rawName: unknown) => {
    result.brokenNames.add(objectKey(def.kind, folderName))
    if (typeof rawName === "string") {
      result.brokenNames.add(objectKey(def.kind, rawName))
    }
  }

  const json = parseJson(file, text, result.diagnostics)
  if (json === undefined) {
    broken(undefined)
    return
  }
  const raw = isRecord(json.value) ? json.value : undefined

  // Тека задає вид: файл чужого виду не проганяємо схемою теки, інакше
  // справжня причина потонула б у помилках невідповідних полів.
  if (raw !== undefined && raw.kind !== def.kind) {
    result.diagnostics.push(
      diagnostic("file.kind-mismatch", file, "/kind", {
        dir: def.dir,
        expected: def.kind,
        actual: typeof raw.kind === "string" ? raw.kind : "missing",
      })
    )
    broken(raw.name)
    return
  }

  const parsed = def.schema.safeParse(json.value)
  if (!parsed.success) {
    result.diagnostics.push(...zodDiagnostics(file, def.schema, json.value))
    broken(raw?.name)
    return
  }

  const data = parsed.data as { name: string; id?: string }
  if (folderName !== data.name || fileBase !== data.name) {
    result.diagnostics.push(
      diagnostic("file.name-mismatch", file, "/name", { name: data.name })
    )
  }
  result.objects.push({
    kind: def.kind,
    name: data.name,
    file,
    ...(data.id !== undefined ? { id: data.id } : {}),
    data,
  })
}

function parseJson(
  file: string,
  text: string,
  diagnostics: Diagnostic[]
): { value: unknown } | undefined {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    diagnostics.push(
      diagnostic("file.invalid-json", file, "", {
        detail: error instanceof Error ? error.message : String(error),
      })
    )
    return undefined
  }
  // Екранований самотній сурогат (`"\ud800"`) — синтаксично коректний JSON,
  // і Zod його пропускає, але це не I-JSON: канонізація хешу на ньому впала б
  // винятком. Компілятор на вводі автора не кидає, тож це помилка файлу тут.
  const path = loneSurrogatePath(value, [])
  if (path !== undefined) {
    diagnostics.push(
      diagnostic("file.invalid-json", file, toPointer(path), {
        detail: "lone surrogate (RFC 7493 I-JSON)",
      })
    )
    return undefined
  }
  return { value }
}

/** Шлях до першого рядка чи ключа з самотнім сурогатом у порядку обходу. */
function loneSurrogatePath(
  value: unknown,
  path: readonly PropertyKey[]
): PropertyKey[] | undefined {
  if (typeof value === "string") {
    return hasLoneSurrogate(value) ? [...path] : undefined
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const found = loneSurrogatePath(value[i], [...path, i])
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!isRecord(value)) return undefined
  for (const [key, child] of Object.entries(value)) {
    // Pointer на сам ключ: значення під ним може бути й коректним.
    if (hasLoneSurrogate(key)) return [...path, key]
    const found = loneSurrogatePath(child, [...path, key])
    if (found !== undefined) return found
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSchemaRule(value: unknown): value is SchemaRule {
  return (SCHEMA_RULES as readonly unknown[]).includes(value)
}

const UK_LOCALE = z.locales.uk()

/**
 * Власні перевірки T0 несуть код у `params.rule` — він і стає кодом
 * діагностики; решта проблем Zod іде під `file.schema` зі своїм текстом.
 */
function zodDiagnostics(
  file: string,
  schema: ZodType,
  value: unknown
): Diagnostic[] {
  // Другий розбір з українською локаллю лише для тексту: завершені issue вже
  // без `input`, тож локаль не може відтворити «отримано …» з них. Локаль
  // передано в розбір, а не в `z.config`: глобальна конфігурація зачепила б
  // усіх споживачів бібліотеки. Порядок issue однаковий, бо схема та сама.
  const issues = schema.safeParse(value).error?.issues ?? []
  const ukIssues =
    schema.safeParse(value, { error: UK_LOCALE.localeError }).error?.issues ??
    []
  return issues.flatMap((issue, index): Diagnostic[] => {
    // Строгі схеми: кожен невідомий ключ — окрема діагностика з pointer на
    // сам ключ, щоб редактор підсвітив одруківку, а не весь об'єкт.
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) =>
        diagnostic("file.unknown-key", file, toPointer([...issue.path, key]), {
          key,
        })
      )
    }
    const pointer = toPointer(issue.path)
    const rule: unknown =
      issue.code === "custom" ? issue.params?.rule : undefined
    if (isSchemaRule(rule)) {
      const field = issue.path.at(-1)
      const offset = issue.code === "custom" ? issue.params?.offset : undefined
      return [
        diagnostic(rule, file, pointer, {
          ...(field === undefined ? {} : { field: String(field) }),
          // Помилка розбору виразу: текст парсера й зміщення в рядку виразу.
          ...(typeof offset === "number"
            ? { offset, detail: issue.message }
            : {}),
        }),
      ]
    }
    // Індекс — вихідний індекс issue, а не діагностики: ключі вище
    // розгортаються в кілька діагностик, а списки issue обох розборів рівні.
    const detailUk = ukIssues[index]?.message
    return [
      diagnostic("file.schema", file, pointer, {
        detail: issue.message,
        ...(detailUk === undefined ? {} : { detailUk }),
      }),
    ]
  })
}
