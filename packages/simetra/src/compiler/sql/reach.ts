import type { Node } from "libpg-query"
import {
  PLATFORM_SCHEMA,
  type PhysicalTable,
  type Project,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import type { ParsedObject } from "../stages/files"
import {
  closedModuleOwners,
  functionSettingsOf,
  hasEffectiveEmptySearchPath,
  routineLanguage,
  ruledFunctions,
} from "./closed-forms"
import {
  commandContextWrite,
  isBuiltinSetConfig,
  literalDynamicText,
  literalText,
} from "./command-context"
import { unitCalls, unitRelations, type ReferencedName } from "./dependencies"
import type { SqlParser } from "./parse"
import type { PlpgsqlExpression, PlpgsqlParser } from "./plpgsql"
import { splitAssignment } from "./rewrite/plpgsql-body"
import { statementTargets } from "./unit-target"
import { inputArgumentTypes, type VerbatimUnit } from "./units"

/**
 * Вбудовані функції, що виконують SQL з рядка: обхід бачить лише дерево, а не
 * текст, який вони виконають, тож будь-яке читання чи запис у ньому —
 * невидимі. Один перелік для обходу досяжності й функцій значень виміру.
 */
export const DYNAMIC_SQL_BUILTINS: ReadonlySet<string> = new Set([
  "query_to_xml",
  "query_to_xml_and_xmlschema",
  "query_to_xmlschema",
  "table_to_xml",
  "table_to_xml_and_xmlschema",
  "table_to_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
  "schema_to_xml",
  "schema_to_xmlschema",
  "schema_to_xml_and_xmlschema",
  "database_to_xml",
  "database_to_xmlschema",
  "database_to_xml_and_xmlschema",
  // Аргумент-запит `tsvector`/`tsquery` — теж текст, що виконується.
  "ts_stat",
  "ts_rewrite",
])

/**
 * Функції схем провайдера, що виконують SQL з рядка (кваліфіковані імена):
 * решті функцій цих схем обхід довіряє (Р2c1-5, п. 4). Нова функція
 * провайдера такого роду потребує поповнення переліку. Обгортка над такою
 * функцією теж її виконує: `graphql_public.graphql` — sql-функція над
 * `graphql.resolve`, яку Supabase ставить разом із pg_graphql.
 */
export const UNSAFE_PROVIDER_FUNCTIONS: ReadonlySet<string> = new Set([
  "extensions.dblink",
  "extensions.dblink_exec",
  "extensions.dblink_send_query",
  "extensions.dblink_open",
  "graphql.resolve",
  "graphql_public.graphql",
  "pgtle.install_extension",
])

/**
 * Голі імена `UNSAFE_PROVIDER_FUNCTIONS`: типовий `search_path` провайдера
 * містить його схеми (`extensions` у Supabase), тож некваліфікований виклик
 * без порожнього `search_path` може розв'язатися саме туди.
 */
const UNSAFE_PROVIDER_NAMES: ReadonlySet<string> = new Set(
  [...UNSAFE_PROVIDER_FUNCTIONS].map((name) => name.split(".").at(-1)!)
)

/** Чому функцію, досяжну із закритого коду, компілятор не може судити. */
export type Unjudgeable =
  "nonLiteralExecute" | "language" | "dynamicBuiltin" | "unknown"
/** Причина знахідки обходу: недосудність або запис налаштувань сесії. */
export type ReachReason = Unjudgeable | "sessionWrite"

/**
 * Довірені множини обходу: схеми провайдера (`PROVIDER_SCHEMAS`) і
 * `схема.ім'я` згенерованих функцій схем застосунку, тіла яких пише
 * компілятор. Будує стадія 5.
 */
export interface ReachTrust {
  providerSchemas: ReadonlySet<string>
  generated: ReadonlySet<string>
}

/** Одиниця моделі, досяжна з голови, і шлях імен до неї від голови. */
export interface Reached {
  unit: VerbatimUnit
  chain: string[]
}

/** Недосудна ціль чи досяжна функція із записом сесії. */
export interface ReachFinding {
  function: string
  chain: string[]
  reason: ReachReason
}

const ARROW = " → "

/** Класи простору `pg_proc`, у які розв'язується виклик. */
const ROUTINES: ReadonlySet<string> = new Set([
  "function",
  "procedure",
  "aggregate",
])
/** Класи з тілом, яке виконується; агрегат лише називає функції-складові. */
const BODIES: ReadonlySet<string> = new Set(["function", "procedure"])
const VIEWS: ReadonlySet<string> = new Set(["view", "materializedView"])

/**
 * Посилання одиниці. `bound` — ім'я зв'язано під час створення з
 * `search_path` сесії (значення аргументів за замовчуванням, тіло `BEGIN
 * ATOMIC`, подання, політика, вираз таблиці), а не з `search_path` функції
 * під час виконання. `attribute` — запис `x.f`, яким Postgres кличе `f(x)`;
 * `write` — таблиця, у яку пише `INSERT`/`UPDATE`/`MERGE`.
 */
interface Reference extends ReferencedName {
  space: "proc" | "rel" | "attribute" | "write"
  bound: boolean
}

/**
 * Що видно в одиниці: посилання, власна недосудність тіла й `opaque` —
 * частина тіла, яку компілятор не прочитав (вираз plpgsql чи текст
 * літерального `EXECUTE`, що не розбирається, блок `DO`, `EXECUTE`
 * підготовленого оператора сесії): виклики в ній невидимі.
 */
interface Analysis {
  refs: Reference[]
  problem?: Unjudgeable
  opaque: boolean
  /**
   * Одиниця сама змінює `search_path` (`SET`, `RESET`, `set_config`): далі в
   * її тілі некваліфіковане ім'я розв'язується вже не за шляхом `CREATE`, а
   * досягнута — змінює шлях викликача (`traverse`).
   */
  pathWrite?: true
}

interface FunctionTree {
  options?: { DefElem?: { defname?: string; arg?: unknown } }[]
  sql_body?: unknown
}

/**
 * Недосудність функції чи процедури моделі (Р2c1-5) — власний предикат, не
 * `closedShellProblem`: та рахує літеральний `EXECUTE` динамічним і
 * повертає `volatility`/`searchPath` раніше за тіло. Мова поза
 * `sql`/`plpgsql` — `language`; тіло чи його частина, що не розбирається, —
 * `unknown`; `EXECUTE` з нелітеральним текстом — `nonLiteralExecute`. Інший
 * клас — `undefined`: тіла, що виконується, у нього немає.
 */
export function unjudgeable(
  unit: VerbatimUnit,
  plpgsql: PlpgsqlParser,
  parse: SqlParser
): Unjudgeable | undefined {
  return BODIES.has(unit.class)
    ? problemOf(analyze(unit, parse, plpgsql))
    : undefined
}

function problemOf(analysis: Analysis): Unjudgeable | undefined {
  return analysis.problem ?? (analysis.opaque ? "unknown" : undefined)
}

/**
 * Одиниці моделі (функції, процедури, агрегати, подання, дослівні політики),
 * досяжні з голови обходом `reachableCalls`; сама голова не входить.
 */
export function reachableUnits(
  head: VerbatimUnit,
  units: readonly VerbatimUnit[],
  trusted: ReachTrust,
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  tables: readonly PhysicalTable[]
): Reached[] {
  return traverse(head, new ReachModel(units, tables, parse, plpgsql), trusted)
    .reached
}

/**
 * Межа довіри закритого коду (Р2b1-19, Р2c1-5, Р2c1-10): функції закритих
 * модулів, обробники підписок і функції множини виконуються посеред
 * оператора команди, тож усе, що вони досягають, мусить бути кодом, який
 * компілятор може судити. Обхід у ширину від голови за викликами (тіла `sql`
 * і вирази plpgsql, текст літерального `EXECUTE`, значення аргументів за
 * замовчуванням, `CALL`, запис `x.f`), за поданнями моделі, за дослівними
 * політиками таблиць, які одиниця читає чи пише (Postgres обчислює їх посеред
 * команди), і за виразами таблиць знімка, у які одиниця пише сама чи через
 * подання моделі (`DEFAULT`, `CHECK`, генеровані колонки, ключі й предикати
 * індексів; вираз, що не розбирається, робить таблицю недосудною —
 * `unknown`, а вираз із записом налаштувань сесії — `sessionWrite`). Кожна
 * недосудна ціль і кожна досяжна одиниця чи таблиця, що пише налаштування
 * сесії, — раз; голова
 * судиться лише за досяжним, не за власним тілом (його судить оболонка), крім
 * частини тіла, якої компілятор не прочитав.
 *
 * Класифікація виклику, у порядку. (1) Функція моделі — обходиться, і цей
 * пріоритет стоїть над переліком схем провайдера: функцію моделі в схемі
 * провайдера пише застосунок. Некваліфіковане ім'я Postgres розв'язує за
 * `search_path`: з ефективним порожнім шляхом викликача під час виконання —
 * лише вбудована, інакше — кожна функція моделі з таким ім'ям у будь-якій
 * схемі (fail-closed). (2) Схема платформи чи згенерована функція — довірена.
 * (3) Некваліфікована чи `pg_catalog.*` — вбудована; з `DYNAMIC_SQL_BUILTINS`
 * (і голе ім'я `UNSAFE_PROVIDER_FUNCTIONS` без порожнього шляху) —
 * `dynamicBuiltin` навіть поруч з однойменною функцією моделі: `pg_catalog`
 * у шляху першим, а перевантаження розв'язується за типами. (4) Схема
 * провайдера — довірена, крім `UNSAFE_PROVIDER_FUNCTIONS`. (5) Решта —
 * `unknown`.
 */
export function reachableCalls(
  head: VerbatimUnit,
  units: readonly VerbatimUnit[],
  trusted: ReachTrust,
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  tables: readonly PhysicalTable[]
): ReachFinding[] {
  return traverse(head, new ReachModel(units, tables, parse, plpgsql), trusted)
    .findings
}

/**
 * `sql.command-context-reach` (Р2c1-5) на кожній голові обходу: функції
 * закритого модуля, обробнику підписки й функції множини скоупу.
 */
export function checkCommandContextReach(
  objects: readonly ParsedObject[],
  project: Project,
  units: readonly VerbatimUnit[],
  tables: readonly PhysicalTable[],
  trusted: ReachTrust,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Diagnostic[] {
  const closed = closedModuleOwners(objects)
  const ruled = ruledFunctions(objects, project)
  // Одна модель на всі голови: спільні функції досягають з багатьох голів.
  const model = new ReachModel(units, tables, parse, plpgsql)
  return units
    .filter(
      (u) =>
        u.class === "function" &&
        ((u.ownerFile !== undefined && closed.has(u.ownerFile)) ||
          ruled.has(u.identity))
    )
    .flatMap((head) =>
      traverse(head, model, trusted).findings.map((found) =>
        diagnostic("sql.command-context-reach", head.file, "", {
          function: found.function,
          chain: found.chain.join(ARROW),
          reason: found.reason,
        })
      )
    )
}

/**
 * Одиниці й таблиці, серед яких іде обхід, з розбором кожної одиниці раз:
 * тіла розбираються недешево, а спільну функцію досягають кілька голів.
 */
class ReachModel {
  readonly routines: readonly VerbatimUnit[]
  readonly views: readonly VerbatimUnit[]
  /**
   * Ціль політики — з дерева (`statementTargets`); порожня схема —
   * некваліфіковане ім'я, яке Postgres розв'язав за шляхом сесії.
   */
  readonly policies: readonly {
    unit: VerbatimUnit
    schema: string
    table: string
  }[]
  private readonly analyses = new Map<VerbatimUnit, Analysis>()
  private readonly verdicts = new Map<VerbatimUnit, ReachReason | undefined>()
  private readonly emptyPaths = new Map<VerbatimUnit, boolean>()
  private readonly tableRefs = new Map<PhysicalTable, TableAnalysis>()

  constructor(
    readonly units: readonly VerbatimUnit[],
    readonly tables: readonly PhysicalTable[],
    private readonly parse: SqlParser,
    private readonly plpgsql: PlpgsqlParser
  ) {
    this.routines = units.filter((u) => ROUTINES.has(u.class))
    this.views = units.filter((u) => VIEWS.has(u.class))
    this.policies = units.flatMap((unit) =>
      unit.class !== "policy"
        ? []
        : statementTargets(unit.tree as Node, "").map((target) => ({
            unit,
            schema: target.schema,
            table: target.object ?? "",
          }))
    )
  }

  analysis(unit: VerbatimUnit): Analysis {
    let found = this.analyses.get(unit)
    if (found === undefined) {
      found = analyze(unit, this.parse, this.plpgsql)
      this.analyses.set(unit, found)
    }
    return found
  }

  /** Знахідка досягнутої одиниці: недосудність, інакше запис сесії. */
  verdict(unit: VerbatimUnit): ReachReason | undefined {
    if (this.verdicts.has(unit)) return this.verdicts.get(unit)
    const problem = BODIES.has(unit.class)
      ? problemOf(this.analysis(unit))
      : undefined
    const found =
      problem ??
      (writesSession(unit, this.units, this.parse, this.plpgsql)
        ? "sessionWrite"
        : undefined)
    this.verdicts.set(unit, found)
    return found
  }

  emptyPath(unit: VerbatimUnit): boolean {
    let found = this.emptyPaths.get(unit)
    if (found === undefined) {
      found = emptyPathOf(unit, this.analysis(unit), this.units)
      this.emptyPaths.set(unit, found)
    }
    return found
  }

  tableReferences(table: PhysicalTable): TableAnalysis {
    let found = this.tableRefs.get(table)
    if (found === undefined) {
      found = tableReferences(table, this.parse, this.plpgsql)
      this.tableRefs.set(table, found)
    }
    return found
  }
}

/**
 * Порожній `search_path` під час виконання тіла: ефективний порожній шлях
 * функції, якого тіло саме не змінює.
 */
function emptyPathOf(
  unit: VerbatimUnit,
  analysis: Analysis,
  units: readonly VerbatimUnit[]
): boolean {
  return (
    BODIES.has(unit.class) &&
    analysis.pathWrite !== true &&
    hasEffectiveEmptySearchPath(unit, units)
  )
}

/**
 * Відношення, які одиниця читає чи пише, з того самого розбору, що й обхід
 * (тіло `sql`, вирази plpgsql, текст літерального `EXECUTE`, визначення
 * подання): два прочитання одного тіла розійшлися б. Некваліфіковане ім'я,
 * яке з порожнім `search_path` може назвати лише `pg_catalog` чи `pg_temp`,
 * не входить; решта некваліфікованих — без схеми (збіг у будь-якій схемі,
 * fail-closed): шлях, за яким Postgres їх розв'яже, статично не відомий.
 */
export function relationReads(
  unit: VerbatimUnit,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): ReferencedName[] {
  const analysis = analyze(unit, parse, plpgsql)
  const empty = emptyPathOf(unit, analysis, units)
  return analysis.refs.flatMap((ref): ReferencedName[] => {
    if (ref.space !== "rel") return []
    if (ref.schema === undefined)
      return empty && !ref.bound ? [] : [{ name: ref.name }]
    return [{ schema: ref.schema, name: ref.name }]
  })
}

/** Вузол черги: одиниця моделі чи таблиця знімка, у яку пишуть. */
type Step =
  | { unit: VerbatimUnit; chain: readonly string[] }
  | { table: PhysicalTable; chain: readonly string[] }

interface Walk {
  reached: Reached[]
  findings: ReachFinding[]
  /** Досягнута одиниця чи вираз таблиці пише `search_path`. */
  pathWritten: boolean
}

/**
 * Обхід від голови. Досягнута одиниця, що пише `search_path`, змінює шлях
 * викликачів: `set_config(…, true)` у функції без власної опції діє до виходу
 * з найближчої функції з опцією, а `SET` без `LOCAL` чи `set_config(…, false)`
 * переживає й вихід із неї. Котрі виклики виконаються після запису, статично
 * не видно, тож тоді обхід повторюється з непорожнім шляхом для всіх одиниць,
 * голови теж (fail-closed): некваліфіковане ім'я судиться так, ніби Postgres
 * розв'язав його за шляхом сесії.
 */
function traverse(
  head: VerbatimUnit,
  model: ReachModel,
  trusted: ReachTrust
): { reached: Reached[]; findings: ReachFinding[] } {
  const first = walk(head, model, trusted, false)
  return first.pathWritten ? walk(head, model, trusted, true) : first
}

function walk(
  head: VerbatimUnit,
  model: ReachModel,
  trusted: ReachTrust,
  sessionPath: boolean
): Walk {
  let pathWritten = false
  const reached: Reached[] = []
  const findings = new Map<string, ReachFinding>()
  const report = (
    fn: string,
    chain: readonly string[],
    reason: ReachReason
  ) => {
    const key = `${fn}\0${reason}`
    if (!findings.has(key)) {
      findings.set(key, { function: fn, chain: [...chain], reason })
    }
  }
  const visited = new Set<string>([head.identity])
  const queue: Step[] = [{ unit: head, chain: [labelOf(head)] }]
  const enqueue = (unit: VerbatimUnit, chain: readonly string[]) => {
    if (visited.has(unit.identity)) return
    visited.add(unit.identity)
    const next = [...chain, labelOf(unit)]
    reached.push({ unit, chain: next })
    const verdict = model.verdict(unit)
    if (verdict !== undefined) report(labelOf(unit), next, verdict)
    queue.push({ unit, chain: next })
  }
  const enqueueTable = (table: PhysicalTable, chain: readonly string[]) => {
    const key = `table:${table.schema}.${table.name}`
    if (visited.has(key)) return
    visited.add(key)
    queue.push({ table, chain: [...chain, `${table.schema}.${table.name}`] })
  }

  const call = (ref: Reference, empty: boolean, chain: readonly string[]) => {
    const { schema, name } = ref
    const qualified = schema === undefined ? name : `${schema}.${name}`
    const routines = model.routines.filter(
      (u) =>
        u.name === name && (schema === undefined ? !empty : u.schema === schema)
    )
    for (const target of routines) enqueue(target, chain)
    const builtin = schema === undefined || schema === "pg_catalog"
    const unsafe = builtin
      ? DYNAMIC_SQL_BUILTINS.has(name) ||
        (schema === undefined && !empty && UNSAFE_PROVIDER_NAMES.has(name))
      : UNSAFE_PROVIDER_FUNCTIONS.has(qualified)
    if (unsafe) {
      report(qualified, [...chain, qualified], "dynamicBuiltin")
      return
    }
    if (builtin || routines.length > 0) return
    if (
      schema === PLATFORM_SCHEMA ||
      trusted.generated.has(qualified) ||
      trusted.providerSchemas.has(schema)
    ) {
      return
    }
    report(qualified, [...chain, qualified], "unknown")
  }
  const relation = (
    ref: Reference,
    empty: boolean,
    chain: readonly string[]
  ) => {
    const { schema, name } = ref
    // З порожнім шляхом некваліфіковане відношення — лише `pg_temp` чи
    // `pg_catalog`: подань і політик моделі там немає.
    if (schema === undefined && empty) return
    for (const view of model.views) {
      if (
        view.name === name &&
        (schema === undefined || view.schema === schema)
      )
        enqueue(view, chain)
    }
    for (const policy of model.policies) {
      if (
        policy.table === name &&
        (schema === undefined ||
          policy.schema === "" ||
          policy.schema === schema)
      ) {
        enqueue(policy.unit, chain)
      }
    }
  }

  /**
   * Ціль `INSERT`/`UPDATE`/`MERGE`: таблиця знімка — її вирази в черзі.
   * Запис у подання моделі Postgres переписує на запис у базове відношення
   * (автооновлюване подання) і обчислює вирази його таблиці; котре з
   * відношень подання базове, без каталогу не видно, тож ціллю стає кожне
   * (fail-closed), рекурсивно. Імена подання зв'язано під час створення.
   */
  const write = (
    schema: string | undefined,
    name: string,
    chain: readonly string[],
    through: Set<VerbatimUnit>
  ) => {
    for (const table of model.tables) {
      if (
        table.name === name &&
        (schema === undefined || table.schema === schema)
      ) {
        enqueueTable(table, chain)
      }
    }
    for (const view of model.views) {
      if (
        view.name !== name ||
        (schema !== undefined && view.schema !== schema) ||
        through.has(view)
      ) {
        continue
      }
      through.add(view)
      for (const ref of model.analysis(view).refs) {
        if (ref.space === "rel") {
          write(ref.schema, ref.name, [...chain, labelOf(view)], through)
        }
      }
    }
  }

  for (let step = queue.shift(); step !== undefined; step = queue.shift()) {
    const { chain } = step
    let refs: readonly Reference[]
    let emptyPath = false
    if ("table" in step) {
      const analysis = model.tableReferences(step.table)
      refs = analysis.refs
      pathWritten ||= analysis.pathWrite
      // Вираз, якого розбір не прочитав, Postgres однаково обчислить посеред
      // запису: його виклики невидимі, тож таблиця — недосудна ланка.
      const label = `${step.table.schema}.${step.table.name}`
      if (analysis.opaque) report(label, chain, "unknown")
      if (analysis.sessionWrite) report(label, chain, "sessionWrite")
    } else {
      const analysis = model.analysis(step.unit)
      refs = analysis.refs
      emptyPath = !sessionPath && model.emptyPath(step.unit)
      // Власний запис голови вже знято з її шляху (`emptyPathOf`), а
      // викликані нею функції з опцією шляху ставлять його на вході.
      if (step.unit !== head) pathWritten ||= analysis.pathWrite === true
      // Голова: власну недосудність судить оболонка, а непрочитану частину
      // тіла — ніхто, тож вона знахідка обходу.
      if (step.unit === head && analysis.opaque) {
        report(labelOf(head), chain, "unknown")
      }
    }
    for (const ref of refs) {
      const empty = emptyPath && !ref.bound
      if (ref.space === "proc") call(ref, empty, chain)
      else if (ref.space === "rel") relation(ref, empty, chain)
      else if (ref.space === "attribute") {
        if (empty) continue
        for (const target of model.routines) {
          if (target.name === ref.name && singleArgument(target))
            enqueue(target, chain)
        }
      } else if (!(ref.schema === undefined && empty)) {
        write(ref.schema, ref.name, chain, new Set())
      }
    }
  }
  return { reached, findings: [...findings.values()], pathWritten }
}

/** Ім'я одиниці в ланцюжку: `схема.ім'я`, а політика — її ідентичністю. */
function labelOf(unit: VerbatimUnit): string {
  return unit.class === "policy" ? unit.identity : `${unit.schema}.${unit.name}`
}

/**
 * Запис налаштувань сесії досягнутою одиницею (Р2c1-10 (а)): у тілі, в
 * опціях `SET` самого `CREATE` чи в будь-якій її одиниці `ALTER FUNCTION`.
 * Посеред команди така одиниця підмінила б claims, з яких
 * `current_user_id()` бере користувача прав, чи контекст команди.
 */
function writesSession(
  unit: VerbatimUnit,
  units: readonly VerbatimUnit[],
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): boolean {
  const writes = (u: VerbatimUnit) =>
    commandContextWrite(u.tree as Node, u.sql, parse, plpgsql).length > 0
  return (
    writes(unit) ||
    (BODIES.has(unit.class) && functionSettingsOf(unit, units).some(writes))
  )
}

/** Функція з одним вхідним аргументом: її кличе й запис `x.f`. */
function singleArgument(unit: VerbatimUnit): boolean {
  const fn = (unit.tree as { CreateFunctionStmt?: object }).CreateFunctionStmt
  return (
    fn !== undefined &&
    inputArgumentTypes(fn as Parameters<typeof inputArgumentTypes>[0])
      .length === 1
  )
}

function analyze(
  unit: VerbatimUnit,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Analysis {
  if (BODIES.has(unit.class)) return analyzeBody(unit, parse, plpgsql)
  return {
    refs: treeReferences(unit.tree, parse, true),
    opaque: false,
    ...(writesSearchPath(unit.tree) ? { pathWrite: true } : {}),
  }
}

function analyzeBody(
  unit: VerbatimUnit,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): Analysis {
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionTree })
    .CreateFunctionStmt
  if (fn === undefined) return { refs: [], problem: "unknown", opaque: false }
  const options = fn.options ?? []
  // Усе, крім рядкового тіла, зв'язано під час створення: значення
  // аргументів за замовчуванням і тіло `BEGIN ATOMIC` (`sql_body`).
  const refs = treeReferences(
    {
      CreateFunctionStmt: {
        ...fn,
        options: options.filter((o) => o.DefElem?.defname !== "as"),
      },
    },
    parse,
    true
  )
  const language = routineLanguage(unit.tree as Node)
  let opaque = false
  let pathWrite = false
  // Текст тіла, що виконується з `search_path` функції. Нерозбірний текст,
  // блок `DO` і `EXECUTE` підготовленого оператора сесії ховають виклики.
  const read = (text: string) => {
    const parsed = parse(text)
    if (!parsed.ok) {
      opaque = true
      return
    }
    for (const s of parsed.statements) {
      refs.push(...treeReferences(s.stmt, parse, false))
      opaque ||= hasKey(s.stmt, OPAQUE_STATEMENTS)
      pathWrite ||= writesSearchPath(s.stmt)
    }
  }
  const result = (problem?: Unjudgeable): Analysis => ({
    refs,
    opaque,
    ...(problem === undefined ? {} : { problem }),
    ...(pathWrite ? { pathWrite: true } : {}),
  })
  if (language === "sql") {
    if (fn.sql_body !== undefined) return result()
    const body = (
      options.find((o) => o.DefElem?.defname === "as")?.DefElem?.arg as
        { List?: { items?: { String?: { sval?: string } }[] } } | undefined
    )?.List?.items?.[0]?.String?.sval
    if (body === undefined) opaque = true
    else read(body)
    return result()
  }
  if (language !== "plpgsql") return result("language")
  const body = plpgsql(unit.sql)
  if (!body.ok || body.fn === undefined) return result("unknown")
  let problem: Unjudgeable | undefined
  for (const statement of body.fn.statements) {
    for (const e of statement.expressions) {
      if (e.role === "dynamic") {
        // Літеральний текст — звичайний SQL, лише записаний рядком: його
        // виклики обходяться, як і решта тіла (Р2c1-5).
        const text = literalDynamicText(e.query, parse)
        if (text === undefined) problem = "nonLiteralExecute"
        else read(text)
        continue
      }
      const texts = expressionTexts(e)
      if (texts === undefined) opaque = true
      else for (const text of texts) read(text)
    }
  }
  return result(problem)
}

const OPAQUE_STATEMENTS = ["DoStmt", "ExecuteStmt"]

function hasKey(value: unknown, keys: readonly string[]): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKey(v, keys))
  if (typeof value !== "object" || value === null) return false
  const node = value as Record<string, unknown>
  return (
    keys.some((key) => key in node) ||
    Object.values(node).some((v) => hasKey(v, keys))
  )
}

/**
 * Чи оператор змінює `search_path`: `SET`/`RESET search_path`, `RESET ALL`
 * чи вбудований `set_config` з ім'ям `search_path` або нелітеральним ім'ям
 * (fail-closed).
 */
function writesSearchPath(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(writesSearchPath)
  if (typeof value !== "object" || value === null) return false
  const node = value as Record<string, unknown>
  const set = node.VariableSetStmt as { kind?: string; name?: string }
  if (
    set !== undefined &&
    (set.kind === "VAR_RESET_ALL" || set.name?.toLowerCase() === "search_path")
  ) {
    return true
  }
  const call = node.FuncCall as
    | { funcname?: { String?: { sval?: string } }[]; args?: unknown[] }
    | undefined
  if (call !== undefined && isBuiltinSetConfig(call.funcname)) {
    const name = literalText(call.args?.[0])
    if (name === undefined || name.toLowerCase() === "search_path") return true
  }
  return Object.values(node).some(writesSearchPath)
}

/**
 * Тексти виразу plpgsql як оператори SQL. На відміну від
 * `plpgsqlExpressionTrees` ціль присвоєння теж читається: індекс
 * `a[public.f()] := …` — виклик; нерозбірна межа присвоєння — `undefined`
 * (fail-closed), а не пропуск.
 */
function expressionTexts(e: PlpgsqlExpression): string[] | undefined {
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

/**
 * Посилання виразів таблиці й `opaque` — вираз, що не розбирається: мовчки
 * пропущений, він сховав би виклик, який Postgres виконає посеред запису.
 */
interface TableAnalysis {
  refs: Reference[]
  opaque: boolean
  pathWrite: boolean
  /** Вираз пише захищене налаштування сесії (`commandContextWrite`). */
  sessionWrite: boolean
}

/** Вирази таблиці, які Postgres обчислює, коли в неї пишуть. */
function tableReferences(
  table: PhysicalTable,
  parse: SqlParser,
  plpgsql: PlpgsqlParser
): TableAnalysis {
  const expressions: string[] = []
  for (const column of table.columns) {
    if (column.default !== undefined) expressions.push(column.default)
    if (column.generated !== undefined) {
      expressions.push(column.generated.expression)
    }
  }
  for (const check of table.checks) expressions.push(check.expression)
  for (const index of table.indexes) {
    if (index.where !== undefined) expressions.push(index.where)
    for (const key of index.keys) {
      if ("expression" in key) expressions.push(key.expression)
    }
  }
  let opaque = false
  let pathWrite = false
  let sessionWrite = false
  const refs = expressions.flatMap((expression) => {
    const parsed = parse(`SELECT (${expression})`)
    if (!parsed.ok) {
      opaque = true
      return []
    }
    return parsed.statements.flatMap((s) => {
      pathWrite ||= writesSearchPath(s.stmt)
      // Те саме правило, що й для одиниці (`writesSession`): вираз таблиці
      // виконується посеред команди, як і досягнута функція.
      sessionWrite ||=
        commandContextWrite(s.stmt as Node, "", parse, plpgsql).length > 0
      return treeReferences(s.stmt, parse, true)
    })
  })
  return { refs, opaque, pathWrite, sessionWrite }
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
    ...writtenTables(tree).map((r): Reference => ({
      ...r,
      space: "write",
      bound,
    })),
  ]
}

/**
 * Останні імена записів `x.f` і `(x).f`: Postgres читає їх і як колонку, і
 * як виклик `f(x)` функції з одним аргументом складеного типу.
 */
function attributeNames(value: unknown): string[] {
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

const WRITES = ["InsertStmt", "UpdateStmt", "MergeStmt"]

/** Таблиці, у які пише оператор дерева. */
function writtenTables(value: unknown): ReferencedName[] {
  if (Array.isArray(value)) return value.flatMap(writtenTables)
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  const found = WRITES.flatMap((key) => {
    const relation = (
      node[key] as
        { relation?: { schemaname?: string; relname?: string } } | undefined
    )?.relation
    if (relation?.relname === undefined) return []
    return [
      relation.schemaname === undefined
        ? { name: relation.relname }
        : { schema: relation.schemaname, name: relation.relname },
    ]
  })
  return [...found, ...Object.values(node).flatMap(writtenTables)]
}
