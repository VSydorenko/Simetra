import type { Node } from "libpg-query"
import {
  KIND_REGISTRY,
  PLATFORM_SCHEMA,
  PROVIDER_FUNCTIONS,
  type PhysicalSnapshot,
  type PhysicalTable,
  type Project,
} from "simetra/model"
import { derivedFunctions } from "../contracts"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { movementWrapperName } from "../movement-functions"
import { PLATFORM_READ_FUNCTIONS } from "../platform/names"
import type { ParsedObject } from "../stages/files"
import type { ResolvedReference } from "../stages/identity"
import { BUILTIN_FUNCTIONS } from "./builtin-functions"
import {
  closedModuleOwners,
  extensionSchemas,
  hasEffectiveEmptySearchPath,
  routineLanguage,
} from "./closed-forms"
import { unitCalls, unitRelations } from "./dependencies"
import { routineBody } from "./function-body"
import type { SqlParser } from "./parse"
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
import {
  functionIdentity,
  inputArgumentTypes,
  type VerbatimUnit,
} from "./units"

/*
 * Голови (Р2c1-17): SQL застосунку, що виконується посеред команди чи під
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
 * (Р2c1-18 (б), (в)); `builtins` — дозвільний перелік вбудованих;
 * `wrappers` — `схема.ім'я` обгортки блоку рухів за `blockHeadKey`;
 * `extensions` — схеми застосунку з функціями боргових розширень (Р2c1-35).
 */
export interface HeadScope {
  units: readonly VerbatimUnit[]
  readable: ReadonlyMap<string, PhysicalTable>
  trusted: ReadonlySet<string>
  builtins: ReadonlySet<string>
  wrappers: ReadonlyMap<string, string>
  extensions: { all: boolean; schemas: ReadonlySet<string> }
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
    project.scopeKinds
  )
  const mainTable = (objectId: string) =>
    physical.tables.find(
      (t) =>
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
    builtins: new Set(BUILTIN_FUNCTIONS),
    wrappers,
    extensions: extensionSchemas(units, project.database.provider),
    parse,
    plpgsql,
  }
}

/** Посилання дерева: виклик, відношення, запис `x.f` чи оператор. */
interface Reference {
  space: "proc" | "rel" | "attribute" | "operator"
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
  ]
}

/**
 * Оператори з кваліфікацією поза `pg_catalog` (`OPERATOR(s.op)`): функцію
 * оператора компілятор не бачить. Некваліфікований оператор — вбудований чи
 * розширення (застосунок власних операторів не оголошує).
 */
function qualifiedOperators(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(qualifiedOperators)
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  const names = (
    (node.A_Expr as { name?: { String?: { sval?: string } }[] } | undefined)
      ?.name ?? []
  ).map((n) => n.String?.sval ?? "")
  const own =
    names.length > 1 && names.at(-2) !== "pg_catalog" ? [names.join(".")] : []
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

/** Одиниця моделі, як її бачить суддя: що з нею не так і що вона називає. */
interface Analysis {
  problems: { construct: HeadConstruct; detail?: string }[]
  refs: Reference[]
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
      }
    }
    if (VIEWS.has(unit.class)) {
      return {
        problems:
          sideEffectOf(unit.tree) === undefined ? [] : [{ construct: "query" }],
        refs: treeReferences(unit.tree, parse, true),
      }
    }
    const problems = queryFunctionProblems(unit, this.scope.units, parse)
    // Тіло, що не має форми запиту, не судиться далі: його вже відмовлено.
    if (problems.length > 0) return { problems, refs: [] }
    const body = parse(sqlBodyText(unit) ?? "")
    return {
      problems,
      refs: [
        ...(body.ok
          ? body.statements.flatMap((s) => treeReferences(s.stmt, parse, false))
          : []),
        ...treeReferences(creationTree(unit), parse, true),
      ],
    }
  }
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
  private readonly visited = new Set<string>()
  private readonly queue: { unit: VerbatimUnit; chain: readonly string[] }[] =
    []
  private readonly index: Index

  constructor(private readonly scope: HeadScope) {
    this.index = indexOf(scope)
  }

  report(chain: readonly string[], construct: HeadConstruct, detail?: string) {
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
    this.visited.add(unit.identity)
  }

  /** Корінь обходу: одиниця, ланцюжок якої вже називає її саму. */
  start(unit: VerbatimUnit, chain: readonly string[]) {
    this.visited.add(unit.identity)
    this.queue.push({ unit, chain })
  }

  private enqueue(unit: VerbatimUnit, chain: readonly string[]) {
    if (this.visited.has(unit.identity)) return
    this.visited.add(unit.identity)
    this.queue.push({ unit, chain: [...chain, labelOf(unit)] })
  }

  /** Розібрані оператори чи вирази в контексті одиниці ланцюжка `chain`. */
  trees(trees: readonly unknown[], chain: readonly string[], bound: boolean) {
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
      const analysis = this.index.analysis(step.unit)
      for (const p of analysis.problems)
        this.report(step.chain, p.construct, p.detail)
      this.references(analysis.refs, step.chain)
    }
    return { findings: [...this.found.values()], relations: this.relations }
  }

  private references(refs: readonly Reference[], chain: readonly string[]) {
    for (const ref of refs) {
      if (ref.space === "proc") this.call(ref, chain)
      else if (ref.space === "rel") this.relation(ref, chain)
      else if (ref.space === "operator")
        this.report(chain, "operator", ref.name)
      // З порожнім шляхом функції `x.f` розв'язується лише в `pg_catalog`.
      else if (ref.bound) this.attribute(ref.name, chain)
    }
  }

  /**
   * Виклик (Р2c1-18): функція моделі — під тим самим правилом (кожне
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
      if (
        routines.some((u) => u.class !== "function") ||
        this.shadowed(schema)
      ) {
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
    if (
      routines.some((u) => u.class !== "function" || this.shadowed(u.schema))
    ) {
      this.report(chain, "call", name)
      return
    }
    for (const unit of routines) this.enqueue(unit, chain)
  }

  /**
   * Схема, де функція боргового розширення могла б перевантажити функцію
   * моделі (Р2c1-35): функцій розширень серед одиниць немає, тож суддя не
   * бачить, у котру з них Postgres розв'яже виклик.
   */
  private shadowed(schema: string): boolean {
    const { all, schemas } = this.scope.extensions
    return all || schemas.has(schema)
  }

  /**
   * Відношення (Р2c1-18): кваліфіковані таблиця виду чи `CustomTable` поза
   * схемою платформи або подання моделі під тим самим правилом. Таблиця з
   * RLS обчислює посеред команди дослівні політики читання (Р2c1-23), тож
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
    this.relations.push({ chain, relation: qualified })
    const key = `table:${qualified}`
    if (table.rowLevelSecurity === "off" || this.visited.has(key)) return
    this.visited.add(key)
    for (const policy of this.index.policiesOn(table))
      this.enqueue(policy, chain)
  }
}

/**
 * Функція-запит (Р2c1-18) і все, що вона досягає: форма, виклики,
 * відношення, подання й політики прочитаних таблиць.
 */
export function judgeQueryFunction(
  unit: VerbatimUnit,
  scope: HeadScope,
  chain: readonly string[]
): HeadJudgement {
  const { judgements } = indexOf(scope)
  const key = `${unit.identity}\0${chain.join(ARROW)}`
  let judgement = judgements.get(key)
  if (judgement === undefined) {
    const walk = new Walk(scope)
    walk.start(unit, chain)
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
 * CHECK кожного домену моделі (Р2c1-33), борг теж: голова виконує його,
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
 * Оператори, якими обробник перевіряє рядок (Р2c1-19). Запис в інші таблиці
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
function queryHeads(project: Project): Set<string> {
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
 * (Р2c1-39): тригери платформи переносять рядок провайдера в «Користувачі»
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
 * `sql.head-not-allowed` (Р2c1-17) на кожній голові, оболонка якої пройшла
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
      emit(unit.file, head, unit.line, judgeQueryFunction(unit, scope, [head]))
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
 * Ланки голів без довіри й без знімка (Р2c1-31): функції моделі, які голови
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
