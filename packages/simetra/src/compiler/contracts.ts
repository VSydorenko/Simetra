import {
  KIND_REGISTRY,
  makeObjectName,
  postsMovements,
  truncatedPeriodExpression,
  standardLogicalName,
  type Attribute,
  type NumberingSpec,
  type AttributeCase,
  type PhysicalColumn,
  type PhysicalSnapshot,
  type PhysicalTable,
  type RegisterKeySpec,
  type VirtualTableKind,
} from "simetra/model"
import { compareStrings } from "./diagnostics"
import { kindLabelOf, type ModelStageResult } from "./stages/model"
import { isMovementQuery, type SqlUnit } from "./sql/units"
import type { ParsedObject } from "./stages/files"
import type { ResolvedReference } from "./stages/identity"

export interface QualifiedName {
  schema: string
  name: string
}

export interface PostingContract {
  documentId: string
  /** Мітка виду документа — значення, яке оболонка пише в `recorder_type`. */
  kindLabel: string
  /** `<doc>_save(p_document jsonb, p_expected_version bigint)`. */
  save: QualifiedName
  /** `<doc>_post(p_id uuid)`. */
  post: QualifiedName
  /** `<doc>_unpost(p_id uuid)`. */
  unpost: QualifiedName
  /**
   * Обов'язкові при проведенні реквізити: шапку стереже CHECK таблиці, рядки
   * ТЧ — лише оболонка (CHECK рядка не знає, чи проведена шапка). Порядок —
   * як реквізити у файлі; ТЧ без обов'язкових реквізитів тут немає.
   */
  requiredOnPost: {
    /** `check` — ім'я CHECK із `PhysicalTable.checks` шапки. */
    header: { attributeId: string; columns: string[]; check: string }[]
    sections: {
      sectionId: string
      table: QualifiedName
      columns: { attributeId: string; columns: string[] }[]
    }[]
  }
  /** Тригер незмінності проведеного: одне ім'я на шапку й кожну ТЧ. */
  immutability: { trigger: string; tables: QualifiedName[] }
  /** За `registerId`. */
  movements: {
    registerId: string
    source: "query" | "constructor"
    function: QualifiedName
  }[]
  /** Фізичні імена ресурсів; за `registerId`. */
  balanceControl: { registerId: string; resources: string[] }[]
}

export interface VirtualTableContract {
  kind: VirtualTableKind
  function: QualifiedName
  /**
   * `balance`: без реєстратора — рухи з `period <= p_at` включно; з
   * реєстратором — `(period, recorder_type, recorder_id) <
   * (p_at, p_recorder_type, p_recorder_id)`, строго до документа. `p_at` NULL —
   * поточні `totals`. SQL — П3.
   *
   * Параметр `p_recorder_type` лишається `text`: Postgres не приймає COLLATE
   * в оголошенні аргумента функції. Колонка `recorder_type` має колляцію "C",
   * тож порівняння моменту SQL П3 пише `p_recorder_type COLLATE "C"` явно
   * (`momentCollation`), інакше порядок міток залежав би від колляції бази.
   */
  parameters: {
    name: "p_at" | "p_from" | "p_to" | "p_recorder_type" | "p_recorder_id"
    type: string
  }[]
  /** Є рівно тоді, коли серед параметрів є `p_recorder_type`. */
  momentCollation?: "C"
  columns: VirtualTableColumn[]
}

/** Міра ресурсу в обчислюваній колонці віртуальної таблиці. */
export type ResourceMeasure =
  "opening" | "receipt" | "expense" | "closing" | "net"

export interface VirtualTableColumn {
  name: string
  type: string
  /**
   * Заповнене в обчислюваних колонок ресурсу: `balance` — `closing`,
   * `balanceAndTurnovers` — `opening`/`receipt`/`expense`/`closing`,
   * `turnovers` — `net`. Колонки носія скоупу, вимірів і зрізів
   * `sliceLast`/`sliceFirst` джерела не мають: вони збігаються з власними
   * колонками регістра, а `origin.elementId` відображає їх однозначно. П3
   * читає відповідність звідси, а не за суфіксом імені.
   */
  source?: { resourceId: string; measure: ResourceMeasure }
}

export interface RegisterContract {
  registerId: string
  movements: QualifiedName
  /**
   * Окремої відповідності ресурсів тут немає: на ресурс одна колонка, її
   * `origin.elementId` однозначний, тож П3 не шукає тут `resources`.
   */
  totals?: QualifiedName
  turnoversMonth?: {
    table: QualifiedName
    /** `truncatedPeriodExpression("period", "month", <timezone проєкту>)`. */
    monthExpression: string
    /** Пара `<r>_receipt`/`<r>_expense` на ресурс замість `<r>`. */
    split: boolean
    /**
     * Ресурси в порядку файлу з фізичними колонками таблиці обертів: пара
     * `receipt`/`expense` за `split: true`, одна `column` інакше. Беруться зі
     * знімка за `origin.elementId`, а не добудовуються з імені (спека §8.3).
     */
    resources: (
      | { resourceId: string; receipt: string; expense: string }
      | { resourceId: string; column: string }
    )[]
  }
  virtualTables: VirtualTableContract[]
  /** Перераховує й звіряє обидві похідні таблиці. */
  totalsMaintenance?: { recalculate: QualifiedName; verify: QualifiedName }
  balanceControl?: { resources: string[] }
}

/**
 * Предвизначені елементи довідника (спека П2 §5, М18): рядок має власний `id`
 * у кожній базі й скоупі, тож засів П3 і пошук ідуть за міткою, а не за `id`
 * елемента в метаданих.
 */
export interface PredefinedContract {
  objectId: string
  /** Колонка мітки; разом зі `scopeColumn` — ключ часткового унікального індексу. */
  column: string
  /** Носій скоупу — перша колонка ключа засіву; у глобального довідника немає. */
  scopeColumn?: string
  /** `<catalog>_predefined([p_scope uuid,] p_label text) RETURNS uuid`. */
  lookupFunction: QualifiedName
  /** У порядку файлу; `label` — фізична мітка, значення колонки `column`. */
  items: { id: string; name: string; label: string }[]
}

/**
 * Нумерація першим записом (спека П2, М21): номер призначає оболонка при
 * першому записі; лічильники й генерацію — П3. Префікса поки немає.
 */
export interface NumberingContract {
  objectId: string
  /** Мітка виду об'єкта — ключ лічильника. */
  kindLabel: string
  /** Фізичне ім'я колонки номера чи коду. */
  column: string
  /** Фізичне ім'я генерованої колонки періоду. */
  periodColumn?: string
  type: NumberingSpec["type"]
  length: number
  autonumber: boolean
  periodicity: NumberingSpec["periodicity"]
  /** Таблиця має власну скоуп-колонку. */
  scoped: boolean
  assignedAt: "firstWrite"
}

export interface Contracts {
  /** За `documentId`. */
  posting: PostingContract[]
  /** За `registerId`. */
  registers: RegisterContract[]
  /** За `objectId`. */
  predefined: PredefinedContract[]
  /** За `objectId`. */
  numbering: NumberingContract[]
}

/** Функція контракту, якої ще немає в БД, з місцем у метаданих для діагностики. */
export interface DerivedFunction extends QualifiedName {
  file: string
  pointer: string
  /** Для тексту діагностики: що це за функція. */
  description: string
  /**
   * Обгортка запиту рухів — сама SQL-одиниця з відомою сигнатурою, тож збіг
   * із дослівною одиницею звіряє перевірка просторів імен Postgres
   * (`sql.unit-duplicate`, `sql.namespace-conflict`), а не перевірка імен
   * функцій контрактів.
   */
  movementQuery?: true
}

const TIMESTAMP = "timestamp with time zone"

/** Мітки імен віртуальних таблиць і їхні параметри (спека §7). */
const VIRTUAL_TABLES: Record<
  VirtualTableKind,
  { label: string; parameters: VirtualTableContract["parameters"] }
> = {
  balance: {
    label: "balance",
    // Реєстратор межує вікно «строго до документа»: проведення читає
    // залишок, не бачачи власних рухів.
    parameters: [
      { name: "p_at", type: TIMESTAMP },
      { name: "p_recorder_type", type: "text" },
      { name: "p_recorder_id", type: "uuid" },
    ],
  },
  balanceAndTurnovers: {
    label: "balance_and_turnovers",
    parameters: [
      { name: "p_from", type: TIMESTAMP },
      { name: "p_to", type: TIMESTAMP },
    ],
  },
  turnovers: {
    label: "turnovers",
    parameters: [
      { name: "p_from", type: TIMESTAMP },
      { name: "p_to", type: TIMESTAMP },
    ],
  },
  sliceLast: {
    label: "slice_last",
    parameters: [{ name: "p_at", type: TIMESTAMP }],
  },
  sliceFirst: {
    label: "slice_first",
    parameters: [{ name: "p_at", type: TIMESTAMP }],
  },
}

const MEASURES = ["opening", "receipt", "expense", "closing"] as const

/** Основна таблиця об'єкта (не ТЧ і не підсумки). */
export function mainTableOf(
  physical: PhysicalSnapshot,
  objectId: string
): PhysicalTable | undefined {
  return physical.tables.find(
    (t) =>
      t.origin.objectId === objectId &&
      t.origin.tabularSectionId === undefined &&
      t.origin.part === undefined
  )
}

function derivedTableOf(
  physical: PhysicalSnapshot,
  objectId: string,
  part: "totals" | "turnoversMonth"
): PhysicalTable | undefined {
  return physical.tables.find(
    (t) => t.origin.objectId === objectId && t.origin.part === part
  )
}

/** Регістр веде похідні таблиці — і функції їх перерахунку та звірки. */
function maintainsDerivedTables(keys: RegisterKeySpec): boolean {
  return keys.totals || keys.turnoversMonth !== undefined
}

/** Ім'я похідної функції — алгоритм імен Postgres від таблиці власника. */
function derived(table: PhysicalTable, label: string): QualifiedName {
  return {
    schema: table.schema,
    name: makeObjectName(table.name, undefined, label),
  }
}

const POSTING_LABELS = { save: "save", post: "post", unpost: "unpost" } as const
const TOTALS_LABELS = {
  recalculate: "totals_recalculate",
  verify: "totals_verify",
} as const
const PREDEFINED_LABEL = "predefined"

/**
 * Функції оболонки проведення документа. Одне джерело імен для контракту й
 * перевірки колізій стадії 4: розбіжність пропустила б колізію до `CREATE` П3.
 */
function postingFunctions(table: PhysicalTable): {
  save: QualifiedName
  post: QualifiedName
  unpost: QualifiedName
} {
  return {
    save: derived(table, POSTING_LABELS.save),
    post: derived(table, POSTING_LABELS.post),
    unpost: derived(table, POSTING_LABELS.unpost),
  }
}

/**
 * Функції перерахунку й звірки агрегатів регістра — підсумків (`totals`) і
 * місячних оборотів `turnovers_month`, які ведуться й для регістрів обороту
 * без підсумків; одне джерело, як вище.
 */
function totalsFunctions(table: PhysicalTable): {
  recalculate: QualifiedName
  verify: QualifiedName
} {
  return {
    recalculate: derived(table, TOTALS_LABELS.recalculate),
    verify: derived(table, TOTALS_LABELS.verify),
  }
}

/** Функція пошуку предвизначеного за міткою; одне джерело, як вище. */
function predefinedLookup(table: PhysicalTable): QualifiedName {
  return derived(table, PREDEFINED_LABEL)
}

/**
 * Предвизначені елементи об'єкта за полями реєстру (`namedElementFields`), а
 * не за назвою виду. Приведення безпечне щодо масиву: дані пройшли схему
 * виду, тож поле є (з типовим `[]`). `id` і `physicalName` гарантовані лише
 * після стадії 2 — їх читають контракти; `derivedFunctionLabels`, яку кличе й
 * `fix` над ще не доповненими файлами, бере лише кількість елементів.
 */
function predefinedItemsOf(
  object: Pick<ParsedObject, "kind" | "data">
): { id: string; name: string; physicalName: string }[] {
  return (KIND_REGISTRY[object.kind].namedElementFields ?? []).flatMap(
    (field) =>
      (object.data as Record<string, unknown>)[field] as {
        id: string
        name: string
        physicalName: string
      }[]
  )
}

/** Функція віртуальної таблиці регістра; одне джерело, як вище. */
function virtualTableFunction(
  table: PhysicalTable,
  kind: VirtualTableKind
): QualifiedName {
  return derived(table, VIRTUAL_TABLES[kind].label)
}

function isRegister(object: ParsedObject): boolean {
  return KIND_REGISTRY[object.kind].registerKeys !== undefined
}

/**
 * Мітки похідних функцій об'єкта (ім'я — `makeObjectName` від його таблиці й
 * мітки) за фактами реєстру видів. Одне джерело для перевірки колізій
 * стадії 4 і для `fix`, який не призначає новій таблиці ім'я, вже зайняте
 * функцією: розійдись вони, `fix` дав би ім'я, яке стадія 4 відхилить.
 * `object.data` — вихід схеми виду (масиви з типовими значеннями).
 */
export function derivedFunctionLabels(
  object: Pick<ParsedObject, "kind" | "data">
): { label: string; description: string }[] {
  const labels: { label: string; description: string }[] = []
  if (predefinedItemsOf(object).length > 0) {
    labels.push({ label: PREDEFINED_LABEL, description: "predefined lookup" })
  }
  if (postsMovements(object.kind)) {
    labels.push(
      { label: POSTING_LABELS.save, description: "save" },
      { label: POSTING_LABELS.post, description: "post" },
      { label: POSTING_LABELS.unpost, description: "unpost" }
    )
  }
  const keys = KIND_REGISTRY[object.kind].registerKeys?.(object.data)
  if (keys === undefined) return labels
  for (const kind of keys.virtualTables) {
    labels.push({
      label: VIRTUAL_TABLES[kind].label,
      description: `${kind} virtual table`,
    })
  }
  if (maintainsDerivedTables(keys)) {
    labels.push(
      { label: TOTALS_LABELS.recalculate, description: "totals recalculation" },
      { label: TOTALS_LABELS.verify, description: "totals verification" }
    )
  }
  return labels
}

/**
 * Усі похідні імена функцій, що їх породжує модель, — для перевірки колізій
 * на стадії 4 (спека §7). Обгортки запитів беруться з оголошених
 * `registerMovements`: на моделі без помилок кожен оголошений регістр має
 * рівно одне джерело рухів, тож обгортка є саме для нього.
 */
export function derivedFunctions(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  physical: PhysicalSnapshot,
  wrapperName: (document: PhysicalTable, register: PhysicalTable) => string
): DerivedFunction[] {
  const result: DerivedFunction[] = []
  const add = (
    object: ParsedObject,
    name: QualifiedName,
    description: string,
    pointer = "/physicalName"
  ) => result.push({ ...name, file: object.file, pointer, description })

  const byId = new Map(objects.map((o) => [o.id ?? "", o]))
  for (const object of objects) {
    const table = mainTableOf(physical, object.id ?? "")
    if (table === undefined) continue
    for (const { label, description } of derivedFunctionLabels(object)) {
      add(object, derived(table, label), `${description} of ${object.name}`)
    }
  }

  const seen = new Set<string>()
  for (const reference of references) {
    if (reference.role !== "document.registerMovement") continue
    const document = byId.get(reference.from.objectId)
    const register = byId.get(reference.to.id)
    if (document === undefined || register === undefined) continue
    const key = `${document.id}\0${register.id}`
    if (seen.has(key)) continue
    seen.add(key)
    const documentTable = mainTableOf(physical, document.id ?? "")
    const registerTable = mainTableOf(physical, register.id ?? "")
    if (documentTable === undefined || registerTable === undefined) continue
    result.push({
      schema: documentTable.schema,
      name: wrapperName(documentTable, registerTable),
      file: document.file,
      pointer: reference.from.pointer,
      description: `movement query of ${document.name} into ${register.name}`,
      movementQuery: true,
    })
  }
  return result
}

/**
 * Контракти оболонки проведення, віртуальних таблиць, підсумків, предвизначених
 * елементів і нумерації (спека §7, §8.3): П3 генерує з них SQL і не виводить їх удруге. Викликається лише на
 * моделі без помилок; порядок скрізь за id, тож вихід детермінований.
 */
export function buildContracts(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  style: AttributeCase,
  sqlUnits: readonly SqlUnit[],
  timezone: string,
  requiredChecks: ModelStageResult["requiredChecks"]
): Contracts {
  const registers = objects
    .filter(isRegister)
    .map((register) => registerContract(register, physical, style, timezone))
    .sort((a, b) => compareStrings(a.registerId, b.registerId))
  const controlById = new Map(
    registers.map((r) => [r.registerId, r.balanceControl?.resources])
  )

  const posting = objects
    .filter((object) => postsMovements(object.kind))
    .map((document): PostingContract => {
      const table = must(mainTableOf(physical, document.id ?? ""))
      const movements = sqlUnits
        .filter(isMovementQuery)
        .filter((unit) => unit.documentId === document.id)
        .map((unit) => ({
          registerId: unit.registerId,
          source: unit.source,
          function: { schema: unit.schema, name: unit.name },
        }))
        .sort((a, b) => compareStrings(a.registerId, b.registerId))
      return {
        documentId: document.id ?? "",
        kindLabel: must((document.data as { kindLabel?: string }).kindLabel),
        ...postingFunctions(table),
        requiredOnPost: requiredOnPost(document, physical, requiredChecks),
        immutability: immutability(document, table, physical),
        movements,
        balanceControl: movements.flatMap(({ registerId }) => {
          const resources = controlById.get(registerId)
          return resources === undefined ? [] : [{ registerId, resources }]
        }),
      }
    })
    .sort((a, b) => compareStrings(a.documentId, b.documentId))
  return {
    posting,
    registers,
    predefined: predefinedContracts(objects, physical, style),
    numbering: numberingContracts(objects, physical, style),
  }
}

function columnsOfElement(table: PhysicalTable, id: string | undefined) {
  return table.columns
    .filter((c) => c.origin.elementId === id)
    .map((c) => c.name)
}

function requiredOnPost(
  document: ParsedObject,
  physical: PhysicalSnapshot,
  requiredChecks: ModelStageResult["requiredChecks"]
): PostingContract["requiredOnPost"] {
  const data = document.data as {
    attributes: Attribute[]
    tabularSections: { id?: string; attributes: Attribute[] }[]
  }
  const table = must(mainTableOf(physical, document.id ?? ""))
  const header = data.attributes
    .filter((attribute) => attribute.required)
    .map((attribute) => ({
      attributeId: attribute.id ?? "",
      columns: columnsOfElement(table, attribute.id),
      // Ім'я призначила стадія 3 (з урахуванням колізій), контракт його не
      // перераховує.
      check: must(
        requiredChecks.find(
          (c) => c.objectId === document.id && c.attributeId === attribute.id
        )
      ).check,
    }))
  const sections = data.tabularSections.flatMap((section) => {
    const sectionTable = must(
      physical.tables.find((t) => t.origin.tabularSectionId === section.id)
    )
    const columns = section.attributes
      .filter((attribute) => attribute.required)
      .map((attribute) => ({
        attributeId: attribute.id ?? "",
        columns: columnsOfElement(sectionTable, attribute.id),
      }))
    return columns.length === 0
      ? []
      : [
          {
            sectionId: section.id ?? "",
            table: { schema: sectionTable.schema, name: sectionTable.name },
            columns,
          },
        ]
  })
  return { header, sections }
}

/**
 * Один тригер на шапку й усі ТЧ: імена тригерів живуть у просторі своєї
 * таблиці, тож однакове ім'я не колізує, а П3 створює їх одним циклом.
 */
function immutability(
  document: ParsedObject,
  table: PhysicalTable,
  physical: PhysicalSnapshot
): PostingContract["immutability"] {
  const sections = (
    document.data as { tabularSections: { id?: string }[] }
  ).tabularSections.map((section) =>
    must(physical.tables.find((t) => t.origin.tabularSectionId === section.id))
  )
  return {
    trigger: makeObjectName(table.name, undefined, "immutable"),
    tables: [table, ...sections].map((t) => ({
      schema: t.schema,
      name: t.name,
    })),
  }
}

function numberingContracts(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  style: AttributeCase
): NumberingContract[] {
  return objects
    .flatMap((object): NumberingContract[] => {
      const spec = KIND_REGISTRY[object.kind].numbering?.(object.data)
      const table = mainTableOf(physical, object.id ?? "")
      if (spec === undefined || table === undefined) return []
      const defs = KIND_REGISTRY[object.kind].standardColumns(object.data)
      const columnOf = (logicalName: string) => {
        const def = must(defs.find((c) => c.logicalName === logicalName))
        const standard = standardLogicalName(def, style)
        return must(table.columns.find((c) => c.origin.standard === standard))
          .name
      }
      // Корінь скоупу несе значення в ключі: власної скоуп-колонки в нього
      // немає, і ключ — стандартний, а не додана колонка.
      const scoped = table.columns.some(
        (c) =>
          c.origin.scopeKindId !== undefined && c.origin.standard === undefined
      )
      return [
        {
          objectId: object.id ?? "",
          kindLabel: must(kindLabelOf(object)),
          column: columnOf(spec.column),
          ...(spec.periodColumn !== undefined
            ? { periodColumn: columnOf(spec.periodColumn) }
            : {}),
          type: spec.type,
          length: spec.length,
          autonumber: spec.autonumber,
          periodicity: spec.periodicity,
          scoped,
          assignedAt: "firstWrite",
        },
      ]
    })
    .sort((a, b) => compareStrings(a.objectId, b.objectId))
}

/** Стандартний реквізит мітки предвизначеного (спека П2 §5, М18). */
const PREDEFINED_NAME = "predefinedName"

/**
 * Лише об'єкти з предвизначеними елементами. Колонку мітки й носій скоупу
 * беремо з ключа часткового унікального індексу знімка: засів П3 ставить його
 * арбітром `ON CONFLICT`, тож контракт і індекс не можуть розійтися. Індекс
 * шукаємо за колонкою мітки й предикатом її стандартного реквізиту, а не як
 * перший частковий: інший частковий індекс не підміниться.
 */
function predefinedContracts(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  style: AttributeCase
): PredefinedContract[] {
  return objects
    .flatMap((object): PredefinedContract[] => {
      const items = predefinedItemsOf(object)
      const table = mainTableOf(physical, object.id ?? "")
      if (items.length === 0 || table === undefined) return []
      const def = must(
        KIND_REGISTRY[object.kind]
          .standardColumns(object.data)
          .find((c) => c.logicalName === PREDEFINED_NAME)
      )
      const standard = standardLogicalName(def, style)
      const column = must(
        table.columns.find((c) => c.origin.standard === standard)
      ).name
      const keys = must(
        table.indexes.find((index) => {
          const last = index.keys.at(-1)
          return (
            index.unique &&
            index.where === def.partialUnique &&
            last !== undefined &&
            "column" in last &&
            last.column === column
          )
        })
      ).keys.map((key) => must("column" in key ? key.column : undefined))
      // Ключ — щонайбільше носій скоупу й мітка (`uniqueWithin`, стадія 3).
      const scopeColumn = keys.length > 1 ? keys[0] : undefined
      return [
        {
          objectId: object.id ?? "",
          column,
          ...(scopeColumn !== undefined ? { scopeColumn } : {}),
          lookupFunction: predefinedLookup(table),
          items: items.map(({ id, name, physicalName }) => ({
            id,
            name,
            label: physicalName,
          })),
        },
      ]
    })
    .sort((a, b) => compareStrings(a.objectId, b.objectId))
}

function registerContract(
  register: ParsedObject,
  physical: PhysicalSnapshot,
  style: AttributeCase,
  timezone: string
): RegisterContract {
  const id = register.id ?? ""
  const table = must(mainTableOf(physical, id))
  const def = KIND_REGISTRY[register.kind]
  const keys = must(def.registerKeys?.(register.data))
  const data = register.data as {
    dimensions: Attribute[]
    resources: Attribute[]
    attributes: Attribute[]
    balanceControl?: { resources: string[] }
  }
  const columnsOf = (attributes: readonly Attribute[]): PhysicalColumn[] => {
    const ids = new Set(attributes.map((a) => a.id))
    return table.columns.filter(
      (c) => c.origin.elementId !== undefined && ids.has(c.origin.elementId)
    )
  }
  // Носій скоупу — перша колонка кожної віртуальної таблиці й частина ключа
  // групування `(носій, виміри…)` (спека §7): RLS ріже рядки за скоупом, а
  // групувати без носія не можна. Параметром він не є, окремого поля ключа
  // контракт не має — порядок колонок несе ключ.
  const carrier = table.columns.filter(
    (c) => c.origin.scopeKindId !== undefined
  )
  const column = ({ name, type }: PhysicalColumn) => ({ name, type })
  const dimensions = columnsOf(data.dimensions)
  const resources = columnsOf(data.resources)
  const periodDef = def
    .standardColumns(register.data)
    .find((c) => c.logicalName === "period")
  const period = table.columns.filter(
    (c) =>
      periodDef !== undefined &&
      c.origin.standard === standardLogicalName(periodDef, style)
  )

  const slice = [
    ...carrier,
    ...period,
    ...dimensions,
    ...resources,
    ...columnsOf(data.attributes),
  ].map(column)
  // Колонка ресурсу з джерелом: id елемента беремо з origin, а не з імені.
  const measured = (r: PhysicalColumn, measure: ResourceMeasure) => ({
    ...column(r),
    source: { resourceId: must(r.origin.elementId), measure },
  })
  const columnsFor: Record<VirtualTableKind, VirtualTableColumn[]> = {
    balance: [
      ...[...carrier, ...dimensions].map(column),
      ...resources.map((r) => measured(r, "closing")),
    ],
    balanceAndTurnovers: [
      ...[...carrier, ...dimensions].map(column),
      ...resources.flatMap((r) =>
        MEASURES.map((measure) => ({
          name: makeObjectName(r.name, undefined, measure),
          type: r.type,
          source: { resourceId: must(r.origin.elementId), measure },
        }))
      ),
    ],
    turnovers: [
      ...[...carrier, ...dimensions].map(column),
      ...resources.map((r) => measured(r, "net")),
    ],
    sliceLast: slice,
    sliceFirst: slice,
  }

  const totals = derivedTableOf(physical, id, "totals")
  const turnoversMonth = derivedTableOf(physical, id, "turnoversMonth")
  const balanceControl =
    data.balanceControl === undefined
      ? undefined
      : {
          resources: data.balanceControl.resources.map((name) => {
            const resource = must(data.resources.find((r) => r.name === name))
            return must(columnsOf([resource])[0]).name
          }),
        }
  return {
    registerId: id,
    movements: { schema: table.schema, name: table.name },
    // Вид каже, що таблиця є, а стадія 3 її не збудувала, — дефект компілятора,
    // а не привід мовчки опустити поле контракту.
    ...(!keys.totals
      ? {}
      : { totals: { schema: must(totals).schema, name: must(totals).name } }),
    ...(keys.turnoversMonth === undefined
      ? {}
      : {
          turnoversMonth: {
            table: {
              schema: must(turnoversMonth).schema,
              name: must(turnoversMonth).name,
            },
            monthExpression: truncatedPeriodExpression(
              must(period[0]).name,
              "month",
              timezone
            ),
            split: keys.turnoversMonth.split,
            resources: data.resources.map((resource) => {
              const resourceId = must(resource.id)
              const names = columnsOfElement(must(turnoversMonth), resourceId)
              return keys.turnoversMonth!.split
                ? {
                    resourceId,
                    receipt: must(names[0]),
                    expense: must(names[1]),
                  }
                : { resourceId, column: must(names[0]) }
            }),
          },
        }),
    virtualTables: keys.virtualTables.map((kind) => ({
      kind,
      function: virtualTableFunction(table, kind),
      parameters: VIRTUAL_TABLES[kind].parameters,
      ...(VIRTUAL_TABLES[kind].parameters.some(
        (p) => p.name === "p_recorder_type"
      )
        ? { momentCollation: "C" as const }
        : {}),
      columns: columnsFor[kind],
    })),
    ...(maintainsDerivedTables(keys)
      ? { totalsMaintenance: totalsFunctions(table) }
      : {}),
    ...(balanceControl === undefined ? {} : { balanceControl }),
  }
}

/** Модель без помилок гарантує наявність; відсутність — дефект компілятора. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing contract input")
  return value
}
