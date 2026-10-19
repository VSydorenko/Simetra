import type {
  Constraint,
  IndexElem,
  IndexStmt,
  Node,
  RangeVar,
  SqlParser,
} from "simetra/compiler"
import {
  quoteIdent,
  type CatalogTable,
  type PgQualifiedName,
  type PhysicalIndexKey,
} from "simetra/model"

/**
 * Розбір дефініцій, які двигун бере з `pg_get_constraintdef` і
 * `pg_get_indexdef`, у форму фізичного знімка (спека П2 §8.3). Структуру
 * читає дерево libpg-query, а текст виразу береться з дефініції дослівно:
 * парсер не має зворотного друку, а канонічну форму виразу дає сам Postgres.
 * Будь-яка частина дефініції, якої знімок не має, — `unrepresentable`, а не
 * тиха втрата.
 */

export type ConstraintDefinition =
  | { type: "primaryKey"; value: NonNullable<CatalogTable["primaryKey"]> }
  | { type: "unique"; value: CatalogTable["uniques"][number] }
  | { type: "check"; value: CatalogTable["checks"][number] }
  | { type: "foreignKey"; value: CatalogTable["foreignKeys"][number] }
  | { type: "unrepresentable"; reason: string }

/**
 * Індекс може мати параметри, яких знімок не виражає (`WITH (...)`,
 * табличний простір), тож розбір теж повертає `unrepresentable`.
 */
export type IndexDefinition =
  | { type: "index"; value: CatalogTable["indexes"][number] }
  | { type: "unrepresentable"; reason: string }

type Unrepresentable = { type: "unrepresentable"; reason: string }

const unrepresentable = (reason: string): Unrepresentable => ({
  type: "unrepresentable",
  reason,
})

type FkAction = CatalogTable["foreignKeys"][number]["onDelete"]

/** Коди дій FK у дереві розбору (`fk_upd_action`/`fk_del_action`). */
const FK_ACTIONS: Readonly<Record<string, FkAction>> = {
  a: "noAction",
  r: "restrict",
  c: "cascade",
  n: "setNull",
  d: "setDefault",
}

function strings(nodes: readonly Node[] | undefined): string[] {
  return (nodes ?? []).map((n) => ("String" in n ? (n.String.sval ?? "") : ""))
}

/** Кваліфіковане ім'я у формі знімка: схема `pg_catalog` не пишеться. */
function qualifiedName(parts: readonly string[]): PgQualifiedName {
  const name = parts.at(-1) ?? ""
  const schema = parts.length > 1 ? parts.at(-2) : undefined
  return schema === undefined || schema === "pg_catalog"
    ? { name }
    : { schema, name }
}

/**
 * Позиція дужки, що закриває відкриту на `open`, з урахуванням рядків
 * (`'...'`) і ідентифікаторів у лапках (`"..."`): дужка чи кома всередині
 * них — не синтаксис.
 */
function closingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const ch = text[i]
    if (ch === "'" || ch === '"') {
      i = closingQuote(text, i)
    } else if (ch === "(") {
      depth++
    } else if (ch === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Кінець рядка чи ідентифікатора в лапках; подвоєна лапка — екранування. */
function closingQuote(text: string, start: number): number {
  const quote = text[start]
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== quote) continue
    if (text[i + 1] === quote) {
      i++
      continue
    }
    return i
  }
  return text.length
}

/** Перша позиція `needle` на верхньому рівні: поза дужками й лапками. */
function topLevelIndexOf(text: string, needle: string, from = 0): number {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (depth === 0 && text.startsWith(needle, i)) return i
    if (ch === "'" || ch === '"') i = closingQuote(text, i)
    else if (ch === "(") depth++
    else if (ch === ")") depth--
  }
  return -1
}

/** Частини списку через кому верхнього рівня. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let start = 0
  let comma = topLevelIndexOf(text, ",")
  while (comma !== -1) {
    parts.push(text.slice(start, comma).trim())
    start = comma + 1
    comma = topLevelIndexOf(text, ",", start)
  }
  parts.push(text.slice(start).trim())
  return parts
}

/** Знімає одну пару дужок, що охоплює весь текст (дужки граматики, не виразу). */
function unwrap(text: string): string {
  const trimmed = text.trim()
  return trimmed.startsWith("(") &&
    closingParen(trimmed, 0) === trimmed.length - 1
    ? trimmed.slice(1, -1).trim()
    : trimmed
}

function parseSingle(parse: SqlParser, sql: string): Node | string {
  const parsed = parse(sql)
  if (!parsed.ok) return `definition does not parse: ${parsed.message}`
  const [statement, ...rest] = parsed.statements
  if (statement === undefined || rest.length > 0)
    return "definition is not a single statement"
  return statement.stmt
}

function deferrableOf(
  constraint: Constraint
): "deferrable" | "initiallyDeferred" | undefined {
  if (constraint.initdeferred === true) return "initiallyDeferred"
  if (constraint.deferrable === true) return "deferrable"
  return undefined
}

/**
 * Обмеження таблиці з `pg_get_constraintdef`: дефініцію розібрано як
 * `ALTER TABLE … ADD CONSTRAINT`, бо саме в цій граматиці вона валідна.
 * Типові значення Postgres не пишуться: `deferrable` PK і UNIQUE відсутнє для
 * «no», а FK пише `"no"` (форма знімка).
 */
export function parseConstraintDefinition(
  parse: SqlParser,
  table: { schema: string; name: string },
  name: string,
  def: string
): ConstraintDefinition {
  const stmt = parseSingle(
    parse,
    `ALTER TABLE ${quoteIdent(table.schema)}.${quoteIdent(table.name)} ADD CONSTRAINT ${quoteIdent(name)} ${def}`
  )
  if (typeof stmt === "string") return unrepresentable(stmt)
  const cmd =
    "AlterTableStmt" in stmt ? stmt.AlterTableStmt.cmds?.[0] : undefined
  const node =
    cmd !== undefined && "AlterTableCmd" in cmd
      ? cmd.AlterTableCmd.def
      : undefined
  if (node === undefined || !("Constraint" in node))
    return unrepresentable("definition is not a table constraint")
  const c = node.Constraint
  if (c.skip_validation === true)
    return unrepresentable("constraint is NOT VALID")
  if (c.is_no_inherit === true)
    return unrepresentable("constraint is NO INHERIT")
  if ((c.including ?? []).length > 0)
    return unrepresentable("constraint index has INCLUDE columns")
  if ((c.options ?? []).length > 0 || c.indexspace !== undefined)
    return unrepresentable("constraint index has storage parameters")
  const deferrable = deferrableOf(c)
  switch (c.contype) {
    case "CONSTR_PRIMARY":
      return {
        type: "primaryKey",
        value: {
          name,
          columns: strings(c.keys),
          ...(deferrable === undefined ? {} : { deferrable }),
        },
      }
    case "CONSTR_UNIQUE":
      return {
        type: "unique",
        value: {
          name,
          columns: strings(c.keys),
          nullsNotDistinct: c.nulls_not_distinct === true,
          ...(deferrable === undefined ? {} : { deferrable }),
        },
      }
    case "CONSTR_CHECK":
      return checkOf(name, def)
    case "CONSTR_FOREIGN":
      return foreignKeyOf(name, c, deferrable)
    default:
      return unrepresentable(
        `constraint type ${(c.contype ?? "unknown").replace(/^CONSTR_/, "").toLowerCase()} has no field in the catalog model`
      )
  }
}

/** Вираз CHECK без обгортки `CHECK (...)` — як його друкує Postgres. */
function checkOf(name: string, def: string): ConstraintDefinition {
  const prefix = "CHECK ("
  if (
    !def.startsWith(prefix) ||
    closingParen(def, prefix.length - 1) !== def.length - 1
  )
    return unrepresentable("check definition has an unexpected form")
  return {
    type: "check",
    value: { name, expression: def.slice(prefix.length, -1) },
  }
}

function foreignKeyOf(
  name: string,
  c: Constraint,
  deferrable: "deferrable" | "initiallyDeferred" | undefined
): ConstraintDefinition {
  if (c.fk_matchtype !== undefined && c.fk_matchtype !== "s")
    return unrepresentable("foreign key has a MATCH type other than SIMPLE")
  if ((c.fk_del_set_cols ?? []).length > 0)
    return unrepresentable("foreign key ON DELETE action names a column list")
  const target: RangeVar | undefined = c.pktable
  // Двигун читає дефініції з порожнім `search_path`, тож ціль поза
  // `pg_catalog` завжди кваліфікована; без схеми — не вгадуємо
  if (target?.schemaname === undefined || target.relname === undefined)
    return unrepresentable("foreign key target has no schema")
  const onDelete = FK_ACTIONS[c.fk_del_action ?? "a"]
  const onUpdate = FK_ACTIONS[c.fk_upd_action ?? "a"]
  if (onDelete === undefined || onUpdate === undefined)
    return unrepresentable("foreign key has an unknown referential action")
  return {
    type: "foreignKey",
    value: {
      name,
      columns: strings(c.fk_attrs),
      references: {
        schema: target.schemaname,
        table: target.relname,
        columns: strings(c.pk_attrs),
      },
      onDelete,
      onUpdate,
      deferrable: deferrable ?? "no",
    },
  }
}

/** Регулярні вирази хвоста ключа: ім'я, можливо кваліфіковане й у лапках. */
const IDENT = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)`
const QUALIFIED = String.raw`${IDENT}(?:\.${IDENT})?`
const NULLS_TAIL = /\s+NULLS\s+(?:FIRST|LAST)$/
const ORDER_TAIL = /\s+(?:ASC|DESC)$/
const OPCLASS_TAIL = new RegExp(String.raw`\s+${QUALIFIED}$`)
const COLLATE_TAIL = new RegExp(String.raw`\s+COLLATE\s+${QUALIFIED}$`)

/**
 * Ключ індексу у формі знімка. Значення Postgres за замовчуванням не
 * пишуться: `ASC`, а також `NULLS LAST` для `ASC` і `NULLS FIRST` для `DESC`.
 */
function indexKey(
  elem: IndexElem,
  text: string
): PhysicalIndexKey | Unrepresentable {
  if ((elem.opclassopts ?? []).length > 0)
    return unrepresentable("index key has operator class options")
  const desc = elem.ordering === "SORTBY_DESC"
  const nulls =
    elem.nulls_ordering === "SORTBY_NULLS_FIRST" && !desc
      ? ("first" as const)
      : elem.nulls_ordering === "SORTBY_NULLS_LAST" && desc
        ? ("last" as const)
        : undefined
  const opclass = strings(elem.opclass)
  const collation = strings(elem.collation)
  const modifiers = {
    ...(desc ? { order: "desc" as const } : {}),
    ...(nulls === undefined ? {} : { nulls }),
    ...(opclass.length > 0 ? { opclass: qualifiedName(opclass) } : {}),
    ...(collation.length > 0 ? { collation: qualifiedName(collation) } : {}),
  }
  if (elem.name !== undefined) return { column: elem.name, ...modifiers }
  // Хвіст ключа знімається в порядку, зворотному до друку `pg_get_indexdef`:
  // `<вираз> [COLLATE c] [opclass] [ASC|DESC] [NULLS FIRST|LAST]`
  let expression = text.replace(NULLS_TAIL, "").replace(ORDER_TAIL, "")
  if (opclass.length > 0) expression = expression.replace(OPCLASS_TAIL, "")
  if (collation.length > 0) expression = expression.replace(COLLATE_TAIL, "")
  return { expression: unwrap(expression), ...modifiers }
}

/**
 * Індекс із повного `CREATE INDEX` двигуна. Індекси первинних ключів і
 * UNIQUE-обмежень окремих фактів не мають, тож сюди не потрапляють.
 */
export function parseIndexDefinition(
  parse: SqlParser,
  def: string
): IndexDefinition {
  const stmt = parseSingle(parse, def)
  if (typeof stmt === "string") return unrepresentable(stmt)
  if (!("IndexStmt" in stmt))
    return unrepresentable("definition is not CREATE INDEX")
  const index: IndexStmt = stmt.IndexStmt
  if ((index.options ?? []).length > 0)
    return unrepresentable("index has storage parameters")
  if (index.tableSpace !== undefined)
    return unrepresentable("index has a tablespace")
  // libpg-query не пише `inh`, коли воно false, тож `ON ONLY` — це відсутнє поле
  if (index.relation?.inh !== true)
    return unrepresentable("index is defined on ONLY the parent table")
  const elems = (index.indexParams ?? []).map((p) =>
    "IndexElem" in p ? p.IndexElem : undefined
  )
  // Текст ключів — перший список у дужках верхнього рівня: ім'я індексу й
  // таблиці в лапках можуть містити дужки, тож пошук пропускає лапки
  const open = topLevelIndexOf(def, "(")
  const close = open === -1 ? -1 : closingParen(def, open)
  const texts = close === -1 ? [] : splitTopLevel(def.slice(open + 1, close))
  if (texts.length !== elems.length)
    return unrepresentable("index keys could not be read from the definition")
  const keys: PhysicalIndexKey[] = []
  for (const [i, elem] of elems.entries()) {
    if (elem === undefined)
      return unrepresentable("index key is not an element")
    const key = indexKey(elem, texts[i]!)
    if ("type" in key) return key
    keys.push(key)
  }
  const include = (index.indexIncludingParams ?? []).map((p) =>
    "IndexElem" in p ? (p.IndexElem.name ?? "") : ""
  )
  const where = topLevelIndexOf(def, " WHERE ", close + 1)
  if (index.whereClause !== undefined && where === -1)
    return unrepresentable(
      "index predicate could not be read from the definition"
    )
  return {
    type: "index",
    value: {
      name: index.idxname ?? "",
      unique: index.unique === true,
      method: index.accessMethod ?? "",
      keys,
      include,
      ...(index.whereClause === undefined
        ? {}
        : { where: unwrap(def.slice(where + " WHERE ".length)) }),
      nullsNotDistinct: index.nulls_not_distinct === true,
    },
  }
}
