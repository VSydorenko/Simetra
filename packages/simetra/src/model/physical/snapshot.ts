import type { FkAction } from "../schemas/custom-table"

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
  /** У порядку оголошення. */
  columns: PhysicalColumn[]
  primaryKey?: { name: string; columns: string[] }
  uniques: { name: string; columns: string[]; nullsNotDistinct: boolean }[]
  checks: { name: string; expression: string }[]
  foreignKeys: {
    name: string
    columns: string[]
    references: { schema: string; table: string; columns: string[] }
    onDelete: FkAction
    onUpdate: FkAction
    deferrable: "no" | "deferrable" | "initiallyDeferred"
  }[]
  indexes: {
    name: string
    unique: boolean
    method: string
    keys: ({ column: string } | { expression: string })[]
    include: string[]
    where?: string
    nullsNotDistinct: boolean
  }[]
}

export interface PhysicalColumn {
  name: string
  /** Рядок у формі `format_type()`. */
  type: string
  notNull: boolean
  default?: string
  identity?: "always" | "byDefault"
  comment?: string
  /** UUID реквізиту або логічне ім'я стандартного реквізиту. */
  origin: { elementId?: string; standard?: string }
}
