import type {
  CommandError,
  CommandResult,
  Filter,
  MetadataRef,
  Operation,
  OrderBy,
  ReadQuery,
  ReadRows,
} from "simetra/model"

/**
 * Інтерфейс ядра T4 v0 (спайк 1 «ядро»). Ядро не імпортує React, TanStack і
 * нічого, крім T0: усе, що воно знає про світ, приходить портом
 * {@link CoreSource} і описом об'єктів {@link ObjectSpec}.
 *
 * Головна гарантія будови: стан змінює лише `commit` сесії, а він перевіряє
 * покоління. Після `dispose()` чи для старого покоління запис неможливий —
 * методи сховищ вимагають відкритої області запису, яку створює лише `commit`.
 */

/** Id рядка (UUID рядком). */
export type Key = string

/** `"<kind>.<name>"` — ім'я об'єкта в ядрі, як у мапі `residency`. */
export type ObjectName = string

/**
 * Значення полів рядка за логічними іменами. Відсутнє поле — «не
 * завантажено» (ліниве), `null` — явне порожнє значення.
 */
export type Values = Readonly<Record<string, unknown>>

/** Підтверджений сервером рядок шапки. */
export interface ServerRow {
  readonly key: Key
  readonly version: number
  readonly values: Values
}

/** Рядок табличної частини власника. */
export interface SectionLine {
  readonly key: Key
  readonly values: Values
}

// ---------------------------------------------------------------- опис

/** Тип поля для локального фільтра й сортування `full`. */
export type FieldType =
  | "string"
  | "number"
  | "bigint-text"
  | "numeric-text"
  | "boolean"
  | "date"
  | "datetime"
  | "uuid"

export interface ObjectSpec {
  readonly ref: MetadataRef
  /** Поля, за якими можна фільтрувати й сортувати локально. */
  readonly fields: Readonly<Record<string, FieldType>>
  /** Ліниві поля: списочне читання їх не віддає, картка віддає. */
  readonly lazy?: readonly string[]
  /** Табличні частини об'єкта за логічним ім'ям. */
  readonly sections?: readonly string[]
}

/**
 * Порт джерела: логічні форми T0 (`ReadQuery`, `Operation`). Адаптер
 * (Server Function, PostgREST, фейк) перекладає їх у дріт. `signal`
 * обривається з `dispose()` сесії чи з відкликанням покоління запиту.
 * Відмова — `CommandFailure` T0.
 */
export interface CoreSource {
  read(query: ReadQuery, signal: AbortSignal): Promise<ReadRows>
  run(
    operations: readonly Operation[],
    signal: AbortSignal
  ): Promise<CommandResult>
}

export interface CoreOptions {
  /** `sub` сесії: знімок SSR прив'язаний до нього. */
  readonly subject: string
  readonly source: CoreSource
  readonly objects: readonly ObjectSpec[]
  /** Межа `full` (типово 5 000). */
  readonly fullLimit?: number
  /**
   * Затримка звільнення підмножини після останньої відписки (типово
   * 1 000 мс; 0 — одразу). Повторне монтування в межах затримки бере ту
   * саму підмножину без запиту.
   */
  readonly releaseDelayMs?: number
  /** Межа ключів одного запиту за ключами (типово 200). */
  readonly keysPerRequest?: number
  /** Політика пам'яті вигляду `window` (спайк 4). */
  readonly window?: WindowOptions
  /** Журнал ядра; збій журналу результату не змінює. */
  readonly log?: (entry: CoreLogEntry) => void
}

export interface WindowOptions {
  /** Сторінок запасу з кожного боку видимих, що лишаються у власності (типово 2). */
  readonly marginPages?: number
  /** Затримка, після якої сторінка поза запасом стає знімком показу (типово 1 000 мс). */
  readonly unloadDelayMs?: number
  /**
   * Межа знімків показу вигляду в байтах (оцінка; типово 4 МіБ). Понад неї
   * найдальші знімки з країв ланцюжка відкидаються разом з місцем у списку.
   */
  readonly ghostBytes?: number
}

export type CoreLogEntry =
  | { kind: "write-back-skipped"; object: ObjectName; key: Key; why: string }
  | { kind: "late-response"; what: string }
  | { kind: "listener-failed"; error: unknown }

// ---------------------------------------------------------------- вигляди

/** Форми підмножин (спека П4-B §6.1) — і водночас вигляди. */
export type ViewSpec =
  /** Набір ключів (форма 1): ділиться на запити по `keysPerRequest`. */
  | {
      readonly kind: "keys"
      readonly object: ObjectName
      readonly keys: readonly Key[]
    }
  /** Картка: шапка з лінивими полями. ТЧ картки — окремі вигляди `section`. */
  | { readonly kind: "card"; readonly object: ObjectName; readonly key: Key }
  /** ТЧ власника (форма 3): усі рядки й `ownerVersion` одним читанням. */
  | {
      readonly kind: "section"
      readonly object: ObjectName
      readonly owner: Key
      readonly section: string
    }
  /** Уся видима множина до межі; фільтр і сортування — локально. */
  | {
      readonly kind: "full"
      readonly object: ObjectName
      readonly where?: Filter
      readonly orderBy?: OrderBy
    }
  /** Вікно keyset-сторінок (мінімум спайку: ланцюжок `loadAfter`). */
  | {
      readonly kind: "window"
      readonly object: ObjectName
      readonly where?: Filter
      readonly orderBy: OrderBy
      readonly pageSize?: number
    }

/** Стан рядка, який бачить UI (словник спільних правил спайків). */
export type RowState =
  "synced" | "pending" | "failed" | "conflict" | "stale" | "removed" | "unknown"

/** Власна мутація, що зачіпає рядок, — для показу й дій UI. */
export interface MutationInfo {
  readonly id: MutationId
  readonly state: MutationState
  /** Поля шапки, які мутація змінює на цьому рядку. */
  readonly fields: readonly string[]
  readonly op: "create" | "update" | "delete" | "section"
  readonly policy: ActionPolicy
  readonly error?: CommandError
}

export interface RowStatus {
  /**
   * Пріоритет: `removed` > `conflict` > `failed` > `unknown` > `pending` >
   * `stale` > `synced`. `unknown` — результат команди невідомий (тайм-аут,
   * `command.unavailable`, обрив після відправлення); ядро перечитує ключ і
   * розв'язує стан у `synced`, `failed` чи `conflict`, без автоповтору. `removed` — сервер видалив рядок (чужа зміна); рядок лишається
   * на місці до дії користувача (рішення архітекторки 08.11).
   * `stale` — рядок може бути застарілим (сигнал, розрив); показ не ховає.
   */
  readonly state: RowState
  /** Поля з незавершеною (у черзі чи в польоті) зміною. */
  readonly pendingFields: readonly string[]
  /** Мутації рядка в порядку журналу; осілі успішні тут не лишаються. */
  readonly mutations: readonly MutationInfo[]
  /** Рядок позначено до видалення незавершеною мутацією `delete`. */
  readonly deleting: boolean
  /** Рядок існує лише як власне створення, сервер його ще не підтвердив. */
  readonly created: boolean
  /** `conflict`: поточний підтверджений рядок сервера для рішення. */
  readonly server?: ServerRow
}

/**
 * Показаний рядок = підтверджений ⊕ власні мутації по порядку. `values` —
 * незмінна посилка: та сама, поки показані значення не змінились, навіть
 * коли змінилась версія чи стан.
 */
export interface RowView {
  readonly key: Key
  /** Підтверджена версія; `undefined` — власне створення до підтвердження. */
  readonly version: number | undefined
  readonly values: Values
  readonly status: RowStatus
  /**
   * Лише `window`: рядок вивантаженої сторінки — останній показаний знімок
   * без власності (стан `stale`), поки сторінку не перечитано за ключами.
   */
  readonly ghost?: true
}

/** Сторінка ланцюжка вікна (для показу й вимірів). */
export interface WindowPageInfo {
  readonly id: number
  /** `resident` — рядки у власності ядра; `ghost` — знімок показу. */
  readonly tier: "resident" | "ghost"
  readonly count: number
}

export interface WindowInfo {
  readonly atStart: boolean
  readonly atEnd: boolean
  readonly loadingBefore: boolean
  readonly loadingAfter: boolean
  /**
   * Покоління ланцюжка: змінюється лише дією користувача (перехід, оновлення,
   * `showNew`). Разом з `target` каже UI, куди стати одним кадром.
   */
  readonly chain: number
  /** `start`/`end` — стати на початок чи кінець; `keep` — тримати якір. */
  readonly target: "start" | "end" | "keep"
  readonly pages: readonly WindowPageInfo[]
  /** Оцінка байтів знімків показу. */
  readonly ghostBytes: number
}

/** Стан вибірки (словник спільних правил). */
export type ViewStatus = "loading" | "ready" | "refreshing" | "error"

export interface ViewSnapshot {
  readonly status: ViewStatus
  readonly error?: CommandError
  /**
   * Рядки вигляду в порядку показу: `keys` — порядок ключів, `full` —
   * локальне сортування, `window` — серверний порядок сторінок (власні
   * створення — на початку). `card` — нуль чи один рядок.
   *
   * Правило стабільності: сигнал, перечитування й перепідписка не
   * вставляють, не прибирають і не переставляють рядків. Склад і порядок
   * змінюють лише завантаження, `refresh()`, `showNew()`, `loadAfter()`,
   * власне створення (один раз, на початку) і підтверджене власне видалення.
   */
  readonly rows: readonly RowView[]
  /** Є нові рядки, позиції яких вигляд не знає (сигнал). */
  readonly hasNewRows: boolean
  /** Дані вигляду треба перечитати (сигнал, втрата скоупу, тайм-аут). */
  readonly needsRefresh: boolean
  /** Лише `section`: версія власника, з якою прийшли рядки, і повнота. */
  readonly section?: {
    readonly ownerVersion: number | undefined
    readonly complete: boolean
    readonly lines: readonly SectionLineView[]
  }
  /** Лише `window`. */
  readonly window?: WindowInfo
  /** Лише `full`: множина понад межу. */
  readonly truncated?: boolean
}

export interface SectionLineView {
  readonly key: Key
  readonly values: Values
  /** Рядок змінено незавершеною дельтою. */
  readonly pending: boolean
  /** Незавершена дельта прибирає рядок: він лишається на місці до осідання. */
  readonly removing: boolean
}

/**
 * Хендл вигляду — пара для `useSyncExternalStore`. Власність на рядки дає
 * лише `subscribe`: React не гарантує парного звільнення для відкинутого
 * рендера (зокрема StrictMode), тож сам хендл нічим не володіє.
 */
export interface ViewHandle {
  /**
   * Незмінний знімок; та сама посилка, якщо для вигляду нічого не змінилось.
   * Без підписки й без знімка SSR — `loading` без рядків.
   */
  getSnapshot(): ViewSnapshot
  /**
   * Підписка = утримання підмножини: перша створює й завантажує її. Після
   * останньої відписки підмножина звільняється через `releaseDelayMs`.
   * Слухач кличеться лише тоді, коли знімок змінився.
   */
  subscribe(listener: () => void): () => void
  /** Перечитати (single-flight: запит під час активного — один хвостовий). */
  refresh(): void
  /** Скинути `hasNewRows`: перечитати склад від початку. */
  showNew(): void
  /** Лише `window`: наступна сторінка keyset-ом. */
  loadAfter(): void
  /** Лише `window`: попередня сторінка (зворотний keyset від першого рядка). */
  loadBefore(): void
  /** Лише `window`: новий ланцюжок від значення першого атрибута сортування. */
  goTo(value: unknown): void
  goToStart(): void
  goToEnd(): void
  /**
   * Лише `window`: ключі першого й останнього видимого рядка. Ядро тримає
   * видимі сторінки із запасом, решту вивантажує й дочитує краї.
   */
  setVisibleRange(first: Key, last: Key): void
}

// ---------------------------------------------------------------- запис

export type MutationId = number

/**
 * Політика показу власної дії. `predict` — передбачене значення показано
 * одразу (лише точні передбачення: встановити поле, перемкнути, видалити).
 * `await` — показане значення не змінюється до відповіді `run`, видно лише
 * стан `pending`; результат сервера застосовується одним `commit` (проведення,
 * номер, підсумки). Редагування картки — чернетка форми поза ядром; у
 * сховище вона потрапляє лише записом.
 */
export type ActionPolicy = "predict" | "await"

export interface TxOptions {
  /** Типово `await`. */
  readonly policy?: ActionPolicy
}

/**
 * `queued` — чекає черги ключа; `sending` — у польоті; `unknown` — результат
 * невідомий, іде перечитування ключів; `failed` — сервер
 * відмовив, зміна видима до `retry` чи `cancel`; `conflict` — сервер має
 * новішу версію, зміна збережена.
 */
export type MutationState =
  "queued" | "sending" | "unknown" | "failed" | "conflict"

/** Одна транзакція фасаду — один виклик `run` — одна транзакція бази. */
export interface Tx {
  create(object: ObjectName, key: Key, values: Values): Tx
  /** Лише змінені поля; база версії — підтверджений рядок ключа. */
  update(object: ObjectName, key: Key, values: Values): Tx
  delete(object: ObjectName, key: Key): Tx
  /** Дельта рядка ТЧ; ядро шле повний масив ТЧ бази ключа. */
  addLine(
    object: ObjectName,
    owner: Key,
    section: string,
    line: SectionLine
  ): Tx
  updateLine(
    object: ObjectName,
    owner: Key,
    section: string,
    line: Key,
    values: Values
  ): Tx
  removeLine(object: ObjectName, owner: Key, section: string, line: Key): Tx
  /** Видимо застосувати й поставити в чергу ключів. */
  commit(): Mutation
}

export type MutationOutcome =
  | { readonly ok: true; readonly rows: readonly (ServerRow | undefined)[] }
  | { readonly ok: false; readonly error: CommandError }

export interface Mutation {
  readonly id: MutationId
  /**
   * Розв'язується на осіданні спроби: успіх — після write-back тим самим
   * `commit`; відмова — мутація лишається в журналі (`failed`/`conflict`).
   * Після `dispose()` — `command.unavailable` `disposed`. Ніколи не
   * відхиляється.
   */
  readonly settled: Promise<MutationOutcome>
}

// ---------------------------------------------------------------- сесія

/** Покоління, від імені якого асинхронна гілка пише в ядро. */
export interface GenerationToken {
  /** Чи прийме `commit` запис від імені цього покоління зараз. */
  readonly valid: boolean
}

/**
 * Публічна область запису для сигналів і перечитувань (спайк 3): лише
 * латання наявних ключів за правилом версії, прибирання, позначки.
 */
export interface Writer {
  /** Латає наявні ключі; рядок меншої версії відкидається (Рд24). */
  patch(object: ObjectName, rows: readonly ServerRow[]): void
  /**
   * Сервер видалив рядки (чи вони невидимі під RLS): `removed` на місці.
   * Рядок зникає, коли його перестане тримати вигляд (оновлення складу).
   */
  remove(object: ObjectName, keys: readonly Key[]): void
  /**
   * `stale` на рядках. Знімає його підтверджений запис ключа з версією, не
   * меншою за `minVersion` (очікувана мінімальна версія із сигналу); без
   * `minVersion` — будь-який наступний підтверджений запис.
   */
  markStale(object: ObjectName, keys: readonly Key[], minVersion?: number): void
  /**
   * Втрата доступу (права, скоуп): рядки й їхні ТЧ зникають негайно з усіх
   * виглядів. Виняток безпеки з правила стабільності.
   */
  purge(object: ObjectName, keys: readonly Key[]): void
  /**
   * `needsRefresh` / `hasNewRows` на виглядах об'єкта; з `spec` — лише на
   * цьому вигляді (позначка вигляду, а не всього об'єкта).
   */
  markViews(
    object: ObjectName,
    flags: { needsRefresh?: boolean; hasNewRows?: boolean },
    spec?: ViewSpec
  ): void
}

export interface CoreSnapshot {
  readonly format: 1
  readonly subject: string
  readonly objects: Readonly<Record<ObjectName, readonly ServerRow[]>>
  readonly sections: readonly {
    readonly object: ObjectName
    readonly owner: Key
    readonly section: string
    readonly ownerVersion: number
    readonly lines: readonly SectionLine[]
  }[]
  /** Підмножини, що володіли рядками на сервері: ключ форми → ключі. */
  readonly subsets: readonly {
    readonly spec: ViewSpec
    readonly keys: readonly Key[]
    readonly atEnd?: boolean
    /** Лише `window`: ланцюжок сторінок із межами. */
    readonly window?: {
      readonly atStart: boolean
      readonly pages: readonly {
        readonly keys: readonly Key[]
        readonly lower: WindowLower
        readonly first?: Cursor
        readonly last?: Cursor
      }[]
    }
  }[]
}

/** Кортеж сортування рядка, прочитаний разом зі сторінкою, плюс ключ. */
export interface Cursor {
  readonly key: Key
  readonly values: Values
}

/**
 * Нижня межа сторінки: як її перечитати, не загубивши рядка між нею й
 * попередньою. `after` — строго після останнього рядка попередньої сторінки
 * (на мить читання); `from` — від власного першого рядка включно (попередня
 * ще невідома); `value` — `goTo`.
 */
export type WindowLower =
  | { readonly k: "start" }
  | { readonly k: "after"; readonly c: Cursor }
  | { readonly k: "from"; readonly c: Cursor }
  | { readonly k: "value"; readonly v: unknown }

export interface CoreSession {
  readonly subject: string
  readonly closed: boolean
  /** Обривається з `dispose()`; передається в кожен запит джерела. */
  readonly signal: AbortSignal
  /** Закрити: жоден запис, відповідь чи слухач після цього не діє. */
  dispose(reason?: unknown): void
  /** Одна пачка сповіщень на `commit`, що змінив стан. */
  subscribe(listener: () => void): () => void
  /** Чиста функція: хендл, мемоізований за канонічним ключем форми. */
  view(spec: ViewSpec): ViewHandle
  /**
   * Попереднє завантаження (loader роутера): власне утримання, яке
   * відпускає перша підписка чи строк `ttlMs` (типово 5 000). Розв'язується
   * після першого завершення завантаження; ніколи не відхиляється.
   */
  preload(spec: ViewSpec, options?: { ttlMs?: number }): Promise<void>
  begin(options?: TxOptions): Tx
  /** Повторити мутацію `failed`/`conflict` з поточної бази ключа. */
  retry(id: MutationId): Mutation | undefined
  /** Скасувати мутацію `failed`/`conflict`: показ повертається до сервера. */
  cancel(id: MutationId): void
  /** Покоління сесії (для сигналів): недійсне після `dispose()`. */
  token(): GenerationToken
  /**
   * Єдина точка змін ззовні. `false` — сесію закрито чи покоління старе;
   * тоді `fn` не викликано й нічого не змінено.
   */
  commit(fn: (writer: Writer) => void, token: GenerationToken): boolean
  /** Підтверджена версія ключа (без оптимістичного шару); `undefined` — немає. */
  confirmedVersion(object: ObjectName, key: Key): number | undefined
  /** Перечитати ключі (сигнал, перепідписка): відсутні прибираються. */
  refetchKeys(object: ObjectName, keys: readonly Key[]): Promise<void>
  /**
   * Активні вигляди об'єкта для приймача сигналів: форма (з `where`), ключі
   * складу й видимість (є підписник). Видимі — першими.
   */
  activeViews(object: ObjectName): readonly {
    readonly spec: ViewSpec
    readonly keys: readonly Key[]
    readonly visible: boolean
  }[]
  /**
   * Системне перечитування виглядів об'єкта одним `commit`: склад і
   * порядок не змінюються (не `refresh()` користувача); зниклі — `removed`.
   */
  revalidate(
    object: ObjectName,
    options?: { visibleOnly?: boolean }
  ): Promise<void>
  /** Ключі власних створень, ще не прийнятих жодною підмножиною. */
  ownCreates(object: ObjectName): readonly Key[]
  dehydrate(): CoreSnapshot
  /**
   * До першого вигляду; без сповіщень і запитів для свіжих даних: вигляд
   * тієї самої форми бере підмножину знімка в стані `ready`.
   */
  hydrate(snapshot: CoreSnapshot): void
  /**
   * Відпустити утримання знімка SSR: підмножини без підписників звільняються
   * через `releaseDelayMs`.
   */
  endHydration(): void
}
