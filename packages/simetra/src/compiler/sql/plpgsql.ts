import { loadModule, parsePlPgSQLSync } from "@libpg-query/parser"

/**
 * Тіло функції PL/pgSQL, розібране компілятором plpgsql самого Postgres.
 * Це порт Simetra: решта компілятора бачить лише ці типи, а форма вузлів
 * `PLpgSQL_*` з `@libpg-query/parser` лишається в цьому файлі.
 */
export interface PlpgsqlFunction {
  variables: PlpgsqlVariable[]
  /** Обхід дерева вглиб; кожен вираз належить найближчому оператору. */
  statements: PlpgsqlStatement[]
  /** Рядки (від `$тег$`) операторів, що виконують динамічний SQL. */
  dynamicSqlLines: number[]
}

export interface PlpgsqlVariable {
  name: string
  /** Параметри функції і службові змінні рядка не мають. */
  lineno?: number
  /** Тип у тому вигляді, як його записав автор: `app.sale.amount%TYPE`. */
  typeText?: string
  kind: "var" | "rec" | "row" | "recfield"
}

export interface PlpgsqlStatement {
  /** Суфікс назви вузла без `PLpgSQL_stmt_`; `declare` — див. `statementsOf`. */
  type: string
  lineno: number
  depth: number
  /** Лише прямі вирази оператора, без вкладених операторів. */
  expressions: PlpgsqlExpression[]
  target?: { variable: string }
}

export interface PlpgsqlExpression {
  query: string
  parseMode: number
  role: "condition" | "value" | "statement" | "assign" | "dynamic"
  /** `SELECT … INTO` і `EXECUTE … INTO`: запит без `INTO`, на його місці пробіли. */
  into?: boolean
  perform?: boolean
  lineno: number
}

export type PlpgsqlParse =
  | { ok: true; fn: PlpgsqlFunction }
  | { ok: false; message: string }
  /** Мова не plpgsql: тіла немає, нічого розбирати. */
  | { ok: true; fn: undefined }

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
    // Семантичну помилку (`RETURN QUERY` у не-SETOF функції) обгортка
    // віддає простим текстом, який сама ж марно розбирає як JSON, тож
    // `SyntaxError` не несе справжнього повідомлення. Текст помилки автора
    // тут не відновити, а компілятор не кидає на користувацькому вводі.
    return {
      ok: false,
      message:
        error instanceof SyntaxError
          ? "PL/pgSQL body does not compile"
          : `PL/pgSQL body does not compile: ${error.message}`,
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

function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Вузол розбору — об'єкт з єдиним ключем `PLpgSQL_*` і тілом вузла. */
function nodeOf(value: unknown): { kind: string; body: Json } | undefined {
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
  const statements: PlpgsqlStatement[] = []
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

function variableOf(
  datum: ReturnType<typeof nodeOf>,
  datums: ReturnType<typeof nodeOf>[]
): PlpgsqlVariable[] {
  if (datum === undefined) return []
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
 * Ім'я змінної, як його бачить автор. Безіменний рядок (ціль `INTO a, b`,
 * аргументи курсора) — службовий, імені не має, тож його назва — імена полів.
 */
function datumName(
  datum: ReturnType<typeof nodeOf>,
  datums: ReturnType<typeof nodeOf>[]
): string | undefined {
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
function targetOf(body: Json, datums: ReturnType<typeof nodeOf>[]) {
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
  datums: ReturnType<typeof nodeOf>[],
  out: PlpgsqlStatement[],
  dynamicLines: Set<number>
): void {
  const type = kind.slice(STATEMENT_PREFIX.length)
  const lineno = linenoOf(body)
  const statement: PlpgsqlStatement = { type, lineno, depth, expressions: [] }
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
): PlpgsqlExpression | undefined {
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
function declarationStatements(
  datums: ReturnType<typeof nodeOf>[]
): PlpgsqlStatement[] {
  const out: PlpgsqlStatement[] = []
  for (const datum of datums) {
    if (datum === undefined || datum.kind !== "PLpgSQL_var") continue
    const lineno = linenoOf(datum.body)
    const name = datumName(datum, datums)
    const expressions: PlpgsqlExpression[] = []
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
      depth: 1,
      expressions,
      ...(name === undefined ? {} : { target: { variable: name } }),
    })
  }
  return out
}
