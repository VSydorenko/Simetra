import type { Node } from "libpg-query"
import { COMMAND_SETTING } from "simetra/model"
import { plpgsqlExpressionTrees } from "./rewrite/plpgsql-body"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"

/** Чим SQL застосунку зачіпає налаштування `simetra.*` (Р2b1-19). */
export type CommandContextWrite =
  | "setConfig"
  | "setStatement"
  | "functionOption"
  | "nonLiteral"
  | "settingsTable"

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

/** Єдине значення `SELECT <значення>`: вираз динамічного оператора. */
function selectedValue(stmt: unknown): unknown {
  const targets = (
    stmt as {
      SelectStmt?: { targetList?: { ResTarget?: { val?: unknown } }[] }
    }
  )?.SelectStmt?.targetList
  return targets?.length === 1 ? targets[0]!.ResTarget?.val : undefined
}

/** Пряме читання рядкового літерала (з можливим приведенням типу). */
function literalText(arg: unknown): string | undefined {
  const node = arg as Record<string, unknown> | undefined
  const cast = node?.TypeCast as { arg?: unknown } | undefined
  if (cast !== undefined) return literalText(cast.arg)
  const text = (node?.A_Const as { sval?: { sval?: string } } | undefined)?.sval
  return text?.sval
}

const DML_STATEMENTS = ["UpdateStmt", "InsertStmt", "DeleteStmt", "MergeStmt"]

/**
 * `UPDATE pg_settings` проходить правилом подання в `set_config`, а ім'я
 * налаштування в `WHERE` надійно не перевірити (Р2b1-19a), тож забороняється
 * будь-який запис у відношення, незалежно від умови. Читання дозволене.
 */
function settingsTableWrite(node: Record<string, unknown>): boolean {
  return DML_STATEMENTS.some((key) => {
    const relation = (
      node[key] as
        { relation?: { schemaname?: string; relname?: string } } | undefined
    )?.relation
    return (
      relation?.relname === "pg_settings" &&
      (relation.schemaname === undefined ||
        relation.schemaname === "pg_catalog")
    )
  })
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
  if (settingsTableWrite(node)) return "settingsTable"
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

interface FunctionTree {
  options?: { DefElem?: { defname?: string; arg?: unknown } }[]
  sql_body?: unknown
}

/**
 * Чи змінює функція налаштування `simetra.*` (контекст команди). Контекст
 * ставить лише `runCommand`; обробник підписки спрацьовує посеред оператора
 * команди, і змінений ним контекст побачили б політики наступних рядків
 * (Р2b1-19, Р2b1-19a). Тіло `LANGUAGE sql` розбирається тут, тіло plpgsql — через
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
  const found = treeWrite(plpgsqlExpressionTrees(body.fn, parse))
  if (found !== undefined) return found
  // Літеральний `EXECUTE '…'` — звичайний SQL, лише записаний рядком: його
  // розбираємо й судимо усіма формами. Нелітеральний текст перевірка дерев
  // не бачить: у закритих модулях і обробниках його відмовлено оболонкою
  // (`dynamicSql`), а в боргових функціях спільних файлів це відоме
  // обмеження до 2c (Р2b1-19a).
  for (const statement of body.fn.statements) {
    for (const e of statement.expressions) {
      if (e.role !== "dynamic") continue
      const wrapped = parse(`SELECT ${e.query}`)
      const text = wrapped.ok
        ? literalText(selectedValue(wrapped.statements[0]?.stmt))
        : undefined
      const inner = text === undefined ? undefined : parse(text)
      if (inner?.ok !== true) continue
      const literal = treeWrite(inner.statements.map((s) => s.stmt))
      if (literal !== undefined) return literal
    }
  }
  return undefined
}
