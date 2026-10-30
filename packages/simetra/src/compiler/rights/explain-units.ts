import {
  PLATFORM_SCHEMA,
  quoteIdent,
  type DatabaseProvider,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import { accessPolicyNames, rightsPolicyLabel } from "../access-units"
import {
  mainTableOf,
  qualified,
  rootFamilyKey,
  type AccessContract,
  type Contracts,
  type ProjectionExtent,
  type QualifiedName,
  type RightsContract,
} from "../contracts"
import { CURRENT_USER, closedFunction } from "../membership-functions"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { sqlLiteral } from "../stages/model"
import {
  ANALYSIS_ROLES,
  RIGHTS_FUNCTIONS,
  ZERO_UUID,
  analysisGate,
  call,
  hasRightsFunctions,
  hasVisibleUsers,
  param,
  userOf,
  uuidLiteral,
  type AnalysisScope,
  type RightsFunctionContracts,
} from "./functions"
import {
  rightsPredicates,
  type RightsCondition,
  type RightsPredicate,
} from "./predicates"
import { must } from "./references"

/**
 * Контракти пояснення: функції прав, контракти доступу таблиць і мітки виду
 * об'єктів за id — об'єкт з `publicRead` без контракту прав мітку бере звідси.
 */
export type ExplainContracts = RightsFunctionContracts &
  Pick<Contracts, "access"> & { kindLabels: ReadonlyMap<string, string> }

const F = RIGHTS_FUNCTIONS
const FN = F.explain
const USER = param(FN, "p_user")

/**
 * Чиї права й множини підставляє гілка: `p_user` — для рядків пояснення,
 * поточний користувач — для перевірки, що рядок бачить сам викликач
 * (спека прав §5.1). Одна побудова рядків для обох, тож перевірка — ті самі
 * предикати, що й політики, а не друга реалізація.
 */
interface Subject {
  /** Аргумент варіантів `_of` і порівняння з поточним користувачем. */
  user: string
  /** Дійсний користувач для носія на «Користувачів». */
  valid: string
  /** CTE рядків прав цього користувача. */
  granted: string
}

const CALLER: Subject = {
  user: CURRENT_USER,
  valid: CURRENT_USER,
  granted: "caller_granted",
}

const DETAIL_SELECT =
  "SELECT d.level, d.scope, d.container, d.object, d.action, d.extent, d.dimension_id, d.role_id, d.custom_role"

/** Рядок пояснення: стала політики й вирази без колонок рядка об'єкта. */
interface ExplainRow {
  policy: string
  kind: "permissive" | "restrictive"
  extent: string | null
  hasRight: string
  carrierMatch: string
  roles: string
}

const OUTPUT: readonly [name: string, type: string][] = [
  ["policy", "text"],
  ["kind", "text"],
  ["extent", "text"],
  ["has_right", "boolean"],
  ["carrier_match", "boolean"],
  ["roles", "uuid[]"],
]

const NO_ROLES = "'{}'::uuid[]"

/**
 * «Чому рядок видно» (спека прав §5.1): `simetra.rights_explain` — по
 * рядку на кожну політику читання основної таблиці об'єкта, яку бачить роль
 * запиту користувача. Рядки будує той самий будівник предикатів і ті самі
 * імена політик, що й `buildAccessUnits`, тож пояснення не розходиться з RLS:
 * рядок видно ⇔ рядок межі (якщо є) має `carrier_match` і хоч один
 * `permissive` рядок має `has_right AND carrier_match` — `RESTRICTIVE`
 * складаються через AND, `PERMISSIVE` — через OR. Без функцій прав політик
 * прав немає, тож і пояснювати нічого.
 */
export function buildExplainUnits(
  contracts: ExplainContracts,
  physical: PhysicalSnapshot,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  if (!hasRightsFunctions(contracts, provider)) return []
  const named = OUTPUT.map(([name, type]) => `${quoteIdent(name)} ${type}`)
  const sql = closedFunction(
    `${qualified(FN)}(p_object text, p_row uuid, p_user uuid)`,
    `TABLE (${named.join(", ")})`,
    explainBody(contracts, physical, provider)
  )
  return [
    sql,
    ...executeGrants(
      `${qualified(FN)}(text, uuid, uuid)`,
      ANALYSIS_ROLES,
      provider
    ),
  ].map((text): SqlUnit => ({
    ...generatedUnit(text, PLATFORM_SCHEMA, parse),
    module,
    generator: "rightsExplain",
  }))
}

/**
 * Тіло: права `p_user` раз (`granted`), далі гілка на кожен підтриманий
 * об'єкт. Гілка дає рядки, лише коли мітка збіглась, рядок є, гейт аналізу
 * пройдено (спека прав §5.1) і `p_user` належить скоупу рядка — інакше порожньо тієї
 * самої форми, тож відповідь не каже, чи рядок існує.
 */
function explainBody(
  contracts: ExplainContracts,
  physical: PhysicalSnapshot,
  provider: DatabaseProvider
): string {
  const rightsById = new Map(contracts.rights.map((c) => [c.objectId, c]))
  const context: BranchContext = {
    contracts,
    label: rightsPolicyLabel(contracts),
    visibleUsers: hasVisibleUsers(contracts, provider),
    subject: {
      user: USER,
      valid: userOf(FN, contracts).user,
      granted: "granted",
    },
  }
  const branches = contracts.access.flatMap((access) => {
    const rights =
      access.rights === undefined
        ? undefined
        : rightsById.get(access.rights.objectId)
    // Рядки об'єкта без контракту прав відкриває лише `publicRead`
    // (`buildAccessUnits` ставить його політику незалежно від прав); без нього
    // такого рядка не бачить ніхто — пояснювати нічого.
    if (rights === undefined && access.publicRead.length === 0) return []
    const main = must(mainTableOf(physical, access.objectId))
    if (main.schema !== access.table.schema || main.name !== access.table.name)
      return []
    // Рядок названо одним `p_row` лише за одноколонковим uuid-ключем `ref`:
    // регістр (реєстратор і рядок) і константа пояснення не мають; рядок ТЧ
    // пояснює рядок власника.
    const key = rootFamilyKey(main, main)
    if (key === undefined) return []
    const label = must(contracts.kindLabels.get(access.objectId))
    return branch(access, rights, label, main, key, context) ?? []
  })
  if (branches.length === 0) {
    return `SELECT ${OUTPUT.map(([name, type]) => `NULL::${type} AS ${name}`).join(", ")} WHERE false`
  }
  return [
    "WITH granted AS (",
    `  ${DETAIL_SELECT}`,
    `  FROM ${call(F.detailOf, [USER])} d`,
    `), ${CALLER.granted} AS (`,
    `  ${DETAIL_SELECT}`,
    `  FROM ${call(F.detailOf, [CURRENT_USER])} d`,
    ")",
    branches.join("\nUNION ALL\n"),
  ].join("\n")
}

interface BranchContext {
  contracts: ExplainContracts
  label: (predicate: RightsPredicate, contract: RightsContract) => string
  visibleUsers: boolean
  /** Користувач рядків пояснення — `p_user`. */
  subject: Subject
}

/**
 * Гілка об'єкта: рядки пояснення його основної таблиці під гейтом. Таблицю
 * без жодної політики читання не відкриває ніщо — гілки немає, і пояснення
 * порожнє, як для невідомої мітки.
 */
function branch(
  access: AccessContract,
  rights: RightsContract | undefined,
  kindLabel: string,
  main: PhysicalTable,
  key: string,
  context: BranchContext
): string | undefined {
  const rows = explainRows(access, rights, main, context, context.subject)
  if (rows.length === 0) return undefined
  const { contracts } = context
  const { scope } = access
  const publicRead = access.publicRead.length > 0
  // Скоуп рядка задає вид скоупу об'єкта й колонка скоупу рядка;
  // нескоуплений об'єкт питає лише глобальний адміністратор (спека прав §5.1).
  const request: AnalysisScope =
    scope === undefined
      ? { kind: uuidLiteral(ZERO_UUID), scope: uuidLiteral(ZERO_UUID) }
      : { kind: uuidLiteral(scope.scopeKindId), scope: row(scope.carrier) }
  const where = [
    `${param(FN, "p_object")} = ${sqlLiteral(kindLabel)}`,
    `${row(key)} = ${param(FN, "p_row")}`,
    analysisGate(contracts, request),
    // `p_user` мусить належати скоупу рядка (спека прав §5.1): адміністратор A не
    // дізнається фактів користувача, що належить лише B. Рядок `publicRead`
    // видно кожному — пояснення фактів `p_user` не розкриває.
    ...(scope !== undefined && !publicRead
      ? [
          `EXISTS (SELECT 1 FROM ${call(F.scopesOf, [USER])} s WHERE s.scope_kind_id = ${uuidLiteral(scope.scopeKindId)} AND s.scope = ${row(scope.carrier)})`,
        ]
      : []),
    // Пояснюється лише рядок, який бачить сам викликач (спека прав §5.1): інакше
    // адміністратор без `read` дізнався б носії рядка з `carrier_match`.
    visibility(explainRows(access, rights, main, context, CALLER)),
  ]
  return [
    "SELECT e.policy, e.kind, e.extent, e.has_right, e.carrier_match, e.roles",
    `FROM ${qualified(access.table)} r`,
    "CROSS JOIN LATERAL (",
    rows.map(renderRow).join("\n  UNION ALL\n"),
    ") e",
    `WHERE ${where.join("\n  AND ")}`,
  ].join("\n")
}

/**
 * Правило видимості над рядками пояснення — те саме, що RLS: кожен
 * `restrictive` (AND) і хоч один `permissive` (OR) з `has_right AND
 * carrier_match`. `NULL` у `WHERE` — не видно, як у політики.
 */
function visibility(rows: readonly ExplainRow[]): string {
  const restrictive = rows
    .filter((r) => r.kind === "restrictive")
    .map((r) => `(${r.carrierMatch})`)
  const permissive = rows
    .filter((r) => r.kind === "permissive")
    .map((r) => `(${r.hasRight} AND ${r.carrierMatch})`)
  return [
    ...restrictive,
    permissive.length === 0 ? "FALSE" : `(${permissive.join(" OR ")})`,
  ].join(" AND ")
}

/** Рядки пояснення основної таблиці для користувача `subject`. */
function explainRows(
  access: AccessContract,
  rights: RightsContract | undefined,
  main: PhysicalTable,
  { contracts, label, visibleUsers }: BranchContext,
  subject: Subject
): ExplainRow[] {
  const names = accessPolicyNames(access.table)
  const publicRead = access.publicRead.length > 0
  const rows: ExplainRow[] = []
  const { scope } = access
  // Межі — ті самі умови, що вирішують, чи `buildAccessUnits` ставить
  // політику межі: інакше пояснення назвало б політику, якої немає.
  if (scope !== undefined && !publicRead) {
    rows.push({
      policy: names.scopeRead,
      kind: "restrictive",
      extent: null,
      hasRight: "TRUE",
      carrierMatch: scopeSetMatch(
        contracts,
        scope,
        row(scope.carrier),
        subject
      ),
      roles: NO_ROLES,
    })
  }
  if (visibleUsers && access.users) {
    rows.push({
      policy: names.scopeRead,
      kind: "restrictive",
      extent: null,
      hasRight: "TRUE",
      carrierMatch: inSet(
        call(F.visibleUsersOf, [subject.user]),
        row(must(contracts.users).keyColumn)
      ),
      roles: NO_ROLES,
    })
  }
  if (publicRead) {
    rows.push({
      policy: names.publicRead,
      kind: "permissive",
      extent: null,
      hasRight: "TRUE",
      carrierMatch: "TRUE",
      roles: NO_ROLES,
    })
  } else if (
    rights !== undefined &&
    rights.actions.some((a) => a.action === "read")
  ) {
    const dimensions = new Map(
      contracts.accessDimensions.map((d) => [uuidLiteral(d.dimensionId), d])
    )
    for (const predicate of rightsPredicates(rights, "read", main, main)) {
      rows.push(
        predicateRow(
          predicate,
          rights,
          names.rights(label(predicate, rights)),
          dimensions,
          subject
        )
      )
    }
  }
  return rows
}

/**
 * Рядок предиката: умова гранту — `has_right` і `roles`, решта умов —
 * `carrier_match`. AND тих самих умов, що в політиці, лише розкладений на дві
 * частини, тож `has_right AND carrier_match` = `USING` політики для `p_user`.
 */
function predicateRow(
  predicate: RightsPredicate,
  rights: RightsContract,
  policy: string,
  dimensions: ReadonlyMap<string, ExplainContracts["accessDimensions"][number]>,
  subject: Subject
): ExplainRow {
  const grants = predicate.conditions.filter(isGrant)
  if (grants.length !== 1) throw new Error("internal: one grant per predicate")
  const grant = must(grants[0])
  const filter = grantFilter(predicate, grant, rights)
  const mine = predicate.conditions.filter((c) => !isGrant(c))
  const { inner } = extentOf(predicate)
  return {
    policy,
    kind: "permissive",
    extent: typeof inner === "string" ? inner : "dimension",
    hasRight: `EXISTS (SELECT 1 FROM ${subject.granted} g WHERE ${filter})`,
    carrierMatch:
      mine.length === 0
        ? "TRUE"
        : mine
            .map((condition) => carrierMatch(condition, dimensions, subject))
            .join(" AND "),
    roles: `ARRAY(SELECT DISTINCT x.role FROM ${subject.granted} g CROSS JOIN LATERAL (VALUES (g.role_id), (g.custom_role)) AS x(role) WHERE ${filter} AND x.role IS NOT NULL ORDER BY x.role)`,
  }
}

const isGrant = (condition: RightsCondition) =>
  condition.kind === "boolean" ||
  (condition.kind === "column" && condition.grantDependent)

/**
 * Рядки прав `p_user`, що дають грант предиката (спека прав §5.1), — ті самі, що
 * читає функція множини політики: скоуплений об'єкт — рядки рівня
 * скоупу зі скоупом рядка (`rights_any`/`own`/`dim`), контейнерний предикат —
 * рядки рівня контейнера з контейнером рядка (`rights_container`),
 * нескоуплений — будь-які рядки, крім контейнерних (`has_right`).
 */
function grantFilter(
  predicate: RightsPredicate,
  grant: RightsCondition,
  rights: RightsContract
): string {
  const { inner, container } = extentOf(predicate)
  const [name, dimension] =
    typeof inner === "string"
      ? [inner, "NULL"]
      : ["dimension", uuidLiteral(inner.dimensionId)]
  const column = columnOf(grant)
  const level =
    column === undefined
      ? "g.level <> 'container'"
      : container
        ? `g.level = 'container' AND g.container = ${row(column)}`
        : `g.level = 'scope' AND g.scope = ${row(column)}`
  return `${level} AND g.object = ${sqlLiteral(rights.kindLabel)} AND g.action = 'read' AND g.extent = ${sqlLiteral(name)} AND g.dimension_id IS NOT DISTINCT FROM ${dimension}`
}

/** Обсяг предиката без контейнера й чи це предикат у контейнері. */
function extentOf(predicate: RightsPredicate): {
  inner: ProjectionExtent
  container: boolean
} {
  const { extent } = predicate
  return typeof extent === "object" && "container" in extent
    ? { inner: extent.inner, container: true }
    : { inner: extent, container: false }
}

const columnOf = (condition: RightsCondition): string | undefined =>
  condition.kind === "boolean" ? undefined : condition.column

/**
 * Носій рядка ∈ множини `p_user` (спека прав §5.1): функцію множини поточного
 * користувача замінює її варіант `_of` з `p_user`. Дослівна функція виміру
 * знає лише поточного користувача: для себе — вона сама, для іншого —
 * `NULL` (невідомо), а не FALSE.
 */
function carrierMatch(
  condition: RightsCondition,
  dimensions: ReadonlyMap<string, ExplainContracts["accessDimensions"][number]>,
  subject: Subject
): string {
  switch (condition.kind) {
    case "currentUser":
      // Носій на «Користувачів» — сам `p_user`, лише дійсний, як у
      // `current_user_id()`; недійсний — FALSE, як і порожня множина.
      return `COALESCE(${row(condition.column)} = ${subject.valid}, FALSE)`
    case "column": {
      const { fn, args } = condition.set
      const column = row(condition.column)
      if (same(fn, F.myMembers)) {
        return inSet(call(F.membersOf, [subject.user, ...args]), column)
      }
      if (same(fn, F.dimensionValues)) {
        const dimension = must(dimensions.get(must(args[0])))
        return "function" in dimension.values
          ? currentOnly(inSet(call(fn, args), column), subject)
          : inSet(call(F.dimensionValuesOf, [subject.user, ...args]), column)
      }
      throw new Error(`internal: no analysis variant of ${qualified(fn)}`)
    }
    case "boolean":
      throw new Error("internal: a boolean condition is always a grant")
  }
}

/**
 * Межа тенанта: скоуп рядка ∈ множини скоупів `p_user`. Функцію множини
 * членства має варіант `rights_scope_set_of`; дослівна функція множини знає
 * лише поточного користувача.
 */
function scopeSetMatch(
  contracts: ExplainContracts,
  scope: NonNullable<AccessContract["scope"]>,
  column: string,
  subject: Subject
): string {
  const membership = contracts.membership.some(
    (m) =>
      m.scopeKindId === scope.scopeKindId &&
      m.setFunction !== undefined &&
      same(m.setFunction, scope.setFunction)
  )
  return membership
    ? inSet(
        call(F.scopeSetOf, [subject.user, uuidLiteral(scope.scopeKindId)]),
        column
      )
    : currentOnly(inSet(call(scope.setFunction), column), subject)
}

/** Для іншого користувача множина невідома — `NULL`, а не FALSE. */
const currentOnly = (match: string, subject: Subject) =>
  `CASE WHEN ${subject.user} = ${CURRENT_USER} THEN ${match} ELSE NULL END`

/**
 * Значення ∈ множини — строго TRUE чи FALSE: `EXISTS` істинний рівно тоді,
 * коли істинне `= ANY` політики, а `NULL` носія не робить відповідь невідомою.
 */
const inSet = (set: string, column: string) =>
  `EXISTS (SELECT 1 FROM ${set} AS v(value) WHERE v.value = ${column})`

const row = (column: string) => `r.${quoteIdent(column)}`

const same = (a: QualifiedName, b: QualifiedName) =>
  a.schema === b.schema && a.name === b.name

function renderRow(r: ExplainRow): string {
  return `  SELECT ${sqlLiteral(r.policy)}::text AS policy, ${sqlLiteral(r.kind)}::text AS kind, ${r.extent === null ? "NULL" : sqlLiteral(r.extent)}::text AS extent, ${r.hasRight} AS has_right, ${r.carrierMatch} AS carrier_match, ${r.roles} AS roles`
}
