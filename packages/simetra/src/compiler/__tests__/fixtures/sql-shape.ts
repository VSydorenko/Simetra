import { loadSqlParser, type SqlParser } from "../../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../../sql/plpgsql"
import { withoutLocations } from "../../sql/units"

/**
 * Форма згенерованого SQL для тестів генераторів тригерних функцій: дерево
 * оператора й тіло plpgsql як дерево операторів. Парсери вантажить
 * `loadShapeParsers()` у `beforeAll`.
 */
let parse: SqlParser | undefined
let plpgsql: PlpgsqlParser | undefined

export async function loadShapeParsers(): Promise<void> {
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
}

export function tree(sql: string): unknown {
  const parsed = parse!(sql)
  if (!parsed.ok || parsed.statements.length !== 1)
    throw new Error(`does not parse: ${sql}`)
  return withoutLocations(parsed.statements[0]!.stmt)
}

/**
 * Тіло plpgsql як дерево операторів: вид, глибина, ціль, `RETURN` і дерево
 * розбору кожного виразу — форматування не впливає, а кожен запит
 * порівнюється цілим (зокрема `FOR SHARE` і ціль `INTO`).
 */
export function bodyShape(createFunction: string) {
  const parsed = plpgsql!(createFunction)
  if (!parsed.ok || parsed.fn === undefined)
    throw new Error(`body does not parse: ${createFunction}`)
  return parsed.fn.statements.map((s) => ({
    type: s.type,
    depth: s.depth,
    target: s.target,
    returns: s.returns,
    expressions: s.expressions.map((e) => ({
      role: e.role,
      into: e.into,
      // Вираз (`parseMode` 2) — без `SELECT`, запит — цілий оператор.
      tree: tree(e.parseMode === 0 ? e.query : `SELECT ${e.query}`),
    })),
  }))
}

/**
 * Функція plpgsql з нелітеральним `EXECUTE` — недосудна для обходу
 * досяжності (Р2c1-5) і поза закритою оболонкою, тож у спільному файлі — борг.
 */
export const dynamicFunction = (name: string, args = "", returns = "int") =>
  `CREATE FUNCTION ${name}(${args}) RETURNS ${returns} LANGUAGE plpgsql VOLATILE AS $$ BEGIN EXECUTE format('SELECT %s', 1); RETURN NULL; END $$;\n`

/** Очікувана функція-тригер з тілом `body`. */
export const expectedFunction = (fn: string, body: string) =>
  `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$\n${body}\n$$;`

/** Вузли дерева з ключем `key`, у порядку обходу. */
export function nodes(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => nodes(item, key))
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  return [
    ...(key in node ? [node[key]] : []),
    ...Object.values(node).flatMap((child) => nodes(child, key)),
  ]
}

/** Відношення дерева: кожен вузол з `relname`. */
export function relationsOf(
  value: unknown
): { schemaname?: string; relname: string }[] {
  if (Array.isArray(value)) return value.flatMap(relationsOf)
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  return [
    ...(typeof node.relname === "string"
      ? [node as { schemaname?: string; relname: string }]
      : []),
    ...Object.values(node).flatMap(relationsOf),
  ]
}

/** Імена функцій, які кличуть вирази тіла. */
export const funcNames = (shape: ReturnType<typeof bodyShape>) =>
  nodes(
    shape.map((s) => s.expressions.map((e) => e.tree)),
    "FuncCall"
  ).flatMap((call) =>
    (call as { funcname: { String: { sval: string } }[] }).funcname.map(
      (n) => n.String.sval
    )
  )
