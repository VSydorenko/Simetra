import { loadModule, parsePlPgSQLSync } from "@libpg-query/parser"

/**
 * Тіло функції PL/pgSQL, розібране компілятором plpgsql самого Postgres.
 * Це порт Simetra: решта компілятора бачить лише ці типи, а форма вузлів
 * `PLpgSQL_*` з `@libpg-query/parser` лишається в цьому файлі. Типи лише для
 * читання: розбір кешується за текстом і віддається за посиланням.
 */
export interface PlpgsqlFunction {
  readonly variables: readonly PlpgsqlVariable[]
  /**
   * Спершу оператори в порядку обходу дерева вглиб, потім службові оператори
   * `declare` (значення за замовчуванням і запити курсорів). Вони стоять поза
   * порядком дерева, тож порядок тексту дає лише сортування за `lineno`.
   */
  readonly statements: readonly PlpgsqlStatement[]
  /** Рядки (від `$тег$`) операторів, що виконують динамічний SQL. */
  readonly dynamicSqlLines: readonly number[]
}

export interface PlpgsqlVariable {
  /** Ім'я, на яке може послатися автор; безіменних службових рядків тут немає. */
  readonly name: string
  /** Параметри функції і службові змінні рядка не мають. */
  readonly lineno?: number
  /** Тип у тому вигляді, як його записав автор: `app.sale.amount%TYPE`. */
  readonly typeText?: string
  readonly kind: "var" | "rec" | "row" | "recfield"
}

export interface PlpgsqlStatement {
  /**
   * Суфікс назви вузла без `PLpgSQL_stmt_`. Додатково `declare` — службовий
   * оператор, що несе вирази оголошень змінної (`default_val` і запит
   * курсора); у дереві його немає.
   */
  readonly type: string
  readonly lineno: number
  /** Глибина в дереві; у `declare` 0, бо він не вкладений в оператор. */
  readonly depth: number
  /** Лише прямі вирази оператора, без вкладених операторів. */
  readonly expressions: readonly PlpgsqlExpression[]
  /**
   * Імена, що їх оператор записує (ціль присвоювання, `INTO`, змінна циклу,
   * цілі `GET DIAGNOSTICS`); кілька — через `", "`. Ціль, записану через
   * `ALIAS`, парсер дає ім'ям справжньої змінної.
   */
  readonly target?: { readonly variable: string }
}

export interface PlpgsqlExpression {
  readonly query: string
  readonly parseMode: number
  readonly role: "condition" | "value" | "statement" | "assign" | "dynamic"
  /** `SELECT … INTO` і `EXECUTE … INTO`: запит без `INTO`, на його місці пробіли. */
  readonly into?: boolean
  readonly perform?: boolean
  readonly lineno: number
}

/**
 * Результат розбору. Парсер викликають лише для `LANGUAGE plpgsql`: рядкове
 * тіло іншої мови дає `fn: undefined`, але SQL-стандартне тіло
 * (`LANGUAGE sql … BEGIN ATOMIC`) валить WASM-виклик, і це `ok: false`. Мову
 * перевіряє виклик за деревом `CREATE FUNCTION`, а не за текстом помилки.
 */
export type PlpgsqlParse =
  | { readonly ok: true; readonly fn: PlpgsqlFunction }
  | { readonly ok: false; readonly message: string }
  /** Мова не plpgsql: тіла немає, нічого розбирати. */
  | { readonly ok: true; readonly fn: undefined }

/** Приймає `CREATE FUNCTION` лише з `LANGUAGE plpgsql`, див. `PlpgsqlParse`. */
export type PlpgsqlParser = (createFunctionSql: string) => PlpgsqlParse

let parser: Promise<PlpgsqlParser> | undefined

/**
 * Один `loadModule()` на процес (ініціалізація WASM дорога), як у
 * `loadSqlParser`. Результати кешуються за текстом: оболонку функції
 * перевіряють кілька стадій, а розбір тіла дорожчий за пошук у `Map`.
 */
export function loadPlpgsqlParser(): Promise<PlpgsqlParser> {
  parser ??= loadModule().then(
    () => {
      const cache = new Map<string, PlpgsqlParse>()
      return (sql: string) => {
        let result = cache.get(sql)
        if (result === undefined) {
          result = parseFunction(sql)
          cache.set(sql, result)
        }
        return result
      }
    },
    (error: unknown) => {
      // Невдале завантаження не кешуємо: наступний виклик спробує знову.
      parser = undefined
      throw error
    }
  )
  return parser
}

function parseFunction(sql: string): PlpgsqlParse {
  let raw: unknown
  try {
    raw = parsePlPgSQLSync(sql)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    // Правдивий текст є лише в синтаксичній помилці Postgres: обгортка кидає її
    // звичайним `Error`. Семантичну помилку вона віддає простим текстом, який
    // сама ж марно розбирає як JSON, тож `SyntaxError` справжнього
    // повідомлення не несе, а збій WASM (`RuntimeError`) — внутрішній текст
    // рушія, незрозумілий авторові. Компілятор не кидає на користувацькому
    // вводі.
    return {
      ok: false,
      message:
        error.constructor === Error
          ? `PL/pgSQL body does not compile: ${error.message}`
          : "PL/pgSQL body does not compile",
    }
  }
  const funcs = asArray(asRecord(raw)?.plpgsql_funcs)
  const body = asRecord(asRecord(funcs[0])?.PLpgSQL_function)
  const action = asRecord(body?.action)
  // Для `LANGUAGE sql` (і не-функцій) повертається запис без `action`.
  if (body === undefined || action === undefined) {
    return { ok: true, fn: undefined }
  }
  return { ok: true, fn: readFunction(body, action) }
}

type Json = Record<string, unknown>
/** Розбір збирає результат змінюваним, а назовні віддає лише для читання. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type StatementDraft = Mutable<Omit<PlpgsqlStatement, "expressions">> & {
  expressions: Mutable<PlpgsqlExpression>[]
}
/** Вузол розбору: ключ `PLpgSQL_*` і тіло. */
interface ParseNode {
  kind: string
  body: Json
}
/** Елемент списку змінних; порожній, якщо вузол не розпізнано. */
type Datum = ParseNode | undefined

function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Вузол розбору — об'єкт з єдиним ключем `PLpgSQL_*` і тілом вузла. */
function nodeOf(value: unknown): ParseNode | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const kind = Object.keys(record)[0]
  const body = kind === undefined ? undefined : asRecord(record[kind])
  return kind === undefined || body === undefined ? undefined : { kind, body }
}

const STATEMENT_PREFIX = "PLpgSQL_stmt_"

/** Вузли, що описують змінні й типи, а не вкладають оператори чи вирази. */
const DATUM_NODES = new Set([
  "PLpgSQL_var",
  "PLpgSQL_rec",
  "PLpgSQL_row",
  "PLpgSQL_recfield",
  "PLpgSQL_type",
  "PLpgSQL_diag_item",
  "PLpgSQL_condition",
])

/** Парсер Postgres не ставить 0-й рядок: його відсутність — це 0. */
function linenoOf(body: Json, fallback = 0): number {
  return typeof body.lineno === "number" ? body.lineno : fallback
}

function readFunction(body: Json, action: Json): PlpgsqlFunction {
  const datums = asArray(body.datums).map(nodeOf)
  const statements: StatementDraft[] = []
  const dynamicLines = new Set<number>()

  const root = nodeOf(action)
  if (root !== undefined) {
    walkStatement(root.kind, root.body, 0, datums, statements, dynamicLines)
  }
  for (const statement of declarationStatements(datums)) {
    statements.push(statement)
  }

  return {
    variables: datums.flatMap((datum) => variableOf(datum, datums)),
    statements,
    dynamicSqlLines: [...dynamicLines].sort((a, b) => a - b),
  }
}

function variableOf(datum: Datum, datums: Datum[]): PlpgsqlVariable[] {
  // Безіменний рядок (ціль `INTO a, b`, аргументи курсора) — службовий:
  // послатися на нього з тексту не можна, тож змінною він не є.
  if (datum === undefined || datum.body.refname === UNNAMED_ROW) return []
  const lineno =
    typeof datum.body.lineno === "number" ? datum.body.lineno : undefined
  const withLine = (v: PlpgsqlVariable): PlpgsqlVariable[] => [
    lineno === undefined ? v : { ...v, lineno },
  ]
  const name = datumName(datum, datums)
  if (name === undefined) return []
  switch (datum.kind) {
    case "PLpgSQL_var": {
      const typname = asRecord(
        asRecord(datum.body.datatype)?.PLpgSQL_type
      )?.typname
      return withLine({
        name,
        kind: "var",
        ...(typeof typname === "string" ? { typeText: typname.trim() } : {}),
      })
    }
    case "PLpgSQL_rec":
      return withLine({ name, kind: "rec" })
    case "PLpgSQL_row":
      return withLine({ name, kind: "row" })
    case "PLpgSQL_recfield":
      return withLine({ name, kind: "recfield" })
    default:
      return []
  }
}

const UNNAMED_ROW = "(unnamed row)"

/**
 * Ім'я змінної, як його бачить автор: `refname`, а для поля запису —
 * `запис.поле`. Для безіменного рядка повертає службову назву `(unnamed row)`;
 * `variableOf` такі рядки відкидає, а `targetOf` підставляє імена полів.
 */
function datumName(datum: Datum, datums: Datum[]): string | undefined {
  if (datum === undefined) return undefined
  const { kind, body } = datum
  if (kind === "PLpgSQL_recfield") {
    const parent = datums[Number(body.recparentno)]
    const parentName =
      parent === undefined ? undefined : datumName(parent, datums)
    return typeof body.fieldname === "string" && parentName !== undefined
      ? `${parentName}.${body.fieldname}`
      : undefined
  }
  if (typeof body.refname !== "string") return undefined
  return body.refname
}

/** Імена, що їх оператор записує: цілі присвоювання, `INTO`, змінна циклу. */
function targetOf(body: Json, datums: Datum[]) {
  if (Array.isArray(body.diag_items)) {
    // `GET DIAGNOSTICS a = ROW_COUNT, NEW.x = …`: цілі лежать в елементах.
    const names = body.diag_items
      .map((item) => {
        const target = nodeOf(item)?.body.target
        return typeof target === "number"
          ? datumName(datums[target], datums)
          : undefined
      })
      .filter((name): name is string => name !== undefined)
    return names.length === 0 ? undefined : { variable: names.join(", ") }
  }
  const direct = nodeOf(body.target) ?? nodeOf(body.var)
  const datum =
    direct ?? (typeof body.varno === "number" ? datums[body.varno] : undefined)
  if (datum === undefined) return undefined
  if (datum.kind === "PLpgSQL_row" && datum.body.refname === UNNAMED_ROW) {
    const names = asArray(datum.body.fields)
      .map((field) => asRecord(field)?.name)
      .filter((name): name is string => typeof name === "string")
    return names.length === 0 ? undefined : { variable: names.join(", ") }
  }
  const variable = datumName(datum, datums)
  return variable === undefined ? undefined : { variable }
}

function walkStatement(
  kind: string,
  body: Json,
  depth: number,
  datums: Datum[],
  out: StatementDraft[],
  dynamicLines: Set<number>
): void {
  const type = kind.slice(STATEMENT_PREFIX.length)
  const lineno = linenoOf(body)
  const statement: StatementDraft = { type, lineno, depth, expressions: [] }
  const target = targetOf(body, datums)
  if (target !== undefined) statement.target = target
  out.push(statement)

  const visit = (
    field: string,
    value: unknown,
    owner: string,
    line: number
  ) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(field, item, owner, line)
      return
    }
    const node = nodeOf(value)
    if (node === undefined) return
    if (node.kind === "PLpgSQL_expr") {
      const expression = expressionOf(node.body, owner, field, type, line)
      if (expression === undefined) return
      if (type === "perform") expression.perform = true
      if (
        body.into === true &&
        (field === "sqlstmt" || (type === "dynexecute" && field === "query"))
      ) {
        expression.into = true
      }
      if (expression.role === "dynamic") dynamicLines.add(line)
      statement.expressions.push(expression)
    } else if (node.kind.startsWith(STATEMENT_PREFIX)) {
      walkStatement(node.kind, node.body, depth + 1, datums, out, dynamicLines)
    } else if (!DATUM_NODES.has(node.kind)) {
      // Обгортки (`PLpgSQL_if_elsif`, `PLpgSQL_case_when`, блок винятків):
      // їхні вирази належать оператору-власнику, а рядок — обгортці.
      const wrapperLine = linenoOf(node.body, line)
      for (const [key, inner] of Object.entries(node.body)) {
        visit(key, inner, node.kind, wrapperLine)
      }
    }
  }

  for (const [field, value] of Object.entries(body)) {
    visit(field, value, kind, lineno)
  }
  // Порядок тексту всередині оператора: `ELSIF` стоїть у дереві перед своїм
  // тілом, але в тексті — після `THEN`. Сортування стабільне.
  statement.expressions.sort((a, b) => a.lineno - b.lineno)
}

function expressionOf(
  body: Json,
  owner: string,
  field: string,
  statementType: string,
  lineno: number
): Mutable<PlpgsqlExpression> | undefined {
  if (typeof body.query !== "string") return undefined
  const parseMode = typeof body.parseMode === "number" ? body.parseMode : 0
  return {
    query: body.query,
    parseMode,
    role: roleOf(parseMode, owner, field, statementType),
    lineno,
  }
}

/**
 * Роль виразу. Режим розбору Postgres розрізняє присвоювання (3..5) і оператор
 * SQL (0); решту виразів розрізняє поле: умова, текст динамічного запиту чи
 * значення.
 */
function roleOf(
  parseMode: number,
  owner: string,
  field: string,
  statementType: string
): PlpgsqlExpression["role"] {
  if (parseMode >= 3) return "assign"
  if (
    field === "dynquery" ||
    (field === "query" &&
      (statementType === "dynexecute" || statementType === "dynfors"))
  ) {
    return "dynamic"
  }
  if (field === "cond" || (owner === "PLpgSQL_case_when" && field === "expr")) {
    return "condition"
  }
  return parseMode === 0 ? "statement" : "value"
}

/**
 * Значення за замовчуванням змінних (`n int := (SELECT … FROM t)`) і запити
 * явних курсорів живуть у списку змінних, а не в операторах, але читають
 * таблиці так само. Вони повертаються службовими операторами `declare`
 * наприкінці списку, щоб споживачі виразів не пропустили їх.
 */
function declarationStatements(datums: Datum[]): StatementDraft[] {
  const out: StatementDraft[] = []
  for (const datum of datums) {
    if (datum === undefined || datum.kind !== "PLpgSQL_var") continue
    const lineno = linenoOf(datum.body)
    const name = datumName(datum, datums)
    const expressions: Mutable<PlpgsqlExpression>[] = []
    for (const field of ["default_val", "cursor_explicit_expr"]) {
      const node = nodeOf(datum.body[field])
      if (node === undefined) continue
      const expression = expressionOf(
        node.body,
        datum.kind,
        field,
        "declare",
        lineno
      )
      if (expression !== undefined) expressions.push(expression)
    }
    if (expressions.length === 0) continue
    out.push({
      type: "declare",
      lineno,
      depth: 0,
      expressions,
      ...(name === undefined ? {} : { target: { variable: name } }),
    })
  }
  return out
}
