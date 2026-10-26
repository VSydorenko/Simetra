import type { Node } from "libpg-query"
import { PROTECTED_SESSION_SETTINGS } from "simetra/model"
import { executesSqlText } from "./builtin-exclusions"
import { plpgsqlExpressionTrees } from "./rewrite/plpgsql-body"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"

/**
 * Чим SQL застосунку зачіпає захищене налаштування сесії (Р2b1-19,
 * Р2b1-19b). Зміна ролі (`SET ROLE`, `SET SESSION AUTHORIZATION` і їхні
 * `RESET`) окремої форми не має: розбирач дає їй той самий `VariableSetStmt`
 * з іменем `role` чи `session_authorization`, тож вона — `setStatement`.
 * `dynamicText` — виклик функції, що виконує переданий текст SQL (Р2c1-32):
 * що вона виконає, статично не відомо, тож це зміна сесії невідомою формою.
 */
export type CommandContextWrite =
  | "setConfig"
  | "setStatement"
  | "functionOption"
  | "nonLiteral"
  | "settingsTable"
  | "dynamicText"

/**
 * Один запис захищеного налаштування: форма й ім'я налаштування, коли воно
 * статично відоме (`RESET ALL` — `*`). Ім'я потрібне боргу прийнятих таблиць:
 * платформний префікс там — помилка, решта — попередження (Р2c1-6).
 */
export interface CommandContextHit {
  form: CommandContextWrite
  setting?: string
}

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

/**
 * Текст динамічного оператора plpgsql (`EXECUTE`, `OPEN … FOR EXECUTE`,
 * `RETURN QUERY EXECUTE`, `FOR … IN EXECUTE`), коли він — рядковий літерал;
 * зібраний під час виконання — `undefined`. Одне правило літерала для
 * перевірки контексту команди й обходу досяжності (Р2c1-5).
 */
export function literalDynamicText(
  query: string,
  parse: SqlParser
): string | undefined {
  const wrapped = parse(`SELECT ${query}`)
  return wrapped.ok
    ? literalText(selectedValue(wrapped.statements[0]?.stmt))
    : undefined
}

/** Пряме читання рядкового літерала (з можливим приведенням типу). */
export function literalText(arg: unknown): string | undefined {
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

/** Ім'я налаштування оператора `SET`/`RESET`; `RESET ALL` — усі (`*`). */
function setStatementSetting(set: SetStatement): string | undefined {
  return set.kind === "VAR_RESET_ALL" ? "*" : set.name
}

/**
 * Лише вбудований `set_config`: функція з тим самим іменем в іншій схемі —
 * чужий код, його судять його власні перевірки. Ім'я бази перед
 * `pg_catalog` Postgres приймає (`<база>.pg_catalog.set_config`), тож воно
 * не виводить виклик з-під перевірки.
 */
export function isBuiltinSetConfig(
  parts: readonly { String?: { sval?: string } }[] | undefined
): boolean {
  const names = (parts ?? []).map((f) => f.String?.sval?.toLowerCase())
  return (
    names.at(-1) === "set_config" &&
    (names.length === 1 || (names.length <= 3 && names.at(-2) === "pg_catalog"))
  )
}

/**
 * Чи кличе виклик функцію, що виконує текст SQL: вбудовану з класу
 * виключень (некваліфіковану чи `pg_catalog.`, як `set_config`) або функцію
 * провайдера з поіменного переліку. Некваліфікований виклик розв'язує шлях
 * пошуку сесії, тож він судиться за голим ім'ям кожного елемента переліку.
 */
function sqlTextCall(
  parts: readonly { String?: { sval?: string } }[] | undefined,
  textFunctions: ReadonlySet<string>
): boolean {
  const names = (parts ?? []).map((f) => f.String?.sval?.toLowerCase())
  const name = names.at(-1)
  if (name === undefined) return false
  const schema = names.length > 1 ? names.at(-2) : undefined
  if (
    (schema === undefined || (names.length <= 3 && schema === "pg_catalog")) &&
    executesSqlText(name)
  ) {
    return true
  }
  if (schema !== undefined) return textFunctions.has(`${schema}.${name}`)
  return [...textFunctions].some((fn) => fn.split(".").at(-1) === name)
}

function callWrite(
  call: CallNode,
  textFunctions: ReadonlySet<string>
): CommandContextHit | undefined {
  if (sqlTextCall(call.funcname, textFunctions)) return { form: "dynamicText" }
  if (!isBuiltinSetConfig(call.funcname)) return undefined
  const first = call.args?.[0]
  if (first === undefined) return undefined
  const text = literalText(first)
  if (text === undefined) return { form: "nonLiteral" }
  return isProtectedSetting(text)
    ? { form: "setConfig", setting: text }
    : undefined
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

/**
 * Обхід дерева розбору: кожна заборонена форма в порядку обходу (вузол —
 * раніше за дітей), тож перший елемент — та сама форма, що бачила перевірка
 * першого запису.
 */
function treeWrites(
  value: unknown,
  textFunctions: ReadonlySet<string>
): CommandContextHit[] {
  const walk = (v: unknown) => treeWrites(v, textFunctions)
  if (Array.isArray(value)) return value.flatMap(walk)
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  const own: CommandContextHit[] = []
  const call =
    node.FuncCall === undefined
      ? undefined
      : callWrite(node.FuncCall as CallNode, textFunctions)
  if (call !== undefined) own.push(call)
  else if (settingsTableWrite(node) || settingsView(node)) {
    own.push({ form: "settingsTable" })
  } else if (aggregateWrite(node)) own.push({ form: "nonLiteral" })
  else if (
    node.VariableSetStmt !== undefined &&
    setStatementWrite(node.VariableSetStmt as SetStatement)
  ) {
    const setting = setStatementSetting(node.VariableSetStmt as SetStatement)
    own.push({
      form: "setStatement",
      ...(setting === undefined ? {} : { setting }),
    })
  }
  return [...own, ...Object.values(node).flatMap(walk)]
}

interface FunctionTree {
  options?: DefElemNode[]
  sql_body?: unknown
}

/** Опції `SET <налаштування> …` функції (`CREATE` чи `ALTER FUNCTION`). */
function optionWrites(
  options: readonly DefElemNode[] | undefined
): CommandContextHit[] {
  const found: CommandContextHit[] = []
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
      found.push({
        form: "functionOption",
        ...(set.name === undefined ? {} : { setting: set.name }),
      })
    }
  }
  return found
}

/**
 * Чи змінює одиниця SQL застосунку захищене налаштування сесії: `simetra.*`
 * (контекст команди), claims запиту чи роль. Їх ставить лише платформа;
 * обробник підписки спрацьовує посеред оператора команди, і змінене ним
 * налаштування побачили б політики наступних рядків (Р2b1-19, Р2b1-19a,
 * Р2b1-19b). Судиться кожна одиниця, а не лише функції (Р2b1-22): подання,
 * домен, політика чи опція `ALTER FUNCTION` виконують свій вираз у тій самій
 * сесії. Тіло `LANGUAGE sql` розбирається тут, тіло plpgsql — через вирази
 * його операторів; тіла інших мов і нелітеральний `EXECUTE` не розбираються:
 * їх відмовляє дозвільний перелік тіла (`sql.function-body-statement`,
 * Р2c1-37).
 * Усі записи одиниці, а не перший: у борговому SQL `SET ROLE` перед
 * `set_config('simetra.…')` інакше сховав би помилку за попередженням
 * (Р2c1-6). Порожній масив — записів немає. `textFunctions` — функції
 * провайдера, що виконують текст SQL (`schema.name`, Р2c1-32).
 */
export function commandContextWrite(
  tree: Node,
  sql: string,
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  textFunctions: ReadonlySet<string> = new Set()
): CommandContextHit[] {
  const fn = (tree as { CreateFunctionStmt?: FunctionTree }).CreateFunctionStmt
  if (fn === undefined) {
    // Опції `ALTER FUNCTION … SET` — та сама форма, що й опції `CREATE`: до
    // загального обходу, який назвав би їх оператором `SET`.
    const alter = (tree as { AlterFunctionStmt?: { actions?: DefElemNode[] } })
      .AlterFunctionStmt
    if (alter !== undefined) {
      return [
        ...optionWrites(alter.actions),
        ...treeWrites({ ...alter, actions: [] }, textFunctions),
      ]
    }
    return treeWrites(tree, textFunctions)
  }
  const options = optionWrites(fn.options)
  const defs = (fn.options ?? []).flatMap((o) =>
    o.DefElem === undefined ? [] : [o.DefElem]
  )
  const language = (
    defs.find((d) => d.defname === "language")?.arg as
      { String?: { sval?: string } } | undefined
  )?.String?.sval?.toLowerCase()
  // Значення параметрів за замовчуванням обчислює виклик, а тіло
  // `BEGIN ATOMIC` уже розібране: обидва — частина дерева самого оператора.
  // Опції судить `optionWrites`, тож у загальний обхід вони не входять.
  const declared = [
    ...options,
    ...treeWrites({ ...fn, options: [] }, textFunctions),
  ]
  if (fn.sql_body !== undefined) return declared
  return [
    ...declared,
    ...bodyWrites(defs, language, sql, parse, plpgsql, textFunctions),
  ]
}

/** Записи рядкового тіла `LANGUAGE sql` чи plpgsql. */
function bodyWrites(
  defs: NonNullable<DefElemNode["DefElem"]>[],
  language: string | undefined,
  sql: string,
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  textFunctions: ReadonlySet<string>
): CommandContextHit[] {
  const walk = (v: unknown) => treeWrites(v, textFunctions)
  if (language === "sql") {
    const body = (
      defs.find((d) => d.defname === "as")?.arg as
        { List?: { items?: { String?: { sval?: string } }[] } } | undefined
    )?.List?.items?.[0]?.String?.sval
    const parsed = body === undefined ? undefined : parse(body)
    return parsed?.ok === true ? walk(parsed.statements.map((s) => s.stmt)) : []
  }
  if (language !== "plpgsql") return []
  const body = plpgsql(sql)
  if (!body.ok || body.fn === undefined) return []
  const found = walk(plpgsqlExpressionTrees(body.fn, parse))
  // Літеральний `EXECUTE '…'` — звичайний SQL, лише записаний рядком: його
  // розбираємо й судимо усіма формами. Нелітеральний текст перевірка дерев
  // не бачить: його відмовляє дозвільний перелік тіла скрізь, борг теж
  // (`sql.function-body-statement`, Р2c1-37).
  for (const statement of body.fn.statements) {
    for (const e of statement.expressions) {
      if (e.role !== "dynamic") continue
      const text = literalDynamicText(e.query, parse)
      const inner = text === undefined ? undefined : parse(text)
      if (inner?.ok !== true) continue
      found.push(...walk(inner.statements.map((s) => s.stmt)))
    }
  }
  return found
}
