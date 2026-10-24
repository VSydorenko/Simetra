import type { Node } from "libpg-query"
import { PROTECTED_SESSION_SETTINGS } from "simetra/model"
import { plpgsqlExpressionTrees } from "./rewrite/plpgsql-body"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"

/**
 * Чим SQL застосунку зачіпає захищене налаштування сесії (Р2b1-19,
 * Р2b1-19b). Зміна ролі (`SET ROLE`, `SET SESSION AUTHORIZATION` і їхні
 * `RESET`) окремої форми не має: розбирач дає їй той самий `VariableSetStmt`
 * з іменем `role` чи `session_authorization`, тож вона — `setStatement`.
 */
export type CommandContextWrite =
  | "setConfig"
  | "setStatement"
  | "functionOption"
  | "nonLiteral"
  | "settingsTable"

/**
 * Захищені налаштування — з переліку T0, тож літерала імені поза T0 немає.
 * Імена налаштувань у Postgres нечутливі до регістру.
 */
function isProtectedSetting(name: string | undefined): boolean {
  const lower = name?.toLowerCase()
  if (lower === undefined) return false
  return (
    PROTECTED_SESSION_SETTINGS.prefixes.some((p) => lower.startsWith(p)) ||
    PROTECTED_SESSION_SETTINGS.names.some((n) => n === lower)
  )
}

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
  return DML_STATEMENTS.some((key) =>
    isSettingsRelation(
      (node[key] as { relation?: unknown } | undefined)?.relation
    )
  )
}

function setStatementWrite(set: SetStatement): boolean {
  return set.kind === "VAR_RESET_ALL" || isProtectedSetting(set.name)
}

/**
 * Лише вбудований `set_config`: функція з тим самим іменем в іншій схемі —
 * чужий код, його судять його власні перевірки. Ім'я бази перед
 * `pg_catalog` Postgres приймає (`<база>.pg_catalog.set_config`), тож воно
 * не виводить виклик з-під перевірки.
 */
function isBuiltinSetConfig(
  parts: readonly { String?: { sval?: string } }[] | undefined
): boolean {
  const names = (parts ?? []).map((f) => f.String?.sval?.toLowerCase())
  return (
    names.at(-1) === "set_config" &&
    (names.length === 1 || (names.length <= 3 && names.at(-2) === "pg_catalog"))
  )
}

function callWrite(call: CallNode): CommandContextWrite | undefined {
  if (!isBuiltinSetConfig(call.funcname)) return undefined
  const first = call.args?.[0]
  if (first === undefined) return undefined
  const text = literalText(first)
  if (text === undefined) return "nonLiteral"
  return isProtectedSetting(text) ? "setConfig" : undefined
}

/**
 * Опції агрегату, що називають функцію. Вбудований `set_config` у будь-якій
 * з них ставить налаштування, чиє ім'я — стан агрегату чи його аргумент,
 * тобто значення часу виконання.
 */
const AGGREGATE_FUNCTION_OPTIONS: ReadonlySet<string> = new Set([
  "sfunc",
  "finalfunc",
  "combinefunc",
  "serialfunc",
  "deserialfunc",
  "msfunc",
  "minvfunc",
  "mfinalfunc",
])

interface DefElemNode {
  DefElem?: { defname?: string; arg?: unknown }
}

function aggregateWrite(node: Record<string, unknown>): boolean {
  const define = node.DefineStmt as
    { kind?: string; definition?: DefElemNode[] } | undefined
  if (define?.kind !== "OBJECT_AGGREGATE") return false
  return (define.definition ?? []).some((d) => {
    const def = d.DefElem
    const type = (
      def?.arg as
        { TypeName?: { names?: { String?: { sval?: string } }[] } } | undefined
    )?.TypeName
    return (
      def?.defname !== undefined &&
      AGGREGATE_FUNCTION_OPTIONS.has(def.defname.toLowerCase()) &&
      isBuiltinSetConfig(type?.names)
    )
  })
}

function isSettingsRelation(relation: unknown): boolean {
  const r = relation as { schemaname?: string; relname?: string } | undefined
  return (
    r?.relname === "pg_settings" &&
    (r.schemaname === undefined || r.schemaname === "pg_catalog")
  )
}

/**
 * Подання над `pg_settings` успадковує його правило оновлення: `UPDATE` у
 * подання змінює налаштування так само, як запис у саме відношення. Читання
 * `pg_settings` у тілах функцій дозволене — запису там перевірка не пропустить.
 */
function settingsView(node: Record<string, unknown>): boolean {
  const view = node.ViewStmt as { query?: unknown } | undefined
  return view !== undefined && readsRelation(view.query, isSettingsRelation)
}

function readsRelation(
  value: unknown,
  match: (relation: unknown) => boolean
): boolean {
  if (Array.isArray(value)) return value.some((v) => readsRelation(v, match))
  if (typeof value !== "object" || value === null) return false
  const node = value as Record<string, unknown>
  if (node.RangeVar !== undefined && match(node.RangeVar)) return true
  return Object.values(node).some((v) => readsRelation(v, match))
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
  if (settingsTableWrite(node) || settingsView(node)) return "settingsTable"
  if (aggregateWrite(node)) return "nonLiteral"
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
  options?: DefElemNode[]
  sql_body?: unknown
}

/** Опція `SET <налаштування> …` функції (`CREATE` чи `ALTER FUNCTION`). */
function optionWrite(
  options: readonly DefElemNode[] | undefined
): CommandContextWrite | undefined {
  for (const def of (options ?? []).flatMap((o) =>
    o.DefElem === undefined ? [] : [o.DefElem]
  )) {
    const set = (def.arg as { VariableSetStmt?: SetStatement } | undefined)
      ?.VariableSetStmt
    // `RESET ALL` опції лише прибирає власні налаштування функції (Р2b1-25):
    // у сесію він нічого не пише, тож не відмова. Оператор `RESET ALL` у тілі
    // судиться окремо і лишається забороненим.
    if (
      def.defname === "set" &&
      set !== undefined &&
      set.kind !== "VAR_RESET_ALL" &&
      setStatementWrite(set)
    ) {
      return "functionOption"
    }
  }
  return undefined
}

/**
 * Чи змінює одиниця SQL застосунку захищене налаштування сесії: `simetra.*`
 * (контекст команди), claims запиту чи роль. Їх ставить лише платформа;
 * обробник підписки спрацьовує посеред оператора команди, і змінене ним
 * налаштування побачили б політики наступних рядків (Р2b1-19, Р2b1-19a,
 * Р2b1-19b). Судиться кожна одиниця, а не лише функції (Р2b1-22): подання,
 * домен, політика чи опція `ALTER FUNCTION` виконують свій вираз у тій самій
 * сесії. Тіло `LANGUAGE sql` розбирається тут, тіло plpgsql — через вирази
 * його операторів; тіла інших мов не розбираються — те саме відоме
 * обмеження до 2c, що й нелітеральний `EXECUTE`. Перша знайдена форма.
 */
export function commandContextWrite(
  tree: Node,
  sql: string,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): CommandContextWrite | undefined {
  const fn = (tree as { CreateFunctionStmt?: FunctionTree }).CreateFunctionStmt
  if (fn === undefined) {
    // Опції `ALTER FUNCTION … SET` — та сама форма, що й опції `CREATE`: до
    // загального обходу, який назвав би їх оператором `SET`.
    const alter = (tree as { AlterFunctionStmt?: { actions?: DefElemNode[] } })
      .AlterFunctionStmt
    if (alter !== undefined) {
      return optionWrite(alter.actions) ?? treeWrite({ ...alter, actions: [] })
    }
    return treeWrite(tree)
  }
  const option = optionWrite(fn.options)
  if (option !== undefined) return option
  const defs = (fn.options ?? []).flatMap((o) =>
    o.DefElem === undefined ? [] : [o.DefElem]
  )
  const language = (
    defs.find((d) => d.defname === "language")?.arg as
      { String?: { sval?: string } } | undefined
  )?.String?.sval?.toLowerCase()
  // Значення параметрів за замовчуванням обчислює виклик, а тіло
  // `BEGIN ATOMIC` уже розібране: обидва — частина дерева самого оператора.
  // Опції судить `optionWrite`, тож у загальний обхід вони не входять.
  const declared = treeWrite({ ...fn, options: [] })
  if (declared !== undefined || fn.sql_body !== undefined) return declared
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
