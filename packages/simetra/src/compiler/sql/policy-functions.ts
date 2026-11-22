import type { Node } from "libpg-query"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  type DatabaseProvider,
  type GrantPurpose,
  type PhysicalTable,
} from "simetra/model"
import { diagnostic, type Diagnostic } from "../diagnostics"
import { CURRENT_USER_FUNCTION } from "../platform/names"
import type { PlatformFormSource } from "./closed-forms"
import { routineLanguage } from "./closed-forms"
import { isSecurityDefiner } from "./definer-reads"
import { unitCalls, unitRelations, type ReferencedName } from "./dependencies"
import { callersOfRole } from "./execute-grants"
import { routineBody } from "./function-body"
import { checkHeadSettings } from "./function-settings-shell"
import { PUBLIC, grantFacts, type GrantFact } from "./grant-facts"
import {
  attributeNames,
  judgeQueryFunction,
  sessionReads,
  singleArgument,
  type HeadScope,
} from "./heads"
import { functionIdentity, qualifiedName } from "./identity"
import type { SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import { sqlBodyText } from "./query-shape"
import { statementTargets } from "./unit-target"
import type { VerbatimUnit } from "./units"

/*
 * Функції політик боргу (спека декларацій функцій §5.8, ADR-0094): definer-
 * функція, яку прямо кличе вираз дослівної політики, — форма платформи, коли
 * її прямий виклик як RPC нешкідливий: вивід — ключ таблиці T політик-
 * викликачів, прив'язаний до актора, з межами `RESTRICTIVE` T у `WHERE`, а
 * політика — `OR` атомів над цим ключем. Розпізнавання й суд — за деревами
 * розбору; голову судить наявний суддя голів (Правило 3).
 */

/**
 * Причина `sql.policy-helper-correlated` у порядку переліку §5.8: перша — у
 * `params.reason`, решта — у `detail`, щоб ключ ремонту не множився.
 */
export type PolicyFunctionReason =
  | "parameters"
  | "language"
  | "volatility"
  | "returns"
  | "outputKey"
  | "restrictiveBound"
  | "actorUnbound"
  | "policyShape"
  | "policyRoles"

const REASONS: readonly PolicyFunctionReason[] = [
  "parameters",
  "language",
  "volatility",
  "returns",
  "outputKey",
  "restrictiveBound",
  "actorUnbound",
  "policyShape",
  "policyRoles",
]

/** Функція політики: форма пройдена, призначення `EXECUTE` виведено. */
export interface PolicyFunction {
  function: { schema: string; name: string }
  unit: VerbatimUnit
  /** Таблиця T, на якій стоять усі політики-викликачі. */
  table: { schema: string; name: string }
  callers: readonly VerbatimUnit[]
  /** Призначення ролей `TO` політик-викликачів `SELECT`/`ALL` з `USING`. */
  purposes: readonly GrantPurpose[]
}

export interface PolicyFunctions {
  functions: PolicyFunction[]
  /** `sql.policy-helper-correlated`: одна на функцію поза формою. */
  diagnostics: Diagnostic[]
}

export interface PolicyFunctionsInput {
  units: readonly VerbatimUnit[]
  /** Таблиці фізичного знімка: ключ T, колонки входів, стан RLS. */
  tables: readonly PhysicalTable[]
  provider: DatabaseProvider
  /**
   * Інші форми платформи (функції множини, обробники, функції значень
   * виміру): функцією політики вони не бувають.
   */
  forms: readonly PlatformFormSource[]
  /** `схема.ім'я` згенерованих функцій множини (`membership`). */
  membershipFunctions: ReadonlySet<string>
  parse: SqlParser
  plpgsql: PlpgsqlParser
}

/**
 * Явні функції ідентичності провайдера — актор у прив'язці результату. Не
 * весь `PROVIDER_FUNCTIONS`: `auth.role()` і `auth.jwt()` актора не
 * називають, тож рівність з ними прив'язкою не є.
 */
const PROVIDER_ACTOR_FUNCTIONS: Readonly<
  Record<DatabaseProvider, readonly string[]>
> = {
  supabase: ["auth.uid"],
  postgres: [],
}

/** Призначення, ролі яких мають сесію користувача чи сервісу (§5.8). */
const SESSION_PURPOSES: readonly GrantPurpose[] = ["user", "service", "command"]

/** Функції ролі сесії: у тілі від власника вони означали б іншу роль. */
const SESSION_ROLE_VALUES: ReadonlySet<string> = new Set([
  "SVFOP_CURRENT_USER",
  "SVFOP_CURRENT_ROLE",
  "SVFOP_SESSION_USER",
  "SVFOP_USER",
  "SVFOP_CURRENT_SCHEMA",
  "SVFOP_CURRENT_CATALOG",
])

const SESSION_ROLE_CALLS: ReadonlySet<string> = new Set([
  "current_user",
  "current_role",
  "session_user",
  "user",
  "current_schema",
  "current_schemas",
  "pg_has_role",
  "row_security_active",
])

interface PolicyTree {
  cmd_name?: string
  permissive?: boolean
  roles?: { RoleSpec?: { roletype?: string; rolename?: string } }[]
  qual?: unknown
  with_check?: unknown
}

interface Policy {
  unit: VerbatimUnit
  tree: PolicyTree
  table: { schema: string; name: string }
  /** `PUBLIC` чи ім'я ролі; `CURRENT_USER` тощо — порожній рядок. */
  roles: readonly string[]
  reading: boolean
}

type Fields = readonly { String?: { sval?: string } }[]

interface ColumnRefNode {
  fields?: Fields
}

interface FuncCallNode {
  funcname?: Fields
  args?: unknown[]
  agg_star?: boolean
  agg_distinct?: boolean
  func_variadic?: boolean
  agg_filter?: unknown
  over?: unknown
  agg_order?: unknown[]
}

interface SelectNode {
  targetList?: { ResTarget?: { val?: unknown; name?: string } }[]
  fromClause?: unknown[]
  whereClause?: unknown
  withClause?: unknown
  valuesLists?: unknown[]
  op?: string
}

interface SubLinkNode {
  subLinkType?: string
  testexpr?: unknown
  operName?: Fields
  subselect?: { SelectStmt?: SelectNode }
}

interface AExprNode {
  kind?: string
  name?: Fields
  lexpr?: unknown
  rexpr?: unknown
}

const names = (fields: Fields | undefined): (string | undefined)[] =>
  (fields ?? []).map((f) => f.String?.sval)

function policyOf(unit: VerbatimUnit): Policy | undefined {
  const tree = (unit.tree as { CreatePolicyStmt?: PolicyTree }).CreatePolicyStmt
  if (unit.class !== "policy" || tree === undefined) return undefined
  const target = statementTargets(unit.tree as Node, unit.schema)[0]
  const roles = (tree.roles ?? []).map(({ RoleSpec: spec }) =>
    spec?.roletype === "ROLESPEC_PUBLIC"
      ? PUBLIC
      : spec?.roletype === "ROLESPEC_CSTRING"
        ? (spec.rolename ?? "")
        : ""
  )
  return {
    unit,
    tree,
    table: {
      schema: target?.schema ?? unit.schema,
      name: target?.object ?? "",
    },
    roles: roles.length === 0 ? [PUBLIC] : roles,
    reading: tree.cmd_name === "select" || tree.cmd_name === "all",
  }
}

/** Вирази політики: `USING` і `WITH CHECK`. */
function expressions(policy: Policy): unknown[] {
  return [policy.tree.qual, policy.tree.with_check].filter(
    (e) => e !== undefined
  )
}

/**
 * Функції моделі, які вираз кличе прямо: виклик за `схема.ім'я`
 * (некваліфікований — у будь-якій схемі: вираз політики зв'язано за шляхом
 * сесії) і запис `x.f` — виклик функції з одним аргументом.
 */
function calledFunctions(
  expr: unknown,
  units: readonly VerbatimUnit[],
  parse: SqlParser
): VerbatimUnit[] {
  const calls = unitCalls({ tree: expr }, parse)
  const attributes = new Set(attributeNames(expr))
  return units.filter(
    (u) =>
      u.class === "function" &&
      (calls.some(
        (c) =>
          c.name === u.name && (c.schema === undefined || c.schema === u.schema)
      ) ||
        (attributes.has(u.name) && singleArgument(u)))
  )
}

/** Кон'юнкти верхнього рівня: вкладені `AND` розгортаються. */
function conjuncts(expr: unknown): unknown[] {
  const bool = (expr as { BoolExpr?: { boolop?: string; args?: unknown[] } })
    ?.BoolExpr
  return bool?.boolop === "AND_EXPR"
    ? (bool.args ?? []).flatMap(conjuncts)
    : [expr]
}

function disjuncts(expr: unknown): unknown[] {
  const bool = (expr as { BoolExpr?: { boolop?: string; args?: unknown[] } })
    ?.BoolExpr
  return bool?.boolop === "OR_EXPR"
    ? (bool.args ?? []).flatMap(disjuncts)
    : [expr]
}

// Поля вузлів, що не змінюють значення: решта (`WHERE`, `FROM`, аргументи,
// `DISTINCT`, агрегатні модифікатори…) робить атом іншою формою.
const SELECT_OF_CALL_KEYS: ReadonlySet<string> = new Set([
  "targetList",
  "limitOption",
  "op",
])
const NULLARY_CALL_KEYS: ReadonlySet<string> = new Set([
  "funcname",
  "funcformat",
  "location",
])

/**
 * `SELECT <схема>.<ім'я>()` і нічого більше: некорельований `InitPlan` над
 * функцією без аргументів. Повертає `схема.ім'я` чи `undefined`.
 */
function selectOfCall(select: SelectNode | undefined): string | undefined {
  if (select === undefined) return undefined
  const extra = Object.keys(select).filter((k) => !SELECT_OF_CALL_KEYS.has(k))
  if (extra.length > 0 || (select.op ?? "SETOP_NONE") !== "SETOP_NONE") {
    return undefined
  }
  const [only, ...rest] = select.targetList ?? []
  if (only === undefined || rest.length > 0) return undefined
  return nullaryCall(only.ResTarget?.val)
}

/** Кваліфікований виклик без аргументів і модифікаторів: `схема.ім'я`. */
function nullaryCall(value: unknown): string | undefined {
  const call = (value as { FuncCall?: FuncCallNode })?.FuncCall
  if (call === undefined) return undefined
  const extra = Object.keys(call).filter((k) => !NULLARY_CALL_KEYS.has(k))
  const parts = names(call.funcname)
  if (extra.length > 0 || parts.length !== 2 || parts.includes(undefined)) {
    return undefined
  }
  return parts.join(".")
}

/** Атом `<колонка> IN (SELECT f())` чи `<колонка> = ANY(ARRAY(SELECT f()))`. */
function setAtom(expr: unknown): { column: Fields; fn: string } | undefined {
  const link = (expr as { SubLink?: SubLinkNode })?.SubLink
  if (link !== undefined) {
    const column = (link.testexpr as { ColumnRef?: ColumnRefNode })?.ColumnRef
    const fn = selectOfCall(link.subselect?.SelectStmt)
    return link.subLinkType === "ANY_SUBLINK" &&
      link.operName === undefined &&
      column?.fields !== undefined &&
      fn !== undefined
      ? { column: column.fields, fn }
      : undefined
  }
  const op = (expr as { A_Expr?: AExprNode })?.A_Expr
  if (op?.kind !== "AEXPR_OP_ANY" || names(op.name).join() !== "=") {
    return undefined
  }
  const column = (op.lexpr as { ColumnRef?: ColumnRefNode })?.ColumnRef
  const array = (op.rexpr as { SubLink?: SubLinkNode })?.SubLink
  const fn =
    array?.subLinkType === "ARRAY_SUBLINK"
      ? selectOfCall(array.subselect?.SelectStmt)
      : undefined
  return column?.fields !== undefined && fn !== undefined
    ? { column: column.fields, fn }
    : undefined
}

/** Вхід `FROM`: базова таблиця з псевдонімом чи без. */
interface Input {
  key: string
  table: PhysicalTable | undefined
  /** Ім'я, яким на вхід посилаються: псевдонім чи ім'я таблиці. */
  ref: string
  schema: string | undefined
  relname: string
  aliased: boolean
  /**
   * Псевдонім зі списком колонок (`d(a, b)`): колонки перейменовано за
   * позицією, тож ім'я колонки в запиті вже не ім'я колонки таблиці.
   */
  renamed: boolean
}

interface RangeVarNode {
  schemaname?: string
  relname?: string
  alias?: { aliasname?: string; colnames?: unknown[] }
  inh?: boolean
}

interface JoinNode {
  jointype?: string
  isNatural?: boolean
  usingClause?: unknown[]
  larg?: unknown
  rarg?: unknown
  quals?: unknown
  alias?: unknown
}

function inputOf(
  range: RangeVarNode,
  key: string,
  tables: readonly PhysicalTable[]
): Input {
  const relname = range.relname ?? ""
  const alias = range.alias?.aliasname
  return {
    key,
    table:
      range.schemaname === undefined
        ? undefined
        : tables.find(
            (t) => t.schema === range.schemaname && t.name === relname
          ),
    ref: alias ?? relname,
    schema: range.schemaname,
    relname,
    aliased: alias !== undefined,
    renamed: (range.alias?.colnames ?? []).length > 0,
  }
}

/**
 * Колонка за правилами видимості Postgres: найближча область, де ім'я
 * однозначне. Вхід без відомих колонок робить некваліфіковане ім'я
 * нерозв'язним (fail-closed).
 */
function resolveColumn(
  fields: Fields,
  scopes: readonly (readonly Input[])[]
): string | undefined {
  const parts = names(fields)
  if (parts.includes(undefined) || parts.length === 0 || parts.length > 3) {
    return undefined
  }
  const column = parts.at(-1)!
  for (let depth = scopes.length - 1; depth >= 0; depth--) {
    const scope = scopes[depth]!
    let found: Input | undefined
    if (parts.length === 1) {
      if (scope.some((i) => i.table === undefined)) return undefined
      const matches = scope.filter((i) =>
        i.table!.columns.some((c) => c.name === column)
      )
      if (matches.length > 1) return undefined
      found = matches[0]
    } else if (parts.length === 2) {
      found = scope.find((i) => i.ref === parts[0])
    } else {
      found = scope.find(
        (i) => !i.aliased && i.schema === parts[0] && i.relname === parts[1]
      )
    }
    if (found === undefined) continue
    if (
      found.table !== undefined &&
      !found.table.columns.some((c) => c.name === column)
    ) {
      return undefined
    }
    return `${found.key}.${column}`
  }
  return undefined
}

/**
 * Дерево без позицій і псевдонімів, де кожне посилання на колонку замінене
 * парою (вхід, колонка): межа політики й кон'юнкт функції порівнюються за
 * значенням, а не за написанням. Вхід T — ключ `T`; входи підзапитів —
 * `<глибина>:<номер>`. Нерозв'язне посилання — `undefined` (fail-closed).
 */
function normalized(
  expr: unknown,
  base: readonly Input[],
  tables: readonly PhysicalTable[]
): string | undefined {
  let failed = false
  const walk = (
    value: unknown,
    scopes: readonly (readonly Input[])[]
  ): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, scopes))
    if (typeof value !== "object" || value === null) return value
    const node = value as Record<string, unknown>
    const column = node.ColumnRef as ColumnRefNode | undefined
    if (column !== undefined) {
      const resolved = resolveColumn(column.fields ?? [], scopes)
      if (resolved === undefined) failed = true
      return { ColumnRef: resolved }
    }
    const select = node.SelectStmt as SelectNode | undefined
    if (select !== undefined) {
      const depth = scopes.length
      const inputs: Input[] = []
      const collect = (item: unknown) => {
        const range = (item as { RangeVar?: RangeVarNode }).RangeVar
        const join = (item as { JoinExpr?: JoinNode }).JoinExpr
        if (range !== undefined) {
          const input = inputOf(range, `${depth}:${inputs.length}`, tables)
          if (input.renamed) failed = true
          inputs.push(input)
        } else if (join !== undefined && join.alias === undefined) {
          collect(join.larg)
          collect(join.rarg)
        } else failed = true
      }
      for (const item of select.fromClause ?? []) collect(item)
      return { SelectStmt: walk(select, [...scopes, inputs]) }
    }
    const range = node.RangeVar as RangeVarNode | undefined
    if (range !== undefined) {
      // `inh` — це `ONLY`: без нащадків таблиця дає інші рядки.
      return {
        RangeVar: {
          schemaname: range.schemaname,
          relname: range.relname,
          inh: range.inh,
        },
      }
    }
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== "location")
        .map(([key, child]) => [key, walk(child, scopes)])
    )
  }
  if (base.some((i) => i.renamed)) return undefined
  const result = walk(expr, [base])
  return failed ? undefined : JSON.stringify(result)
}

/** Розбір тіла функції: `FROM`, кон'юнкти `ON` і чи форма тіла допустима. */
interface Body {
  select: SelectNode
  inputs: Input[]
  on: unknown[]
  /** Тіло поза формою прив'язки (похідна таблиця, `WITH`, `UNION`…). */
  shape: boolean
}

function bodyOf(
  unit: VerbatimUnit,
  tables: readonly PhysicalTable[],
  parse: SqlParser
): Body | undefined {
  const text = sqlBodyText(unit)
  const parsed = text === undefined ? undefined : parse(text)
  if (parsed === undefined || !parsed.ok) return undefined
  const [only, ...rest] = parsed.statements
  const select = (only?.stmt as { SelectStmt?: SelectNode } | undefined)
    ?.SelectStmt
  if (select === undefined || rest.length > 0) return undefined
  const inputs: Input[] = []
  const on: unknown[] = []
  let shape =
    (select.op ?? "SETOP_NONE") === "SETOP_NONE" &&
    select.withClause === undefined &&
    select.valuesLists === undefined
  // Лише базові таблиці, з'єднані комою чи внутрішнім `JOIN … ON`: похідна
  // таблиця, функція множини, `LATERAL` чи зовнішнє з'єднання виводять
  // рядки, яких ланцюжок рівностей не зв'язує з актором.
  const collect = (item: unknown) => {
    const range = (item as { RangeVar?: RangeVarNode }).RangeVar
    const join = (item as { JoinExpr?: JoinNode }).JoinExpr
    if (range !== undefined) {
      const input = inputOf(range, `0:${inputs.length}`, tables)
      if (input.table === undefined) shape = false
      inputs.push(input)
      return
    }
    if (
      join === undefined ||
      join.jointype !== "JOIN_INNER" ||
      join.isNatural === true ||
      join.usingClause !== undefined ||
      join.alias !== undefined
    ) {
      shape = false
      return
    }
    collect(join.larg)
    collect(join.rarg)
    for (const c of join.quals === undefined ? [] : conjuncts(join.quals)) {
      const op = (c as { BoolExpr?: { boolop?: string } }).BoolExpr?.boolop
      if (op === "OR_EXPR" || op === "NOT_EXPR") shape = false
      on.push(c)
    }
  }
  for (const item of select.fromClause ?? []) collect(item)
  return { select, inputs, on, shape }
}

/** Актор: явна функція ідентичності чи вона ж у `(SELECT …)`. */
function isActor(expr: unknown, actors: ReadonlySet<string>): boolean {
  const call = nullaryCall(expr)
  if (call !== undefined) return actors.has(call)
  const link = (expr as { SubLink?: SubLinkNode })?.SubLink
  if (link?.subLinkType !== "EXPR_SUBLINK") return false
  const inner = selectOfCall(link.subselect?.SelectStmt)
  return inner !== undefined && actors.has(inner)
}

/** Ліва й права колонки рівності `a = b`, якщо обидві — посилання на колонку. */
function equality(expr: unknown): [unknown, unknown] | undefined {
  const op = (expr as { A_Expr?: AExprNode })?.A_Expr
  return op?.kind === "AEXPR_OP" && names(op.name).join() === "="
    ? [op.lexpr, op.rexpr]
    : undefined
}

const columnFields = (expr: unknown): Fields | undefined =>
  (expr as { ColumnRef?: ColumnRefNode })?.ColumnRef?.fields

/**
 * Вхід, до якого прив'язано актора: кон'юнкт `<колонка R> = <актор>` (у
 * будь-якому порядку операндів) чи `<колонка R> IN (SELECT g())` /
 * `= ANY(ARRAY(SELECT g()))` над іншою функцією політики чи функцією
 * множини скоупу.
 */
function actorInput(
  conjunct: unknown,
  inputs: readonly Input[],
  actors: ReadonlySet<string>,
  sets: ReadonlySet<string>
): string | undefined {
  const pair = equality(conjunct)
  let fields: Fields | undefined
  if (pair !== undefined) {
    const [left, right] = pair
    if (isActor(right, actors)) fields = columnFields(left)
    else if (isActor(left, actors)) fields = columnFields(right)
  } else {
    const atom = setAtom(conjunct)
    if (atom !== undefined && sets.has(atom.fn)) fields = atom.column
  }
  const resolved =
    fields === undefined ? undefined : resolveColumn(fields, [inputs])
  return resolved?.slice(0, resolved.indexOf("."))
}

/**
 * Зв'язність графа з'єднань: вершини — входи `FROM`, ребра — рівності колонок
 * різних входів серед кон'юнктів `WHERE` і `ON`. Перехресне з'єднання без
 * ланцюжка рівностей лишає вхід поза актором.
 */
function connected(
  inputs: readonly Input[],
  edges: readonly unknown[],
  from: string
): boolean {
  const links = new Map<string, Set<string>>(
    inputs.map((i) => [i.key, new Set<string>()])
  )
  for (const edge of edges) {
    const pair = equality(edge)
    const left = columnFields(pair?.[0])
    const right = columnFields(pair?.[1])
    if (left === undefined || right === undefined) continue
    const a = resolveColumn(left, [inputs])
    const b = resolveColumn(right, [inputs])
    if (a === undefined || b === undefined) continue
    const ka = a.slice(0, a.indexOf("."))
    const kb = b.slice(0, b.indexOf("."))
    if (ka === kb) continue
    links.get(ka)?.add(kb)
    links.get(kb)?.add(ka)
  }
  const seen = new Set([from])
  const queue = [from]
  for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
    for (const next of links.get(key) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return inputs.every((i) => seen.has(i.key))
}

/** Чи роль має `SELECT` на T за дослівними грантами (без відкликання). */
function selects(
  role: string,
  table: { schema: string; name: string },
  grants: readonly GrantFact[]
): boolean {
  const key = `table|${qualifiedName(table.schema, table.name)}`
  const facts = grants.filter((f) => f.keys.includes(key))
  const covers = (f: GrantFact, columns: boolean) =>
    f.privileges.length === 0 ||
    f.privileges.some(
      (p) =>
        (p.name === "select" || p.name === "all") && (columns || !p.columns)
    )
  // Порядок операторів не моделюється: будь-яке відкликання від отримувача
  // перемагає (fail-closed — роль без `SELECT` не дістане `EXECUTE`).
  const holds = (grantee: string) =>
    facts.some((f) => f.grant && f.roles.has(grantee) && covers(f, false)) &&
    !facts.some((f) => !f.grant && f.roles.has(grantee) && covers(f, true))
  return holds(role) || holds(PUBLIC)
}

/** Призначення ролі `TO`, якщо вона — роль сесії профілю; інакше `undefined`. */
function sessionPurposes(
  role: string,
  provider: DatabaseProvider
): GrantPurpose[] | undefined {
  if (role === PUBLIC || role === "") return undefined
  const purposes = callersOfRole(role, provider)
  return purposes !== undefined &&
    purposes.every((p) => SESSION_PURPOSES.includes(p))
    ? purposes
    : undefined
}

/** Роль профілю чи платформи: її відмінність від інших ролей доведена. */
function knownRoles(provider: DatabaseProvider): ReadonlySet<string> {
  return new Set(
    [
      ...Object.values(PROVIDER_API_ROLES[provider]),
      ...Object.values(PLATFORM_ROLES),
    ].filter((r): r is string => typeof r === "string")
  )
}

/**
 * Перевірка межі `RESTRICTIVE` (§5.8, Р4 плану Д5) транзитивно через функції,
 * які вона кличе: у тілі від імені власника функції ролі сесії, ролей і
 * привілеїв, відношення під RLS і подання означали б інше, ніж у політиці;
 * `current_setting` — лише за правилом голови. Тіло, якого обхід не
 * прочитав, — fail-closed.
 */
class BoundCheck {
  /**
   * Вердикт ланки за ідентичністю: один обхід ділять усі кандидати, тож
   * відмовлена ланка лишається відмовленою. Поки ланка в обході — `false`
   * (цикл — відмова).
   */
  private readonly verdicts = new Map<string, boolean>()

  constructor(private readonly input: PolicyFunctionsInput) {}

  allowed(expr: unknown): boolean {
    return this.tree(expr)
  }

  private tree(tree: unknown): boolean {
    const { parse, units, tables } = this.input
    if (sessionReads(tree).length > 0 || sessionRole(tree)) return false
    const unit = { tree }
    for (const rel of unitRelations(unit, parse)) {
      if (!this.relation(rel, units, tables)) return false
    }
    for (const call of unitCalls(unit, parse)) {
      if (
        (call.schema === undefined || call.schema === "pg_catalog") &&
        forbiddenCall(call.name)
      ) {
        return false
      }
      const routines = units.filter(
        (u) =>
          (u.class === "function" || u.class === "procedure") &&
          u.name === call.name &&
          (call.schema === undefined || u.schema === call.schema)
      )
      for (const routine of routines) {
        if (!this.routine(routine)) return false
      }
    }
    const attributes = new Set(attributeNames(tree))
    for (const routine of units) {
      if (
        routine.class === "function" &&
        attributes.has(routine.name) &&
        singleArgument(routine) &&
        !this.routine(routine)
      ) {
        return false
      }
    }
    return true
  }

  private relation(
    rel: ReferencedName,
    units: readonly VerbatimUnit[],
    tables: readonly PhysicalTable[]
  ): boolean {
    const views = units.filter(
      (u) =>
        (u.class === "view" || u.class === "materializedView") &&
        u.name === rel.name &&
        (rel.schema === undefined || u.schema === rel.schema)
    )
    if (views.length > 0) return false
    const matched = tables.filter(
      (t) =>
        t.name === rel.name &&
        (rel.schema === undefined || t.schema === rel.schema)
    )
    return (
      matched.length > 0 && matched.every((t) => t.rowLevelSecurity === "off")
    )
  }

  private routine(unit: VerbatimUnit): boolean {
    const known = this.verdicts.get(unit.identity)
    if (known !== undefined) return known
    // Ланка, досягнута ще під час власного обходу, — цикл: рекурсивна межа
    // не межа (Postgres однаково рекурсував би), тож відмова. Тимчасово
    // «так» лишило б остаточне «так» за іншою ланкою циклу.
    this.verdicts.set(unit.identity, false)
    const verdict = this.routineAllowed(unit)
    this.verdicts.set(unit.identity, verdict)
    return verdict
  }

  private routineAllowed(unit: VerbatimUnit): boolean {
    const { parse, plpgsql } = this.input
    const body = routineBody(unit.tree as Node, unit.sql, parse, plpgsql)
    if (body.problem !== undefined) return false
    for (const { stmt } of body.statements) {
      if (!this.tree(stmt)) return false
    }
    for (const { text } of body.values) {
      const parsed = parse(text)
      if (!parsed.ok) return false
      for (const s of parsed.statements) if (!this.tree(s.stmt)) return false
    }
    return true
  }
}

function forbiddenCall(name: string): boolean {
  return (
    SESSION_ROLE_CALLS.has(name) ||
    (name.startsWith("has_") && name.endsWith("_privilege"))
  )
}

function sessionRole(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(sessionRole)
  if (typeof value !== "object" || value === null) return false
  const node = value as Record<string, unknown>
  const op = (node.SQLValueFunction as { op?: string } | undefined)?.op
  if (op !== undefined && SESSION_ROLE_VALUES.has(op)) return true
  return Object.values(node).some(sessionRole)
}

interface FunctionTree {
  parameters?: { FunctionParameter?: { mode?: string } }[]
  returnType?: { names?: Fields; setof?: boolean; arrayBounds?: unknown[] }
  options?: {
    DefElem?: { defname?: string; arg?: { String?: { sval?: string } } }
  }[]
}

const INPUT_MODES: ReadonlySet<string> = new Set([
  "FUNC_PARAM_DEFAULT",
  "FUNC_PARAM_IN",
  "FUNC_PARAM_INOUT",
  "FUNC_PARAM_VARIADIC",
])

/**
 * Розпізнавач і суддя функцій політик (§5.8, Р2–Р5 плану Д5). Кандидат —
 * definer-функція, яку прямо кличе вираз дослівної політики, крім інших форм
 * платформи; функція значень виміру в політиці — завжди `policyShape`: ролі
 * запиту `EXECUTE` на неї не мають. Кандидат без причин — функція політики з
 * призначеннями; з причинами — одна діагностика класу ремонту.
 */
export function policyFunctions(input: PolicyFunctionsInput): PolicyFunctions {
  const { units, provider, forms, parse } = input
  const policies = units.flatMap((u) => policyOf(u) ?? [])
  const formIdentity = (form: PlatformFormSource) =>
    functionIdentity(form.function.schema, form.function.name, [])
  const others = new Set(
    forms.filter((f) => f.form !== "dimension").map(formIdentity)
  )
  const dimensions = new Set(
    forms.filter((f) => f.form === "dimension").map(formIdentity)
  )
  const callers = new Map<VerbatimUnit, Policy[]>()
  for (const policy of policies) {
    for (const expr of expressions(policy)) {
      for (const fn of calledFunctions(expr, units, parse)) {
        if (others.has(fn.identity)) continue
        if (!dimensions.has(fn.identity) && !isSecurityDefiner(fn, units)) {
          continue
        }
        const list = callers.get(fn) ?? []
        if (!list.includes(policy)) list.push(policy)
        callers.set(fn, list)
      }
    }
  }
  const candidates = new Set(
    [...callers.keys()]
      .filter((u) => !dimensions.has(u.identity))
      .map((u) => `${u.schema}.${u.name}`)
  )
  const sets = new Set([
    ...forms
      .filter((f) => f.form === "setFunction")
      .map((f) => `${f.function.schema}.${f.function.name}`),
    ...input.membershipFunctions,
  ])
  const actors = new Set([
    ...PROVIDER_ACTOR_FUNCTIONS[provider],
    `${CURRENT_USER_FUNCTION.schema}.${CURRENT_USER_FUNCTION.name}`,
  ])
  const grants = grantFacts(units, parse)
  const bounds = new BoundCheck(input)
  const known = knownRoles(provider)
  const result: PolicyFunctions = { functions: [], diagnostics: [] }
  for (const [unit, list] of callers) {
    const judged = dimensions.has(unit.identity)
      ? { reasons: ["policyShape" as const], table: undefined, purposes: [] }
      : judge({
          unit,
          callers: list,
          policies,
          input,
          candidates,
          sets: new Set([
            ...sets,
            ...[...candidates].filter(
              (c) => c !== `${unit.schema}.${unit.name}`
            ),
          ]),
          actors,
          grants,
          bounds,
          known,
        })
    if (judged.reasons.length === 0 && judged.table !== undefined) {
      result.functions.push({
        function: { schema: unit.schema, name: unit.name },
        unit,
        table: judged.table,
        callers: list.map((p) => p.unit),
        purposes: judged.purposes,
      })
      continue
    }
    const [reason, ...rest] = REASONS.filter((r) => judged.reasons.includes(r))
    result.diagnostics.push(
      diagnostic("sql.policy-helper-correlated", unit.file, "", {
        schema: unit.schema,
        name: unit.name,
        function: `${unit.schema}.${unit.name}`,
        reason: reason!,
        ...(rest.length === 0 ? {} : { detail: rest.join(", ") }),
        line: unit.line,
      })
    )
  }
  return result
}

interface Judgement {
  reasons: PolicyFunctionReason[]
  table: { schema: string; name: string } | undefined
  purposes: GrantPurpose[]
}

function judge(context: {
  unit: VerbatimUnit
  callers: readonly Policy[]
  policies: readonly Policy[]
  input: PolicyFunctionsInput
  candidates: ReadonlySet<string>
  sets: ReadonlySet<string>
  actors: ReadonlySet<string>
  grants: readonly GrantFact[]
  bounds: BoundCheck
  known: ReadonlySet<string>
}): Judgement {
  const { unit, callers, input } = context
  const { tables, parse } = input
  const reasons = new Set<PolicyFunctionReason>()
  const fn = (unit.tree as { CreateFunctionStmt?: FunctionTree })
    .CreateFunctionStmt
  const modes = (fn?.parameters ?? []).map(
    (p) => p.FunctionParameter?.mode ?? ""
  )
  if (modes.some((m) => INPUT_MODES.has(m))) reasons.add("parameters")
  const language = routineLanguage(unit.tree as Node)
  if (language !== "sql") reasons.add("language")
  const volatility = (fn?.options ?? []).find(
    (o) => o.DefElem?.defname === "volatility"
  )?.DefElem?.arg?.String?.sval
  // Без ключового слова Postgres бере VOLATILE; IMMUTABLE не може читати.
  if (volatility !== "stable") reasons.add("volatility")
  const returned = names(fn?.returnType?.names)
  if (
    modes.some((m) => !INPUT_MODES.has(m)) ||
    fn?.returnType?.setof !== true ||
    (fn.returnType.arrayBounds ?? []).length > 0 ||
    returned.at(-1) !== "uuid" ||
    !(
      returned.length === 1 ||
      (returned.length === 2 && returned[0] === "pg_catalog")
    )
  ) {
    reasons.add("returns")
  }

  // T — одна таблиця під усіма політиками-викликачами з ключем-колонкою uuid.
  const targets = new Set(
    callers.map((p) => qualifiedName(p.table.schema, p.table.name))
  )
  const first = callers[0]!.table
  const table =
    targets.size === 1
      ? tables.find((t) => t.schema === first.schema && t.name === first.name)
      : undefined
  const keyColumn =
    table?.primaryKey?.columns.length === 1
      ? table.columns.find((c) => c.name === table.primaryKey!.columns[0])
      : undefined
  const key = keyColumn?.type === "uuid" ? keyColumn.name : undefined
  if (table === undefined || key === undefined) reasons.add("outputKey")

  const body = language === "sql" ? bodyOf(unit, tables, parse) : undefined
  if (language === "sql") {
    if (body === undefined || !body.shape) reasons.add("actorUnbound")
  }
  if (body !== undefined && body.shape) {
    const { select, inputs } = body
    // Перейменована колонка входу робить ім'я виводу не ключем T.
    if (inputs.some((i) => i.renamed)) reasons.add("outputKey")
    const [target, ...more] = select.targetList ?? []
    const output = columnFields(target?.ResTarget?.val)
    if (output === undefined || more.length > 0) reasons.add("actorUnbound")
    const ofT =
      table === undefined ? [] : inputs.filter((i) => i.table === table)
    const tInput = ofT.length === 1 ? ofT[0] : undefined
    if (tInput === undefined) reasons.add("outputKey")
    if (output !== undefined && key !== undefined && tInput !== undefined) {
      if (resolveColumn(output, [inputs]) !== `${tInput.key}.${key}`) {
        reasons.add("outputKey")
      }
    }
    const where =
      select.whereClause === undefined ? [] : conjuncts(select.whereClause)
    const bindings = where.flatMap(
      (c) => actorInput(c, inputs, context.actors, context.sets) ?? []
    )
    const from = tInput?.key ?? inputs[0]?.key
    if (
      bindings.length === 0 ||
      from === undefined ||
      !connected(inputs, [...where, ...body.on], from)
    ) {
      reasons.add("actorUnbound")
    }
    if (table !== undefined && tInput !== undefined) {
      const callerRoles = new Set(callers.flatMap((p) => p.roles))
      const base = inputs.map((i) => (i === tInput ? { ...i, key: "T" } : i))
      const present = new Set(
        where.flatMap((c) => normalized(c, base, tables) ?? [])
      )
      const tScope: Input[] = [
        {
          key: "T",
          table,
          ref: table.name,
          schema: table.schema,
          relname: table.name,
          aliased: false,
          renamed: false,
        },
      ]
      for (const policy of context.policies) {
        if (
          policy.tree.permissive === true ||
          !policy.reading ||
          policy.table.schema !== table.schema ||
          policy.table.name !== table.name ||
          policy.tree.qual === undefined
        ) {
          continue
        }
        // Межа застосовна, якщо її роль не доведено відмінною від ролей
        // викликачів (членства дослівних ролей компілятор не знає).
        const applies = policy.roles.some(
          (r) => r === PUBLIC || callerRoles.has(r) || !context.known.has(r)
        )
        if (!applies) continue
        const parts = conjuncts(policy.tree.qual).map((c) =>
          normalized(c, tScope, tables)
        )
        if (
          parts.some((p) => p === undefined || !present.has(p)) ||
          !context.bounds.allowed(policy.tree.qual)
        ) {
          reasons.add("restrictiveBound")
        }
      }
    }
  }

  // Політика — `OR` атомів над ключем T, кожен над функцією політики.
  for (const policy of callers) {
    for (const expr of expressions(policy)) {
      if (!calledFunctions(expr, input.units, parse).includes(unit)) continue
      const ok = disjuncts(expr).every((d) => {
        const atom = setAtom(d)
        return (
          atom !== undefined &&
          context.candidates.has(atom.fn) &&
          key !== undefined &&
          isKeyColumn(atom.column, policy.table, key)
        )
      })
      if (!ok) reasons.add("policyShape")
    }
  }

  // Ролі: кожна роль сесії, що стоїть у `TO` політики `SELECT`/`ALL` з
  // викликом у `USING` і має `SELECT` на T.
  const readers = callers.filter(
    (p) =>
      p.reading &&
      p.tree.qual !== undefined &&
      calledFunctions(p.tree.qual, input.units, parse).includes(unit)
  )
  const readerRoles = new Set(readers.flatMap((p) => p.roles))
  const purposes = new Set<GrantPurpose>()
  for (const role of new Set(callers.flatMap((p) => p.roles))) {
    const own = sessionPurposes(role, input.provider)
    if (
      own === undefined ||
      !readerRoles.has(role) ||
      table === undefined ||
      !selects(role, table, context.grants)
    ) {
      reasons.add("policyRoles")
      continue
    }
    for (const p of own) purposes.add(p)
  }
  return {
    reasons: [...reasons],
    table:
      table === undefined
        ? undefined
        : { schema: table.schema, name: table.name },
    purposes: SESSION_PURPOSES.filter((p) => purposes.has(p)),
  }
}

/** Колонка атома політики — ключ T: голе ім'я чи кваліфіковане таблицею T. */
function isKeyColumn(
  fields: Fields,
  table: { schema: string; name: string },
  key: string
): boolean {
  const parts = names(fields)
  return (
    parts.at(-1) === key &&
    (parts.length === 1 ||
      (parts.length === 2 && parts[0] === table.name) ||
      (parts.length === 3 &&
        parts[0] === table.schema &&
        parts[1] === table.name))
  )
}

/**
 * `sql.head-not-allowed` на кожній функції політики: голову судить той самий
 * суддя Правила 3, що й функцію множини скоупу; функція політики — корінь
 * голови, тож і її оболонка фіксує налаштування сесії (`sql.head-settings`).
 */
export function checkPolicyFunctionHeads(
  functions: readonly PolicyFunction[],
  scope: HeadScope
): Diagnostic[] {
  return [
    ...checkHeadSettings(
      functions.map((f) => f.unit),
      scope.units
    ),
    ...functions.flatMap(({ unit }) => {
      const head = `${unit.schema}.${unit.name}`
      return judgeQueryFunction(unit, scope, [head]).findings.map((finding) =>
        diagnostic("sql.head-not-allowed", unit.file, "", {
          head,
          chain: finding.chain.join(" → "),
          construct: finding.construct,
          ...(finding.detail === undefined ? {} : { detail: finding.detail }),
          line: unit.line,
        })
      )
    }),
  ]
}
