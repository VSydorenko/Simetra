import {
  PLATFORM_SCHEMA,
  PROVIDER_IDENTITY_SOURCES,
  RIGHTS_COLUMNS,
  deletionMarkColumn,
  keyColumn,
  quoteIdent,
  tabularParentColumn,
  type AttributeCase,
  type DatabaseProvider,
  type GrantPurpose,
  type PhysicalSnapshot,
  type PhysicalTable,
  type StandardColumnDef,
} from "simetra/model"
import {
  mainTableOf,
  type AssignmentSourceContract,
  type CompiledAssignedOn,
  type CompiledRoleLevel,
  type Contracts,
  type ProjectionExtent,
  type QualifiedName,
  type RightsCatalogContract,
  type RightsContract,
  type RightsExtent,
  type RightsLevelKey,
  type RightsProjectionRow,
  type SourceConditionContract,
  qualified,
} from "../contracts"
import { compareStrings } from "../diagnostics"
import {
  CURRENT_USER,
  closedFunction,
  memberScopesBody,
  type ClosedFunctionShape,
} from "../membership-functions"
import { sha256HexSync } from "../sha256"
import { dollarTag } from "../movement-functions"
import type { CreationNode } from "../sql/dependencies"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { allowedActions, compareExtents, levelAllowsExtent } from "./expand"
import { levelKey } from "./facts"
import { must } from "./references"
import { rightsLevelOf } from "./system-catalogs"
import { sqlLiteral } from "../stages/model"
import { standardColumn } from "../standard-column"

const platform = (name: string): QualifiedName => ({
  schema: PLATFORM_SCHEMA,
  name,
})

/**
 * Імена функцій прав (спека прав §5.1): одне місце для генератора, будівника
 * умов і тестів.
 */
export const RIGHTS_FUNCTIONS = {
  projection: platform("rights_projection"),
  bump: platform("rights_bump"),
  versions: platform("rights_versions"),
  projectionVersion: platform("rights_projection_version"),
  fullAccessRoles: platform("rights_full_access_roles"),
  roleGrants: platform("rights_role_grants"),
  requires: platform("rights_requires"),
  domain: platform("rights_domain"),
  roles: platform("rights_roles"),
  sourceKeys: platform("rights_source_keys"),
  myScopes: platform("rights_my_scopes"),
  mine: platform("rights_mine"),
  any: platform("rights_any"),
  own: platform("rights_own"),
  dim: platform("rights_dim"),
  container: platform("rights_container"),
  hasRight: platform("has_right"),
  myMembers: platform("rights_my_members"),
  dimensionValues: platform("rights_dimension_values"),
  visibleUsers: platform("rights_visible_users"),
  scopesOf: platform("rights_scopes_of"),
  detailOf: platform("rights_detail_of"),
  membersOf: platform("rights_members_of"),
  dimensionValuesOf: platform("rights_dimension_values_of"),
  scopeSetOf: platform("rights_scope_set_of"),
  visibleUsersOf: platform("rights_visible_users_of"),
  member: platform("rights_member"),
  who: platform("rights_who"),
  explain: platform("rights_explain"),
  journalOf: platform("rights_journal_of"),
} as const satisfies Record<string, QualifiedName>

/**
 * Чиї права рахує шаблон (Р2d2-2): вираз користувача й функції його множин.
 * Функції поточного користувача й варіанти аналізу `_of` — те саме тіло з
 * іншим користувачем, тож друга реалізація призначень, дельт, замикання чи
 * «моїх скоупів» неможлива.
 */
export interface RightsUser {
  /** Дійсний користувач чи `NULL` — некорельований вираз. */
  user: string
  /** Множина «мої скоупи» цього користувача. */
  scopes: string
  /** Учасники цього користувача виду скоупу `scopeKind`. */
  members: (scopeKind: string) => string
  /**
   * Поточний користувач сесії: лише його множину знають дослівні функції
   * проєкту (виміру, множини скоупу).
   */
  current: boolean
}

const CURRENT: RightsUser = {
  user: CURRENT_USER,
  scopes: call(RIGHTS_FUNCTIONS.myScopes),
  members: (scopeKind) => call(RIGHTS_FUNCTIONS.myMembers, [scopeKind]),
  current: true,
}

/**
 * Користувач аргументу `p_user` варіанта `fn`. Діє лише дійсний — та сама
 * умова, що в `current_user_id()`; інакше вираз — `NULL` і варіант порожній,
 * як і права недійсного поточного користувача. Без «Користувачів» дійсність
 * не визначена, тож аргумент — як є. Вкладені множини кличуть варіанти з
 * тим самим аргументом: кожен перевіряє дійсність сам.
 */
export function userOf(
  fn: QualifiedName,
  contracts: RightsFunctionContracts
): RightsUser {
  const p = param(fn, "p_user")
  const { users } = contracts
  const key = users === undefined ? "" : `u.${quoteIdent(users.keyColumn)}`
  return {
    user:
      users === undefined
        ? p
        : `(SELECT ${key} FROM ${qualified(users.table)} u WHERE ${key} = ${p} AND NOT u.${quoteIdent(users.invalidColumn)})`,
    scopes: call(RIGHTS_FUNCTIONS.scopesOf, [p]),
    members: (scopeKind) => call(RIGHTS_FUNCTIONS.membersOf, [p, scopeKind]),
    current: false,
  }
}

/**
 * Хто виконує функції множини й помічники (Р2a1-14): роль запиту
 * користувача, сервісна (для неї — порожні множини) і роль команд. Функції
 * даних не виконує ніхто, крім власника: їх кличуть лише функції `definer`.
 */
const SET_ROLES: readonly GrantPurpose[] = ["user", "service", "command"]

/**
 * Хто виконує функції аналізу прав (Р2d2-1): без сервісної ролі — у неї немає
 * користувача, а аналіз розкриває чужі права.
 */
export const ANALYSIS_ROLES: readonly GrantPurpose[] = ["user", "command"]

/** Контракти, з яких генератор будує функції (Р2a1-22, Р2a1-24). */
export type RightsFunctionContracts = Pick<
  Contracts,
  | "rights"
  | "roles"
  | "rightsProjection"
  | "rightsCatalogs"
  | "accessDimensions"
  | "membership"
  | "membershipSources"
  | "assignmentSources"
  | "users"
>

interface Declaration {
  fn: QualifiedName
  /** Аргументи з іменами — у `CREATE`, лише типи — у `GRANT`. */
  args: readonly [name: string, type: string][]
  returns: string
  body: string
  shape: ClosedFunctionShape | "stable" | "write"
  grants?: readonly GrantPurpose[]
  requires?: readonly CreationNode[]
}

/**
 * Чи є в проєкті `simetra.current_user_id()` (Р2a1-30, Р2d1-6, Р2d1-7) — одне
 * місце, з яким звіряються шар сесії, генератор прав і генератори політик.
 * Функцію дає шар «Користувачів», а без них — лише прийняте джерело членства
 * на провайдері, де `sub` і є id користувача (спека прав §4.6, С8): колонка
 * користувача джерела порівнюється з ним напряму.
 */
export function hasSessionUser(
  contracts: Pick<Contracts, "users" | "membershipSources">,
  provider: DatabaseProvider
): boolean {
  return (
    contracts.users !== undefined ||
    (contracts.membershipSources.length > 0 &&
      PROVIDER_IDENTITY_SOURCES[provider].subjectIsUserId)
  )
}

/**
 * Чи є в проєкті функції прав (Р2a1-15, Р2a2-24, Р2d1-7) — одне місце, з яким
 * звіряються генератор функцій і генератор політик: політика, що кличе
 * неіснуючу функцію, не застосувалась би. Без жодної `Role` прав немає; без
 * функції поточного користувача — теж (fail-closed, Р2a1-30).
 */
export function hasRightsFunctions(
  contracts: Pick<Contracts, "roles" | "users" | "membershipSources">,
  provider: DatabaseProvider
): boolean {
  return contracts.roles.length > 0 && hasSessionUser(contracts, provider)
}

/**
 * Чи є межа видимості «Користувачів» (Р2a2-18, Р2d1-7): функції прав, самі
 * «Користувачі» й хоч одне членство — довідник чи прийняте джерело; без
 * учасників «моїх скоупів» множина звелася б до «я».
 */
export function hasVisibleUsers(
  contracts: Pick<
    Contracts,
    "roles" | "users" | "membership" | "membershipSources"
  >,
  provider: DatabaseProvider
): boolean {
  return (
    hasRightsFunctions(contracts, provider) &&
    contracts.users !== undefined &&
    (contracts.membership.length > 0 || contracts.membershipSources.length > 0)
  )
}

/**
 * Функції прав у схемі `simetra` (спека прав §5.1) — згенеровані одиниці без
 * власника, як механіка рядків: вони спільні для всіх об'єктів. Без жодної
 * `Role` функцій немає (Р2a1-15). Фізичні колонки системних довідників і
 * контейнерів генератор бере зі знімка за походженням колонки, а не за
 * іменем.
 */
export function buildRightsUnits(
  contracts: RightsFunctionContracts,
  physical: PhysicalSnapshot,
  attributeCase: AttributeCase,
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  if (!hasRightsFunctions(contracts, provider)) return []
  const F = RIGHTS_FUNCTIONS
  const text = (name: string): [string, string] => [name, "text"]
  const uuid = (name: string): [string, string] => [name, "uuid"]
  const data = (
    fn: QualifiedName,
    returns: string,
    body: string
  ): Declaration => ({ fn, args: [], returns, body, shape: "data" })
  const definer = (
    fn: QualifiedName,
    args: Declaration["args"],
    returns: string,
    body: string
  ): Declaration => ({ fn, args, returns, body, shape: "definer" })
  // Варіант аналізу (Р2d2-2): без `EXECUTE`, його кличуть лише функції
  // аналізу від власника.
  const variant = (
    fn: QualifiedName,
    args: Declaration["args"],
    returns: string,
    body: string
  ): Declaration => ({
    fn,
    args: [uuid("p_user"), ...args],
    returns,
    body,
    shape: "stable",
  })
  const analysis = (
    fn: QualifiedName,
    args: Declaration["args"],
    returns: string,
    body: string
  ): Declaration => ({
    ...definer(fn, args, returns, body),
    grants: ANALYSIS_ROLES,
  })
  const of = (fn: QualifiedName) => userOf(fn, contracts)
  const declarations: Declaration[] = [
    data(
      F.projection,
      table(PROJECTION_COLUMNS),
      valuesBody(PROJECTION_COLUMNS, projectionRows(contracts))
    ),
    data(
      F.requires,
      table(REQUIRES_COLUMNS),
      valuesBody(REQUIRES_COLUMNS, requiresRows(contracts.rights))
    ),
    data(
      F.domain,
      table(DOMAIN_COLUMNS),
      valuesBody(DOMAIN_COLUMNS, domainRows(contracts))
    ),
    data(
      F.roles,
      table(ROLES_COLUMNS),
      valuesBody(ROLES_COLUMNS, rolesRows(contracts))
    ),
    data(
      F.sourceKeys,
      table(SOURCE_KEYS_COLUMNS),
      valuesBody(SOURCE_KEYS_COLUMNS, sourceKeysRows(contracts))
    ),
    definer(
      F.myScopes,
      [],
      table(MY_SCOPES_COLUMNS),
      myScopesBody(contracts, CURRENT)
    ),
    variant(
      F.scopesOf,
      [],
      table(MY_SCOPES_COLUMNS),
      myScopesBody(contracts, of(F.scopesOf))
    ),
    definer(
      F.mine,
      [],
      table(MINE_COLUMNS),
      mineBody(contracts, physical, attributeCase, CURRENT, false)
    ),
    variant(
      F.detailOf,
      [],
      table(DETAIL_COLUMNS),
      mineBody(contracts, physical, attributeCase, of(F.detailOf), true)
    ),
    definer(
      F.any,
      [text("p_action"), text("p_object")],
      "SETOF uuid",
      scopesBody(F.any, "any")
    ),
    definer(
      F.own,
      [text("p_action"), text("p_object")],
      "SETOF uuid",
      scopesBody(F.own, "own")
    ),
    definer(
      F.dim,
      [text("p_action"), text("p_object"), uuid("p_dimension")],
      "SETOF uuid",
      scopesBody(F.dim, "dimension")
    ),
    definer(
      F.container,
      [
        text("p_action"),
        text("p_object"),
        text("p_extent"),
        uuid("p_dimension"),
      ],
      "SETOF uuid",
      containerBody()
    ),
    definer(
      F.hasRight,
      [
        text("p_action"),
        text("p_object"),
        text("p_extent"),
        uuid("p_dimension"),
      ],
      "boolean",
      hasRightBody()
    ),
    definer(
      F.myMembers,
      [uuid("p_scope_kind")],
      "SETOF uuid",
      membersBody(F.myMembers, CURRENT)
    ),
    variant(
      F.membersOf,
      [uuid("p_scope_kind")],
      "SETOF uuid",
      membersBody(F.membersOf, of(F.membersOf))
    ),
    definer(
      F.dimensionValues,
      [uuid("p_dimension")],
      "SETOF uuid",
      dimensionValuesBody(contracts, F.dimensionValues, CURRENT)
    ),
    variant(
      F.dimensionValuesOf,
      [uuid("p_dimension")],
      "SETOF uuid",
      dimensionValuesBody(
        contracts,
        F.dimensionValuesOf,
        of(F.dimensionValuesOf)
      )
    ),
    variant(
      F.scopeSetOf,
      [uuid("p_scope_kind")],
      "SETOF uuid",
      scopeSetOfBody(contracts, of(F.scopeSetOf))
    ),
    ...(hasVisibleUsers(contracts, provider)
      ? [
          definer(
            F.visibleUsers,
            [],
            "SETOF uuid",
            visibleUsersBody(contracts, CURRENT)
          ),
          variant(
            F.visibleUsersOf,
            [],
            "SETOF uuid",
            visibleUsersBody(contracts, of(F.visibleUsersOf))
          ),
        ]
      : []),
    analysis(
      F.member,
      [uuid("p_scope_kind"), uuid("p_scope"), uuid("p_member")],
      table(MEMBER_COLUMNS),
      memberBody(contracts)
    ),
    analysis(
      F.who,
      [
        text("p_action"),
        text("p_object"),
        uuid("p_scope_kind"),
        uuid("p_scope"),
      ],
      table(WHO_COLUMNS),
      whoBody(contracts, physical, attributeCase)
    ),
  ]
  if (contracts.rightsCatalogs.length > 0) {
    declarations.push(
      data(
        F.fullAccessRoles,
        table([
          ["role_id", "uuid"],
          ["storage", "text"],
          ["storage_id", "uuid"],
        ]),
        valuesBody(
          [
            ["role_id", "uuid"],
            ["storage", "text"],
            ["storage_id", "uuid"],
          ],
          contracts.roles
            .filter((role) => role.fullAccess)
            .map((role) => [
              role.roleId,
              ...storageValues(rightsLevelOf(role.assignedOn, contracts)),
            ])
        )
      ),
      {
        fn: F.roleGrants,
        args: [
          text("p_level"),
          uuid("p_level_id"),
          uuid("p_archetype"),
          ["p_delta", "jsonb"],
        ],
        returns: table(PROJECTION_COLUMNS.slice(1)),
        body: roleGrantsBody(),
        shape: "stable",
      },
      {
        fn: F.bump,
        args: [uuid("p_scope_kind"), uuid("p_scope")],
        returns: "void",
        shape: "write",
        requires: [
          { type: "table", schema: PLATFORM_SCHEMA, name: "rights_versions" },
        ],
        body: [
          "BEGIN",
          `  INSERT INTO ${qualified(F.versions)} AS v (scope_kind_id, scope, version)`,
          "  VALUES (p_scope_kind, p_scope, 1)",
          "  ON CONFLICT (scope_kind_id, scope) DO UPDATE SET version = v.version + 1;",
          "END;",
        ].join("\n"),
      },
      analysis(
        F.journalOf,
        [uuid("p_scope_kind"), uuid("p_scope"), ["p_limit", "integer"]],
        table(journalColumns(physical)),
        journalBody(contracts, physical)
      ),
      definer(
        F.versions,
        [],
        "TABLE (scope_kind_id uuid, scope uuid, version bigint)",
        [
          `SELECT s.scope_kind_id, s.scope, coalesce(v.version, 0::bigint)`,
          `FROM (SELECT DISTINCT m.scope_kind_id, m.scope FROM ${call(F.myScopes)} m`,
          `      UNION SELECT '${ZERO_UUID}'::uuid, '${ZERO_UUID}'::uuid) s`,
          `LEFT JOIN ${qualified(F.versions)} v USING (scope_kind_id, scope)`,
        ].join("\n")
      )
    )
  }
  const render = ({
    fn,
    args,
    returns,
    body,
    shape,
    grants,
    requires,
  }: Declaration): SqlUnit[] => {
    const named = args.map(([name, type]) => `${name} ${type}`).join(", ")
    const types = args.map(([, type]) => type).join(", ")
    const signature = `${qualified(fn)}(${named})`
    const tag = dollarTag(body)
    const sql =
      shape === "write"
        ? `CREATE OR REPLACE FUNCTION ${signature} RETURNS ${returns} LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' SET row_security = off AS ${tag}\n${body}\n${tag};`
        : shape === "stable"
          ? `CREATE OR REPLACE FUNCTION ${signature} RETURNS ${returns} LANGUAGE sql STABLE SET search_path = '' AS ${tag}\n${body}\n${tag};`
          : closedFunction(signature, returns, body, shape)
    return [
      sql,
      ...executeGrants(
        `${qualified(fn)}(${types})`,
        grants ?? (shape === "definer" ? SET_ROLES : []),
        provider
      ),
    ].map((text, i): SqlUnit => ({
      ...generatedUnit(text, PLATFORM_SCHEMA, parse),
      module,
      generator: "rights",
      ...(i === 0 && requires !== undefined ? { requires } : {}),
    }))
  }
  const units = declarations
    .flatMap(render)
    .sort((a, b) => compareStrings(a.identity, b.identity))
  if (contracts.rightsCatalogs.length > 0) {
    const version = sha256HexSync(units.map((unit) => unit.sql).join("\n"))
    units.push(
      ...render({
        ...data(
          F.projectionVersion,
          "text",
          `SELECT ${sqlLiteral(version)}::text`
        ),
        grants: SET_ROLES,
      })
    )
  }
  return units.sort((a, b) => compareStrings(a.identity, b.identity))
}

/** Нульовий ключ замінює NULL глобального рівня в ключах службових таблиць. */
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000"

/**
 * Та сама форма рядків і те саме замикання, що у власних правах: зміна
 * вимог не може розійтися між перевіркою приросту й читанням прав актора.
 */
function roleGrantsBody(): string {
  const F = RIGHTS_FUNCTIONS
  const p = (name: string) => param(F.roleGrants, name)
  const shape = `NULL::text AS storage, NULL::uuid AS storage_id, NULL::uuid AS scope, NULL::uuid AS container, NULL::uuid AS custom_role, ${p("p_archetype")} AS archetype, ${p("p_level")} AS level, ${p("p_level_id")} AS level_id`
  return [
    "WITH typed AS (",
    `  SELECT r.role_id FROM ${call(F.roles)} r`,
    `  WHERE r.role_id = ${p("p_archetype")} AND r.level = ${p("p_level")} AND r.level_id IS NOT DISTINCT FROM ${p("p_level_id")}`,
    "), deltas AS (",
    `  SELECT d.object, d.action, d.extent, d.dimension AS dimension_id, d.effect`,
    `  FROM jsonb_to_recordset(${p("p_delta")}) AS d(object text, action text, extent text, dimension uuid, effect text)`,
    "), role_rows AS (",
    // Віднімання `deny` — `EXCEPT` (хеш, `NULL` виміру рівні нативно), а не
    // корельований `NOT EXISTS` над CTE (Р2d2-26): рядки архетипу — дії з
    // проєкції, без `NULL` в об'єкті, дії й обсязі, тож `=` і рівність
    // `EXCEPT` збігаються; дублікати знімає `DISTINCT` результату.
    `  SELECT ${shape}, k.object, k.action, k.extent, k.dimension_id`,
    "  FROM (",
    `    SELECT p.object, p.action, p.extent, p.dimension_id FROM typed r JOIN ${call(F.projection)} p ON p.role_id = r.role_id`,
    "    EXCEPT",
    "    SELECT d.object, d.action, d.extent, d.dimension_id FROM deltas d WHERE d.effect = 'deny'",
    "  ) k",
    "  UNION ALL",
    `  SELECT ${shape}, d.object, d.action, d.extent, d.dimension_id`,
    `  FROM typed r CROSS JOIN deltas d JOIN ${call(F.domain)} m`,
    `    ON m.level = ${p("p_level")} AND m.level_id IS NOT DISTINCT FROM ${p("p_level_id")}`,
    "   AND m.object = d.object AND m.action = d.action AND m.extent = d.extent AND m.dimension_id IS NOT DISTINCT FROM d.dimension_id",
    "  WHERE d.effect = 'allow'",
    `), closure_1 AS (\n${closurePass("role_rows", CLOSURE_COLUMNS)}\n), closure_2 AS (\n${closurePass("closure_1", CLOSURE_COLUMNS)}\n)`,
    "SELECT DISTINCT object, action, extent, dimension_id FROM closure_2",
  ].join("\n")
}

// --- Функції даних --------------------------------------------------------

type Column = readonly [name: string, type: string]
type Value = string | null

const PROJECTION_COLUMNS: readonly Column[] = [
  ["role_id", "uuid"],
  ["object", "text"],
  ["action", "text"],
  ["extent", "text"],
  ["dimension_id", "uuid"],
]
const REQUIRES_COLUMNS: readonly Column[] = [
  ["object", "text"],
  ["action", "text"],
  ["required", "text"],
]
const DOMAIN_COLUMNS: readonly Column[] = [
  ["level", "text"],
  ["level_id", "uuid"],
  ["object", "text"],
  ["action", "text"],
  ["extent", "text"],
  ["dimension_id", "uuid"],
]
const ROLES_COLUMNS: readonly Column[] = [
  ["role_id", "uuid"],
  ["level", "text"],
  ["level_id", "uuid"],
  ["storage", "text"],
  ["storage_id", "uuid"],
]
const SOURCE_KEYS_COLUMNS: readonly Column[] = [
  ["source_id", "uuid"],
  ["key", "text"],
  ["role_id", "uuid"],
]
const MY_SCOPES_COLUMNS: readonly Column[] = [
  ["scope_kind_id", "uuid"],
  ["scope", "uuid"],
  ["member", "uuid"],
]
const MINE_COLUMNS: readonly Column[] = [
  ["level", "text"],
  ["level_id", "uuid"],
  ["scope", "uuid"],
  ["container", "uuid"],
  ["object", "text"],
  ["action", "text"],
  ["extent", "text"],
  ["dimension_id", "uuid"],
]
/**
 * Рядки прав з походженням (Р2d2-2): архетип, кастомна роль і чи дав рядок
 * архетип, чи дельта `allow`.
 */
const DETAIL_COLUMNS: readonly Column[] = [
  ...MINE_COLUMNS,
  ["role_id", "uuid"],
  ["custom_role", "uuid"],
  ["via", "text"],
]
/** Права учасника в скоупі запиту з походженням (Р2d2-4). */
const MEMBER_COLUMNS: readonly Column[] = [
  ["object", "text"],
  ["action", "text"],
  ["extent", "text"],
  ["dimension_id", "uuid"],
  ["container", "uuid"],
  ["role_id", "uuid"],
  ["custom_role", "uuid"],
  ["via", "text"],
]
/** Хто має право через ролі рівня запиту (Р2d2-5). */
const WHO_COLUMNS: readonly Column[] = [
  ["user_id", "uuid"],
  ["member", "uuid"],
  ["role_id", "uuid"],
  ["custom_role", "uuid"],
  ["extent", "text"],
  ["dimension_id", "uuid"],
  ["container", "uuid"],
]

/** Пара (обсяг, вимір) рядка: вимір — лише в обсягу `dimension`. */
function extentValues(extent: ProjectionExtent): [string, Value] {
  return typeof extent === "string"
    ? [extent, null]
    : ["dimension", extent.dimensionId]
}

function projectionExtent(extent: RightsExtent): ProjectionExtent {
  return extent.form === "dimension"
    ? { dimensionId: extent.dimensionId }
    : extent.form
}

function levelValues(level: CompiledRoleLevel): [string, Value] {
  switch (level.level) {
    case "scope":
      return ["scope", level.scopeKindId]
    case "container":
      return ["container", level.containerId]
    default:
      return [level.level, null]
  }
}

interface DomainEntry {
  contract: RightsContract
  action: string
  extent: ProjectionExtent
}

/**
 * Домен рівня (Р2a1-12): кожна дія кожного об'єкта, яку рівень дозволяє, на
 * кожному підтриманому обсязі, який рівень має. Ті самі правила, що в
 * розгортанні ролі (`allowedActions`, `levelAllowsExtent`), тож дельта не
 * дасть кастомній ролі нічого, чого не дав би грант її архетипу; з них же
 * розгорнуто `fullAccess` (Р2a1-9).
 */
function levelDomain(
  level: CompiledRoleLevel,
  rights: readonly RightsContract[]
): DomainEntry[] {
  return rights.flatMap((contract) => {
    const allowed = allowedActions(level, contract)
    if (allowed === undefined) return []
    return contract.actions.flatMap(({ action, extents }) =>
      allowed.has(action)
        ? extents
            .map(projectionExtent)
            .filter((extent) => levelAllowsExtent(level, extent))
            .map((extent) => ({ contract, action, extent }))
        : []
    )
  })
}

/** The desired delta domain for each archetype, using the rights generator's level rules. */
export function rightsDomainRows(
  contracts: Pick<Contracts, "rights" | "roles">
): {
  roleId: string
  object: string
  action: string
  extent: string
  dimensionId: string | null
}[] {
  return contracts.roles.flatMap((role) =>
    levelDomain(role.assignedOn, contracts.rights).map((entry) => {
      const [extent, dimensionId] = extentValues(entry.extent)
      return {
        roleId: role.roleId,
        object: entry.contract.kindLabel,
        action: entry.action,
        extent,
        dimensionId,
      }
    })
  )
}

/**
 * Рядки проєкції з розгорнутим `fullAccess` (Р2a1-9): роль з повними правами
 * отримує явні рядки всього домену свого рівня, тож гілки обходу в SQL
 * немає. Порядок — порядок проєкції. Одне місце для таблиці проєкції й для
 * попередження на вид скоупу: «хто читає» в попередженні — рівно те, що
 * побачать політики.
 */
export function expandedProjection(
  contracts: Pick<Contracts, "rights" | "roles" | "rightsProjection">
): Pick<RightsProjectionRow, "roleId" | "objectId" | "action" | "extent">[] {
  const rows = new Map<
    string,
    Pick<RightsProjectionRow, "roleId" | "objectId" | "action" | "extent">
  >()
  const add = (
    roleId: string,
    objectId: string,
    action: string,
    extent: ProjectionExtent
  ) => {
    const [extentName, dimension] = extentValues(extent)
    rows.set(
      JSON.stringify([roleId, objectId, action, extentName, dimension]),
      {
        roleId,
        objectId,
        action,
        extent,
      }
    )
  }
  for (const row of contracts.rightsProjection) {
    add(row.roleId, row.objectId, row.action, row.extent)
  }
  for (const role of contracts.roles) {
    if (!role.fullAccess) continue
    for (const entry of levelDomain(role.assignedOn, contracts.rights)) {
      add(role.roleId, entry.contract.objectId, entry.action, entry.extent)
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      compareStrings(a.roleId, b.roleId) ||
      compareStrings(a.objectId, b.objectId) ||
      compareStrings(a.action, b.action) ||
      compareExtents(a.extent, b.extent)
  )
}

function projectionRows(contracts: RightsFunctionContracts): Value[][] {
  const byObject = new Map(contracts.rights.map((c) => [c.objectId, c]))
  return expandedProjection(contracts).map((row) => [
    row.roleId,
    must(byObject.get(row.objectId)).kindLabel,
    row.action,
    ...extentValues(row.extent),
  ])
}

/** Вимоги дій — уже транзитивне замикання контракту (`RightsAction.requires`). */
function requiresRows(rights: readonly RightsContract[]): Value[][] {
  return rights.flatMap((contract) =>
    contract.actions.flatMap(({ action, requires }) =>
      requires.map((required) => [contract.kindLabel, action, required])
    )
  )
}

/** Домени рівнів, на яких є ролі, — кожен рівень раз, у порядку ролей. */
function domainRows(contracts: RightsFunctionContracts): Value[][] {
  const levels = new Map<string, CompiledRoleLevel>()
  for (const role of contracts.roles) {
    levels.set(levelKey(role.assignedOn), role.assignedOn)
  }
  return [...levels.values()].flatMap((level) =>
    levelDomain(level, contracts.rights).map(({ contract, action, extent }) => [
      ...levelValues(level),
      contract.kindLabel,
      action,
      ...extentValues(extent),
    ])
  )
}

/**
 * Рівні ролей і рівень зберігання їхніх призначень (Р2a1-12, Р2a1-24) —
 * стала генератора з `rightsLevelOf`: `NULL` — «кожен користувач» чи рівень,
 * покритий прийнятим джерелом, тож рядок довідника призначень такої ролі не
 * вмикає.
 */
function rolesRows(contracts: RightsFunctionContracts): Value[][] {
  return contracts.roles.map((role) => [
    role.roleId,
    ...levelValues(role.assignedOn),
    ...storageValues(rightsLevelOf(role.assignedOn, contracts)),
  ])
}

/**
 * Ключі ролей у прийнятих джерелах призначень (Р2d1-4): (джерело, ключ) →
 * архетип. Стала генератора, тож невідомий ключ у даних цілі не з'єднується
 * ні з чим (fail-closed, спека прав §4.7).
 */
function sourceKeysRows(contracts: RightsFunctionContracts): Value[][] {
  return contracts.roles.flatMap((role) =>
    role.sourceKeys.map(({ sourceId, key }) => [sourceId, key, role.roleId])
  )
}

function storageValues(level: RightsLevelKey | undefined): [Value, Value] {
  if (level === undefined) return [null, null]
  return level.level === "global"
    ? ["global", null]
    : ["scope", level.scopeKindId]
}

function table(columns: readonly Column[]): string {
  return `TABLE (${columns.map(([name, type]) => `${quoteIdent(name)} ${type}`).join(", ")})`
}

/**
 * Тіло функції даних — `VALUES` з типізованими сталими; без рядків —
 * порожня множина тих самих типів.
 */
function valuesBody(columns: readonly Column[], rows: Value[][]): string {
  const names = columns.map(([name]) => name).join(", ")
  if (rows.length === 0) return emptySet(columns)
  const value = (v: Value, type: string) =>
    v === null ? `NULL::${type}` : `${sqlLiteral(v)}::${type}`
  const lines = rows.map(
    (row) =>
      `  (${row.map((v, i) => value(v, must(columns[i])[1])).join(", ")})`
  )
  return [
    `SELECT ${names}`,
    `FROM (VALUES`,
    lines.join(",\n"),
    `) AS v(${names})`,
  ].join("\n")
}

function emptySet(columns: readonly Column[]): string {
  return `SELECT ${columns.map(([name, type]) => `NULL::${type} AS ${name}`).join(", ")} WHERE false`
}

// --- Функції множини ------------------------------------------------------

/**
 * Мої скоупи (Р2a1-25, Р2a1-26): єдине місце, що читає таблиці членства й
 * прийняті джерела членства (Р2d1-3), — учасник поточного користувача за
 * видом скоупу, за тією самою умовою, що функція множини членства. Без
 * членства — порожня множина.
 */
function myScopesBody(
  contracts: RightsFunctionContracts,
  whose: RightsUser
): string {
  const catalogs = contracts.membership.map((m) => {
    const user = `m.${quoteIdent(m.userColumn)}`
    return [
      `SELECT ${uuidLiteral(m.scopeKindId)} AS scope_kind_id, m.${quoteIdent(m.scopeColumn)} AS scope, m.${quoteIdent(m.keyColumn)} AS member`,
      `FROM ${qualified(m.table)} m`,
      `WHERE ${user} IS NOT NULL`,
      `  AND ${user} = ${whose.user}`,
    ].join("\n")
  })
  const sources = contracts.membershipSources.map((source) => {
    const user = `s.${quoteIdent(source.user)}`
    return [
      `SELECT ${uuidLiteral(source.scopeKindId)} AS scope_kind_id, s.${quoteIdent(source.scope)} AS scope, s.${quoteIdent(source.member)} AS member`,
      `FROM ${qualified(source.table)} s`,
      `WHERE ${user} IS NOT NULL`,
      `  AND ${user} = ${whose.user}`,
      ...activeCondition("s", source.active).map((c) => `  AND ${c}`),
      ...sourceConditions("s", source.where).map((c) => `  AND ${c}`),
    ].join("\n")
  })
  const branches = [...catalogs, ...sources]
  if (branches.length === 0) return emptySet(MY_SCOPES_COLUMNS)
  return branches.join("\nUNION ALL\n")
}

/**
 * Умова активності рядка прийнятого джерела: `IS TRUE`, тож `NULL` прав не дає
 * (fail-closed); без змапованої колонки активний кожен рядок.
 */
function activeCondition(alias: string, column: string | undefined): string[] {
  return column === undefined ? [] : [`${alias}.${quoteIdent(column)} IS TRUE`]
}

/**
 * Кон'юнкти умови рядків прийнятого джерела чи його таблиці ролей
 * (Р2d1-15): рівність колонки літералу чи `IS [NOT] NULL`. Умова лише
 * звужує, а `NULL = <літерал>` рядка не дає (fail-closed). Ті самі кон'юнкти
 * читає план ключів ролей (Р2d1-11), тож форма — одна.
 */
export function sourceConditions(
  alias: string,
  conditions: readonly SourceConditionContract[]
): string[] {
  return conditions.map((condition) => {
    const column = `${alias}.${quoteIdent(condition.column)}`
    if ("isNull" in condition) {
      return `${column} IS ${condition.isNull ? "" : "NOT "}NULL`
    }
    const { equals } = condition
    switch (condition.type) {
      case "uuid":
        return `${column} = ${uuidLiteral(String(equals))}`
      case "boolean":
        return `${column} = ${equals === true ? "TRUE" : "FALSE"}`
      default:
        return `${column} = ${sqlLiteral(equals)}`
    }
  })
}

/**
 * З'єднання рядка джерела `src` з таблицею ролей `sr` (Р2d1-17): посилання й
 * умова ролі. Одне місце для гілки джерела `rights_mine` і запиту ключів плану
 * (Р2d1-18): розійдися вони — план називав би ключі рядків, яких функції прав
 * не читають, чи мовчав би про ті, що читають. Без таблиці ролей — порожньо.
 */
export function roleTableJoin(source: AssignmentSourceContract): string[] {
  const { roleTable } = source
  if (roleTable === undefined) return []
  return [
    `JOIN ${qualified(roleTable.table)} sr`,
    `  ON ${[
      `sr.${quoteIdent(roleTable.id)} = src.${quoteIdent(source.role)}`,
      ...sourceConditions("sr", roleTable.where),
    ].join("\n AND ")}`,
  ]
}

/**
 * Видимі «Користувачі» (спека системної схеми §12, Р2a2-18): я ∪ користувачі
 * учасників моїх скоупів. Мої скоупи обчислює лише `rights_my_scopes`
 * (Р2a1-25); таблицю членства виду K функція читає лише за рядками
 * `rights_my_scopes()` того самого виду (Р2a1-26) — інакше учасник іншого
 * виду з тим самим значенням скоупу відкрив би чужих користувачів.
 */
function visibleUsersBody(
  contracts: RightsFunctionContracts,
  whose: RightsUser
): string {
  return [
    `SELECT ${whose.user}`,
    `WHERE ${whose.user} IS NOT NULL`,
    ...contracts.membership.flatMap((m) => {
      const user = `m.${quoteIdent(m.userColumn)}`
      return [
        `UNION`,
        `SELECT ${user}`,
        `FROM ${qualified(m.table)} m`,
        `JOIN ${whose.scopes} s`,
        `  ON s.scope_kind_id = ${uuidLiteral(m.scopeKindId)}`,
        ` AND s.scope = m.${quoteIdent(m.scopeColumn)}`,
        `WHERE ${user} IS NOT NULL`,
      ]
    }),
    // Учасники прийнятого джерела (Р2d1-8) — за тією самою умовою активності,
    // що «мої скоупи»: неактивний учасник не відкриває свого користувача.
    ...contracts.membershipSources.flatMap((source) => {
      const user = `m.${quoteIdent(source.user)}`
      return [
        `UNION`,
        `SELECT ${user}`,
        `FROM ${qualified(source.table)} m`,
        `JOIN ${whose.scopes} s`,
        `  ON s.scope_kind_id = ${uuidLiteral(source.scopeKindId)}`,
        ` AND s.scope = m.${quoteIdent(source.scope)}`,
        `WHERE ${user} IS NOT NULL`,
        ...activeCondition("m", source.active).map((c) => `  AND ${c}`),
        ...sourceConditions("m", source.where).map((c) => `  AND ${c}`),
      ]
    }),
  ].join("\n")
}

/**
 * Права користувача (спека прав §5.1): призначення з довідників прав, рядки
 * їхніх ролей, замикання вимог і рядки «кожного користувача». Кожен
 * запобіжник — окрема умова, яку мутаційний DB-сценарій прибирає поодинці.
 * `detail` додає походження рядка (Р2d2-2) — лише вихідними колонками: тіло
 * без них — рівно тіло `rights_mine`.
 */
function mineBody(
  contracts: RightsFunctionContracts,
  physical: PhysicalSnapshot,
  style: AttributeCase,
  user: RightsUser,
  detail: boolean
): string {
  const via = (source: string) => (detail ? `, '${source}'::text AS via` : "")
  const closure = detail ? DETAIL_CLOSURE_COLUMNS : CLOSURE_COLUMNS
  const ctes: [string, string, string?][] = [
    [
      "my_scopes",
      `SELECT s.scope_kind_id, s.scope, s.member\nFROM ${user.scopes} s`,
    ],
    ["assignments", assignmentsCte(contracts, physical, style, user)],
    ["typed", typedCte(contracts.assignmentSources.length > 0)],
    ["containers", containersCte(contracts.rights, physical, style)],
    [
      "held",
      // Контейнер — лише в архетипу контейнерного рівня й лише існуючий
      // контейнер того самого тенанта (Р2a1-7): inner join, тож `NULL`,
      // неіснуючий чи чужий контейнер не дає рядка. Вид скоупу контейнера
      // зіставлено явно з видом скоупу рядка призначення, а не лише через
      // рівень зберігання архетипу (`typed`): скоуп без виду нічого не
      // означає (Р2a1-26). Вид — колонка `scope_kind_id`, а не `storage_id`:
      // у рядка джерела там id джерела (Р2d1-4). Позначка видалення
      // контейнера прав не відкликає (Р2a1-28): права зникають із вилученням
      // контейнера.
      [
        `SELECT t.storage, t.storage_id, t.scope, NULL::uuid AS container, t.custom_role, t.archetype, t.level, t.level_id`,
        `FROM typed t`,
        `WHERE t.level <> 'container'`,
        `UNION ALL`,
        `SELECT t.storage, t.storage_id, t.scope, k.container, t.custom_role, t.archetype, t.level, t.level_id`,
        `FROM typed t`,
        `JOIN containers k`,
        `  ON k.level_id = t.level_id`,
        ` AND k.container = t.container`,
        ` AND k.scope_kind_id IS NOT DISTINCT FROM t.scope_kind_id`,
        ` AND k.scope IS NOT DISTINCT FROM t.scope`,
        `WHERE t.level = 'container'`,
      ].join("\n"),
    ],
    // Дельти — не матеріалізований CTE (Р2d2-26): гілка `allow` з'єднує їх
    // з призначеннями, і з оцінкою в кілька рядків планувальник бере
    // вкладений цикл, що перечитує матеріалізовані дельти всіх тенантів на
    // кожен рядок. Без матеріалізації умова кастомної ролі доходить до
    // таблиці дельт — індекс власника рядка ТЧ, а не перебір. Індекс ТЧ
    // скоупленого виду веде колонкою скоупу, тож гілка `allow` рівняє і її
    // (`scope_key` зі скоупом призначення): кастомна роль — того самого
    // тенанта, що й призначення (Р2a1-7), тож умова лише відкриває індекс.
    [
      "deltas",
      deltasCte(contracts.rightsCatalogs, physical, style),
      "NOT MATERIALIZED ",
    ],
    [
      "role_rows",
      // Кастомна роль — рядки архетипу без збігів `deny` (з точністю до
      // обсягу й виміру) і дельти `allow` з домену рівня архетипу; невідома
      // мітка, дія, обсяг чи вимір у домен не входить і не діє (fail-closed).
      // Збіг `deny` — вікно за ключем збігу над рядками архетипу й `deny`, а
      // не корельований `NOT EXISTS` над CTE дельт усіх тенантів (Р2d2-26):
      // той перечитував дельти на кожен рядок ролі. Розбиття вікна рівняє
      // `NULL` — як `IS NOT DISTINCT FROM` для `storage_id` і виміру; для
      // `storage` і `custom_role` збіг через `=`, тож рядки `deny` з `NULL`
      // там у вікно не беруться: рядок архетипу без кастомної ролі не
      // знімається.
      [
        `SELECT ${CLOSURE_COLUMNS.output.map((c) => `w.${c}`).join(", ")}${detail ? ", w.via" : ""}`,
        `FROM (`,
        `  SELECT c.*, bool_or(c.deny) OVER (PARTITION BY c.storage, c.storage_id, c.custom_role, c.object, c.action, c.extent, c.dimension_id) AS denied`,
        `  FROM (`,
        `    SELECT h.storage, h.storage_id, h.scope, h.container, h.custom_role, h.archetype, h.level, h.level_id, p.object, p.action, p.extent, p.dimension_id${via("archetype")}, false AS deny`,
        `    FROM held h`,
        `    JOIN ${call(RIGHTS_FUNCTIONS.projection)} p ON p.role_id = h.archetype`,
        `    UNION ALL`,
        `    SELECT d.storage, d.storage_id, NULL, NULL, d.custom_role, NULL, NULL, NULL, d.object, d.action, d.extent, d.dimension_id${detail ? ", NULL AS via" : ""}, true`,
        `    FROM deltas d`,
        `    WHERE d.effect = 'deny' AND d.storage IS NOT NULL AND d.custom_role IS NOT NULL`,
        `  ) c`,
        `) w`,
        `WHERE NOT w.deny AND NOT w.denied`,
        `UNION ALL`,
        `SELECT h.storage, h.storage_id, h.scope, h.container, h.custom_role, h.archetype, h.level, h.level_id, d.object, d.action, d.extent, d.dimension_id${via("delta")}`,
        `FROM held h`,
        `JOIN deltas d`,
        `  ON d.storage = h.storage`,
        ` AND d.storage_id IS NOT DISTINCT FROM h.storage_id`,
        ` AND d.custom_role = h.custom_role`,
        ` AND d.scope_key = coalesce(h.scope, ${GLOBAL_SCOPE_KEY})`,
        `JOIN ${call(RIGHTS_FUNCTIONS.domain)} m`,
        `  ON m.level = h.level`,
        ` AND m.level_id IS NOT DISTINCT FROM h.level_id`,
        ` AND m.object = d.object`,
        ` AND m.action = d.action`,
        ` AND m.extent = d.extent`,
        ` AND m.dimension_id IS NOT DISTINCT FROM d.dimension_id`,
        `WHERE d.effect = 'allow'`,
      ].join("\n"),
    ],
    // Замикання вимог у межах одного призначення (Р2a1-11): рядок лишається,
    // якщо кожна його вимога є в тому самому призначенні на тому самому
    // обсязі (і вимірі) чи на `any`. Рівно два проходи — найбільша нерухома
    // точка, бо `rights_requires` транзитивно замкнене (y ∈ req(x) ⇒
    // req(y) ⊆ req(x)). Прохід 1 фіксує шар `any`: `x@any` тримається лише
    // на `y@any`, а `y@any` прохід 1 зняв би лише за браком `z@any` для
    // z ∈ req(y) ⊆ req(x) — тоді `x@any` теж зняв би. Прохід 2 фіксує шари
    // `own` і вимірів: `y@e`, на якому тримається `x@e` після проходу 2, міг
    // би впасти в проході 3 лише за браком `z@e` і `z@any`, z ∈ req(x) — але
    // їх уже перевірено для `x@e`. Один прохід недостатній через різницю
    // обсягів: коли лишились `post@own`, `update@any` і `read@own`, прохід 1
    // знімає `update@any` (немає `read@any`), і лише прохід 2 — `post@own`,
    // що тримався на `update@any`. Рекурсивний CTE віднімання не виражає.
    ["closure_1", closurePass("role_rows", closure)],
    ["closure_2", closurePass("closure_1", closure)],
  ]
  return [
    `WITH ${ctes.map(([name, sql, materialized = ""]) => `${name} AS ${materialized}(\n${indent(sql)}\n)`).join(",\n")}`,
    `SELECT c.level, c.level_id, c.scope, c.container, c.object, c.action, c.extent, c.dimension_id${detail ? ", c.archetype AS role_id, c.custom_role AS custom_role, c.via AS via" : ""}`,
    `FROM closure_2 c`,
    `UNION`,
    // «Кожен користувач» призначень не має: його рядки — без скоупу й
    // контейнера, лише для дійсного користувача.
    `SELECT r.level, r.level_id, NULL::uuid, NULL::uuid, p.object, p.action, p.extent, p.dimension_id${detail ? `, r.role_id AS role_id, NULL::uuid AS custom_role${via("archetype")}` : ""}`,
    ...everyUserRows(),
    `  AND ${user.user} IS NOT NULL`,
  ].join("\n")
}

/**
 * Рядки ролей «кожного користувача» — без призначень і замикання: одне місце
 * для `rights_mine` і для «хто може» (Р2d2-5).
 */
function everyUserRows(): string[] {
  return [
    `FROM ${call(RIGHTS_FUNCTIONS.roles)} r`,
    `JOIN ${call(RIGHTS_FUNCTIONS.projection)} p ON p.role_id = r.role_id`,
    `WHERE r.level = 'everyUser'`,
  ]
}

/** Один прохід замикання над попереднім: тримається лише рядок з усіма вимогами. */
const CLOSURE_COLUMNS = {
  output: [
    "storage",
    "storage_id",
    "scope",
    "container",
    "custom_role",
    "archetype",
    "level",
    "level_id",
    "object",
    "action",
    "extent",
    "dimension_id",
  ],
  identity: [
    "storage",
    "storage_id",
    "scope",
    "container",
    "custom_role",
    "archetype",
  ],
} as const

/**
 * Походження `via` проходить замикання лише вихідною колонкою (Р2d2-2): у
 * ідентичності призначення його немає, інакше дія з дельти втратила б вимогу,
 * яку дає рядок архетипу.
 */
const DETAIL_CLOSURE_COLUMNS = {
  output: [...CLOSURE_COLUMNS.output, "via"],
  identity: CLOSURE_COLUMNS.identity,
}

/** Ключ рядка в межах призначення: дія на обсязі (і вимірі). */
const CLOSURE_KEY = ["object", "action", "extent", "dimension_id"] as const

/**
 * Прохід замикання множинами й сортуванням, без з'єднання двох похідних
 * множин (Р2d2-22). Корельований `NOT EXISTS` з кортежем ідентичності через
 * `IS NOT DISTINCT FROM` і `OR` обсягу Postgres не хешує, а оцінки рядків
 * CTE тут на порядки менші за справжні, тож і хешоване з'єднання двох
 * CTE планувальник міняє на вкладений цикл — обидва квадратичні за кількістю
 * скоупів власника `fullAccess`. `EXCEPT` і віконні функції від оцінок не
 * залежать: хеш чи сортування, O(n log n). З'єднання лишається лише з
 * малою сталою множиною `rights_requires`.
 *
 * - Ідентичність призначення стискається в номер `assignment` — `dense_rank`
 *   за її колонками: рівні колонки (і `NULL` у тих самих місцях) при
 *   сортуванні рівні й дають той самий номер; сентинел замість `NULL` не
 *   потрібен.
 * - Вимога, не задоволена тим самим обсягом і виміром, — `EXCEPT` (`NULL`
 *   виміру рівні нативно).
 * - Вимогу рятує рядок `any` того самого призначення — вікно за
 *   (призначення, об'єкт, дія, вимога): рядок `any` не має обсягу рядка, що
 *   вимагає, тож множинами того самого складу це не виражається.
 * - Рядок зі знятою вимогою знімається вікном за ключем рядка.
 */
function closurePass(
  previous: string,
  columns: { output: readonly string[]; identity: readonly string[] }
): string {
  const list = (alias: string, names: readonly string[]) =>
    names.map((column) => `${alias}.${column}`).join(", ")
  const key = (alias: string) => list(alias, CLOSURE_KEY)
  const requires = call(RIGHTS_FUNCTIONS.requires)
  // Рядок знятого ключа — лише ключ; решту колонок `UNION ALL` дає `NULL`
  // типу першої гілки. Ім'я колонки — щоб варіант з походженням відрізнявся
  // від `rights_mine` лише колонками `via` (тест «detail_of projects to mine»).
  const droppedRow = columns.output
    .map((column) =>
      (CLOSURE_KEY as readonly string[]).includes(column)
        ? `u.${column}`
        : `NULL AS ${column}`
    )
    .join(", ")
  return [
    `WITH ranked AS (`,
    `  SELECT ${list("g", columns.output)},`,
    `         dense_rank() OVER (ORDER BY ${list("g", columns.identity)}) AS assignment`,
    `  FROM ${previous} g`,
    `), unmet_extent AS (`,
    `  SELECT g.assignment, ${key("g")}, q.required`,
    `  FROM ranked g`,
    `  JOIN ${requires} q ON q.object = g.object AND q.action = g.action`,
    `  EXCEPT`,
    `  SELECT s.assignment, s.object, q.action, s.extent, s.dimension_id, q.required`,
    `  FROM ranked s`,
    `  JOIN ${requires} q ON q.object = s.object AND q.required = s.action`,
    `), unmet AS (`,
    `  SELECT w.assignment, ${key("w")}`,
    `  FROM (`,
    `    SELECT c.*, bool_or(c.any_row) OVER (PARTITION BY c.assignment, c.object, c.action, c.required) AS rescued`,
    `    FROM (`,
    `      SELECT u.assignment, ${key("u")}, u.required, false AS any_row`,
    `      FROM unmet_extent u`,
    `      UNION ALL`,
    `      SELECT s.assignment, s.object, q.action, s.extent, s.dimension_id, q.required, true`,
    `      FROM ranked s`,
    `      JOIN ${requires} q ON q.object = s.object AND q.required = s.action`,
    `      WHERE s.extent = 'any'`,
    `    ) c`,
    `  ) w`,
    `  WHERE NOT w.rescued`,
    `)`,
    `SELECT ${list("k", columns.output)}`,
    `FROM (`,
    `  SELECT r.*, bool_or(r.unmet) OVER (PARTITION BY r.assignment, ${key("r")}) AS dropped`,
    `  FROM (`,
    `    SELECT ${list("g", columns.output)}, g.assignment, false AS unmet`,
    `    FROM ranked g`,
    `    UNION ALL`,
    `    SELECT ${droppedRow}, u.assignment, true`,
    `    FROM unmet u`,
    `  ) r`,
    `) k`,
    `WHERE NOT k.dropped`,
  ].join("\n")
}

const ASSIGNMENT_COLUMNS: readonly Column[] = [
  ["storage", "text"],
  ["storage_id", "uuid"],
  ["scope", "uuid"],
  ["container", "uuid"],
  ["custom_role", "uuid"],
  ["archetype", "uuid"],
  ["scope_kind_id", "uuid"],
  ["source_level", "text"],
  ["source_level_id", "uuid"],
]

/**
 * Мої призначення (Р2a1-13, Р2a1-26, Р2d1-4) — з довідників прав і з прийнятих
 * джерел призначень, одним шляхом далі: `scope_kind_id` — вид скоупу рядка
 * (для `held`), `source_level`/`source_level_id` — рівень джерела (для
 * `typed`), у рядка довідника — `NULL`.
 */
function assignmentsCte(
  contracts: RightsFunctionContracts,
  physical: PhysicalSnapshot,
  style: AttributeCase,
  user: RightsUser
): string {
  const branches = [
    ...contracts.rightsCatalogs.map((catalog) =>
      catalogAssignments(catalog, physical, style, user)
    ),
    ...contracts.assignmentSources.map((source) =>
      sourceAssignments(source, contracts.rights, user)
    ),
  ]
  if (branches.length === 0) return emptySet(ASSIGNMENT_COLUMNS)
  return branches.join("\nUNION ALL\n")
}

/**
 * Призначення довідника прав: рівень скоупу — учасник з моїх скоупів того
 * самого виду, глобальний — я сам. Кастомна роль — того самого рівня й
 * тенанта, без позначки видалення; призначення кастомної ролі, якої немає,
 * не діє. Вид скоупу рядка — рівень зберігання довідника: він і є вид
 * скоупу чи `NULL`.
 */
function catalogAssignments(
  catalog: RightsCatalogContract,
  physical: PhysicalSnapshot,
  style: AttributeCase,
  user: RightsUser
): string {
  const assignments = catalogColumns(physical, catalog.assignments.table, style)
  const roles = catalogColumns(physical, catalog.roles.table, style)
  const a = (def: StandardColumnDef) => `a.${quoteIdent(assignments(def))}`
  const c = (def: StandardColumnDef) => `c.${quoteIdent(roles(def))}`
  const R = RIGHTS_COLUMNS
  const KEY = keyColumn(false)
  const DELETION = deletionMarkColumn()
  const { level } = catalog
  const storage = storageSql(level)
  const scope =
    level.level === "scope"
      ? `a.${quoteIdent(scopeColumn(physical, catalog.assignments.table))}`
      : "NULL::uuid"
  // Кастомна роль — з «Ролей» того самого тенанта (Р2a1-7): інакше
  // призначення в A взяло б кастомну роль B з її дельтами.
  const sameTenant =
    level.level === "scope"
      ? [
          `c.${quoteIdent(scopeColumn(physical, catalog.roles.table))} = ${scope}`,
        ]
      : []
  // Учасник рівня скоупу — мій лише в моїх скоупах того самого виду
  // (Р2a1-26): id учасника задає той, хто пише.
  const mine =
    level.level === "scope"
      ? [
          `JOIN my_scopes s`,
          `  ON s.scope_kind_id = ${uuidLiteral(level.scopeKindId)}`,
          ` AND s.scope = ${scope}`,
          ` AND s.member = ${a(R.subject)}`,
        ]
      : []
  return [
    `SELECT ${storage.storage} AS storage, ${storage.storageId} AS storage_id, ${scope} AS scope, ${a(R.container)} AS container, ${a(R.customRole)} AS custom_role,`,
    `       CASE WHEN ${a(R.customRole)} IS NULL THEN ${a(R.archetype)} ELSE ${c(R.archetype)} END AS archetype,`,
    `       ${storage.storageId} AS scope_kind_id, NULL::text AS source_level, NULL::uuid AS source_level_id`,
    `FROM ${qualified(catalog.assignments.table)} a`,
    ...mine,
    `LEFT JOIN ${qualified(catalog.roles.table)} c`,
    `  ON ${[...sameTenant, `${c(KEY)} = ${a(R.customRole)}`].join("\n AND ")}`,
    ` AND NOT ${c(DELETION)}`,
    `WHERE NOT ${a(DELETION)}`,
    `  AND (${a(R.customRole)} IS NULL) = (${c(KEY)} IS NULL)`,
    ...(level.level === "scope"
      ? []
      : [`  AND ${a(R.subject)} = ${user.user}`]),
  ].join("\n")
}

/**
 * Призначення прийнятого джерела (Р2d1-4, спека прав §4.7): лише архетип за
 * ключем ролі — внутрішнє з'єднання, тож невідомий ключ чи `NULL` у колонці
 * ролі не дає рядка; кастомних ролей з джерела немає. Учасник рівня скоупу й
 * контейнера зі скоупленим контейнером — мій учасник виду K (Р2a1-26), скоуп
 * — з моїх скоупів; глобальний і нескоуплений контейнер — я сам.
 */
function sourceAssignments(
  source: AssignmentSourceContract,
  rights: readonly RightsContract[],
  user: RightsUser
): string {
  const src = (column: string) => `src.${quoteIdent(column)}`
  const scopeKindId = sourceScopeKind(source.assignedOn, rights)
  const [level, levelId] = levelValues(source.assignedOn)
  const scoped = scopeKindId !== undefined
  const container =
    source.assignedOn.level === "container" && source.container !== undefined
      ? src(source.container)
      : "NULL::uuid"
  const conditions = [
    ...(scoped ? [] : [`${src(source.member)} = ${user.user}`]),
    ...activeCondition("src", source.active),
    // Умова рядків (R1'): рядок іншого рівня поліморфної таблиці інакше
    // читався б як призначення цього джерела.
    ...sourceConditions("src", source.where),
  ]
  // Роль через посилання (R2): ключ — у рядку таблиці ролей, а її умова
  // відсікає кастомну роль тенанта з ключем системної. Псевдонім `sr`, бо
  // `r` у `typed` того самого тіла — `rights_roles()`.
  const { roleTable } = source
  const roleKey =
    roleTable === undefined
      ? src(source.role)
      : `sr.${quoteIdent(roleTable.key)}`
  const roleJoin = roleTableJoin(source)
  // Скоуп рядка мусить дорівнювати скоупу учасника (R1): інакше адмін тенанта
  // A вписав би учасника B зі скоупом A, і рядок діяв би в B.
  const rowScope =
    source.scope === undefined ? [] : [` AND s.scope = ${src(source.scope)}`]
  return [
    `SELECT 'source'::text AS storage, ${uuidLiteral(source.sourceId)} AS storage_id, ${scoped ? "s.scope" : "NULL::uuid"} AS scope, ${container} AS container, NULL::uuid AS custom_role, k.role_id AS archetype,`,
    `       ${scoped ? uuidLiteral(scopeKindId) : "NULL::uuid"} AS scope_kind_id, ${sqlLiteral(level)}::text AS source_level, ${levelId === null ? "NULL::uuid" : uuidLiteral(levelId)} AS source_level_id`,
    `FROM ${qualified(source.table)} src`,
    ...roleJoin,
    `JOIN ${call(RIGHTS_FUNCTIONS.sourceKeys)} k`,
    `  ON k.source_id = ${uuidLiteral(source.sourceId)}`,
    ` AND k.key = ${roleKey}`,
    ...(scoped
      ? [
          `JOIN my_scopes s`,
          `  ON s.scope_kind_id = ${uuidLiteral(scopeKindId)}`,
          ` AND s.member = ${src(source.member)}`,
          ...rowScope,
        ]
      : []),
    ...(conditions.length === 0
      ? []
      : [`WHERE ${conditions.join("\n  AND ")}`]),
  ].join("\n")
}

/**
 * Вид скоупу рядків джерела: рівень скоупу — його вид, контейнерний — вид
 * скоупу контейнера; глобальний і нескоуплений контейнер (рівень зберігання
 * глобальний, `rightsLevelOf`) — без виду.
 */
function sourceScopeKind(
  level: CompiledAssignedOn,
  rights: readonly RightsContract[]
): string | undefined {
  switch (level.level) {
    case "scope":
      return level.scopeKindId
    case "container":
      return must(rights.find((c) => c.objectId === level.containerId))
        .scopeKindId
    default:
      return undefined
  }
}

/**
 * Типізація призначень рівнем ролі. Рядок довідника вмикає архетип лише свого
 * рівня зберігання (Р2a1-12): так відкидається і чужий рівень, і зниклий
 * архетип, і «кожен користувач», і рівень, покритий джерелом. Рівень
 * зберігання ролей, покритих джерелом, — `NULL`, тож рядок джерела
 * типізується інакше (Р2d1-4): рівень ролі мусить дорівнювати рівню джерела —
 * сталій генератора, а не даним; ключ глобальної ролі в контейнерному джерелі
 * її не вмикає.
 */
function typedCte(withSources: boolean): string {
  const columns = `SELECT x.storage, x.storage_id, x.scope, x.container, x.custom_role, x.archetype, x.scope_kind_id, r.level, r.level_id`
  const roles = `JOIN ${call(RIGHTS_FUNCTIONS.roles)} r`
  return [
    columns,
    `FROM assignments x`,
    roles,
    `  ON r.role_id = x.archetype`,
    ` AND r.storage = x.storage`,
    ` AND r.storage_id IS NOT DISTINCT FROM x.storage_id`,
    ...(withSources
      ? [
          `UNION ALL`,
          columns,
          `FROM assignments x`,
          roles,
          `  ON r.role_id = x.archetype`,
          ` AND r.level = x.source_level`,
          ` AND r.level_id IS NOT DISTINCT FROM x.source_level_id`,
          `WHERE x.storage = 'source'`,
        ]
      : []),
  ].join("\n")
}

const DELTA_COLUMNS: readonly Column[] = [
  ["storage", "text"],
  ["storage_id", "uuid"],
  ["custom_role", "uuid"],
  ["object", "text"],
  ["action", "text"],
  ["extent", "text"],
  ["dimension_id", "uuid"],
  ["effect", "text"],
  ["scope_key", "uuid"],
]

/**
 * Ключ скоупу дельти глобального довідника: у глобальних призначень скоупу
 * немає (`NULL`), а `=` з `NULL` не збігається.
 */
const GLOBAL_SCOPE_KEY = "'00000000-0000-0000-0000-000000000000'::uuid"

/**
 * Дельти кастомних ролей кожного рівня з рівнем зберігання. `scope_key` —
 * колонка скоупу таблиці дельт (глобальної — константа): нею гілка `allow`
 * читає дельти індексом скоупу й власника, а не перебором.
 */
function deltasCte(
  catalogs: readonly RightsCatalogContract[],
  physical: PhysicalSnapshot,
  style: AttributeCase
): string {
  if (catalogs.length === 0) return emptySet(DELTA_COLUMNS)
  return catalogs
    .map((catalog) => {
      const delta = catalogColumns(physical, catalog.roles.delta, style)
      const d = (def: StandardColumnDef) => `d.${quoteIdent(delta(def))}`
      const R = RIGHTS_COLUMNS
      const storage = storageSql(catalog.level)
      const scopeKey =
        catalog.level.level === "scope"
          ? `d.${quoteIdent(scopeColumn(physical, catalog.roles.delta))}`
          : GLOBAL_SCOPE_KEY
      return [
        `SELECT ${storage.storage} AS storage, ${storage.storageId} AS storage_id, ${d(tabularParentColumn())} AS custom_role,`,
        `       ${d(R.object)} AS object, ${d(R.action)} AS action, ${d(R.extent)} AS extent, ${d(R.dimension)} AS dimension_id, ${d(R.effect)} AS effect,`,
        `       ${scopeKey} AS scope_key`,
        `FROM ${qualified(catalog.roles.delta)} d`,
      ].join("\n")
    })
    .join("\nUNION ALL\n")
}

const CONTAINER_COLUMNS: readonly Column[] = [
  ["level_id", "uuid"],
  ["container", "uuid"],
  ["scope_kind_id", "uuid"],
  ["scope", "uuid"],
]

/**
 * Рядки кожного виду-контейнера з видом скоупу й скоупом; нескоуплений
 * контейнер — лише існування (вид і скоуп `NULL`, як у глобального довідника
 * призначень).
 */
function containersCte(
  rights: readonly RightsContract[],
  physical: PhysicalSnapshot,
  style: AttributeCase
): string {
  const containers = rights.filter((c) => c.container === true)
  if (containers.length === 0) return emptySet(CONTAINER_COLUMNS)
  return containers
    .map((contract) => {
      const table = must(mainTableOf(physical, contract.objectId))
      const key = standardColumn(table, keyColumn(false), style).name
      const { scopeKindId } = contract
      const [kind, scope] =
        scopeKindId === undefined
          ? ["NULL::uuid", "NULL::uuid"]
          : [
              uuidLiteral(scopeKindId),
              `k.${quoteIdent(scopeColumn(physical, contract.table))}`,
            ]
      return [
        `SELECT ${uuidLiteral(contract.objectId)} AS level_id, k.${quoteIdent(key)} AS container, ${kind} AS scope_kind_id, ${scope} AS scope`,
        `FROM ${qualified(contract.table)} k`,
      ].join("\n")
    })
    .join("\nUNION ALL\n")
}

/**
 * Скоупи з правом в обсязі (Р2a1-19): лише рядки рівня скоупу — глобальні
 * права читає `has_right`, контейнерні — `rights_container`.
 */
function scopesBody(
  fn: QualifiedName,
  extent: "any" | "own" | "dimension"
): string {
  return [
    `SELECT DISTINCT m.scope`,
    `FROM ${call(RIGHTS_FUNCTIONS.mine)} m`,
    `WHERE m.level = 'scope'`,
    `  AND m.extent = ${sqlLiteral(extent)}`,
    `  AND m.object = ${param(fn, "p_object")}`,
    `  AND m.action = ${param(fn, "p_action")}`,
    ...(extent === "dimension"
      ? [`  AND m.dimension_id = ${param(fn, "p_dimension")}`]
      : []),
  ].join("\n")
}

/** Контейнери з правом (Р2a1-19): лише рядки контейнерного рівня. */
function containerBody(): string {
  const fn = RIGHTS_FUNCTIONS.container
  return [
    `SELECT DISTINCT m.container`,
    `FROM ${call(RIGHTS_FUNCTIONS.mine)} m`,
    `WHERE m.level = 'container'`,
    ...rightFilter(fn),
  ].join("\n")
}

/**
 * Право на нескоуплений об'єкт незалежно від скоупу (Р2a1-19), без
 * контейнерних рядків: інакше контейнерна роль на одному контейнері відкрила
 * б об'єкти всіх контейнерів.
 */
function hasRightBody(): string {
  const fn = RIGHTS_FUNCTIONS.hasRight
  return [
    `SELECT EXISTS (`,
    `  SELECT 1`,
    `  FROM ${call(RIGHTS_FUNCTIONS.mine)} m`,
    `  WHERE m.level <> 'container'`,
    ...rightFilter(fn).map((line) => `  ${line}`),
    `)`,
  ].join("\n")
}

function rightFilter(fn: QualifiedName): string[] {
  return [
    `  AND m.object = ${param(fn, "p_object")}`,
    `  AND m.action = ${param(fn, "p_action")}`,
    `  AND m.extent = ${param(fn, "p_extent")}`,
    `  AND m.dimension_id IS NOT DISTINCT FROM ${param(fn, "p_dimension")}`,
  ]
}

/**
 * Мої значення виміру (спека прав §4.4): від гранту не залежать. Зв'язок —
 * рядки, де суб'єкт — мій учасник виду суб'єкта (Р2a1-26) чи я сам; функція
 * — дослівна функція проєкту. Дослівна функція знає лише поточного
 * користувача, тож у варіанті аналізу (Р2d2-2) її гілки немає.
 */
function dimensionValuesBody(
  contracts: RightsFunctionContracts,
  fn: QualifiedName,
  user: RightsUser
): string {
  const dimensions = contracts.accessDimensions.filter(
    (dimension) => user.current || !("function" in dimension.values)
  )
  if (dimensions.length === 0) return "SELECT NULL::uuid WHERE false"
  return dimensions
    .map((dimension) => {
      const guard = `${param(fn, "p_dimension")} = ${uuidLiteral(dimension.dimensionId)}`
      if ("function" in dimension.values) {
        return [
          `SELECT f.value`,
          `FROM ${call(dimension.values.function)} AS f(value)`,
          `WHERE ${guard}`,
        ].join("\n")
      }
      const { relation } = dimension.values
      const subject = `v.${quoteIdent(relation.subject)}`
      const mine =
        "users" in relation.subjectTarget
          ? `${subject} = ${user.user}`
          : `${subject} IN (SELECT ${user.members(uuidLiteral(relation.subjectTarget.membership))})`
      return [
        `SELECT v.${quoteIdent(relation.value)}`,
        `FROM ${qualified(relation.table)} v`,
        `WHERE ${guard}`,
        `  AND ${mine}`,
      ].join("\n")
    })
    .join("\nUNION ALL\n")
}

/** Мої учасники виду скоупу — лише з «моїх скоупів» (Р2a1-25). */
function membersBody(fn: QualifiedName, user: RightsUser): string {
  return [
    `SELECT s.member`,
    `FROM ${user.scopes} s`,
    `WHERE s.scope_kind_id = ${param(fn, "p_scope_kind")}`,
  ].join("\n")
}

/**
 * Варіант функцій множини членства (Р2d2-2): тіло `<таблиця>_member_scopes`
 * кожного виду з `setFunction: "membership"` під умовою виду — функції
 * множини окремих видів тут зведено в одну. Дослівна функція множини знає
 * лише поточного користувача, тож її виду тут немає.
 */
function scopeSetOfBody(
  contracts: RightsFunctionContracts,
  user: RightsUser
): string {
  const fn = RIGHTS_FUNCTIONS.scopeSetOf
  const arms = contracts.membership
    .filter((m) => m.setFunction !== undefined)
    .map(
      (m) =>
        `${memberScopesBody(m, user.user)}\n  AND ${param(fn, "p_scope_kind")} = ${uuidLiteral(m.scopeKindId)}`
    )
  if (arms.length === 0) return "SELECT NULL::uuid WHERE false"
  return arms.join("\nUNION ALL\n")
}

// --- Функції аналізу ------------------------------------------------------

/** Аргументи скоупу запиту функції аналізу. */
export interface AnalysisScope {
  kind: string
  scope: string
}

const analysisScope = (fn: QualifiedName): AnalysisScope => ({
  kind: param(fn, "p_scope_kind"),
  scope: param(fn, "p_scope"),
})

/** Глобальний рівень запиту — нульові вид і скоуп (Р2d2-3). */
function globalScope({ kind, scope }: AnalysisScope): string {
  return `${kind} = ${uuidLiteral(ZERO_UUID)} AND ${scope} = ${uuidLiteral(ZERO_UUID)}`
}

/**
 * Гейт аналізу (Р2d2-3, Ф13): рядки — лише коли власні права викликача мають
 * `administerRights` на довіднику призначень ролей рівня запиту. Вид скоупу —
 * явний аргумент: id скоупу задає той, хто пише (Р2a1-26), тож адміністратор
 * одного виду не питає про скоуп іншого з тим самим id. Без права —
 * порожньо, без помилки. Рівень без довідника призначень (його покриває
 * прийняте джерело) гейта не проходить.
 */
export function analysisGate(
  contracts: RightsFunctionContracts,
  request: AnalysisScope
): string {
  const labels = new Map(contracts.rights.map((c) => [c.objectId, c.kindLabel]))
  const arms = contracts.rightsCatalogs.map((catalog) => {
    const label = sqlLiteral(must(labels.get(catalog.assignments.objectId)))
    if (catalog.level.level === "global") {
      return `(${globalScope(request)} AND g.level = 'global' AND g.object = ${label})`
    }
    const kind = uuidLiteral(catalog.level.scopeKindId)
    return `(${request.kind} = ${kind} AND g.level = 'scope' AND g.level_id = ${kind} AND g.scope = ${request.scope} AND g.object = ${label})`
  })
  if (arms.length === 0) return "false"
  return [
    `EXISTS (`,
    `  SELECT 1`,
    `  FROM ${call(RIGHTS_FUNCTIONS.mine)} g`,
    `  WHERE g.action = 'administerRights'`,
    `    AND (${arms.join("\n      OR ")})`,
    `)`,
  ].join("\n")
}

/**
 * Учасники скоупу запиту з їхнім користувачем (Р2d2-4, Р2d2-5): довідники
 * членства й прийняті джерела членства виду запиту — з тими самими умовами
 * рядків, що «мої скоупи» (Р2d1-15). Учасник без користувача прав не має.
 */
function scopeMembers(
  contracts: RightsFunctionContracts,
  request: AnalysisScope,
  member: string | undefined
): string[] {
  const catalogs = contracts.membership.map((m) => {
    const column = (name: string) => `m.${quoteIdent(name)}`
    return [
      `SELECT ${column(m.keyColumn)} AS member, ${column(m.userColumn)} AS user_id`,
      `FROM ${qualified(m.table)} m`,
      `WHERE ${request.kind} = ${uuidLiteral(m.scopeKindId)}`,
      `  AND ${column(m.scopeColumn)} = ${request.scope}`,
      ...(member === undefined
        ? []
        : [`  AND ${column(m.keyColumn)} = ${member}`]),
      `  AND ${column(m.userColumn)} IS NOT NULL`,
    ].join("\n")
  })
  const sources = contracts.membershipSources.map((source) => {
    const column = (name: string) => `s.${quoteIdent(name)}`
    return [
      `SELECT ${column(source.member)} AS member, ${column(source.user)} AS user_id`,
      `FROM ${qualified(source.table)} s`,
      `WHERE ${request.kind} = ${uuidLiteral(source.scopeKindId)}`,
      `  AND ${column(source.scope)} = ${request.scope}`,
      ...(member === undefined
        ? []
        : [`  AND ${column(source.member)} = ${member}`]),
      `  AND ${column(source.user)} IS NOT NULL`,
      ...activeCondition("s", source.active).map((c) => `  AND ${c}`),
      ...sourceConditions("s", source.where).map((c) => `  AND ${c}`),
    ].join("\n")
  })
  return [...catalogs, ...sources]
}

/**
 * Рядки прав рівня запиту (Р2d2-3): рядок скоупу — свого виду й скоупу,
 * контейнерний — за видом скоупу контейнера й тим самим скоупом; адміністратор
 * виду `team` з підлаштованим id не бачить рядків `org`. Глобальний запит —
 * глобальні рядки, рядки контейнерів без виду скоупу й, якщо `everyUser`,
 * рядки «кожного користувача».
 */
function requestRows(
  contracts: RightsFunctionContracts,
  request: AnalysisScope,
  everyUser: boolean
): string {
  const containerKinds = contracts.rights
    .filter((c) => c.container === true && c.scopeKindId !== undefined)
    .map(
      (c) =>
        `WHEN ${uuidLiteral(c.objectId)} THEN ${uuidLiteral(must(c.scopeKindId))}`
    )
  // Контейнер без виду скоупу зберігає призначення на глобальному рівні
  // (Р2a1-7), тож його рядки бачить лише глобальний запит; рядок скоупу його
  // не покриває: скоупу й виду в нього немає.
  const unscoped = contracts.rights
    .filter((c) => c.container === true && c.scopeKindId === undefined)
    .map((c) => uuidLiteral(c.objectId))
  const levels = `d.level ${everyUser ? "IN ('global', 'everyUser')" : "= 'global'"}`
  const globalLevels =
    unscoped.length === 0
      ? `(${levels}`
      : `(${levels} OR (d.level = 'container' AND d.level_id IN (${unscoped.join(", ")}))`
  return [
    `((d.level = 'scope' AND d.level_id = ${request.kind} AND d.scope = ${request.scope})`,
    ...(containerKinds.length === 0
      ? []
      : [
          ` OR (d.level = 'container' AND CASE d.level_id ${containerKinds.join(" ")} ELSE NULL::uuid END = ${request.kind} AND d.scope = ${request.scope})`,
        ]),
    ` OR (${globalScope(request)} AND ${globalLevels})))`,
  ].join("\n")
}

/**
 * Права учасника в скоупі запиту (Р2d2-4): учасник мусить належати скоупу,
 * інакше — порожньо, як і без користувача: адміністратор A не дізнається, чи
 * учасник B — користувач в A. Глобальний запит — `p_member` і є користувач.
 */
function memberBody(contracts: RightsFunctionContracts): string {
  const fn = RIGHTS_FUNCTIONS.member
  const request = analysisScope(fn)
  const member = param(fn, "p_member")
  return [
    `SELECT DISTINCT d.object, d.action, d.extent, d.dimension_id, d.container, d.role_id, d.custom_role, d.via`,
    `FROM (`,
    indent(
      [
        ...scopeMembers(contracts, request, member),
        `SELECT ${member} AS member, ${member} AS user_id\nWHERE ${globalScope(request)}`,
      ].join("\nUNION ALL\n")
    ),
    `) u`,
    `CROSS JOIN LATERAL ${call(RIGHTS_FUNCTIONS.detailOf, ["u.user_id"])} d`,
    `WHERE ${analysisGate(contracts, request)}`,
    `  AND ${requestRows(contracts, request, true)}`,
  ].join("\n")
}

/**
 * Хто має право через ролі рівня запиту (Р2d2-5): учасники скоупу, а для
 * глобального запиту — власники глобальних призначень (зокрема призначень
 * контейнера без виду скоупу) і рядок «кожного
 * користувача» (`user_id IS NULL`). Кандидатів лише перелічено: права кожного
 * рахує той самий шаблон `rights_detail_of`.
 */
function whoBody(
  contracts: RightsFunctionContracts,
  physical: PhysicalSnapshot,
  style: AttributeCase
): string {
  const fn = RIGHTS_FUNCTIONS.who
  const request = analysisScope(fn)
  const global = globalScope(request)
  const owners = [
    ...contracts.rightsCatalogs
      .filter((catalog) => catalog.level.level === "global")
      .map((catalog) => {
        const subject = `a.${quoteIdent(catalogColumns(physical, catalog.assignments.table, style)(RIGHTS_COLUMNS.subject))}`
        return `SELECT NULL::uuid AS member, ${subject} AS user_id\nFROM ${qualified(catalog.assignments.table)} a\nWHERE ${global}\n  AND ${subject} IS NOT NULL`
      }),
    ...contracts.assignmentSources
      // Власники рівня, що зберігається глобально: глобальне джерело й
      // джерело нескоупленого контейнера — учасник там і є користувач.
      .filter(
        (source) =>
          sourceScopeKind(source.assignedOn, contracts.rights) === undefined
      )
      .map((source) => {
        const member = `src.${quoteIdent(source.member)}`
        return `SELECT NULL::uuid AS member, ${member} AS user_id\nFROM ${qualified(source.table)} src\nWHERE ${global}\n  AND ${member} IS NOT NULL`
      }),
  ]
  const object = param(fn, "p_object")
  const action = param(fn, "p_action")
  const gate = analysisGate(contracts, request)
  return [
    `SELECT u.user_id, u.member, d.role_id, d.custom_role, d.extent, d.dimension_id, d.container`,
    `FROM (`,
    indent(
      [...scopeMembers(contracts, request, undefined), ...owners].join(
        "\nUNION\n"
      ) || `SELECT NULL::uuid AS member, NULL::uuid AS user_id WHERE false`
    ),
    `) u`,
    `CROSS JOIN LATERAL ${call(RIGHTS_FUNCTIONS.detailOf, ["u.user_id"])} d`,
    `WHERE ${gate}`,
    `  AND d.object = ${object}`,
    `  AND d.action = ${action}`,
    `  AND ${requestRows(contracts, request, false)}`,
    `UNION`,
    `SELECT NULL::uuid, NULL::uuid, r.role_id, NULL::uuid, p.extent, p.dimension_id, NULL::uuid`,
    ...everyUserRows(),
    `  AND ${global}`,
    `  AND p.object = ${object}`,
    `  AND p.action = ${action}`,
    `  AND ${gate}`,
  ].join("\n")
}

const JOURNAL = platform("rights_journal")

/** Колонки журналу прав — з його фізичної таблиці, у її порядку (Р2d2-7). */
function journalColumns(physical: PhysicalSnapshot): Column[] {
  return tableOf(physical, JOURNAL).columns.map((column): Column => [
    column.name,
    column.type,
  ])
}

/**
 * Журнал прав скоупу запиту (Р2d2-7): пара (вид, скоуп), бо uuid скоупів
 * різних видів спільно не унікальні (Р2a1-26); новіші першими, `seq` — у
 * межах однієї транзакції, де `at` однаковий. Від'ємний ліміт — порожньо, а
 * не помилка Postgres.
 */
function journalBody(
  contracts: RightsFunctionContracts,
  physical: PhysicalSnapshot
): string {
  const fn = RIGHTS_FUNCTIONS.journalOf
  const request = analysisScope(fn)
  return [
    `SELECT ${journalColumns(physical)
      .map(([name]) => `j.${quoteIdent(name)}`)
      .join(", ")}`,
    `FROM ${qualified(JOURNAL)} j`,
    `WHERE ${analysisGate(contracts, request)}`,
    `  AND j.scope_kind_id = ${request.kind}`,
    `  AND j.scope = ${request.scope}`,
    `ORDER BY j.at DESC, j.seq DESC`,
    `LIMIT greatest(0, least(${param(fn, "p_limit")}, 1000))`,
  ].join("\n")
}

// --- Допоміжне ------------------------------------------------------------

/** Рівень зберігання довідника як сталі SQL тієї ж форми, що в `rights_roles`. */
function storageSql(level: RightsLevelKey): {
  storage: string
  storageId: string
} {
  return level.level === "global"
    ? { storage: "'global'::text", storageId: "NULL::uuid" }
    : { storage: "'scope'::text", storageId: uuidLiteral(level.scopeKindId) }
}

/**
 * Колонки таблиці довідника прав за визначенням стандартної колонки реєстру
 * в стилі проєкту: `origin.standard` у snake_case — `custom_role`, а не
 * `customRole` (Рб1-1).
 */
function catalogColumns(
  physical: PhysicalSnapshot,
  name: QualifiedName,
  style: AttributeCase
): (def: StandardColumnDef) => string {
  const table = tableOf(physical, name)
  return (def) => standardColumn(table, def, style).name
}

/** Колонка скоупу таблиці — позначена моделлю, а не вгадана за іменем. */
function scopeColumn(physical: PhysicalSnapshot, name: QualifiedName): string {
  return must(
    tableOf(physical, name).columns.find(
      (c) => c.origin.scopeKindId !== undefined
    )
  ).name
}

function tableOf(
  physical: PhysicalSnapshot,
  name: QualifiedName
): PhysicalTable {
  return must(
    physical.tables.find(
      (t) => t.schema === name.schema && t.name === name.name
    )
  )
}

/** Виклик функції з аргументами-сталими; спільний з будівником умов. */
export function call(fn: QualifiedName, args: readonly string[] = []): string {
  return `${qualified(fn)}(${args.join(", ")})`
}

/**
 * Параметр, кваліфікований іменем функції: колонка з тим самим іменем у
 * тілі SQL-функції перемогла б параметр.
 */
export function param(fn: QualifiedName, name: string): string {
  return `${quoteIdent(fn.name)}.${name}`
}

export function uuidLiteral(value: string): string {
  return `${sqlLiteral(value)}::uuid`
}

function indent(sql: string): string {
  return sql
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}
