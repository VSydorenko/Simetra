import type { RuleCode, Severity } from "simetra/compiler"
import type { CatalogModel, DatabaseProvider } from "simetra/model"

/** Адреса бази; пул і його життя — справа адаптера. */
export interface DbConnection {
  url: string
}

/**
 * Де будувати тінь. Без `shadowBase` тінь co-located із ціллю (платформна
 * спека §6.2): той самий кластер, ті самі ролі й розширення. `shadowBase` —
 * інший сервер тієї самої мажорної версії: адміністративна сесія з правом
 * `CREATE DATABASE`, якої в цілі може не бути.
 */
export interface ShadowOptions {
  target: DbConnection
  shadowBase?: DbConnection
}

/**
 * Межа керування (платформна спека §6.9): керовані схеми застосунку цілком
 * плюс об'єкти застосунку в чужих схемах за пресетом провайдера. Внутрішні
 * об'єкти провайдера й некеровані схеми — поза межею.
 */
export interface EngineScope {
  /** Схеми застосунку, якими порт керує цілком, зокрема їхні гранти й типові привілеї. */
  schemas: readonly string[]
  /** Пресет «об'єкти застосунку в чужих схемах» (§6.9). */
  provider: DatabaseProvider
}

/** Двигун і його версія: модель каталогу й план мають сенс лише разом із ними. */
export interface EngineIdentity {
  name: string
  version: string
}

/** Не плутати з локальним `QualifiedTable` у `compiler/operations/promote/gates.ts`: той не експортується. */
export interface LockedTable {
  schema: string
  name: string
}

/**
 * Структурна адреса знищуваного об'єкта: з StableId двигуна, а не з його
 * рядкової форми, яка неоднозначна для імен із крапкою. `table` — лише для
 * підоб'єктів таблиці (колонка, обмеження, тригер тощо).
 */
export interface EngineObjectRef {
  kind: string
  schema: string
  table?: string
  name: string
}

export interface EngineDiagnostic {
  code: RuleCode
  severity: Severity
  message: string
  /** Ідентичність об'єкта двигуна, якого стосується діагностика. */
  object?: string
  /**
   * Параметри тексту з `MESSAGES`: `message` — англійською, а інші мови
   * адаптер будує з коду й параметрів, як для діагностик компілятора.
   */
  params: Record<string, string | number>
  /**
   * Власний код двигуна (`unmodeled_drift`, `unmodeled_kind`, …): гейти й
   * перепис класів розпізнають його за полем, а не розбором тексту.
   */
  engineCode?: string
}

/**
 * Непрозорий каталог двигуна для `plan`: його вміст (факти й розв'язані опції
 * профілю) за межу порту не виходить, назовні — лише модель каталогу.
 */
export interface EngineCatalog {
  readonly engine: string
}

export interface Extracted {
  model: CatalogModel
  catalog: EngineCatalog
  diagnostics: EngineDiagnostic[]
  /**
   * Ідентичності одиниць незаповнених матеріалізованих подань. Стан
   * заповнення — не форма об'єкта, тож модель каталогу його не несе, а двигун
   * не бачить; звірка порівнює його між базою й тінню.
   */
  unpopulated: string[]
}

/** Дієслова дії плану: зі списку їх бере й схема артефакту плану. */
export const ENGINE_ACTION_VERBS = ["create", "alter", "drop"] as const

/** Тризначна: потоку П3 потрібна межа коміту після дії, а не лише «так/ні». */
export const ENGINE_TRANSACTIONALITIES = [
  "transactional",
  "nonTransactional",
  "commitBoundaryAfter",
] as const

/** Налаштування сесії, яке виконавець плану виставляє перед діями сегмента. */
export interface EngineSetting {
  name: string
  value: string
}

/**
 * Дозволена преамбула плану: ім'я — значення. Будь-що інше в преамбулі
 * двигуна — діагностика `engine.preamble-unknown`, а не тихе виконання.
 * Перелік належить порту: його перевіряють і адаптер, і раннер. Раннер 2a
 * преамбулу лише перевіряє за переліком, а не виконує: пара неподільна, і
 * П3-2b виконує її разом із ревалідацією тіл (R22 плану П3-2a).
 */
export const ENGINE_PREAMBLE_ALLOWED: Readonly<Record<string, string>> = {
  search_path: "pg_catalog",
  check_function_bodies: "off",
}

/**
 * Дія плану у формі порту. Ціль дії видно лише разом із `consumes`: GRANT,
 * `ENABLE RLS`, `REPLICA IDENTITY` тощо не мають ні `produces`, ні `destroys`.
 */
export interface EngineAction {
  sql: string
  verb: (typeof ENGINE_ACTION_VERBS)[number]
  /** Ідентичності об'єктів у рядковій формі StableId двигуна. */
  produces: string[]
  consumes: string[]
  destroys: string[]
  /**
   * Створювані об'єкти структурно (з `produces`), за тим самим правилом, що
   * й `destroyed`: слід кроку (FK, який він створює) T2 розпізнає без
   * відтворення рядкової форми ідентичності двигуна.
   */
  produced: EngineObjectRef[]
  /**
   * Знищувані об'єкти структурно (з `destroys`): за ними розпізнають, що план
   * губить, без розбору рядкових ідентичностей. Об'єкти без схеми й імені
   * (ролі, членства, гранти) сюди не входять.
   */
  destroyed: EngineObjectRef[]
  /**
   * Вжиті об'єкти структурно (з `consumes`), за тим самим правилом, що й
   * `destroyed`: на чому дія несе `dataLoss`, T2 розпізнає без відтворення
   * рядкової форми ідентичності двигуна.
   */
  consumed: EngineObjectRef[]
  transactionality: (typeof ENGINE_TRANSACTIONALITIES)[number]
  /**
   * Дія вживає результат попередньої `commitBoundaryAfter` (нове значення
   * енаму): між ними потрібен `COMMIT`, тож в одній транзакції її не виконати.
   */
  newSegmentBefore: boolean
  /**
   * Наявні таблиці (`relkind` r/p) вихідного стану цього плану, які дія
   * блокує: сама таблиця чи батьківська таблиця підоб'єкта (column, default,
   * constraint, trigger, policy, rule). Батько-домен, стороння таблиця й
   * таблиця, яку створює сам план, сюди не входять. Знання про `relkind` — в
   * адаптері; раннер блокує список як є.
   */
  lockedTables: LockedTable[]
  /**
   * Найсильніший режим, який дія бере на `lockedTables` (`none`,
   * `shareUpdateExclusive`, `share`, `shareRowExclusive`,
   * `accessExclusive`). Наслідки на інших таблицях (ціль FK, таблиці, що
   * посилаються) виводить T2 зі сліду кроку.
   */
  lockClass: string
  dataLoss: boolean
  rewriteRisk: boolean
}

export interface EnginePlan {
  actions: EngineAction[]
  empty: boolean
  /** Преамбула двигуна, як є; допустимість рахує `ENGINE_PREAMBLE_ALLOWED`. */
  preamble: EngineSetting[]
  /** Діагностики самого плану (зокрема `engine.preamble-unknown`). */
  diagnostics: EngineDiagnostic[]
}

export type ShadowOutcome<T> =
  | { status: "loaded"; value: T; diagnostics: EngineDiagnostic[] }
  | { status: "shadow-failed"; diagnostics: EngineDiagnostic[] }

export interface SchemaEngine {
  readonly identity: EngineIdentity
  extract(db: DbConnection, scope: EngineScope): Promise<Extracted>
  /**
   * Чисто, без бази: обидва каталоги несуть усе, що потрібно двигуну. Опції
   * плану (роль, можливості, профіль) беруться з `source`, а з `optionsFrom` —
   * якщо задано: план часто будують між двома копіями, а застосовують до
   * третьої бази, і саме її роль визначає, що двигун має право планувати.
   */
  plan(
    source: EngineCatalog,
    target: EngineCatalog,
    scope: EngineScope,
    o?: { optionsFrom?: EngineCatalog }
  ): EnginePlan
  /**
   * Створює тінь поруч із `target` (або на `shadowBase` тієї самої мажорної
   * версії — розбіжність є винятком, не результатом), засіває її базовим станом провайдера й
   * завантажує `desiredSql`; `plan` у колбеку — «ціль → тінь».
   * Діагностики двигуна щодо завантаження, цілі й плану (зокрема
   * `unmodeled_drift`: оператор плану впаде на цілі) — у результаті.
   * `unmodeled_kind` двигуна відфільтровано, коли його клас уже назвав
   * помилкою перепис тієї бази, з якої прийшла діагностика (дрейф і план —
   * перепис цілі чи тіні): один об'єкт не звучить двічі, а клас, якого
   * перепис не рахує, лишається попередженням. Тінь прибирається завжди,
   * зокрема при помилці; порожньої тіні порт не дає.
   */
  withDesiredShadow<T>(
    o: ShadowOptions,
    desiredSql: string,
    scope: EngineScope,
    fn: (shadow: DbConnection, plan: EnginePlan) => Promise<T>
  ): Promise<ShadowOutcome<T>>
  /**
   * Жертовна копія поточного стану цілі в межі: друга co-located тінь (або на
   * shadowBase), засіяна базовим станом провайдера; стан цілі відтворено
   * планом двигуна. Точність копії перевіряє викликач. Тінь прибирається завжди.
   */
  withTargetClone<T>(
    o: ShadowOptions,
    target: Extracted,
    scope: EngineScope,
    fn: (clone: DbConnection) => Promise<T>
  ): Promise<ShadowOutcome<T>>
}
