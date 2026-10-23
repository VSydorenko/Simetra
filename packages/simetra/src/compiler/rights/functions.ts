import {
  PLATFORM_SCHEMA,
  quoteIdent,
  type DatabaseProvider,
  type GrantPurpose,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import {
  mainTableOf,
  type CompiledRoleLevel,
  type Contracts,
  type ProjectionExtent,
  type QualifiedName,
  type RightsCatalogContract,
  type RightsContract,
  type RightsExtent,
  type RightsLevelKey,
  qualified,
} from "../contracts"
import { compareStrings } from "../diagnostics"
import {
  CURRENT_USER,
  closedFunction,
  type ClosedFunctionShape,
} from "../membership-functions"
import { executeGrants } from "../sql/execute-grants"
import type { SqlParser } from "../sql/parse"
import { generatedUnit, type SqlUnit } from "../sql/units"
import { allowedActions, compareExtents, levelAllowsExtent } from "./expand"
import { levelKey } from "./facts"
import { must } from "./references"
import { rightsLevelOf } from "./system-catalogs"
import { sqlLiteral } from "../stages/model"

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
  requires: platform("rights_requires"),
  domain: platform("rights_domain"),
  roles: platform("rights_roles"),
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
} as const satisfies Record<string, QualifiedName>

/**
 * Хто виконує функції множини й помічники (Р2a1-14): роль запиту
 * користувача, сервісна (для неї — порожні множини) і роль команд. Функції
 * даних не виконує ніхто, крім власника: їх кличуть лише функції `definer`.
 */
const SET_ROLES: readonly GrantPurpose[] = ["user", "service", "command"]

/** Контракти, з яких генератор будує функції (Р2a1-22, Р2a1-24). */
export type RightsFunctionContracts = Pick<
  Contracts,
  | "rights"
  | "roles"
  | "rightsProjection"
  | "rightsCatalogs"
  | "accessDimensions"
  | "membership"
  | "assignmentSources"
  | "users"
>

interface Declaration {
  fn: QualifiedName
  /** Аргументи з іменами — у `CREATE`, лише типи — у `GRANT`. */
  args: readonly [name: string, type: string][]
  returns: string
  body: string
  shape: ClosedFunctionShape
}

/**
 * Чи є в проєкті функції прав (Р2a1-15, Р2a1-30, Р2a2-24) — одне місце, з яким
 * звіряються генератор функцій і генератор політик: політика, що кличе
 * неіснуючу функцію, не застосувалась би. Без жодної `Role` прав немає. Без
 * «Користувачів» немає `current_user_id` (шар платформи нічого не генерує), а
 * права можливі лише через прийняте джерело (спека прав §4.6, С8), яке до 2d
 * прав не дає (Р2a1-30); межа fail-closed та сама — прав немає, і
 * попередження `rights.adopted-source-unsupported` це вже каже.
 */
export function hasRightsFunctions(
  contracts: Pick<Contracts, "roles" | "users">
): boolean {
  return contracts.roles.length > 0 && contracts.users !== undefined
}

/**
 * Чи є межа видимості «Користувачів» (Р2a2-18): функції прав і хоч один
 * довідник членства — без учасників «моїх скоупів» множина звелася б до «я», а
 * прийняте джерело членства до 2d прав не дає.
 */
export function hasVisibleUsers(
  contracts: Pick<Contracts, "roles" | "users" | "membership">
): boolean {
  return hasRightsFunctions(contracts) && contracts.membership.length > 0
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
  provider: DatabaseProvider,
  module: string,
  parse: SqlParser
): SqlUnit[] {
  if (!hasRightsFunctions(contracts)) return []
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
    definer(F.myScopes, [], table(MY_SCOPES_COLUMNS), myScopesBody(contracts)),
    definer(F.mine, [], table(MINE_COLUMNS), mineBody(contracts, physical)),
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
      [
        `SELECT s.member`,
        `FROM ${call(F.myScopes)} s`,
        `WHERE s.scope_kind_id = ${param(F.myMembers, "p_scope_kind")}`,
      ].join("\n")
    ),
    definer(
      F.dimensionValues,
      [uuid("p_dimension")],
      "SETOF uuid",
      dimensionValuesBody(contracts)
    ),
    ...(hasVisibleUsers(contracts)
      ? [definer(F.visibleUsers, [], "SETOF uuid", visibleUsersBody(contracts))]
      : []),
  ]
  return declarations
    .flatMap(({ fn, args, returns, body, shape }) => {
      const named = args.map(([name, type]) => `${name} ${type}`).join(", ")
      const types = args.map(([, type]) => type).join(", ")
      return [
        closedFunction(`${qualified(fn)}(${named})`, returns, body, shape),
        ...executeGrants(
          `${qualified(fn)}(${types})`,
          shape === "definer" ? SET_ROLES : [],
          provider
        ),
      ]
    })
    .map((sql): SqlUnit => ({
      ...generatedUnit(sql, PLATFORM_SCHEMA, parse),
      module,
      generator: "rights",
    }))
    .sort((a, b) => compareStrings(a.identity, b.identity))
}

// --- Функції даних --------------------------------------------------------

type Column = readonly [name: string, type: "uuid" | "text"]
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

/**
 * Рядки проєкції з розгорнутим `fullAccess` (Р2a1-9): роль з повними правами
 * отримує явні рядки всього домену свого рівня, тож гілки обходу в SQL
 * немає. Порядок — порядок проєкції.
 */
function projectionRows(contracts: RightsFunctionContracts): Value[][] {
  const byObject = new Map(contracts.rights.map((c) => [c.objectId, c]))
  const rows = new Map<
    string,
    {
      roleId: string
      objectId: string
      action: string
      extent: ProjectionExtent
    }
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
  return [...rows.values()]
    .sort(
      (a, b) =>
        compareStrings(a.roleId, b.roleId) ||
        compareStrings(a.objectId, b.objectId) ||
        compareStrings(a.action, b.action) ||
        compareExtents(a.extent, b.extent)
    )
    .map((row) => [
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

function storageValues(level: RightsLevelKey | undefined): [Value, Value] {
  if (level === undefined) return [null, null]
  return level.level === "global"
    ? ["global", null]
    : ["scope", level.scopeKindId]
}

function table(columns: readonly Column[]): string {
  return `TABLE (${columns.map(([name, type]) => `${name} ${type}`).join(", ")})`
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
 * Мої скоупи (Р2a1-25, Р2a1-26): єдине місце, що читає таблиці членства, —
 * учасник поточного користувача за видом скоупу, за тією самою умовою, що
 * функція множини членства. Без довідників членства — порожня множина.
 */
function myScopesBody(contracts: RightsFunctionContracts): string {
  if (contracts.membership.length === 0) return emptySet(MY_SCOPES_COLUMNS)
  return contracts.membership
    .map((m) => {
      const user = `m.${quoteIdent(m.userColumn)}`
      return [
        `SELECT ${uuidLiteral(m.scopeKindId)} AS scope_kind_id, m.${quoteIdent(m.scopeColumn)} AS scope, m.${quoteIdent(m.keyColumn)} AS member`,
        `FROM ${qualified(m.table)} m`,
        `WHERE ${user} IS NOT NULL`,
        `  AND ${user} = ${CURRENT_USER}`,
      ].join("\n")
    })
    .join("\nUNION ALL\n")
}

/**
 * Видимі «Користувачі» (спека системної схеми §12, Р2a2-18): я ∪ користувачі
 * учасників моїх скоупів. Мої скоупи обчислює лише `rights_my_scopes`
 * (Р2a1-25); таблицю членства виду K функція читає лише за рядками
 * `rights_my_scopes()` того самого виду (Р2a1-26) — інакше учасник іншого
 * виду з тим самим значенням скоупу відкрив би чужих користувачів.
 */
function visibleUsersBody(contracts: RightsFunctionContracts): string {
  return [
    `SELECT ${CURRENT_USER}`,
    `WHERE ${CURRENT_USER} IS NOT NULL`,
    ...contracts.membership.flatMap((m) => {
      const user = `m.${quoteIdent(m.userColumn)}`
      return [
        `UNION`,
        `SELECT ${user}`,
        `FROM ${qualified(m.table)} m`,
        `JOIN ${call(RIGHTS_FUNCTIONS.myScopes)} s`,
        `  ON s.scope_kind_id = ${uuidLiteral(m.scopeKindId)}`,
        ` AND s.scope = m.${quoteIdent(m.scopeColumn)}`,
        `WHERE ${user} IS NOT NULL`,
      ]
    }),
  ].join("\n")
}

/**
 * Права поточного користувача (спека прав §5.1): призначення з довідників
 * прав, рядки їхніх ролей, замикання вимог і рядки «кожного користувача».
 * Кожен запобіжник — окрема умова, яку мутаційний DB-сценарій прибирає
 * поодинці.
 */
function mineBody(
  contracts: RightsFunctionContracts,
  physical: PhysicalSnapshot
): string {
  const ctes: [string, string][] = [
    [
      "my_scopes",
      `SELECT s.scope_kind_id, s.scope, s.member\nFROM ${call(RIGHTS_FUNCTIONS.myScopes)} s`,
    ],
    ["assignments", assignmentsCte(contracts.rightsCatalogs, physical)],
    [
      "typed",
      // Архетип діє лише з довідника свого рівня зберігання (Р2a1-12): так
      // відкидається і чужий рівень, і зниклий архетип, і «кожен
      // користувач», і рівень, покритий джерелом.
      [
        `SELECT x.storage, x.storage_id, x.scope, x.container, x.custom_role, x.archetype, r.level, r.level_id`,
        `FROM assignments x`,
        `JOIN ${call(RIGHTS_FUNCTIONS.roles)} r`,
        `  ON r.role_id = x.archetype`,
        ` AND r.storage = x.storage`,
        ` AND r.storage_id IS NOT DISTINCT FROM x.storage_id`,
      ].join("\n"),
    ],
    ["containers", containersCte(contracts.rights, physical)],
    [
      "held",
      // Контейнер — лише в архетипу контейнерного рівня й лише існуючий
      // контейнер того самого тенанта (Р2a1-7): inner join, тож `NULL`,
      // неіснуючий чи чужий контейнер не дає рядка. Вид скоупу контейнера
      // зіставлено явно з видом довідника призначень, а не лише через
      // рівень зберігання архетипу (`typed`): скоуп без виду нічого не
      // означає (Р2a1-26). Позначка видалення контейнера прав не відкликає
      // (Р2a1-28): права зникають із вилученням контейнера.
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
        ` AND k.scope_kind_id IS NOT DISTINCT FROM t.storage_id`,
        ` AND k.scope IS NOT DISTINCT FROM t.scope`,
        `WHERE t.level = 'container'`,
      ].join("\n"),
    ],
    ["deltas", deltasCte(contracts.rightsCatalogs, physical)],
    [
      "role_rows",
      // Кастомна роль — рядки архетипу без збігів `deny` (з точністю до
      // обсягу й виміру) і дельти `allow` з домену рівня архетипу; невідома
      // мітка, дія, обсяг чи вимір у домен не входить і не діє (fail-closed).
      [
        `SELECT h.storage, h.storage_id, h.scope, h.container, h.custom_role, h.archetype, h.level, h.level_id, p.object, p.action, p.extent, p.dimension_id`,
        `FROM held h`,
        `JOIN ${call(RIGHTS_FUNCTIONS.projection)} p ON p.role_id = h.archetype`,
        `WHERE NOT EXISTS (`,
        `  SELECT 1`,
        `  FROM deltas d`,
        `  WHERE d.storage = h.storage`,
        `    AND d.storage_id IS NOT DISTINCT FROM h.storage_id`,
        `    AND d.custom_role = h.custom_role`,
        `    AND d.effect = 'deny'`,
        `    AND d.object = p.object`,
        `    AND d.action = p.action`,
        `    AND d.extent = p.extent`,
        `    AND d.dimension_id IS NOT DISTINCT FROM p.dimension_id`,
        `)`,
        `UNION ALL`,
        `SELECT h.storage, h.storage_id, h.scope, h.container, h.custom_role, h.archetype, h.level, h.level_id, d.object, d.action, d.extent, d.dimension_id`,
        `FROM held h`,
        `JOIN deltas d`,
        `  ON d.storage = h.storage`,
        ` AND d.storage_id IS NOT DISTINCT FROM h.storage_id`,
        ` AND d.custom_role = h.custom_role`,
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
    ["closure_1", closurePass("role_rows")],
    ["closure_2", closurePass("closure_1")],
  ]
  return [
    `WITH ${ctes.map(([name, sql]) => `${name} AS (\n${indent(sql)}\n)`).join(",\n")}`,
    `SELECT c.level, c.level_id, c.scope, c.container, c.object, c.action, c.extent, c.dimension_id`,
    `FROM closure_2 c`,
    `UNION`,
    // «Кожен користувач» призначень не має: його рядки — без скоупу й
    // контейнера, лише для дійсного користувача.
    `SELECT r.level, r.level_id, NULL::uuid, NULL::uuid, p.object, p.action, p.extent, p.dimension_id`,
    `FROM ${call(RIGHTS_FUNCTIONS.roles)} r`,
    `JOIN ${call(RIGHTS_FUNCTIONS.projection)} p ON p.role_id = r.role_id`,
    `WHERE r.level = 'everyUser'`,
    `  AND ${CURRENT_USER} IS NOT NULL`,
  ].join("\n")
}

/** Один прохід замикання над попереднім: тримається лише рядок з усіма вимогами. */
function closurePass(previous: string): string {
  return [
    `SELECT g.storage, g.storage_id, g.scope, g.container, g.custom_role, g.archetype, g.level, g.level_id, g.object, g.action, g.extent, g.dimension_id`,
    `FROM ${previous} g`,
    `WHERE NOT EXISTS (`,
    `  SELECT 1`,
    `  FROM ${call(RIGHTS_FUNCTIONS.requires)} q`,
    `  WHERE q.object = g.object`,
    `    AND q.action = g.action`,
    `    AND NOT EXISTS (`,
    `      SELECT 1`,
    `      FROM ${previous} s`,
    `      WHERE (s.storage, s.storage_id, s.scope, s.container, s.custom_role, s.archetype)`,
    `            IS NOT DISTINCT FROM (g.storage, g.storage_id, g.scope, g.container, g.custom_role, g.archetype)`,
    `        AND s.object = q.object`,
    `        AND s.action = q.required`,
    `        AND (s.extent = 'any' OR (s.extent = g.extent AND s.dimension_id IS NOT DISTINCT FROM g.dimension_id))`,
    `    )`,
    `)`,
  ].join("\n")
}

const ASSIGNMENT_COLUMNS: readonly Column[] = [
  ["storage", "text"],
  ["storage_id", "uuid"],
  ["scope", "uuid"],
  ["container", "uuid"],
  ["custom_role", "uuid"],
  ["archetype", "uuid"],
]

/**
 * Мої призначення за довідниками прав (Р2a1-13, Р2a1-26): рівень скоупу —
 * учасник з моїх скоупів того самого виду, глобальний — я сам. Кастомна роль
 * — того самого рівня й тенанта, без позначки видалення; призначення
 * кастомної ролі, якої немає, не діє.
 */
function assignmentsCte(
  catalogs: readonly RightsCatalogContract[],
  physical: PhysicalSnapshot
): string {
  if (catalogs.length === 0) return emptySet(ASSIGNMENT_COLUMNS)
  return catalogs
    .map((catalog) => {
      const assignments = catalogColumns(physical, catalog.assignments.table)
      const roles = catalogColumns(physical, catalog.roles.table)
      const a = (logical: string) => `a.${quoteIdent(assignments(logical))}`
      const c = (logical: string) => `c.${quoteIdent(roles(logical))}`
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
              ` AND s.member = ${a("subject")}`,
            ]
          : []
      return [
        `SELECT ${storage.storage} AS storage, ${storage.storageId} AS storage_id, ${scope} AS scope, ${a("container")} AS container, ${a("customRole")} AS custom_role,`,
        `       CASE WHEN ${a("customRole")} IS NULL THEN ${a("archetype")} ELSE ${c("archetype")} END AS archetype`,
        `FROM ${qualified(catalog.assignments.table)} a`,
        ...mine,
        `LEFT JOIN ${qualified(catalog.roles.table)} c`,
        `  ON ${[...sameTenant, `${c("ref")} = ${a("customRole")}`].join("\n AND ")}`,
        ` AND NOT ${c("deletionMark")}`,
        `WHERE NOT ${a("deletionMark")}`,
        `  AND (${a("customRole")} IS NULL) = (${c("ref")} IS NULL)`,
        ...(level.level === "scope"
          ? []
          : [`  AND ${a("subject")} = ${CURRENT_USER}`]),
      ].join("\n")
    })
    .join("\nUNION ALL\n")
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
]

/** Дельти кастомних ролей кожного рівня з рівнем зберігання. */
function deltasCte(
  catalogs: readonly RightsCatalogContract[],
  physical: PhysicalSnapshot
): string {
  if (catalogs.length === 0) return emptySet(DELTA_COLUMNS)
  return catalogs
    .map((catalog) => {
      const delta = catalogColumns(physical, catalog.roles.delta)
      const d = (logical: string) => `d.${quoteIdent(delta(logical))}`
      const storage = storageSql(catalog.level)
      return [
        `SELECT ${storage.storage} AS storage, ${storage.storageId} AS storage_id, ${d("parent")} AS custom_role,`,
        `       ${d("object")} AS object, ${d("action")} AS action, ${d("extent")} AS extent, ${d("dimension")} AS dimension_id, ${d("effect")} AS effect`,
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
  physical: PhysicalSnapshot
): string {
  const containers = rights.filter((c) => c.container === true)
  if (containers.length === 0) return emptySet(CONTAINER_COLUMNS)
  return containers
    .map((contract) => {
      const table = must(mainTableOf(physical, contract.objectId))
      const key = must(
        table.columns.find((c) => c.origin.standard === "ref")
      ).name
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
 * — дослівна функція проєкту.
 */
function dimensionValuesBody(contracts: RightsFunctionContracts): string {
  if (contracts.accessDimensions.length === 0)
    return "SELECT NULL::uuid WHERE false"
  const fn = RIGHTS_FUNCTIONS.dimensionValues
  return contracts.accessDimensions
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
          ? `${subject} = ${CURRENT_USER}`
          : `${subject} IN (SELECT ${call(RIGHTS_FUNCTIONS.myMembers, [uuidLiteral(relation.subjectTarget.membership)])})`
      return [
        `SELECT v.${quoteIdent(relation.value)}`,
        `FROM ${qualified(relation.table)} v`,
        `WHERE ${guard}`,
        `  AND ${mine}`,
      ].join("\n")
    })
    .join("\nUNION ALL\n")
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

/** Колонки таблиці довідника прав за логічним іменем стандартної колонки. */
function catalogColumns(
  physical: PhysicalSnapshot,
  name: QualifiedName
): (logical: string) => string {
  const table = tableOf(physical, name)
  return (logical) =>
    must(table.columns.find((c) => c.origin.standard === logical)).name
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
function param(fn: QualifiedName, name: string): string {
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
