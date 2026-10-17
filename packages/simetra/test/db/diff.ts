import type {
  CatalogColumn,
  CatalogConstraint,
  CatalogEnumType,
  CatalogIndex,
  CatalogShape,
  CatalogTable,
} from "./catalog"

/**
 * Класи об'єктів, які рендерить П2 і порівнює паперовий тест (спека П2
 * §10.2). Коментар — властивість свого об'єкта, а не окремий клас: план двигуна
 * міняє його разом з об'єктом.
 */
export type CatalogDiffClass =
  "table" | "column" | "constraint" | "index" | "enumType"

export interface CatalogDiffEntry {
  op: "add" | "drop" | "alter"
  class: CatalogDiffClass
  /** Таблиця об'єкта; в енам-типу — порожньо (він не належить таблиці). */
  table: string
  name: string
  /** `add`/`drop` — форма об'єкта; `alter` — відмінні властивості. */
  detail: string
}

export type CatalogDiff = CatalogDiffEntry[]

const CLASS_ORDER: CatalogDiffClass[] = [
  "table",
  "column",
  "constraint",
  "index",
  "enumType",
]

const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

function columnForm(column: CatalogColumn): string {
  return [
    column.type,
    column.notNull ? "NOT NULL" : "NULL",
    column.default === undefined ? undefined : `DEFAULT ${column.default}`,
    column.generated === undefined
      ? undefined
      : `GENERATED ALWAYS AS ${column.generated.expression} STORED`,
    column.identity === undefined
      ? undefined
      : `IDENTITY ${column.identity.generation}`,
    column.collation === undefined
      ? undefined
      : `COLLATE ${column.collation.schema ?? "pg_catalog"}.${column.collation.name}`,
    column.comment === undefined ? undefined : `COMMENT ${column.comment}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
}

function constraintForm(constraint: CatalogConstraint): string {
  return [
    constraint.definition,
    constraint.initiallyDeferred
      ? "DEFERRABLE INITIALLY DEFERRED"
      : constraint.deferrable
        ? "DEFERRABLE"
        : undefined,
    constraint.comment === undefined
      ? undefined
      : `COMMENT ${constraint.comment}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
}

// `pg_get_indexdef` повна: метод, ключі, порядок, `INCLUDE`, предикат, NND.
const indexForm = (index: CatalogIndex): string => index.definition

function tableForm(table: CatalogTable): string {
  return [
    `RLS ${table.rowLevelSecurity}`,
    table.comment === undefined ? undefined : `COMMENT ${table.comment}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ")
}

const enumForm = (type: CatalogEnumType): string =>
  [
    `(${type.values.join(", ")})`,
    type.comment === undefined ? undefined : `COMMENT ${type.comment}`,
  ]
    .filter((part) => part !== undefined)
    .join(" ")

/**
 * Різниця однойменних множин об'єктів: `add` — є лише у скомпільованій формі,
 * `drop` — лише в прийнятій, `alter` — форма відрізняється. Імена — справжній
 * ідентифікатор: компілятор і прийнята форма спираються на типові імена
 * Postgres, тож розбіжність імені — теж різниця, а не шум.
 */
function diffNamed<T extends { name: string }>(
  diff: CatalogDiff,
  cls: CatalogDiffClass,
  table: string,
  accepted: readonly T[],
  compiled: readonly T[],
  form: (item: T) => string
): void {
  const before = new Map(accepted.map((item) => [item.name, item]))
  const after = new Map(compiled.map((item) => [item.name, item]))
  for (const [name, item] of after) {
    const old = before.get(name)
    if (old === undefined) {
      diff.push({ op: "add", class: cls, table, name, detail: form(item) })
    } else if (form(old) !== form(item)) {
      diff.push({
        op: "alter",
        class: cls,
        table,
        name,
        detail: `${form(old)} → ${form(item)}`,
      })
    }
  }
  for (const [name, item] of before) {
    if (!after.has(name)) {
      diff.push({ op: "drop", class: cls, table, name, detail: form(item) })
    }
  }
}

function diffTableContents(
  diff: CatalogDiff,
  name: string,
  accepted: CatalogTable | undefined,
  compiled: CatalogTable | undefined
): void {
  diffNamed(
    diff,
    "column",
    name,
    accepted?.columns ?? [],
    compiled?.columns ?? [],
    columnForm
  )
  diffNamed(
    diff,
    "constraint",
    name,
    accepted?.constraints ?? [],
    compiled?.constraints ?? [],
    constraintForm
  )
  // Індекс за PK/UNIQUE — частина обмеження: план створює й видаляє його
  // разом з обмеженням, окремий рядок лише подвоїв би різницю.
  const own = (table: CatalogTable | undefined): CatalogIndex[] =>
    (table?.indexes ?? []).filter((index) => index.constraint === undefined)
  diffNamed(diff, "index", name, own(accepted), own(compiled), indexForm)
}

/** Енам-типи, на які посилаються колонки перелічених таблиць. */
function referencedEnums(
  catalog: CatalogShape,
  tables: readonly CatalogTable[]
): CatalogEnumType[] {
  const types = new Set(
    tables.flatMap((table) => table.columns.map((column) => column.type))
  )
  return catalog.enumTypes.filter(
    (type) =>
      types.has(type.name) ||
      types.has(`<schema>.${type.name}`) ||
      types.has(`${type.schema}.${type.name}`)
  )
}

/**
 * Різниця «прийнята → скомпільована» форма (спека П2 §10.2): що мав би
 * зробити план міграції, щоб прийнята форма стала скомпільованою. Лише класи,
 * які рендерить П2, і лише перелічені таблиці (імена без схеми): кожен
 * каталог прочитано зі своєї схеми, а схема в текстах уже замінена на
 * плейсхолдер, тож однакові об'єкти двох схем дають однакові форми.
 */
export function diffCatalogs(
  accepted: CatalogShape,
  compiled: CatalogShape,
  tables: string[]
): CatalogDiff {
  const diff: CatalogDiff = []
  const pick = (catalog: CatalogShape): CatalogTable[] =>
    catalog.tables.filter((table) => tables.includes(table.name))
  const acceptedTables = pick(accepted)
  const compiledTables = pick(compiled)

  diffNamed(diff, "table", "", acceptedTables, compiledTables, tableForm)
  // Рядок таблиці несе її власне ім'я в `table` — так усі різниці одного
  // об'єкта стоять поруч після сортування.
  for (const entry of diff) entry.table = entry.name

  for (const name of tables) {
    diffTableContents(
      diff,
      name,
      acceptedTables.find((table) => table.name === name),
      compiledTables.find((table) => table.name === name)
    )
  }

  diffNamed(
    diff,
    "enumType",
    "",
    referencedEnums(accepted, acceptedTables),
    referencedEnums(compiled, compiledTables),
    enumForm
  )

  return diff.sort(
    (a, b) =>
      byCodePoint(a.table, b.table) ||
      CLASS_ORDER.indexOf(a.class) - CLASS_ORDER.indexOf(b.class) ||
      byCodePoint(a.name, b.name) ||
      byCodePoint(a.op, b.op)
  )
}

/** Колонки FK чи індексу з різниці; вираз у ключі індексу — `null`. */
interface KeyShape {
  columns: (string | null)[]
  /** Ціль FK; в індексу немає. */
  target?: { table: string; columns: string[] }
}

function keyShape(
  catalog: CatalogShape,
  entry: CatalogDiffEntry
): KeyShape | undefined {
  const table = catalog.tables.find((t) => t.name === entry.table)
  if (entry.class === "index") {
    const index = table?.indexes.find((i) => i.name === entry.name)
    return index === undefined
      ? undefined
      : {
          columns: index.keys.map((key) =>
            "column" in key ? key.column : null
          ),
        }
  }
  const constraint = table?.constraints.find((c) => c.name === entry.name)
  if (constraint?.references === undefined) return undefined
  return {
    columns: constraint.columns,
    target: {
      table: constraint.references.table,
      columns: constraint.references.columns,
    },
  }
}

const sameColumns = (
  a: readonly (string | null)[],
  b: readonly (string | null)[]
): boolean =>
  a.length === b.length &&
  a.every((column, i) => column !== null && column === b[i])

/**
 * Перевіряє правило паперового тесту (спека П2 §10.2, М4): змін немає, а
 * кожне видалення — простий FK чи індекс посилання, який вид замінює складеним
 * із носієм скоупу першим на тих самих колонках. Для кожного видалення має
 * бути рівно одне таке додавання в тій самій таблиці (для FK — і на ту саму
 * ціль із носієм скоупу цілі першим), і жодне додавання не замінює двох
 * видалень. Повертає порушення текстом; порожньо — правило виконане.
 *
 * `carriers` — носій скоупу кожної таблиці скомпільованої форми (з фізичного
 * знімка), бо саме вид визначає, яка колонка несе скоуп.
 */
export function scopeReplacementViolations(
  diff: CatalogDiff,
  accepted: CatalogShape,
  compiled: CatalogShape,
  carriers: ReadonlyMap<string, string>
): string[] {
  const violations: string[] = []
  const used = new Set<CatalogDiffEntry>()
  for (const entry of diff) {
    if (entry.op === "alter") {
      violations.push(`alter ${entry.class} ${entry.table}.${entry.name}`)
    }
    if (entry.op !== "drop") continue
    const label = `drop ${entry.class} ${entry.table}.${entry.name}`
    const dropped =
      entry.class === "index" || entry.class === "constraint"
        ? keyShape(accepted, entry)
        : undefined
    const carrier = carriers.get(entry.table)
    if (dropped === undefined || carrier === undefined) {
      violations.push(`${label}: not a reference FK or index of a scoped table`)
      continue
    }
    const targetCarrier =
      dropped.target === undefined
        ? undefined
        : carriers.get(dropped.target.table)
    const matches = diff.filter((add) => {
      if (add.op !== "add" || add.class !== entry.class) return false
      if (add.table !== entry.table) return false
      const added = keyShape(compiled, add)
      if (added === undefined) return false
      if (!sameColumns(added.columns, [carrier, ...dropped.columns])) {
        return false
      }
      if (dropped.target === undefined) return added.target === undefined
      return (
        targetCarrier !== undefined &&
        added.target?.table === dropped.target.table &&
        sameColumns(added.target.columns, [
          targetCarrier,
          ...dropped.target.columns,
        ])
      )
    })
    if (matches.length !== 1) {
      violations.push(
        `${label}: ${matches.length} scope-prefixed replacements, expected 1`
      )
      continue
    }
    const match = matches[0]!
    if (used.has(match)) {
      violations.push(`${label}: replacement ${match.name} already used`)
    }
    used.add(match)
  }
  return violations
}
