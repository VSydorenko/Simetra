import {
  KIND_REGISTRY,
  PROVIDER_EVENT_SOURCES,
  PUBLIC_READ_PURPOSES,
  makeObjectName,
  postsMovements,
  truncatedPeriodExpression,
  standardLogicalName,
  type Attribute,
  type DatabaseProvider,
  type LocalizedString,
  type NumberingSpec,
  type AttributeCase,
  type Catalog,
  type PhysicalColumn,
  type PhysicalSnapshot,
  type PhysicalTable,
  type Project,
  type PublicReadRole,
  type RegisterKeySpec,
  type RequestRolePurpose,
  type ScopeKind,
  type SubscriptionEvent,
  type VirtualTableKind,
} from "simetra/model"
import { compareStrings } from "./diagnostics"
import {
  choosesMembership,
  membershipFunctionNames,
  membershipsOf,
} from "./membership-functions"
import {
  kindLabelOf,
  usersCatalogOf,
  type ModelStageResult,
} from "./stages/model"
import { isMovementQuery, type SqlUnit } from "./sql/units"
import { objectKey, type ParsedObject } from "./stages/files"
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

/**
 * Підписка на подію (спека промоції §9.3): П3 генерує з неї тригер
 * `FOR EACH ROW` на кожне джерело з викликом обробника.
 */
export interface EventSubscriptionContract {
  subscriptionId: string
  /** `physicalName` підписки — база імені тригера, призначена раз. */
  name: string
  /**
   * `whenChanged` — фізичні колонки цього джерела (поліморфна пара — обидві):
   * те саме логічне ім'я в різних джерелах може мати різні фізичні імена.
   * Порожньо — будь-який запис.
   */
  sources: { schema: string; table: string; whenChanged: string[] }[]
  event: SubscriptionEvent
  handler: QualifiedName
  /** Текст для `COMMENT ON TRIGGER`: коментар прийнятого тригера стає ним. */
  title?: LocalizedString
  description?: LocalizedString
}

/**
 * Персональні колонки таблиці (спека промоції §9.10): команда знеособлення
 * (П4) ставить їх у `NULL`. Поліморфна пара дає обидві фізичні колонки.
 */
export interface PersonalDataContract {
  objectId: string
  table: QualifiedName
  columns: string[]
}

/**
 * Системний довідник «Користувачі» (спека користувачів §4): з цього контракту
 * платформний шар будує провізію й поточного користувача. Найменування —
 * відображуване ім'я, провізія обрізає його до `descriptionLength`.
 */
export interface UsersContract {
  objectId: string
  table: QualifiedName
  keyColumn: "id"
  descriptionColumn: string
  descriptionLength: number
  invalidColumn: "invalid"
  userKindColumn: "user_kind"
}

/**
 * Довідник членства виду скоупу (спека користувачів §8): П3 будує з нього
 * політики, а функції вже згенеровано одиницями моделі.
 */
export interface MembershipContract {
  objectId: string
  scopeKindId: string
  table: QualifiedName
  scopeColumn: string
  userColumn: string
  myMemberFunction: QualifiedName
  /** Лише коли вид скоупу обирає `setFunction: "membership"`. */
  setFunction?: QualifiedName
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
  /**
   * За `objectId`: призначення ролі API, якій об'єкт відкриває читання, —
   * лише роль запиту; ім'я ролі дає `PROVIDER_API_ROLES` провайдера.
   */
  publicRead: { objectId: string; purpose: RequestRolePurpose }[]
  /** За `bucket`: вид скоупу вказано id, бо ім'я виду може змінитися. */
  storageBuckets: { bucket: string; scopeKindId: string }[]
  /** За `subscriptionId`. */
  eventSubscriptions: EventSubscriptionContract[]
  /** За `objectId`, далі за таблицею: основна й кожна ТЧ — окремі записи. */
  personalData: PersonalDataContract[]
  /** Немає — у проєкті немає «Користувачів», а з ними й платформного шару. */
  users?: UsersContract
  /** За `objectId`. */
  membership: MembershipContract[]
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
  wrapperName: (document: PhysicalTable, register: PhysicalTable) => string,
  scopeKinds: readonly ScopeKind[]
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
    // Функції членства — згенеровані одиниці, але RPC кличе їх за іменем,
    // тож і для них дослівна функція з тим самим іменем — колізія.
    const { membership, scope } = object.data as {
      membership?: unknown
      scope?: string
    }
    if (membership !== undefined) {
      const names = membershipFunctionNames(table)
      add(
        object,
        names.myMember,
        `member lookup of ${object.name}`,
        "/membership"
      )
      const kind = scopeKinds.find((k) => k.name === scope)
      if (kind !== undefined && choosesMembership(kind)) {
        add(
          object,
          names.memberScopes,
          `membership set function of ${object.name}`,
          "/membership"
        )
      }
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
  elementChecks: ModelStageResult["elementChecks"],
  project: Pick<
    Project,
    "scopeKinds" | "storageBuckets" | "defaultSchema" | "database"
  >
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
        requiredOnPost: requiredOnPost(document, physical, elementChecks),
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
    publicRead: objects
      .flatMap((object) => {
        const role = (object.data as { publicRead?: PublicReadRole }).publicRead
        return role === undefined
          ? []
          : [
              {
                objectId: object.id ?? "",
                purpose: PUBLIC_READ_PURPOSES[role],
              },
            ]
      })
      .sort((a, b) => compareStrings(a.objectId, b.objectId)),
    storageBuckets: project.storageBuckets
      .map(({ bucket, scopeKind }) => ({
        bucket,
        // Існування виду стереже стадія 2: до контрактів доходить лише модель
        // без помилок.
        scopeKindId: must(
          project.scopeKinds.find((k) => k.name === scopeKind)?.id
        ),
      }))
      .sort((a, b) => compareStrings(a.bucket, b.bucket)),
    eventSubscriptions: eventSubscriptionContracts(objects, physical, project),
    personalData: personalDataContracts(objects, physical),
    ...withUsers(usersContractOf(objects, physical)),
    membership: membershipsOf(objects, physical, project).map(
      (m): MembershipContract => ({
        objectId: m.object.id ?? "",
        scopeKindId: m.scopeKind.id ?? "",
        table: { schema: m.table.schema, name: m.table.name },
        scopeColumn: m.scopeColumn,
        userColumn: m.userColumn,
        myMemberFunction: m.myMember,
        ...(m.setFunction === undefined ? {} : { setFunction: m.setFunction }),
      })
    ),
  }
}

function withUsers(users: UsersContract | undefined): {
  users?: UsersContract
} {
  return users === undefined ? {} : { users }
}

/**
 * Контракт «Користувачів» — і для блоку контрактів, і для платформного шару,
 * що генерує провізію над тими самими колонками (одне джерело).
 */
export function usersContractOf(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot
): UsersContract | undefined {
  const users = usersCatalogOf(objects)
  if (users === undefined) return undefined
  const objectId = users.id ?? ""
  const table = must(mainTableOf(physical, objectId))
  // Фізичне ім'я найменування дає реєстр виду, а не літерал тут.
  const description = KIND_REGISTRY[users.kind]
    .standardColumns(users.data)
    .find((c) => c.logicalName === "description")!
  return {
    objectId,
    table: { schema: table.schema, name: table.name },
    keyColumn: "id",
    descriptionColumn: description.physicalName,
    descriptionLength: (users.data as Catalog).descriptionLength,
    invalidColumn: "invalid",
    userKindColumn: "user_kind",
  }
}

/**
 * Лише таблиці, де є персональні реквізити. Колонки беремо за `elementId`
 * реквізиту, а не за іменем: фізичні імена призначені раз і не збігаються
 * з логічними.
 */
function personalDataContracts(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot
): PersonalDataContract[] {
  const personal = (attributes: readonly Attribute[] | undefined) =>
    (attributes ?? []).filter((a) => a.personalData === true)
  const record = (
    objectId: string,
    table: PhysicalTable | undefined,
    attributes: readonly Attribute[]
  ): PersonalDataContract[] => {
    if (table === undefined || attributes.length === 0) return []
    const ids = new Set(attributes.map((a) => a.id))
    const columns = table.columns
      .filter(
        (c) => c.origin.elementId !== undefined && ids.has(c.origin.elementId)
      )
      .map((c) => c.name)
    return columns.length === 0
      ? []
      : [
          {
            objectId,
            table: { schema: table.schema, name: table.name },
            columns,
          },
        ]
  }
  return objects
    .flatMap((object): PersonalDataContract[] => {
      const objectId = object.id ?? ""
      const data = object.data as Record<string, unknown>
      const own = KIND_REGISTRY[object.kind].columnFields.flatMap((field) =>
        personal(data[field] as Attribute[] | undefined)
      )
      const sections = (
        (data.tabularSections ?? []) as {
          id?: string
          attributes: Attribute[]
        }[]
      ).flatMap((section) =>
        record(
          objectId,
          physical.tables.find((t) => t.origin.tabularSectionId === section.id),
          personal(section.attributes)
        )
      )
      return [
        ...record(objectId, mainTableOf(physical, objectId), own),
        ...sections,
      ]
    })
    .sort(
      (a, b) =>
        compareStrings(a.objectId, b.objectId) ||
        compareStrings(a.table.schema, b.table.schema) ||
        compareStrings(a.table.name, b.table.name)
    )
}

/** Таблиця-джерело підписки: основна таблиця об'єкта чи таблиця провайдера. */
export interface SubscriptionSourceTable {
  schema: string
  table: string
  /** Фізичні колонки за логічним іменем (для таблиці провайдера — ім'я колонки). */
  columns: ReadonlyMap<string, readonly string[]>
}

/**
 * Колонки основної таблиці об'єкта за логічним іменем реквізиту чи
 * стандартного реквізиту в стилі проєкту. Поліморфна пара дає дві колонки.
 */
function columnsByLogicalName(
  object: ParsedObject,
  table: PhysicalTable
): Map<string, string[]> {
  const def = KIND_REGISTRY[object.kind]
  const data = object.data as Record<string, unknown>
  const names = new Map(
    def.columnFields.flatMap((field) =>
      ((data[field] ?? []) as { id?: string; name: string }[]).map(
        (element) => [element.id, element.name] as const
      )
    )
  )
  const result = new Map<string, string[]>()
  for (const column of table.columns) {
    // Скоуп-колонка без стандартного реквізиту реквізитом не є.
    const logical =
      column.origin.elementId !== undefined
        ? names.get(column.origin.elementId)
        : column.origin.standard
    if (logical === undefined) continue
    result.set(logical, [...(result.get(logical) ?? []), column.name])
  }
  return result
}

/**
 * Таблиця джерела за pointer-ом підписки. `undefined` — джерело не
 * резолвиться в таблицю (невідомий об'єкт, вид без таблиці, таблиця поза
 * пресетом): про це звітують стадії 2 і 4, а не читачі.
 */
export function subscriptionSourceTables(
  subscription: ParsedObject,
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  provider: DatabaseProvider
): Map<string, SubscriptionSourceTable | undefined> {
  const spec = KIND_REGISTRY[subscription.kind].subscription?.(
    subscription.data
  )
  const byKey = new Map(objects.map((o) => [objectKey(o.kind, o.name), o]))
  const result = new Map<string, SubscriptionSourceTable | undefined>()
  for (const source of spec?.sources ?? []) {
    if ("providerTable" in source) {
      const { schema, table } = source.providerTable
      const preset = PROVIDER_EVENT_SOURCES[provider].find(
        (s) => s.schema === schema && s.table === table
      )
      result.set(
        source.pointer,
        preset === undefined
          ? undefined
          : {
              schema,
              table,
              columns: new Map(preset.columns.map((c) => [c, [c]])),
            }
      )
      continue
    }
    const target = byKey.get(objectKey(source.ref.kind, source.ref.name))
    const table =
      target === undefined ? undefined : mainTableOf(physical, target.id ?? "")
    result.set(
      source.pointer,
      target === undefined || table === undefined
        ? undefined
        : {
            schema: table.schema,
            table: table.name,
            columns: columnsByLogicalName(target, table),
          }
    )
  }
  return result
}

function eventSubscriptionContracts(
  objects: readonly ParsedObject[],
  physical: PhysicalSnapshot,
  project: Pick<Project, "defaultSchema" | "database">
): EventSubscriptionContract[] {
  return objects
    .flatMap((object): EventSubscriptionContract[] => {
      const spec = KIND_REGISTRY[object.kind].subscription?.(object.data)
      if (spec === undefined) return []
      // Модель без помилок: кожне джерело — таблиця, і кожне ім'я
      // `whenChanged` є в кожному джерелі (стадія 4).
      const tables = [
        ...subscriptionSourceTables(
          object,
          objects,
          physical,
          project.database.provider
        ).values(),
      ].map(must)
      const data = object.data as {
        physicalName?: string
        title?: LocalizedString
        description?: LocalizedString
      }
      return [
        {
          subscriptionId: object.id ?? "",
          name: must(data.physicalName),
          sources: tables.map(({ schema, table, columns }) => ({
            schema,
            table,
            whenChanged: (spec.whenChanged ?? []).flatMap((name) => [
              ...must(columns.get(name)),
            ]),
          })),
          event: spec.event,
          handler: {
            schema: spec.handler.schema ?? project.defaultSchema,
            name: spec.handler.name,
          },
          ...(data.title === undefined ? {} : { title: data.title }),
          ...(data.description === undefined
            ? {}
            : { description: data.description }),
        },
      ]
    })
    .sort((a, b) => compareStrings(a.subscriptionId, b.subscriptionId))
}

function columnsOfElement(table: PhysicalTable, id: string | undefined) {
  return table.columns
    .filter((c) => c.origin.elementId === id)
    .map((c) => c.name)
}

function requiredOnPost(
  document: ParsedObject,
  physical: PhysicalSnapshot,
  elementChecks: ModelStageResult["elementChecks"]
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
        elementChecks.find(
          (c) =>
            c.label === "required" &&
            c.objectId === document.id &&
            c.attributeId === attribute.id
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
      // Ключ — щонайбільше носій скоупу й мітка (`uniqueCarrier`, стадія 3).
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
