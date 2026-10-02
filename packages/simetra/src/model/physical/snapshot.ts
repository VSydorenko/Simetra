import type {
  Deferrable,
  FkAction,
  PgQualifiedName,
  RowLevelSecurity,
} from "../schemas/custom-table"

/**
 * Контракт фізичного знімка (спека §8.3). Живе в T0, бо з нього будують
 * рендер, хеш і `explain`, а extract адаптера мапиться в ті самі типи.
 * Масиви `uniques`/`checks`/`foreignKeys`/`indexes` відсортовані за `name`,
 * `tables` і `enumTypes` — за `(schema, name)`: знімок детермінований, тож
 * порівняння й хеш не залежать від порядку обходу.
 */
export interface PhysicalSnapshot {
  tables: PhysicalTable[]
  enumTypes: PhysicalEnumType[]
}

/** Звідки в метаданих походить фізичний об'єкт (для `explain`). */
export interface PhysicalOrigin {
  objectId: string
  tabularSectionId?: string
  /**
   * Похідна таблиця об'єкта поруч з основною: поточні підсумки регістра або
   * його місячні обороти.
   */
  part?: "totals" | "turnoversMonth"
}

export interface PhysicalEnumType {
  schema: string
  name: string
  values: string[]
  origin: PhysicalOrigin
}

export interface PhysicalTable {
  schema: string
  name: string
  comment?: string
  origin: PhysicalOrigin
  /**
   * Похідні таблиці регістра й рядки ТЧ мають RLS власника: інакше вони
   * відкривали б дані, закриті в основній таблиці.
   */
  rowLevelSecurity: RowLevelSecurity
  /** У порядку оголошення. */
  columns: PhysicalColumn[]
  primaryKey?: {
    name: string
    columns: string[]
    deferrable?: DeferredConstraint
  }
  uniques: {
    name: string
    columns: string[]
    nullsNotDistinct: boolean
    deferrable?: DeferredConstraint
  }[]
  checks: { name: string; expression: string }[]
  foreignKeys: {
    name: string
    columns: string[]
    references: { schema: string; table: string; columns: string[] }
    onDelete: FkAction
    onUpdate: FkAction
    // FK пише й «no», а PK/UNIQUE його пропускають (`DeferredConstraint`), щоб
    // знімок і хеш таблиць видів 1С лишились тими самими; уніфікація — борг до
    // наступного прийнятого злому фізичного хешу.
    deferrable: "no" | "deferrable" | "initiallyDeferred"
  }[]
  indexes: {
    name: string
    unique: boolean
    method: string
    keys: PhysicalIndexKey[]
    include: string[]
    where?: string
    nullsNotDistinct: boolean
  }[]
}

/**
 * `DEFERRABLE` первинного ключа чи UNIQUE. Відсутнє поле — `NOT DEFERRABLE`:
 * значення «no» у знімку не пишеться, тож стан має одну форму, а таблиці
 * видів 1С (їхні ключі не відкладаються) поля не мають зовсім.
 */
export type DeferredConstraint = Exclude<Deferrable, "no">

/**
 * Елемент ключа індексу. Значення Postgres за замовчуванням (`ASC`, типове
 * розташування `NULL` для порядку) не пишуться, як у `pg_get_indexdef`: один
 * фізичний індекс — одна форма знімка.
 */
export type PhysicalIndexKey = ({ column: string } | { expression: string }) & {
  order?: "asc" | "desc"
  nulls?: "first" | "last"
  opclass?: PgQualifiedName
  collation?: PgQualifiedName
}

export interface PhysicalColumn {
  name: string
  /** Рядок у формі `format_type()`. */
  type: string
  notNull: boolean
  default?: string
  /**
   * Identity-колонка: режим і ім'я її послідовності. Ім'я обирає компілятор
   * тим самим алгоритмом, що й Postgres (`<таблиця>_<колонка>_seq` з обходом
   * зайнятих), і воно займає `pg_class` схеми поряд з таблицями й індексами.
   */
  identity?: { generation: "always" | "byDefault"; sequence: string }
  /**
   * Генерована колонка (`GENERATED ALWAYS AS (...) STORED`): значення дає
   * база, тож `default` у такої колонки немає.
   */
  generated?: { expression: string }
  /** Колляція колонки; відсутня — колляція типу. */
  collation?: PgQualifiedName
  comment?: string
  /**
   * UUID реквізиту або логічне ім'я стандартного реквізиту; `scopeKindId` —
   * у кожної колонки, що несе значення скоупу: доданої скоуп-колонки, ключа
   * кореня, `parent_id` рядка ТЧ кореня й названої в описі скоуп-колонки
   * `CustomTable` (`scopeColumn`). Остання лишається елементом опису, тож
   * несе `elementId` разом зі `scopeKindId`.
   */
  origin: { elementId?: string; standard?: string; scopeKindId?: string }
}
