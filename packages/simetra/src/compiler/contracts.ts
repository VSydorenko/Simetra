import {
  KIND_REGISTRY,
  makeObjectName,
  postsMovements,
  standardLogicalName,
  type Attribute,
  type AttributeCase,
  type PhysicalColumn,
  type PhysicalSnapshot,
  type PhysicalTable,
  type VirtualTableKind,
} from "simetra/model"
import { compareStrings } from "./diagnostics"
import type { SqlUnit } from "./movement-functions"
import type { ParsedObject } from "./stages/files"
import type { ResolvedReference } from "./stages/identity"

export interface QualifiedName {
  schema: string
  name: string
}

export interface PostingContract {
  documentId: string
  post: QualifiedName
  unpost: QualifiedName
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
  parameters: { name: "p_at" | "p_from" | "p_to"; type: string }[]
  columns: { name: string; type: string }[]
}

export interface RegisterContract {
  registerId: string
  movements: QualifiedName
  totals?: QualifiedName
  virtualTables: VirtualTableContract[]
  totalsMaintenance?: { recalculate: QualifiedName; verify: QualifiedName }
  balanceControl?: { resources: string[] }
}

/** Предвизначені елементи довідника: засів за `id` — П3. */
export interface PredefinedContract {
  objectId: string
  /** У порядку файлу. */
  items: { id: string; name: string }[]
}

export interface Contracts {
  /** За `documentId`. */
  posting: PostingContract[]
  /** За `registerId`. */
  registers: RegisterContract[]
  /** За `objectId`. */
  predefined: PredefinedContract[]
}

/** Функція контракту, якої ще немає в БД, з місцем у метаданих для діагностики. */
export interface DerivedFunction extends QualifiedName {
  file: string
  pointer: string
  /** Для тексту діагностики: що це за функція. */
  description: string
}

const TIMESTAMP = "timestamp with time zone"

/** Мітки імен віртуальних таблиць і їхні параметри (спека §7). */
const VIRTUAL_TABLES: Record<
  VirtualTableKind,
  { label: string; parameters: VirtualTableContract["parameters"] }
> = {
  balance: {
    label: "balance",
    parameters: [{ name: "p_at", type: TIMESTAMP }],
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

function totalsTableOf(
  physical: PhysicalSnapshot,
  objectId: string
): PhysicalTable | undefined {
  return physical.tables.find(
    (t) => t.origin.objectId === objectId && t.origin.part === "totals"
  )
}

/** Ім'я похідної функції — алгоритм імен Postgres від таблиці власника. */
function derived(table: PhysicalTable, label: string): QualifiedName {
  return {
    schema: table.schema,
    name: makeObjectName(table.name, undefined, label),
  }
}

/**
 * Функції оболонки проведення документа. Одне джерело імен для контракту й
 * перевірки колізій стадії 4: розбіжність пропустила б колізію до `CREATE` П3.
 */
function postingFunctions(table: PhysicalTable): {
  post: QualifiedName
  unpost: QualifiedName
} {
  return { post: derived(table, "post"), unpost: derived(table, "unpost") }
}

/** Функції перерахунку й звірки підсумків регістра; одне джерело, як вище. */
function totalsFunctions(table: PhysicalTable): {
  recalculate: QualifiedName
  verify: QualifiedName
} {
  return {
    recalculate: derived(table, "totals_recalculate"),
    verify: derived(table, "totals_verify"),
  }
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
    if (postsMovements(object.kind)) {
      const { post, unpost } = postingFunctions(table)
      add(object, post, `post of ${object.name}`)
      add(object, unpost, `unpost of ${object.name}`)
    }
    const keys = KIND_REGISTRY[object.kind].registerKeys?.(object.data)
    if (keys === undefined) continue
    for (const kind of keys.virtualTables) {
      add(
        object,
        virtualTableFunction(table, kind),
        `${kind} virtual table of ${object.name}`
      )
    }
    if (keys.totals) {
      const { recalculate, verify } = totalsFunctions(table)
      add(object, recalculate, `totals recalculation of ${object.name}`)
      add(object, verify, `totals verification of ${object.name}`)
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
    add(
      document,
      {
        schema: documentTable.schema,
        name: wrapperName(documentTable, registerTable),
      },
      `movement query of ${document.name} into ${register.name}`,
      reference.from.pointer
    )
  }
  return result
}

/**
 * Контракти оболонки проведення, віртуальних таблиць і підсумків (спека §7,
 * §8.3): П3 генерує з них SQL і не виводить їх удруге. Викликається лише на
 * моделі без помилок; порядок скрізь за id, тож вихід детермінований.
 */
export function buildContracts(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  style: AttributeCase,
  sqlUnits: readonly SqlUnit[]
): Contracts {
  const registers = objects
    .filter(isRegister)
    .map((register) => registerContract(register, physical, style))
    .sort((a, b) => compareStrings(a.registerId, b.registerId))
  const controlById = new Map(
    registers.map((r) => [r.registerId, r.balanceControl?.resources])
  )

  const posting = objects
    .filter((object) => postsMovements(object.kind))
    .map((document): PostingContract => {
      const table = must(mainTableOf(physical, document.id ?? ""))
      const movements = sqlUnits
        .filter((unit) => unit.documentId === document.id)
        .map((unit) => ({
          registerId: unit.registerId,
          source: unit.source,
          function: { schema: unit.schema, name: unit.name },
        }))
        .sort((a, b) => compareStrings(a.registerId, b.registerId))
      return {
        documentId: document.id ?? "",
        ...postingFunctions(table),
        movements,
        balanceControl: movements.flatMap(({ registerId }) => {
          const resources = controlById.get(registerId)
          return resources === undefined ? [] : [{ registerId, resources }]
        }),
      }
    })
    .sort((a, b) => compareStrings(a.documentId, b.documentId))
  return { posting, registers, predefined: predefinedContracts(objects) }
}

/** Лише об'єкти з іменованими елементами; вид визначає реєстр, а не його назва. */
function predefinedContracts(
  objects: readonly ParsedObject[]
): PredefinedContract[] {
  return objects
    .flatMap((object): PredefinedContract[] => {
      const fields = KIND_REGISTRY[object.kind].namedElementFields ?? []
      const items = fields
        // Приведення безпечне: контракти будуються лише на моделі без помилок,
        // тож схема виду та стадія 2 гарантують масив з `id` і `name`.
        .flatMap(
          (field) =>
            (object.data as Record<string, unknown>)[field] as {
              id: string
              name: string
            }[]
        )
        .map(({ id, name }) => ({ id, name }))
      return items.length === 0 ? [] : [{ objectId: object.id ?? "", items }]
    })
    .sort((a, b) => compareStrings(a.objectId, b.objectId))
}

function registerContract(
  register: ParsedObject,
  physical: PhysicalSnapshot,
  style: AttributeCase
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
  const columnsFor: Record<VirtualTableKind, { name: string; type: string }[]> =
    {
      balance: [...carrier, ...dimensions, ...resources].map(column),
      balanceAndTurnovers: [
        ...[...carrier, ...dimensions].map(column),
        ...resources.flatMap((r) =>
          ["opening", "receipt", "expense", "closing"].map((label) => ({
            name: makeObjectName(r.name, undefined, label),
            type: r.type,
          }))
        ),
      ],
      turnovers: [...carrier, ...dimensions, ...resources].map(column),
      sliceLast: slice,
      sliceFirst: slice,
    }

  const totals = totalsTableOf(physical, id)
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
    ...(totals === undefined
      ? {}
      : { totals: { schema: totals.schema, name: totals.name } }),
    virtualTables: keys.virtualTables.map((kind) => ({
      kind,
      function: virtualTableFunction(table, kind),
      parameters: VIRTUAL_TABLES[kind].parameters,
      columns: columnsFor[kind],
    })),
    ...(keys.totals ? { totalsMaintenance: totalsFunctions(table) } : {}),
    ...(balanceControl === undefined ? {} : { balanceControl }),
  }
}

/** Модель без помилок гарантує наявність; відсутність — дефект компілятора. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("internal: missing contract input")
  return value
}
