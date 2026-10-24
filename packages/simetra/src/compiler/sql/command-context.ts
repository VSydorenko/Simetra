import type { Node } from "libpg-query"
import { COMMAND_SETTING } from "simetra/model"
import { splitAssignment } from "./rewrite/plpgsql-body"
import type { SqlParser } from "./parse"
import type { PlpgsqlFunction, PlpgsqlParser } from "./plpgsql"

/** Чим SQL застосунку зачіпає налаштування `simetra.*` (Р2b1-19). */
export type CommandContextWrite =
  "setConfig" | "setStatement" | "functionOption" | "nonLiteral"

/**
 * Простір імен налаштувань платформи, виведений зі сталої контексту: літерала
 * імені поза T0 немає. Забороняється весь простір, а не одне ім'я: наступне
 * налаштування платформи не повинно ставати новою дірою.
 */
const PLATFORM_SETTING_PREFIX = `${COMMAND_SETTING.split(".")[0]}.`

const isPlatformSetting = (name: string | undefined): boolean =>
  name?.toLowerCase().startsWith(PLATFORM_SETTING_PREFIX) === true

interface SetStatement {
  kind?: string
  name?: string
}

interface CallNode {
  funcname?: { String?: { sval?: string } }[]
  args?: Node[]
}

/** Пряме читання рядкового літерала (з можливим приведенням типу). */
function literalText(arg: unknown): string | undefined {
  const node = arg as Record<string, unknown> | undefined
  const cast = node?.TypeCast as { arg?: unknown } | undefined
  if (cast !== undefined) return literalText(cast.arg)
  const text = (node?.A_Const as { sval?: { sval?: string } } | undefined)?.sval
  return text?.sval
}

function setStatementWrite(set: SetStatement): boolean {
  return set.kind === "VAR_RESET_ALL" || isPlatformSetting(set.name)
}

function callWrite(call: CallNode): CommandContextWrite | undefined {
  const names = (call.funcname ?? []).map((f) => f.String?.sval?.toLowerCase())
  // Лише вбудований `set_config`: функція з тим самим іменем в іншій схемі —
  // чужий код, його судять його власні перевірки.
  const builtin =
    names.at(-1) === "set_config" &&
    (names.length === 1 || (names.length === 2 && names[0] === "pg_catalog"))
  if (!builtin) return undefined
  const first = call.args?.[0]
  if (first === undefined) return undefined
  const text = literalText(first)
  if (text === undefined) return "nonLiteral"
  return isPlatformSetting(text) ? "setConfig" : undefined
}

/** Обхід дерева розбору: перша заборонена форма чи `undefined`. */
function treeWrite(value: unknown): CommandContextWrite | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = treeWrite(item)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const node = value as Record<string, unknown>
  if (node.FuncCall !== undefined) {
    const found = callWrite(node.FuncCall as CallNode)
    if (found !== undefined) return found
  }
  if (
    node.VariableSetStmt !== undefined &&
    setStatementWrite(node.VariableSetStmt as SetStatement)
  ) {
    return "setStatement"
  }
  for (const inner of Object.values(node)) {
    const found = treeWrite(inner)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Дерева виразів тіла plpgsql: той самий обхід, що й читання копій обробником
 * (Р2a2-9). Динамічний SQL сюди не доходить: його відкидає закрита оболонка, а
 * нерозбірний вираз — розбір тіла, що вже пройшов.
 */
export function plpgsqlExpressionTrees(
  fn: PlpgsqlFunction,
  parse: SqlParser
): unknown[] {
  const trees: unknown[] = []
  for (const statement of fn.statements) {
    for (const e of statement.expressions) {
      if (e.role === "dynamic") continue
      let text = e.query
      if (e.parseMode >= 3) {
        const split = splitAssignment(e.query, e.parseMode - 2)
        if (split === undefined) continue
        text = `SELECT ${e.query.slice(split.valueStart)}`
      } else if (e.parseMode > 0) {
        text = `SELECT ${e.query}`
      }
      const parsed = parse(text)
      if (parsed.ok) trees.push(parsed.statements.map((s) => s.stmt))
    }
  }
  return trees
}

interface FunctionTree {
  options?: { DefElem?: { defname?: string; arg?: unknown } }[]
  sql_body?: unknown
}

/**
 * Чи змінює функція налаштування `simetra.*` (контекст команди). Контекст
 * ставить лише `runCommand`; обробник підписки спрацьовує посеред оператора
 * команди, і змінений ним контекст побачили б політики наступних рядків
 * (Р2b1-19). Тіло `LANGUAGE sql` розбирається тут, тіло plpgsql — через
 * вирази його операторів. Перша знайдена форма.
 */
export function commandContextWrite(
  tree: Node,
  sql: string,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): CommandContextWrite | undefined {
  const fn = (tree as { CreateFunctionStmt?: FunctionTree }).CreateFunctionStmt
  if (fn === undefined) return undefined
  const defs = (fn.options ?? []).flatMap((o) =>
    o.DefElem === undefined ? [] : [o.DefElem]
  )
  for (const def of defs) {
    const set = (def.arg as { VariableSetStmt?: SetStatement } | undefined)
      ?.VariableSetStmt
    if (def.defname === "set" && set !== undefined && setStatementWrite(set)) {
      return "functionOption"
    }
  }
  const language = (
    defs.find((d) => d.defname === "language")?.arg as
      { String?: { sval?: string } } | undefined
  )?.String?.sval?.toLowerCase()
  if (fn.sql_body !== undefined) return treeWrite(fn.sql_body)
  if (language === "sql") {
    const body = (
      defs.find((d) => d.defname === "as")?.arg as
        { List?: { items?: { String?: { sval?: string } }[] } } | undefined
    )?.List?.items?.[0]?.String?.sval
    const parsed = body === undefined ? undefined : parse(body)
    return parsed?.ok === true
      ? treeWrite(parsed.statements.map((s) => s.stmt))
      : undefined
  }
  if (language !== "plpgsql") return undefined
  const body = plpgsql(sql)
  if (!body.ok || body.fn === undefined) return undefined
  return treeWrite(plpgsqlExpressionTrees(body.fn, parse))
}
