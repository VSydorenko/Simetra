import {
  KIND_REGISTRY,
  MAX_PHYSICAL_NAME_BYTES,
  assignPhysicalName,
  expectsKindLabel,
  formatMetaFile,
  formatProjectFile,
  kindByDir,
  makeObjectName,
  projectSchema,
  type KindDefinition,
  type PhysicalNameRole,
  type StandardColumnDef,
} from "simetra/model"
import { compile } from "../compile"
import { derivedFunctionLabels } from "../contracts"
import {
  compareStrings,
  diagnostic,
  sortDiagnostics,
  type Diagnostic,
} from "../diagnostics"
import { withRanges } from "../locate"
import { PROJECT_FILE } from "../stages/files"
import { DERIVED_TABLE_LABELS } from "../stages/model"
import { changesBetween } from "./changes"
import type { OperationResult } from "./types"

/**
 * Відносний шлях від файлу метаданих до файлу JSON Schema встановленого
 * пакета (`schemaFile` — `<тека виду>.schema.json` чи `project.schema.json`).
 * Розташування пакета на диску знає лише обгортка (CLI, MCP), тож T1 отримує
 * його функцією (рішення плану 5).
 */
export type SchemaPathResolver = (file: string, schemaFile: string) => string

/**
 * Джерело нових id. Операції без I/O, але випадковість потрібна: обгортки
 * передають `crypto.randomUUID`, тести — детермінований лічильник.
 */
export type IdSource = () => string

export interface CompletionOptions {
  schemaPath: SchemaPathResolver
  newId: IdSource
}

export interface CompletionResult {
  /** Повна мапа файлів після доповнення. */
  files: Map<string, string>
  /** Пояснення того, чого доповнення свідомо не зробило. */
  diagnostics: Diagnostic[]
}

const PROJECT_SCHEMA_FILE = "project.schema.json"
const META_SUFFIX = ".meta.json"
const NO_SCOPE = "none"

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const encoder = new TextEncoder()
const byteLength = (name: string) => encoder.encode(name).length

interface Located {
  pointer: string
  element: Json
}

interface ObjectFile {
  path: string
  raw: Json
  def: KindDefinition
  /**
   * Вихід схеми виду, коли файл її проходить: стандартні колонки, ключі
   * регістра й похідні функції реєстр рахує з розібраних даних. Немає —
   * файл зламаний, і доповнення працює без цих знань (запису все одно не
   * буде: компіляція результату дасть помилку).
   */
  data?: unknown
}

/** Елементи масиву-поля, що є об'єктами, з їхніми pointer. */
function elementsAt(owner: Json, field: string, base = ""): Located[] {
  const value = owner[field]
  if (!Array.isArray(value)) return []
  return value.flatMap((element: unknown, index) =>
    isRecord(element) ? [{ pointer: `${base}/${field}/${index}`, element }] : []
  )
}

/** Табличні частини — лише у виду, якому реєстр їх дозволяє. */
function sectionsOf(file: ObjectFile): Located[] {
  return file.def.tabularSectionColumns === undefined
    ? []
    : elementsAt(file.raw, "tabularSections")
}

/** Елементи з мітками замість колонок: значення й предвизначені елементи. */
function labelGroupsOf(file: ObjectFile): Located[][] {
  const fields = [
    ...(file.def.valueElements ? ["values"] : []),
    ...(file.def.namedElementFields ?? []),
  ]
  return fields.map((field) => elementsAt(file.raw, field))
}

/**
 * Кожен іменований елемент файлу (спека П2 §3) — за полями реєстру видів, а
 * не за переліком видів: новий вид приходить зі своїм записом.
 */
function namedElementsOf(file: ObjectFile): Located[] {
  return [
    { pointer: "", element: file.raw },
    ...file.def.columnFields.flatMap((field) => elementsAt(file.raw, field)),
    ...sectionsOf(file).flatMap((section) => [
      section,
      ...elementsAt(section.element, "attributes", section.pointer),
    ]),
    ...labelGroupsOf(file).flat(),
  ]
}

function parseJson(text: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Файли об'єктів, які доповнення розуміє: шлях `<тека виду>/<Ім'я>/<Ім'я>.meta.json`,
 * JSON-об'єкт і `kind` виду теки. Решту (зламаний JSON, чужий вид) лишаємо
 * як є — причину назве компіляція результату.
 */
function readObjectFiles(files: ReadonlyMap<string, string>): ObjectFile[] {
  const result: ObjectFile[] = []
  for (const path of [...files.keys()].sort(compareStrings)) {
    const segments = path.split("/")
    if (segments.length !== 3 || !segments[2]!.endsWith(META_SUFFIX)) continue
    const def = kindByDir(segments[0]!)
    const raw = parseJson(files.get(path)!)
    if (def === undefined || raw === undefined || raw.kind !== def.kind) {
      continue
    }
    const parsed = def.schema.safeParse(raw)
    result.push({
      path,
      raw,
      def,
      ...(parsed.success ? { data: parsed.data } : {}),
    })
  }
  return result
}

/** Поля, які доповнювач призначає раз: фізичне ім'я елемента й мітка виду. */
type AssignedField = "physicalName" | "kindLabel"

const assignedOf = (element: Json, field: AssignedField): string | undefined =>
  typeof element[field] === "string" ? element[field] : undefined

const physicalNameOf = (element: Json): string | undefined =>
  assignedOf(element, "physicalName")

/** Вид цілі `Ref` береться з сирого JSON: компіляція для цього не потрібна. */
function fieldRole(element: Json): PhysicalNameRole {
  if (element.type !== "Ref") return { role: "field" }
  if (Array.isArray(element.allowedTypes) && element.allowedTypes.length > 0) {
    return { role: "field", reference: "polymorphic" }
  }
  const ref = element.ref
  if (!isRecord(ref)) return { role: "field" }
  const kind = ref.kind
  // Значення виду — мітки (реєстр: `valueElements`), тож колонка зберігає
  // мітку, а не ключ, і суфікса `_id` не має.
  const enumeration =
    typeof kind === "string" &&
    Object.hasOwn(KIND_REGISTRY, kind) &&
    KIND_REGISTRY[kind as keyof typeof KIND_REGISTRY].valueElements
  return { role: "field", reference: enumeration ? "enumeration" : "single" }
}

/** Колонки, які займає поле: поліморфне — пару `_type`/`_id` (спека §5). */
function columnsOfField(name: string, role: PhysicalNameRole): string[] {
  return role.role === "field" && role.reference === "polymorphic"
    ? [`${name}_type`, `${name}_id`]
    : [name]
}

/** Фізичні імена стандартних колонок, разом із можливою поліморфною парою. */
function standardNames(columns: readonly StandardColumnDef[]): string[] {
  return columns.flatMap((column) =>
    column.polymorphic === undefined
      ? [column.physicalName]
      : [
          column.physicalName,
          `${column.physicalName}_type`,
          `${column.physicalName}_id`,
        ]
  )
}

/**
 * Доповнювач фізичних імен: тримає області унікальності (простори відношень
 * PG-схем, колонки таблиць, мітки) і звітує імена, яких свідомо не дав.
 */
class NameAssigner {
  readonly diagnostics: Diagnostic[] = []
  private readonly relations = new Map<string, Set<string>>()

  constructor(
    private readonly objects: readonly ObjectFile[],
    private readonly project: Json | undefined,
    private readonly defaultSchema: string
  ) {}

  run(): void {
    this.assignScopeKinds()
    for (const file of this.objects) this.occupyRelations(file)
    for (const file of this.objects) this.assignObject(file)
    for (const file of this.objects) this.assignSections(file)
    for (const file of this.objects) this.assignColumns(file)
    for (const file of this.objects) this.assignLabels(file)
    this.assignKindLabels()
  }

  /**
   * Призначає ім'я елементу без нього. Ім'я, яке разом із похідними
   * (`suffixes`) перевищило б ліміт Postgres, не призначається: автор задає
   * коротше сам, а `identity.physical-name-missing` лишається в результаті.
   * `field` — куди пишеться призначене: наявне значення не змінюється ніколи.
   */
  private assign(
    file: string,
    at: Located,
    role: PhysicalNameRole,
    taken: ReadonlySet<string>,
    suffixes: readonly string[] = [],
    field: AssignedField = "physicalName"
  ): string | undefined {
    const name = at.element.name
    if (
      assignedOf(at.element, field) !== undefined ||
      typeof name !== "string"
    ) {
      return undefined
    }
    const candidate = assignPhysicalName(name, role, taken)
    const longest = [candidate, ...suffixes.map((s) => `${candidate}${s}`)]
      .sort((a, b) => byteLength(b) - byteLength(a))
      .at(0)!
    if (byteLength(longest) > MAX_PHYSICAL_NAME_BYTES) {
      this.diagnostics.push(
        diagnostic("operation.physical-name-too-long", file, at.pointer, {
          name: candidate,
          longest,
        })
      )
      return undefined
    }
    at.element[field] = candidate
    return candidate
  }

  private assignScopeKinds(): void {
    if (this.project === undefined) return
    const kinds = elementsAt(this.project, "scopeKinds")
    const taken = new Set(kinds.flatMap((k) => physicalNameOf(k.element) ?? []))
    for (const kind of kinds) {
      const name = this.assign(PROJECT_FILE, kind, { role: "scopeKind" }, taken)
      if (name !== undefined) taken.add(name)
    }
  }

  /**
   * Простір відношень: таблиці й енам-типи PG-схеми ділять його з похідними
   * таблицями регістрів і (за брифом плану) з функціями контрактів. Вид без
   * матеріалізації (перерахування) має окремий простір за видом.
   */
  private relationsOf(file: ObjectFile): Set<string> {
    const schema =
      typeof file.raw.schema === "string" ? file.raw.schema : this.defaultSchema
    const key =
      file.def.materializes === "none"
        ? `kind:${file.def.kind}`
        : `schema:${schema}`
    let set = this.relations.get(key)
    if (set === undefined) {
      set = new Set()
      this.relations.set(key, set)
    }
    return set
  }

  /** Похідні від імені таблиці об'єкта: таблиці регістра й функції. */
  private derivedLabels(file: ObjectFile): string[] {
    if (file.data === undefined) return []
    const keys = file.def.registerKeys?.(file.data)
    return [
      ...(keys?.totals === true ? [DERIVED_TABLE_LABELS.totals] : []),
      ...(keys?.turnoversMonth !== undefined
        ? [DERIVED_TABLE_LABELS.turnoversMonth]
        : []),
      ...derivedFunctionLabels({ kind: file.def.kind, data: file.data }).map(
        (l) => l.label
      ),
    ]
  }

  private occupy(file: ObjectFile, name: string): void {
    const set = this.relationsOf(file)
    set.add(name)
    for (const label of this.derivedLabels(file)) {
      set.add(makeObjectName(name, undefined, label))
    }
  }

  private occupyRelations(file: ObjectFile): void {
    const own = physicalNameOf(file.raw)
    if (own !== undefined) this.occupy(file, own)
    for (const section of sectionsOf(file)) {
      const name = physicalNameOf(section.element)
      if (name !== undefined) this.relationsOf(file).add(name)
    }
  }

  private assignObject(file: ObjectFile): void {
    // Ліміт рахується з похідними таблицями: `makeObjectName` їх мовчки
    // обрізав би, і дві таблиці регістра розійшлися б із його ім'ям.
    const keys =
      file.data === undefined ? undefined : file.def.registerKeys?.(file.data)
    const suffixes = [
      ...(keys?.totals === true ? [`_${DERIVED_TABLE_LABELS.totals}`] : []),
      ...(keys?.turnoversMonth !== undefined
        ? [`_${DERIVED_TABLE_LABELS.turnoversMonth}`]
        : []),
    ]
    const name = this.assign(
      file.path,
      { pointer: "", element: file.raw },
      { role: "object" },
      this.relationsOf(file),
      suffixes
    )
    if (name !== undefined) this.occupy(file, name)
  }

  private assignSections(file: ObjectFile): void {
    const owner = physicalNameOf(file.raw)
    // Без імені власника префікса немає; про власника вже звітовано.
    if (owner === undefined) return
    const taken = this.relationsOf(file)
    for (const section of sectionsOf(file)) {
      const name = this.assign(
        file.path,
        section,
        { role: "tabularSection", ownerPhysicalName: owner },
        taken
      )
      if (name !== undefined) taken.add(name)
    }
  }

  /** Фізичне ім'я колонки-носія скоупу об'єкта. */
  private scopeColumnOf(file: ObjectFile): string[] {
    // Прийнята таблиця описує фізику сама: носій — її власна колонка
    // (`scopeColumn`), а не похідна від виду скоупу.
    if (file.def.declared || this.project === undefined) return []
    const scope = file.raw.scope
    if (typeof scope !== "string" || scope === NO_SCOPE) return []
    const kind = elementsAt(this.project, "scopeKinds").find(
      (k) => k.element.name === scope
    )
    const name = kind === undefined ? undefined : physicalNameOf(kind.element)
    return name === undefined ? [] : [name]
  }

  /**
   * Колонки таблиці: зайняті іменами реквізитів тієї ж таблиці, стандартними
   * колонками виду за налаштуваннями й носієм скоупу.
   */
  private assignTable(
    file: ObjectFile,
    elements: readonly Located[],
    standard: readonly StandardColumnDef[]
  ): void {
    const roleOf = (element: Json): PhysicalNameRole =>
      file.def.declared ? { role: "column" } : fieldRole(element)
    const taken = new Set([
      ...standardNames(standard),
      ...this.scopeColumnOf(file),
    ])
    for (const { element } of elements) {
      const name = physicalNameOf(element)
      if (name === undefined) continue
      for (const column of columnsOfField(name, roleOf(element))) {
        taken.add(column)
      }
    }
    for (const at of elements) {
      const role = roleOf(at.element)
      const suffixes =
        role.role === "field" && role.reference === "polymorphic"
          ? ["_type", "_id"]
          : []
      const name = this.assign(file.path, at, role, taken, suffixes)
      if (name === undefined) continue
      for (const column of columnsOfField(name, role)) taken.add(column)
    }
  }

  private assignColumns(file: ObjectFile): void {
    const { def, data, raw } = file
    this.assignTable(
      file,
      def.columnFields.flatMap((field) => elementsAt(raw, field)),
      data === undefined ? [] : def.standardColumns(data)
    )
    const rowColumns =
      data === undefined ? [] : (def.tabularSectionColumns?.(data) ?? [])
    for (const section of sectionsOf(file)) {
      this.assignTable(
        file,
        elementsAt(section.element, "attributes", section.pointer),
        rowColumns
      )
    }
  }

  /**
   * Мітка виду — літерал даних (колонка виду поліморфних пар, контракт прав),
   * а не ідентифікатор, тож унікальна на весь проєкт, а не в PG-схемі, і
   * зарезервоване слово її не зсуває. Наявні мітки займаються першими: нова
   * не забирає чужої, а однойменні об'єкти різних схем отримують мітки за
   * порядком файлів.
   */
  private assignKindLabels(): void {
    const taken = new Set(
      this.objects.flatMap((file) => assignedOf(file.raw, "kindLabel") ?? [])
    )
    for (const file of this.objects) {
      // Без розібраних даних не видно ключа прийнятої таблиці; зламаний
      // файл однаково не скомпілюється.
      if (file.data === undefined) continue
      if (!expectsKindLabel(file.def.kind, file.data)) continue
      const name = this.assign(
        file.path,
        { pointer: "", element: file.raw },
        { role: "label" },
        taken,
        [],
        "kindLabel"
      )
      if (name !== undefined) taken.add(name)
    }
  }

  private assignLabels(file: ObjectFile): void {
    for (const group of labelGroupsOf(file)) {
      const taken = new Set(
        group.flatMap((at) => physicalNameOf(at.element) ?? [])
      )
      for (const at of group) {
        const name = this.assign(file.path, at, { role: "label" }, taken)
        if (name !== undefined) taken.add(name)
      }
    }
  }
}

/**
 * Механічне доповнення файлів (спека П2 §3, §8.5, §8.6): відсутні `id`
 * (UUID v4) і `physicalName` іменованих елементів, `kindLabel` об'єктів,
 * `$schema`, канонічна
 * форма й порядок ключів. Наявні id і фізичні імена не змінюються ніколи.
 * Спільне для `fix` і операцій, що створюють елементи: новий елемент
 * отримує ідентичність тим самим шляхом, що й елемент, доданий руками.
 *
 * `only` — файли, які доповнення має право змінити (операція над однією
 * ціллю не переформатовує сторонніх файлів). Зайняті імена й надалі
 * рахуються над усіма файлами: інакше нове ім'я зіткнулося б зі старим.
 */
export function completeFiles(
  files: ReadonlyMap<string, string>,
  o: CompletionOptions,
  only?: ReadonlySet<string>
): CompletionResult {
  const objects = readObjectFiles(files)
  const project = files.has(PROJECT_FILE)
    ? parseJson(files.get(PROJECT_FILE)!)
    : undefined
  const parsedProject =
    project === undefined ? undefined : projectSchema.safeParse(project)
  const defaultSchema = parsedProject?.success
    ? parsedProject.data.defaultSchema
    : typeof project?.defaultSchema === "string"
      ? project.defaultSchema
      : "public"

  // Id першими: вони не залежать ні від чого, а порядок обходу (шлях файлу,
  // порядок елементів) робить лічильник тестів відтворюваним.
  const identified = [
    ...(project === undefined ? [] : elementsAt(project, "scopeKinds")),
    ...objects.flatMap(namedElementsOf),
  ]
  for (const { element } of identified) {
    if (element.id === undefined) element.id = o.newId()
  }

  const names = new NameAssigner(objects, project, defaultSchema)
  names.run()

  // Доповнення поза `only` відкидається на записі: на чистому вході там і
  // так нічого доповнювати, а звіт про них не стосується операції.
  const writable = (path: string) => only === undefined || only.has(path)
  const result = new Map(files)
  if (project !== undefined && writable(PROJECT_FILE)) {
    project.$schema = o.schemaPath(PROJECT_FILE, PROJECT_SCHEMA_FILE)
    result.set(PROJECT_FILE, formatProjectFile(project))
  }
  for (const file of objects.filter((f) => writable(f.path))) {
    file.raw.$schema = o.schemaPath(file.path, `${file.def.dir}.schema.json`)
    result.set(file.path, formatMetaFile(file.raw))
  }
  return {
    files: result,
    diagnostics: names.diagnostics.filter((d) => writable(d.file)),
  }
}

/**
 * Хвіст кожної операції, що пише файли: доповнення, компіляція результату й
 * перелік змін відносно входу. `ok` — результат без помилок; лише тоді
 * обгортка пише `changes`.
 */
export async function completeAndCompile(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  o: CompletionOptions,
  only?: ReadonlySet<string>
): Promise<OperationResult> {
  const completed = completeFiles(after, o, only)
  const compiled = await compile(completed.files)
  return {
    ok: compiled.ok,
    changes: changesBetween(before, completed.files),
    diagnostics: sortDiagnostics([
      ...compiled.diagnostics,
      ...withRanges(completed.diagnostics, completed.files),
    ]),
  }
}

/**
 * `simetra fix` як чиста функція: доповнення плюс компіляція результату.
 * `fix` працює й над входом, що не компілюється (рішення плану 2): його
 * справа — лагодити саме вхід. `changes` — лише файли зі зміненим текстом.
 */
export async function fixFiles(
  files: ReadonlyMap<string, string>,
  o: CompletionOptions
): Promise<OperationResult> {
  return completeAndCompile(files, files, o)
}
