import type { Node } from "libpg-query"
import {
  KIND_REGISTRY,
  PLATFORM_SCHEMA,
  PROVIDER_FUNCTIONS,
  isObjectOrigin,
  type PhysicalSnapshot,
  type PhysicalTable,
  HEAD_READABLE_SETTINGS,
  type Project,
} from "simetra/model"
import { derivedFunctions } from "../contracts"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { movementWrapperName } from "../movement-functions"
import { PLATFORM_READ_FUNCTIONS } from "../platform/names"
import type { ParsedObject } from "../stages/files"
import type { ResolvedReference } from "../stages/identity"
import { HEAD_BUILTINS } from "./head-builtins"
import { HEAD_PINNED_SETTINGS } from "./head-settings"
import {
  closedModuleOwners,
  hasEffectiveEmptySearchPath,
  pinnedSettingProblem,
  routineLanguage,
} from "./closed-forms"
import { unitCalls, unitRelations } from "./dependencies"
import { routineBody } from "./function-body"
import { relationNameText, type SqlParser } from "./parse"
import type {
  PlpgsqlExpression,
  PlpgsqlParser,
  PlpgsqlStatement,
} from "./plpgsql"
import {
  queryFunctionProblems,
  sideEffectOf,
  sqlBodyText,
  type HeadConstruct,
} from "./query-shape"
import { splitAssignment } from "./rewrite/plpgsql-body"
import { statementTargets } from "./unit-target"
import { functionIdentity, unitIdentity } from "./identity"
import { inputArgumentTypes, type VerbatimUnit } from "./units"

/*
 * Голови (спека прав §5.3): SQL застосунку, що виконується посеред команди чи під
 * час обчислення політики, — функції закритих модулів, обробники підписок,
 * функції множини, функції значень виміру й блоки запиту рухів. Межа голів
 * дозвільна (власник): судиться те, що перелік називає, а все інше — вид
 * оператора plpgsql, виклик, відношення, частина тіла, якої порт не прочитав,
 * — `sql.head-not-allowed`. Денайліст над майже повною мовою plpgsql давав би
 * новий клас обходу на кожному раунді рев'ю.
 */

/** Конструкція поза межею й шлях від голови до одиниці, де вона стоїть. */
export interface HeadFinding {
  chain: readonly string[]
  construct: HeadConstruct
  detail?: string
}

/**
 * Судження голови: знахідки й кожне кваліфіковане відношення, яке прочитали
 * голова й її ланки (`rights.dimension-function-reads-rights`).
 */
export interface HeadJudgement {
  findings: HeadFinding[]
  relations: { chain: readonly string[]; relation: string }[]
}

/**
 * Що голова може читати й кликати. `readable` — `схема.ім'я` таблиць виду й
 * `CustomTable` знімка поза схемою платформи; `trusted` — функції, що лише
 * читають: поточний користувач платформи, згенеровані функції членства,
 * пошуку предвизначеного й віртуальних таблиць і поіменні функції провайдера
 * (спека прав §5.3); `builtins` — дозвільний перелік вбудованих;
 * `wrappers` — `схема.ім'я` обгортки блоку рухів за `blockHeadKey`.
 */
export interface HeadScope {
  units: readonly VerbatimUnit[]
  readable: ReadonlyMap<string, PhysicalTable>
  trusted: ReadonlySet<string>
  builtins: ReadonlySet<string>
  wrappers: ReadonlyMap<string, string>
  parse: SqlParser
  plpgsql: PlpgsqlParser
}

const ARROW = " → "

/** Ключ блоку рухів у `HeadScope.wrappers` і в `skip` для `checkHeads`. */
export function blockHeadKey(block: { file: string; line: number }): string {
  return `block:${block.file}:${block.line}`
}

export function headScope(
  objects: readonly ParsedObject[],
  references: readonly ResolvedReference[],
  project: Project,
  physical: PhysicalSnapshot,
  units: readonly VerbatimUnit[],
  membershipFunctions: ReadonlySet<string>,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): HeadScope {
  const derived = derivedFunctions(
    objects,
    references,
    physical,
    movementWrapperName,
    project.scopeKinds,
    project.naming.attributeCase
  )
  const mainTable = (objectId: string) =>
    physical.tables.find(
      (t) =>
        isObjectOrigin(t.origin) &&
        t.origin.objectId === objectId &&
        t.origin.tabularSectionId === undefined &&
        t.origin.part === undefined
    )
  const wrappers = new Map<string, string>()
  for (const reference of references) {
    if (reference.role !== "posting.movementsBlock") continue
    const document = mainTable(reference.from.objectId)
    const register = mainTable(reference.to.id)
    if (document === undefined || register === undefined) continue
    wrappers.set(
      blockHeadKey({ file: reference.from.file, line: reference.line ?? 0 }),
      `${document.schema}.${movementWrapperName(document, register)}`
    )
  }
  return {
    units,
    readable: new Map(
      physical.tables
        .filter((t) => t.schema !== PLATFORM_SCHEMA)
        .map((t) => [`${t.schema}.${t.name}`, t])
    ),
    trusted: new Set([
      ...PLATFORM_READ_FUNCTIONS.map((f) => `${f.schema}.${f.name}`),
      ...membershipFunctions,
      ...derived
        .filter((f) => f.reads === true)
        .map((f) => `${f.schema}.${f.name}`),
      ...PROVIDER_FUNCTIONS[project.database.provider],
    ]),
    // Позитивний перелік, а не «загальний мінус виключення»: нова
    // вбудована загального переліку не стає дозволеною в голові сама.
    builtins: new Set(HEAD_BUILTINS),
    wrappers,
    parse,
    plpgsql,
  }
}

/**
 * Посилання дерева: виклик, відношення, запис `x.f`, оператор чи читання
 * стану сесії (`setting`, ім'я налаштування в `name`).
 */
interface Reference {
  space: "proc" | "rel" | "attribute" | "operator" | "setting" | "regcast"
  schema?: string
  name: string
  /**
   * Ім'я зв'язано під час створення з `search_path` сесії (подання, вираз
   * політики, значення аргументів за замовчуванням), а не з порожнім шляхом
   * функції під час виконання.
   */
  bound: boolean
}

function treeReferences(
  tree: unknown,
  parse: SqlParser,
  bound: boolean
): Reference[] {
  const unit = { tree }
  return [
    ...unitCalls(unit, parse).map((r): Reference => ({
      ...r,
      space: "proc",
      bound,
    })),
    ...unitRelations(unit, parse).map((r): Reference => ({
      ...r,
      space: "rel",
      bound,
    })),
    ...attributeNames(tree).map((name): Reference => ({
      name,
      space: "attribute",
      bound,
    })),
    ...qualifiedOperators(tree).map((name): Reference => ({
      name,
      space: "operator",
      bound,
    })),
    ...settingReads(tree).map((name): Reference => ({
      name,
      space: "setting",
      bound,
    })),
    ...regCasts(tree).map((name): Reference => ({
      name,
      space: "regcast",
      bound,
    })),
  ]
}

/** Типи `reg*`: приведення тексту до них називає об'єкт бази текстом. */
const REG_TYPES: ReadonlySet<string> = new Set([
  "regclass",
  "regproc",
  "regprocedure",
  "regoper",
  "regoperator",
  "regtype",
  "regnamespace",
  "regrole",
  "regconfig",
  "regdictionary",
  "regcollation",
])

/**
 * Приведення до типу `reg*`, якого збирач залежностей не розв'язує в
 * посилання (`dependencies.ts`): об'єкт, названий текстом під час виконання,
 * не бачать ні виклики, ні відношення голови. Розв'язується лише рядковий
 * літерал, приведений до `regclass`, — він стає відношенням і судиться
 * правилом відношень; будь-яке інше приведення — знахідка `call` з типом.
 */
function regCasts(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(regCasts)
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  const cast = node.TypeCast as
    | { arg?: unknown; typeName?: { names?: FuncCallNode["funcname"] } }
    | undefined
  const type =
    cast === undefined ? undefined : builtinName(cast.typeName?.names)
  const own =
    type !== undefined && REG_TYPES.has(type) && !resolvedRegclass(type, cast!)
      ? [`::${type}`]
      : []
  return [...own, ...Object.values(node).flatMap(regCasts)]
}

/**
 * Чи приведення `regclass` розв'язує збирач: рядковий літерал (крізь
 * вкладені приведення й `COLLATE`, як `regclassArgument`) з іменем
 * відношення, яке розбирає `relationNameText`.
 */
function resolvedRegclass(type: string, cast: { arg?: unknown }): boolean {
  if (type !== "regclass") return false
  let arg = cast.arg as Record<string, { arg?: unknown }> | undefined
  while (arg?.TypeCast !== undefined || arg?.CollateClause !== undefined) {
    arg = (arg.TypeCast ?? arg.CollateClause)!.arg as
      Record<string, { arg?: unknown }> | undefined
  }
  const text = stringLiteral(arg)
  const names = text === undefined ? undefined : relationNameText(text)
  return names !== undefined && names.length <= 3
}

/** Налаштування часової зони сесії: деталь `setting` для залежних від неї форм. */
const TIME_ZONE = "TimeZone"

/**
 * `SQLValueFunction` у місцевому часі сесії: дата чи час «зараз» залежать
 * від `TimeZone`, який ставить клієнт (`Prefer: timezone` PostgREST), а
 * `current_timestamp` — абсолютний момент і лишається дозволеним.
 */
const LOCAL_TIME_VALUES: ReadonlySet<string> = new Set([
  "SVFOP_CURRENT_DATE",
  "SVFOP_CURRENT_TIME",
  "SVFOP_CURRENT_TIME_N",
  "SVFOP_LOCALTIME",
  "SVFOP_LOCALTIME_N",
  "SVFOP_LOCALTIMESTAMP",
  "SVFOP_LOCALTIMESTAMP_N",
])

/**
 * Типи місцевого часу: перетворення `timestamptz` у них читає `TimeZone`;
 * `timetz` (`time with time zone`) бере зсув зони сесії.
 */
const LOCAL_TIME_TYPES: ReadonlySet<string> = new Set([
  "date",
  "time",
  "timetz",
  "timestamp",
])

interface FuncCallNode {
  funcname?: { String?: { sval?: string } }[]
  args?: unknown[]
  func_variadic?: boolean
}

/** Ім'я вбудованої: некваліфіковане чи `pg_catalog.`; інша схема — `undefined`. */
function builtinName(
  names: readonly { String?: { sval?: string } }[] | undefined
): string | undefined {
  const parts = (names ?? []).map((n) => n.String?.sval ?? "")
  if (parts.length === 1) return parts[0]
  return parts.length === 2 && parts[0] === "pg_catalog" ? parts[1] : undefined
}

/** Голий рядковий літерал (без приведення) чи `undefined`. */
function stringLiteral(value: unknown): string | undefined {
  const constant = (value as { A_Const?: { sval?: { sval?: string } } })
    ?.A_Const
  return constant?.sval === undefined ? undefined : (constant.sval.sval ?? "")
}

/**
 * Літерал дати й часу ISO 8601 (`YYYY-MM-DD[ T]hh:mm…`): інший порядок
 * (`'01-02-2026'`) читає `DateStyle`, слова (`'today'`, `'now'`) — зона сесії.
 * `timetz` і `timestamptz` без явного зсуву беруть зсув зони сесії, тож для
 * них зсув обов'язковий.
 */
function isoLiteral(text: string, type: string): boolean {
  const match =
    /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(
      text
    )
  return match !== null && (!ZONED_TYPES.has(type) || match[1] !== undefined)
}

/** Типи з зоною: літерал без зсуву Postgres читає в зоні сесії. */
const ZONED_TYPES: ReadonlySet<string> = new Set(["timetz", "timestamptz"])

/** `SQLValueFunction` абсолютного моменту: `current_timestamp[(n)]`. */
const MOMENT_VALUES: ReadonlySet<string> = new Set([
  "SVFOP_CURRENT_TIMESTAMP",
  "SVFOP_CURRENT_TIMESTAMP_N",
])

/** Вбудовані без аргументів, що повертають `timestamptz` — абсолютний момент. */
const MOMENT_FUNCTIONS: ReadonlySet<string> = new Set([
  "now",
  "statement_timestamp",
  "transaction_timestamp",
  "clock_timestamp",
])

/**
 * Вираз, тип якого доведено `timestamptz`: `current_timestamp`, `now()` і
 * споріднені без аргументів чи літерал ISO з явним зсувом, приведений до
 * `timestamptz`. Типів решти виразів компілятор не знає.
 */
function provablyTimestamptz(value: unknown): boolean {
  const moment = (value as { SQLValueFunction?: { op?: string } })
    ?.SQLValueFunction
  if (moment?.op !== undefined) return MOMENT_VALUES.has(moment.op)
  const call = (value as { FuncCall?: FuncCallNode })?.FuncCall
  if (call !== undefined) {
    const name = builtinName(call.funcname)
    return (
      name !== undefined &&
      MOMENT_FUNCTIONS.has(name) &&
      (call.args ?? []).length === 0
    )
  }
  const cast = (
    value as {
      TypeCast?: {
        arg?: unknown
        typeName?: { names?: FuncCallNode["funcname"] }
      }
    }
  )?.TypeCast
  if (cast === undefined) return false
  const text = stringLiteral(cast.arg)
  return (
    builtinName(cast.typeName?.names) === "timestamptz" &&
    text !== undefined &&
    isoLiteral(text, "timestamptz")
  )
}

/**
 * Значення, перетворення якого в тип часу `type` не залежить від
 * `TimeZone` і `DateStyle`: `NULL`, літерал ISO (`isoLiteral`),
 * `<доведено timestamptz> AT TIME ZONE '<літерал>'` (результат —
 * `timestamp`, без зони сесії), а для `timestamptz` — і сам вираз, доведено
 * `timestamptz`. `AT TIME ZONE` над `timestamp` повертає `timestamptz`, яке
 * наступне перетворення знову читає в зоні сесії, тож типів, яких компілятор
 * не знає, — fail-closed.
 */
function zoneFree(value: unknown, type: string): boolean {
  const constant = (value as { A_Const?: { isnull?: boolean } })?.A_Const
  if (constant?.isnull === true) return true
  const text = stringLiteral(value)
  if (text !== undefined) return isoLiteral(text, type)
  if (type === "timestamptz") return provablyTimestamptz(value)
  const call = (value as { FuncCall?: FuncCallNode })?.FuncCall
  return (
    type !== "timetz" &&
    call !== undefined &&
    builtinName(call.funcname) === "timezone" &&
    call.args?.length === 2 &&
    stringLiteral(call.args[0]) !== undefined &&
    provablyTimestamptz(call.args[1])
  )
}

/**
 * Назва, яку `current_setting` вузла читає поза дозвільним (спека прав
 * §5.8, Р6/Р7 плану Д5): назва, якої немає серед точних
 * `HEAD_READABLE_SETTINGS`, чи сама назва функції, коли назву сховано.
 * Правило — у розборі дерева, бо обхід голови бачить лише ім'я виклику, а не
 * його аргументи.
 */
function settingRead(node: Record<string, unknown>): string | undefined {
  const call = node.FuncCall as FuncCallNode | undefined
  if (call === undefined || builtinName(call.funcname) !== "current_setting") {
    return undefined
  }
  const args = call.args ?? []
  // Лише перший позиційний аргумент — голий літерал точної назви:
  // приведення, іменований аргумент, VARIADIC чи вираз ховають назву.
  const setting = stringLiteral(args[0])
  return setting !== undefined &&
    call.func_variadic !== true &&
    args.length <= 2 &&
    !args.some((a) => (a as { NamedArgExpr?: unknown }).NamedArgExpr) &&
    HEAD_READABLE_SETTINGS.includes(setting)
    ? undefined
    : (setting ?? "current_setting")
}

/**
 * Чи вузол дослівного виразу політики читає часову зону сесії (спека
 * декларацій функцій §5.8): функція голови фіксує `TimeZone` у своїй
 * оболонці (`HEAD_PINNED_SETTINGS`), а вираз політики, який обчислює
 * Postgres у сесії клієнта, такої оболонки не має — для нього правило за
 * іменами: місцевий час «зараз», перетворення в тип місцевого часу без
 * `AT TIME ZONE '<літерал>'` над доведено `timestamptz` і перетворення в
 * `timestamptz` того, що не має зони (`zoneFree`).
 */
function timeZoneRead(node: Record<string, unknown>): boolean {
  const value = node.SQLValueFunction as { op?: string } | undefined
  if (value?.op !== undefined && LOCAL_TIME_VALUES.has(value.op)) return true
  const cast = node.TypeCast as
    | { arg?: unknown; typeName?: { names?: FuncCallNode["funcname"] } }
    | undefined
  if (cast !== undefined) {
    const type = builtinName(cast.typeName?.names)
    return (
      type !== undefined &&
      (LOCAL_TIME_TYPES.has(type) || type === "timestamptz") &&
      !zoneFree(cast.arg, type)
    )
  }
  const call = node.FuncCall as FuncCallNode | undefined
  const name = call === undefined ? undefined : builtinName(call.funcname)
  if (call === undefined || name === undefined) return false
  const args = call.args ?? []
  // `AT LOCAL` — `timezone(x)` з одним аргументом: зона сесії.
  if (name === "timezone") return args.length === 1
  // Перетворення в `timestamptz` значення без зони (`timestamp`, `date`,
  // літерал без зсуву) читає зону сесії так само.
  if (LOCAL_TIME_TYPES.has(name) || name === "timestamptz") {
    return !(args.length === 1 && zoneFree(args[0], name))
  }
  // Без третього аргументу-зони `date_trunc` над `timestamptz` і
  // `date_add`/`date_subtract` беруть зону сесії.
  if (name === "date_trunc") {
    if (args.length === 3) return stringLiteral(args[2]) === undefined
    return !zoneFree(args[1], "timestamp")
  }
  if (name === "date_add" || name === "date_subtract") {
    return !(args.length === 3 && stringLiteral(args[2]) !== undefined)
  }
  return false
}

/** Кожне значення `read` вузлів дерева, від кореня вглиб. */
function collect(
  value: unknown,
  read: (node: Record<string, unknown>) => string | undefined
): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => collect(v, read))
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  const own = read(node)
  return [
    ...(own === undefined ? [] : [own]),
    ...Object.values(node).flatMap((v) => collect(v, read)),
  ]
}

/** Читання налаштувань поза дозвільним у дереві функції (`settingRead`). */
function settingReads(value: unknown): string[] {
  return collect(value, settingRead)
}

/** Читання часової зони сесії у виразі політики (`timeZoneRead`). */
function timeZoneReads(value: unknown): string[] {
  return collect(value, (node) => (timeZoneRead(node) ? TIME_ZONE : undefined))
}

/**
 * Кожне читання стану сесії поза дозвільним у дослівному виразі політики:
 * `current_setting` поза точними назвами й часова зона сесії.
 */
export function sessionReads(value: unknown): string[] {
  return collect(value, (node) =>
    timeZoneRead(node) ? TIME_ZONE : settingRead(node)
  )
}

type NameList = { String?: { sval?: string } }[] | undefined

/**
 * Оператори з кваліфікацією поза `pg_catalog` (`OPERATOR(s.op)`): функцію
 * оператора компілятор не бачить. Некваліфікований оператор — вбудований чи
 * розширення (застосунок власних операторів не оголошує). Оператор називає
 * не лише вираз (`A_Expr`), а й `ORDER BY … USING` (`SortBy.useOp`) і
 * порівняння з підзапитом `x OPERATOR(s.op) ANY (…)` (`SubLink.operName`).
 */
function qualifiedOperators(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(qualifiedOperators)
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  const lists: NameList[] = [
    (node.A_Expr as { name?: NameList } | undefined)?.name,
    (node.SortBy as { useOp?: NameList } | undefined)?.useOp,
    (node.SubLink as { operName?: NameList } | undefined)?.operName,
  ]
  const own = lists.flatMap((list) => {
    const names = (list ?? []).map((n) => n.String?.sval ?? "")
    return names.length > 1 && names.at(-2) !== "pg_catalog"
      ? [names.join(".")]
      : []
  })
  return [...own, ...Object.values(node).flatMap(qualifiedOperators)]
}

/**
 * Останні імена записів `x.f` і `(x).f`: Postgres читає їх і як колонку, і
 * як виклик `f(x)` функції з одним аргументом складеного типу.
 */
export function attributeNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(attributeNames)
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  const found: string[] = []
  const ref = node.ColumnRef as { fields?: unknown[] } | undefined
  const indirection = (node.A_Indirection as { indirection?: unknown[] })
    ?.indirection
  for (const fields of [
    (ref?.fields?.length ?? 0) > 1 ? ref?.fields : undefined,
    indirection,
  ]) {
    const last = (fields?.at(-1) as { String?: { sval?: string } } | undefined)
      ?.String?.sval
    if (last !== undefined) found.push(last)
  }
  return [...found, ...Object.values(node).flatMap(attributeNames)]
}

/** Функція з одним вхідним аргументом: її кличе й запис `x.f`. */
export function singleArgument(unit: VerbatimUnit): boolean {
  const fn = (unit.tree as { CreateFunctionStmt?: object }).CreateFunctionStmt
  return (
    fn !== undefined &&
    inputArgumentTypes(fn as Parameters<typeof inputArgumentTypes>[0])
      .length === 1
  )
}

/**
 * Тексти виразу plpgsql як оператори SQL. На відміну від
 * `plpgsqlExpressionTrees` ціль присвоєння теж читається: індекс
 * `a[public.f()] := …` — виклик; нерозбірна межа присвоєння — `undefined`
 * (fail-closed), а не пропуск.
 */
export function expressionTexts(e: PlpgsqlExpression): string[] | undefined {
  if (e.parseMode >= 3) {
    const split = splitAssignment(e.query, e.parseMode - 2)
    if (split === undefined) return undefined
    return [
      `SELECT ${e.query.slice(split.valueStart)}`,
      `SELECT ${e.query.slice(0, split.targetEnd)}`,
    ]
  }
  return [e.parseMode > 0 ? `SELECT ${e.query}` : e.query]
}

interface FunctionTree {
  options?: { DefElem?: { defname?: string } }[]
}

/**
 * Значення аргументів за замовчуванням і решта `CREATE` без тіла: Postgres
 * зв'язує їх під час створення за шляхом сесії.
 */
function creationTree(unit: VerbatimUnit): unknown {
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionTree })
    .CreateFunctionStmt
  return {
    CreateFunctionStmt: {
      ...fn,
      options: (fn?.options ?? []).filter((o) => o.DefElem?.defname !== "as"),
    },
  }
}

interface PolicyTree {
  cmd_name?: string
  qual?: unknown
}

/** Політика, яку Postgres обчислює на читанні: команда `SELECT` чи `ALL`. */
function readingPolicy(unit: VerbatimUnit): PolicyTree | undefined {
  const policy = (unit.tree as { CreatePolicyStmt?: PolicyTree })
    .CreatePolicyStmt
  return policy?.cmd_name === "select" || policy?.cmd_name === "all"
    ? policy
    : undefined
}

/**
 * Одиниця моделі, як її бачить суддя: що з нею не так, що вона називає і
 * читання часової зони сесії в її деревах (`zoneRefs`) — їх обхід звітує лише
 * там, де одиниця виконується в налаштуваннях клієнта (`Walk`).
 */
interface Analysis {
  problems: { construct: HeadConstruct; detail?: string }[]
  refs: Reference[]
  zoneRefs: Reference[]
}

/** Читання часової зони сесії в деревах — посилання `setting` обходу. */
function zoneReferences(trees: readonly unknown[]): Reference[] {
  return trees.flatMap((tree) =>
    timeZoneReads(tree).map((name): Reference => ({
      name,
      space: "setting",
      bound: true,
    }))
  )
}

/**
 * Опція `SET` зафіксованого налаштування голови (`HEAD_PINNED_SETTINGS`):
 * у корені його судить `sql.head-settings`, а не форма функції-запиту.
 */
function pinnedSettingFinding(p: { construct: string; detail?: string }) {
  return (
    p.construct === "setting" &&
    HEAD_PINNED_SETTINGS.some(
      (s) => s.name.toLowerCase() === p.detail?.toLowerCase()
    )
  )
}

const ROUTINES: ReadonlySet<string> = new Set([
  "function",
  "procedure",
  "aggregate",
])
const VIEWS: ReadonlySet<string> = new Set(["view", "materializedView"])

/**
 * Одиниці області за іменами й розбір кожної раз: спільну функцію досягають
 * кілька голів, а тіла розбираються недешево.
 */
class Index {
  private readonly routines = new Map<string, VerbatimUnit[]>()
  private readonly views = new Map<string, VerbatimUnit[]>()
  private readonly policies: {
    unit: VerbatimUnit
    schema: string
    table: string
  }[] = []
  private readonly analyses = new Map<VerbatimUnit, Analysis>()
  /** Судження функції-запиту за `identity` і ланцюжком: голову судять двічі. */
  readonly judgements = new Map<string, HeadJudgement>()

  constructor(private readonly scope: HeadScope) {
    for (const unit of scope.units) {
      const into = ROUTINES.has(unit.class)
        ? this.routines
        : VIEWS.has(unit.class)
          ? this.views
          : undefined
      if (into !== undefined) {
        into.set(unit.name, [...(into.get(unit.name) ?? []), unit])
      }
      if (unit.class === "policy" && readingPolicy(unit) !== undefined) {
        for (const target of statementTargets(unit.tree as Node, "")) {
          this.policies.push({
            unit,
            schema: target.schema,
            table: target.object ?? "",
          })
        }
      }
    }
  }

  routinesNamed(name: string, schema?: string): VerbatimUnit[] {
    return (this.routines.get(name) ?? []).filter(
      (u) => schema === undefined || u.schema === schema
    )
  }

  viewsNamed(schema: string, name: string): VerbatimUnit[] {
    return (this.views.get(name) ?? []).filter((u) => u.schema === schema)
  }

  /** Дослівні політики читання таблиці; некваліфікована ціль — будь-де. */
  policiesOn(table: PhysicalTable): VerbatimUnit[] {
    return this.policies
      .filter(
        (p) =>
          p.table === table.name &&
          (p.schema === "" || p.schema === table.schema)
      )
      .map((p) => p.unit)
  }

  analysis(unit: VerbatimUnit): Analysis {
    let found = this.analyses.get(unit)
    if (found === undefined) {
      found = this.analyze(unit)
      this.analyses.set(unit, found)
    }
    return found
  }

  private analyze(unit: VerbatimUnit): Analysis {
    const { parse } = this.scope
    if (unit.class === "policy") {
      // Таблицю політики Postgres розв'язав під час створення: вираз `USING`
      // зв'язано за шляхом сесії.
      const qual = readingPolicy(unit)?.qual
      return {
        problems:
          sideEffectOf(qual) === undefined ? [] : [{ construct: "query" }],
        refs: qual === undefined ? [] : treeReferences(qual, parse, true),
        zoneRefs: qual === undefined ? [] : zoneReferences([qual]),
      }
    }
    if (VIEWS.has(unit.class)) {
      return {
        problems:
          sideEffectOf(unit.tree) === undefined ? [] : [{ construct: "query" }],
        refs: treeReferences(unit.tree, parse, true),
        zoneRefs: zoneReferences([unit.tree]),
      }
    }
    const problems = queryFunctionProblems(unit, this.scope.units, parse)
    // Тіло, що не має форми запиту, не судиться далі: його вже відмовлено.
    // Зафіксоване налаштування в оболонці форму тіла не ламає: тіло кореня
    // судиться й тоді, коли значення судить `sql.head-settings`.
    if (problems.some((p) => !pinnedSettingFinding(p))) {
      return { problems, refs: [], zoneRefs: [] }
    }
    const body = parse(sqlBodyText(unit) ?? "")
    const trees = [
      ...(body.ok ? body.statements.map((s) => s.stmt) : []),
      creationTree(unit),
    ]
    return {
      problems,
      refs: [
        ...(body.ok
          ? body.statements.flatMap((s) => treeReferences(s.stmt, parse, false))
          : []),
        ...treeReferences(creationTree(unit), parse, true),
      ],
      zoneRefs: zoneReferences(trees),
    }
  }
}

/** Крок обходу: ланцюжок і контекст налаштувань (`Walk.visited`). */
interface Step {
  chain: readonly string[]
  session: boolean
  quiet: boolean
}

const indexes = new WeakMap<HeadScope, Index>()

function indexOf(scope: HeadScope): Index {
  let found = indexes.get(scope)
  if (found === undefined) {
    found = new Index(scope)
    indexes.set(scope, found)
  }
  return found
}

function labelOf(unit: VerbatimUnit): string {
  return unit.class === "policy" ? unit.identity : `${unit.schema}.${unit.name}`
}

/**
 * Обхід у ширину від голови з множиною відвіданих (`identity` одиниці,
 * `table:<схема.ім'я>` таблиці): спільна ланка й цикл судяться раз, а
 * ланцюжок знахідки — найкоротший шлях від голови.
 */
class Walk {
  private readonly found = new Map<string, HeadFinding>()
  private readonly relations: HeadJudgement["relations"] = []
  /**
   * Відвідані одиниці й контекст, у якому їх уже судили: `pinned` — у
   * зафіксованих налаштуваннях голови, `session` — у налаштуваннях клієнта
   * (вираз політики й усе, що він досягає). Судження `session` повніше, тож
   * одиниця, вже суджена `pinned`, у контексті `session` проходить ще раз лише
   * заради часової зони (`quiet`).
   */
  private readonly visited = new Map<string, "pinned" | "session">()
  private readonly queue: (Step & { unit: VerbatimUnit })[] = []
  private readonly index: Index
  /** Контекст кроку, який обхід зараз судить. */
  private step: Step = { chain: [], session: false, quiet: false }
  /** Корінь, у якого зафіксовані налаштування судить `sql.head-settings`. */
  private pinnedRoot: VerbatimUnit | undefined

  constructor(private readonly scope: HeadScope) {
    this.index = indexOf(scope)
  }

  report(chain: readonly string[], construct: HeadConstruct, detail?: string) {
    if (this.step.quiet && !(construct === "setting" && detail === TIME_ZONE))
      return
    const key = `${chain.join(ARROW)}\0${construct}\0${detail ?? ""}`
    if (this.found.has(key)) return
    this.found.set(key, {
      chain,
      construct,
      ...(detail === undefined ? {} : { detail }),
    })
  }

  /** Одиниця, яку судить не обхід: голова-обробник. */
  mark(unit: VerbatimUnit) {
    this.visited.set(unit.identity, "session")
  }

  /**
   * Корінь обходу: одиниця, ланцюжок якої вже називає її саму. `pinned` —
   * корінь із зафіксованими налаштуваннями (`checkHeadSettings`): опції `SET`
   * цих налаштувань у ньому судить не форма функції-запиту.
   */
  start(unit: VerbatimUnit, chain: readonly string[], pinned: boolean) {
    this.visited.set(unit.identity, "pinned")
    this.queue.push({ unit, chain, session: false, quiet: false })
    if (pinned) this.pinnedRoot = unit
  }

  /**
   * Ланка в контексті поточного кроку. Політика обчислюється в налаштуваннях
   * клієнта завжди; функція, що сама фіксує налаштування голови, — у своїх.
   */
  private enqueue(unit: VerbatimUnit, chain: readonly string[]) {
    const session =
      unit.class === "policy" ||
      (this.step.session &&
        !(
          unit.class === "function" &&
          pinnedSettingProblem(unit, this.scope.units) === undefined
        ))
    const seen = this.visited.get(unit.identity)
    if (seen === "session" || (seen === "pinned" && !session)) return
    this.visited.set(unit.identity, session ? "session" : "pinned")
    this.queue.push({
      unit,
      chain: [...chain, labelOf(unit)],
      session,
      quiet: seen === "pinned",
    })
  }

  /** Розібрані оператори чи вирази в контексті одиниці ланцюжка `chain`. */
  trees(trees: readonly unknown[], chain: readonly string[], bound: boolean) {
    this.step = { chain, session: false, quiet: false }
    for (const tree of trees) {
      if (sideEffectOf(tree) !== undefined) this.report(chain, "query")
      this.references(treeReferences(tree, this.scope.parse, bound), chain)
    }
  }

  run(): HeadJudgement {
    for (
      let step = this.queue.shift();
      step !== undefined;
      step = this.queue.shift()
    ) {
      this.step = step
      const analysis = this.index.analysis(step.unit)
      for (const p of analysis.problems) {
        if (step.unit === this.pinnedRoot && pinnedSettingFinding(p)) continue
        this.report(step.chain, p.construct, p.detail)
      }
      this.references(analysis.refs, step.chain)
      if (step.session) this.references(analysis.zoneRefs, step.chain)
    }
    return { findings: [...this.found.values()], relations: this.relations }
  }

  private references(refs: readonly Reference[], chain: readonly string[]) {
    for (const ref of refs) {
      if (ref.space === "proc") this.call(ref, chain)
      else if (ref.space === "rel") this.relation(ref, chain)
      else if (ref.space === "operator")
        this.report(chain, "operator", ref.name)
      else if (ref.space === "setting") this.report(chain, "setting", ref.name)
      else if (ref.space === "regcast") this.report(chain, "call", ref.name)
      // З порожнім шляхом функції `x.f` розв'язується лише в `pg_catalog`.
      else if (ref.bound) this.attribute(ref.name, chain)
    }
  }

  /**
   * Виклик (спека прав §5.3): функція моделі — під тим самим правилом (кожне
   * перевантаження; агрегат тіла не має, а з тим самим ім'ям Postgres може
   * розв'язати виклик саме в нього — тож `call` усе ім'я); довірена функція,
   * що лише читає; вбудована з переліку — некваліфікована чи `pg_catalog.`.
   * У поданні й політиці некваліфікована вбудована розв'язується за шляхом
   * сесії, тож і вона мусить бути кваліфікована.
   */
  private call(ref: Reference, chain: readonly string[]) {
    const { schema, name } = ref
    if (schema === undefined) {
      if (ref.bound) this.report(chain, "unqualified", name)
      else if (!this.scope.builtins.has(name)) this.report(chain, "call", name)
      return
    }
    const qualified = `${schema}.${name}`
    if (schema === "pg_catalog") {
      if (!this.scope.builtins.has(name)) this.report(chain, "call", qualified)
      return
    }
    const routines = this.index.routinesNamed(name, schema)
    if (routines.length > 0) {
      if (routines.some((u) => u.class !== "function")) {
        this.report(chain, "call", qualified)
      } else {
        for (const unit of routines) this.enqueue(unit, chain)
      }
      return
    }
    if (!this.scope.trusted.has(qualified))
      this.report(chain, "call", qualified)
  }

  /** Запис `x.f` — виклик кожної функції моделі `f` з одним аргументом. */
  private attribute(name: string, chain: readonly string[]) {
    const routines = this.index
      .routinesNamed(name)
      .filter((u) => u.class !== "function" || singleArgument(u))
    if (routines.some((u) => u.class !== "function")) {
      this.report(chain, "call", name)
      return
    }
    for (const unit of routines) this.enqueue(unit, chain)
  }

  /**
   * Відношення (спека прав §5.3): кваліфіковані таблиця виду чи `CustomTable` поза
   * схемою платформи або подання моделі під тим самим правилом. Таблиця з
   * RLS обчислює посеред команди дослівні політики читання (спека прав §5.3), тож
   * вони судяться як вирази з політикою в ланцюжку; з RLS `off` політик
   * Postgres не обчислює.
   */
  private relation(ref: Reference, chain: readonly string[]) {
    const { schema, name } = ref
    if (schema === undefined) {
      this.report(chain, "unqualified", name)
      return
    }
    const qualified = `${schema}.${name}`
    const views = this.index.viewsNamed(schema, name)
    for (const view of views) this.enqueue(view, chain)
    const table = this.scope.readable.get(qualified)
    if (table === undefined) {
      if (views.length === 0) this.report(chain, "relation", qualified)
      return
    }
    if (!this.step.quiet) this.relations.push({ chain, relation: qualified })
    // Ключ обходу ділить множину з ідентичностями одиниць, тож складається
    // тим самим правилом `identity.ts`. Політики таблиці судяться завжди в
    // контексті `session`, тож таблиця — раз.
    const key = unitIdentity("table", schema, name)
    if (table.rowLevelSecurity === "off" || this.visited.has(key)) return
    this.visited.set(key, "session")
    for (const policy of this.index.policiesOn(table))
      this.enqueue(policy, chain)
  }
}

/**
 * Функція-запит (спека прав §5.3) і все, що вона досягає: форма, виклики,
 * відношення, подання й політики прочитаних таблиць.
 */
export function judgeQueryFunction(
  unit: VerbatimUnit,
  scope: HeadScope,
  chain: readonly string[],
  pinned: boolean
): HeadJudgement {
  const { judgements } = indexOf(scope)
  const key = `${unit.identity}\0${chain.join(ARROW)}\0${pinned}`
  let judgement = judgements.get(key)
  if (judgement === undefined) {
    const walk = new Walk(scope)
    walk.start(unit, chain, pinned)
    judgement = walk.run()
    judgements.set(key, judgement)
  }
  return judgement
}

/**
 * Розібрані оператори чи вирази за правилами відношень і викликів
 * Правила 3. `bound` — імена зв'язано під час створення (подання, вираз
 * політики, CHECK домену): тоді й виклик вбудованої мусить бути
 * кваліфікованим.
 */
export function judgeQuery(
  trees: readonly Node[],
  scope: HeadScope,
  chain: readonly string[],
  bound: boolean
): HeadJudgement {
  const walk = new Walk(scope)
  walk.trees(trees, chain, bound)
  return walk.run()
}

interface DomainTree {
  constraints?: {
    Constraint?: { contype?: string; raw_expr?: Node }
  }[]
}

/**
 * CHECK кожного домену моделі (спека прав §5.3), борг теж: голова виконує його,
 * коли приводить значення до домену (приведення, змінна, параметр, `NEW`), а
 * типи в голові не відстежуються — тож CHECK судиться як вираз Правила 3,
 * зв'язаний під час створення за шляхом сесії.
 */
export function checkDomainChecks(
  units: readonly VerbatimUnit[],
  scope: HeadScope
): Diagnostic[] {
  const found: Diagnostic[] = []
  for (const unit of units) {
    if (unit.class !== "domain") continue
    const domain = (unit.tree as { CreateDomainStmt?: DomainTree })
      .CreateDomainStmt
    const checks = (domain?.constraints ?? []).flatMap((c) =>
      c.Constraint?.contype === "CONSTR_CHECK" &&
      c.Constraint.raw_expr !== undefined
        ? [c.Constraint.raw_expr]
        : []
    )
    if (checks.length === 0) continue
    const label = `${unit.schema}.${unit.name}`
    for (const finding of judgeQuery(checks, scope, [label], true).findings) {
      found.push(
        diagnostic("sql.domain-check-not-allowed", unit.file, "", {
          domain: label,
          chain: finding.chain.join(ARROW),
          construct: finding.construct,
          ...(finding.detail === undefined ? {} : { detail: finding.detail }),
          line: unit.line,
        })
      )
    }
  }
  return found
}

/**
 * Оператори, якими обробник перевіряє рядок (спека прав §5.3). Запис в інші таблиці
 * — TS-хуки П4 (платформна спека Р23): обробник посеред команди лише
 * перевіряє й присвоює `NEW`. `declare` — службовий оператор оголошень.
 */
const HANDLER_STATEMENTS: ReadonlySet<string> = new Set([
  "block",
  "assign",
  "if",
  "case",
  "loop",
  "while",
  "fori",
  "fors",
  "foreach_a",
  "exit",
  "return",
  "raise",
  "assert",
  "perform",
  "execsql",
  "declare",
])

/** Оператори, запит яких — рівно один `SELECT`. */
const QUERY_STATEMENTS: ReadonlySet<string> = new Set([
  "execsql",
  "fors",
  "perform",
])

/**
 * Правило 2: обробник — `plpgsql` з ефективним порожнім `search_path`, кожен
 * оператор якого — з `HANDLER_STATEMENTS`, запит `execsql` (лише з `INTO`),
 * `fors` і `perform` — один `SELECT`, а кожен вираз (зокрема ціль
 * присвоєння) — без побічних ефектів і за правилами відношень і викликів
 * Правила 3 у контексті функції. Частина тіла, яку порт не прочитав, —
 * `unread`: суддя дозвільний.
 */
export function judgeHandler(
  unit: VerbatimUnit,
  scope: HeadScope
): HeadJudgement {
  const chain = [labelOf(unit)]
  const walk = new Walk(scope)
  // Тіло самої голови судить цей суддя, а не обхід функцій-запитів.
  walk.mark(unit)
  if (routineLanguage(unit.tree as Node) !== "plpgsql") {
    walk.report(chain, "language")
    return walk.run()
  }
  if (!hasEffectiveEmptySearchPath(unit, scope.units)) {
    walk.report(chain, "searchPath")
  }
  const body = scope.plpgsql(unit.sql)
  if (!body.ok || body.fn === undefined) {
    walk.report(chain, "unread")
    return walk.run()
  }
  if (body.fn.unreadLines.length > 0) walk.report(chain, "unread")
  for (const statement of body.fn.statements) {
    if (!HANDLER_STATEMENTS.has(statement.type)) {
      walk.report(chain, "statement", statement.type)
      continue
    }
    if (QUERY_STATEMENTS.has(statement.type)) {
      const kind = queryStatementProblem(statement, scope.parse)
      if (kind !== undefined) {
        walk.report(chain, "statement", kind)
        continue
      }
    }
    for (const e of statement.expressions) {
      const parsed = expressionTexts(e)?.map((text) => scope.parse(text))
      if (parsed === undefined || parsed.some((p) => !p.ok)) {
        walk.report(chain, "unread")
        continue
      }
      for (const p of parsed) {
        if (p.ok)
          walk.trees(
            p.statements.map((s) => s.stmt),
            chain,
            false
          )
      }
    }
  }
  return walk.run()
}

/**
 * Запит `execsql`, `fors` чи `perform`, що не є одним `SELECT`: вузол запиту
 * (`InsertStmt`, `VariableSetStmt`…); `SELECT` оператора `execsql` без
 * `INTO` — `execsql`. Нерозбірний запит судить читання виразів (`unread`).
 */
function queryStatementProblem(
  statement: PlpgsqlStatement,
  parse: SqlParser
): string | undefined {
  const query = statement.expressions.find((e) => e.role === "statement")
  if (query === undefined) return statement.type
  const parsed = parse(query.query)
  if (!parsed.ok) return undefined
  const [only, ...rest] = parsed.statements
  if (only === undefined) return statement.type
  const key = Object.keys(only.stmt)[0] ?? statement.type
  if (key !== "SelectStmt" || rest.length > 0) return key
  if (statement.type === "execsql" && query.into !== true) return "execsql"
  return undefined
}

/** Обробники підписок: ідентичність → чи пише він рядок таблиці провайдера. */
function handlersOf(
  objects: readonly ParsedObject[],
  project: Project
): Map<string, boolean> {
  const handlers = new Map<string, boolean>()
  for (const object of objects) {
    const spec = KIND_REGISTRY[object.kind].subscription?.(object.data)
    if (spec === undefined) continue
    const identity = functionIdentity(
      spec.handler.schema ?? project.defaultSchema,
      spec.handler.name,
      []
    )
    const provider =
      spec.event === "beforeWrite" &&
      spec.sources.some((source) => "providerTable" in source)
    handlers.set(identity, (handlers.get(identity) ?? false) || provider)
  }
  return handlers
}

/** Функції множини й функції значень виміру — функції-запити. */
export function queryHeads(project: Project): Set<string> {
  return new Set([
    ...project.scopeKinds.flatMap((kind) =>
      typeof kind.setFunction === "string"
        ? []
        : [
            functionIdentity(
              kind.setFunction.schema ?? project.defaultSchema,
              kind.setFunction.name,
              []
            ),
          ]
    ),
    ...project.accessDimensions.flatMap((dimension) =>
      "function" in dimension.values
        ? [
            functionIdentity(
              dimension.values.function.schema ?? project.defaultSchema,
              dimension.values.function.name,
              []
            ),
          ]
        : []
    ),
  ])
}

/**
 * Ідентичності функцій-голів: обробники, функції множини й виміру, функції
 * закритих модулів. Виклик згенерованої функції, що пише, з голови судить
 * лише суддя голів (`call`), а не `sql.platform-function-call`.
 */
export function headFunctionIdentities(
  objects: readonly ParsedObject[],
  project: Project,
  units: readonly VerbatimUnit[]
): ReadonlySet<string> {
  const closed = closedModuleOwners(objects)
  return new Set([
    ...handlersOf(objects, project).keys(),
    ...queryHeads(project),
    ...units
      .filter(
        (u) =>
          u.class === "function" &&
          u.ownerFile !== undefined &&
          closed.has(u.ownerFile)
      )
      .map((u) => u.identity),
  ])
}

/**
 * Обробник `beforeWrite` таблиці провайдера не присвоює полів `NEW`
 * (спека прав §5.3): тригери платформи переносять рядок провайдера в «Користувачі»
 * й ідентичності, тож присвоєння змінило б таблицю виду повз команду.
 */
function assignsNew(unit: VerbatimUnit, plpgsql: PlpgsqlParser): boolean {
  const body = plpgsql(unit.sql)
  if (!body.ok || body.fn === undefined) return false
  return body.fn.statements.some(
    (statement) =>
      statement.type !== "declare" &&
      (statement.target?.variable.split(", ") ?? []).some((name) => {
        const lower = name.toLowerCase()
        return lower === "new" || lower.startsWith("new.")
      })
  )
}

/**
 * `sql.head-not-allowed` (спека прав §5.3) на кожній голові, оболонка якої пройшла
 * власну перевірку (`skip` — ідентичності голів і ключі блоків з
 * діагностикою оболонки): обробник — лише Правилом 2, хоч би де лежав, решта
 * функцій — Правилом 3, блок рухів — правилами відношень і викликів.
 */
export function checkHeads(
  objects: readonly ParsedObject[],
  project: Project,
  units: readonly VerbatimUnit[],
  scope: HeadScope,
  skip: ReadonlySet<string>
): Diagnostic[] {
  const handlers = handlersOf(objects, project)
  const queries = queryHeads(project)
  const closed = closedModuleOwners(objects)
  const found: Diagnostic[] = []
  const emit = (
    file: string,
    head: string,
    line: number,
    judgement: HeadJudgement
  ) => {
    for (const finding of judgement.findings) {
      found.push(
        diagnostic("sql.head-not-allowed", file, "", {
          head,
          chain: finding.chain.join(ARROW),
          construct: finding.construct,
          ...(finding.detail === undefined ? {} : { detail: finding.detail }),
          line,
        })
      )
    }
  }
  for (const unit of units) {
    if (unit.class !== "function" || skip.has(unit.identity)) continue
    const head = labelOf(unit)
    const provider = handlers.get(unit.identity)
    if (provider !== undefined) {
      const judgement = judgeHandler(unit, scope)
      emit(unit.file, head, unit.line, {
        ...judgement,
        findings: [
          ...judgement.findings,
          ...(provider && assignsNew(unit, scope.plpgsql)
            ? [
                {
                  chain: [head],
                  construct: "statement" as const,
                  detail: "assign",
                },
              ]
            : []),
        ],
      })
    } else if (
      queries.has(unit.identity) ||
      (unit.ownerFile !== undefined && closed.has(unit.ownerFile))
    ) {
      emit(
        unit.file,
        head,
        unit.line,
        judgeQueryFunction(unit, scope, [head], queries.has(unit.identity))
      )
    }
  }
  for (const object of objects) {
    for (const block of object.movementBlocks ?? []) {
      const key = blockHeadKey(block)
      const head = scope.wrappers.get(key)
      if (head === undefined || skip.has(key)) continue
      const parsed = scope.parse(block.sql)
      if (!parsed.ok) continue
      emit(
        block.file,
        head,
        block.line,
        judgeQuery(
          parsed.statements.map((s) => s.stmt),
          scope,
          [head],
          false
        )
      )
    }
  }
  return found
}

/**
 * Ланки голів без довіри й без знімка (спека прав §5.3): функції моделі, які голови
 * кличуть (за `схема.ім'я`, некваліфіковане — у будь-якій схемі), подання,
 * які читають, і функції дослівних політик читання прочитаних відношень —
 * транзитивно. Оболонку кожної задає лише `CREATE`, тож окремий `ALTER
 * FUNCTION` на будь-яку з них — помилка раннього блоку
 * (`sql.function-settings-shell`).
 */
export function headLinks(
  objects: readonly ParsedObject[],
  project: Project | undefined,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): VerbatimUnit[] {
  const closed = closedModuleOwners(objects)
  const heads = new Set([
    ...(project === undefined
      ? []
      : [...handlersOf(objects, project).keys(), ...queryHeads(project)]),
  ])
  const visited = new Set<string>()
  const reached: VerbatimUnit[] = []
  const queue: VerbatimUnit[] = []
  const enqueue = (unit: VerbatimUnit) => {
    if (visited.has(unit.identity)) return
    visited.add(unit.identity)
    if (ROUTINES.has(unit.class)) reached.push(unit)
    queue.push(unit)
  }
  const named = (classes: ReadonlySet<string>, name: string, schema?: string) =>
    units.filter(
      (u) =>
        classes.has(u.class) &&
        u.name === name &&
        (schema === undefined || u.schema === schema)
    )
  const policies = units.filter(
    (u) => u.class === "policy" && readingPolicy(u) !== undefined
  )
  const follow = (refs: readonly Reference[]) => {
    for (const ref of refs) {
      if (ref.space === "proc") {
        for (const unit of named(ROUTINES, ref.name, ref.schema)) enqueue(unit)
      } else if (ref.space === "attribute") {
        if (ref.bound) {
          for (const unit of named(ROUTINES, ref.name)) enqueue(unit)
        }
      } else if (ref.space === "rel") {
        for (const view of named(VIEWS, ref.name, ref.schema)) enqueue(view)
        for (const policy of policies) {
          const on = statementTargets(policy.tree as Node, "").some(
            (t) =>
              t.object === ref.name &&
              (t.schema === "" ||
                ref.schema === undefined ||
                t.schema === ref.schema)
          )
          if (on) enqueue(policy)
        }
      }
    }
  }
  for (const unit of units) {
    if (
      unit.class === "function" &&
      (heads.has(unit.identity) ||
        (unit.ownerFile !== undefined && closed.has(unit.ownerFile)))
    ) {
      enqueue(unit)
    }
  }
  for (const object of objects) {
    for (const block of object.movementBlocks ?? []) {
      const parsed = parse(block.sql)
      if (parsed.ok) {
        follow(
          parsed.statements.flatMap((s) => treeReferences(s.stmt, parse, false))
        )
      }
    }
  }
  for (let unit = queue.shift(); unit !== undefined; unit = queue.shift()) {
    follow(linkReferences(unit, parse, plpgsql))
  }
  return reached
}

/** Що називає одиниця для `headLinks`: усе, що виконує тіло, і вирази. */
function linkReferences(
  unit: VerbatimUnit,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Reference[] {
  if (unit.class === "policy") {
    const qual = readingPolicy(unit)?.qual
    return qual === undefined ? [] : treeReferences(qual, parse, true)
  }
  if (VIEWS.has(unit.class)) return treeReferences(unit.tree, parse, true)
  if (unit.class !== "function" && unit.class !== "procedure") return []
  const body = routineBody(unit.tree as Node, unit.sql, parse, plpgsql)
  return [
    ...body.statements.flatMap(({ stmt }) =>
      treeReferences(stmt, parse, false)
    ),
    ...body.values.flatMap(({ text }) => {
      const parsed = parse(text)
      return parsed.ok
        ? parsed.statements.flatMap((s) => treeReferences(s.stmt, parse, false))
        : []
    }),
    ...treeReferences(creationTree(unit), parse, true),
  ]
}
