import {
  APPLIED_SNAPSHOT_HASH_FUNCTION_NAME,
  COMMAND_CORE_ERRORS,
  PLATFORM_SCHEMA,
  RIGHTS_COLUMNS,
  RIGHTS_MAINTENANCE_SETTING,
  deletionMarkColumn,
  encodeAttributes,
  keyColumn,
  quoteIdent,
  type PhysicalTable,
  type RuntimeObject,
} from "simetra/model"
import {
  buildRuntimeCatalog,
  effectiveHolderRows,
  fullAccessHolderRows,
  mainTableOf,
  qualified,
  sourceConditions,
  standardColumn,
  type CompiledModel,
  type CompiledScopeKind,
  type Contracts,
  type DiagnosticParams,
  type QualifiedName,
  type RuleCode,
} from "simetra/compiler"
import type { DbConnection, EngineDiagnostic } from "../engine"
import { applyDiagnostic } from "./diagnostic"
import { APPLY_ADVISORY_LOCK } from "./execute"
import {
  ApplyConnectionLost,
  ApplyDbError,
  type ApplyDatabase,
  type ApplyTransaction,
} from "./port"

/** One maintenance action of the `rights-maintenance` tool (P4 spec §6.12). */
export type RightsMaintenanceRequest =
  | { action: "firstGlobalAssignment"; user: string; role: string }
  | { action: "restoreGlobalFullAccess"; user: string; role?: string }
  | {
      action: "tenantFullAccess"
      scopeKind: string
      scope: string
      user: string
      role: string
      member?: Record<string, unknown>
    }

/**
 * What the tool wrote: the new assignment and, on the scope level, the member
 * row the assignment addresses (new or existing).
 */
export interface RightsMaintenanceDone {
  assignment: string
  member?: string
}

type RoleContract = Contracts["roles"][number]
type RightsCatalog = Contracts["rightsCatalogs"][number]

/** Рядок членства виду скоупу: генерований довідник чи прийняте джерело. */
interface Membership {
  table: QualifiedName
  key: string
  scope: string
  user: string
  /** Умови активного рядка джерела: учасника обираємо дієвого. */
  conditions: string[]
  /** Об'єкт каталогу рантайму; немає — нового учасника не вставити. */
  object?: RuntimeObject
}

interface Prepared {
  user: string
  role: RoleContract
  catalog: RightsCatalog
  assignments: PhysicalTable
  scope?: {
    id: string
    root: { table: QualifiedName; column: string }
    membership: Membership
    /** Закодований `member`; `undefined` — не задано чи немає каталогу. */
    member?: { columns: Record<string, unknown> }
    /** `member` задано: наявний учасник з ним — відмова, а не тихий пропуск. */
    memberGiven: boolean
  }
}

/** Відмова з діагностикою: летить з транзакції, щоб порт відкотив її. */
class Refusal extends Error {
  constructor(readonly diagnostic: EngineDiagnostic) {
    super(diagnostic.code)
    this.name = "Refusal"
  }
}

const refusal = (code: RuleCode, params: DiagnosticParams = {}) =>
  applyDiagnostic(code, "error", params)

const q = quoteIdent
const R = RIGHTS_COLUMNS

// База до функції хеша (`42883`) чи без схеми платформи (`3F000`) — модель
// не застосована, а не збій (як `NO_APPLIED_STATE` рантайму).
const NO_APPLIED_STATE = new Set(["42883", "3F000"])

// Білий список пар (`message`, `detail`) — як `mapDatabaseError` T3: SQL
// застосунку може кинути той самий `DETAIL` з іншим повідомленням, і такий
// текст назовні не йде.
const reasonsOf = (entry: Record<string, string>): readonly string[] =>
  Object.entries(entry)
    .filter(([key]) => key !== "errcode" && key !== "message")
    .map(([, value]) => value)
const ALLOWED_DETAILS = new Map<string, readonly string[]>([
  [
    COMMAND_CORE_ERRORS.forbidden.message,
    reasonsOf(COMMAND_CORE_ERRORS.forbidden),
  ],
  [COMMAND_CORE_ERRORS.context.message, reasonsOf(COMMAND_CORE_ERRORS.context)],
])

const LOCK = `SELECT pg_try_advisory_xact_lock(${APPLY_ADVISORY_LOCK}) AS locked`
const APPLIED_HASH = `SELECT ${q(PLATFORM_SCHEMA)}.${q(APPLIED_SNAPSHOT_HASH_FUNCTION_NAME)}() AS hash`
// Читання стану не повинне тихо бачити нуль рядків під RLS, яку вхід не
// обходить: з `row_security = off` це гучне `42501` (Р-A4-5).
const ROW_SECURITY_OFF = "SELECT set_config('row_security', 'off', true)"
const MAINTENANCE_ON = "SELECT set_config($1, 'on', true)"
const NEW_ID = "SELECT gen_random_uuid() AS id"

const levelName = (model: CompiledModel, catalog: RightsCatalog): string => {
  const { level } = catalog
  if (level.level === "global") return "global"
  const kind = model.scopeKinds.find((k) => k.id === level.scopeKindId)
  return `scope:${kind?.name ?? level.scopeKindId}`
}

function tableOf(model: CompiledModel, name: QualifiedName): PhysicalTable {
  const found = model.physical.tables.find(
    (table) => table.schema === name.schema && table.name === name.name
  )
  if (found === undefined)
    throw new Error(`internal: missing table ${qualified(name)}`)
  return found
}

const column = (
  model: CompiledModel,
  table: PhysicalTable,
  def: { logicalName: string }
) => standardColumn(table, def, model.project.naming.attributeCase).name

function rootOf(
  model: CompiledModel,
  kind: CompiledScopeKind
): { table: QualifiedName; column: string } {
  if ("external" in kind.root) {
    const { schema, table, column } = kind.root.external
    return { table: { schema, name: table }, column }
  }
  const main = mainTableOf(model.physical, kind.root.objectId)
  if (main === undefined)
    throw new Error(`internal: missing root table of scope kind ${kind.name}`)
  return {
    table: { schema: main.schema, name: main.name },
    column: column(model, main, keyColumn(false)),
  }
}

function membershipOf(
  model: CompiledModel,
  kind: CompiledScopeKind
): Membership | undefined {
  const contract = model.contracts.membership.find(
    (m) => m.scopeKindId === kind.id
  )
  if (contract !== undefined)
    return {
      table: contract.table,
      key: contract.keyColumn,
      scope: contract.scopeColumn,
      user: contract.userColumn,
      conditions: [],
      object: buildRuntimeCatalog(model).objects.find(
        (o) => o.id === contract.objectId
      ),
    }
  const source = model.contracts.membershipSources.find(
    (s) => s.scopeKindId === kind.id
  )
  if (source === undefined) return undefined
  return {
    table: source.table,
    key: source.member,
    scope: source.scope,
    user: source.user,
    conditions: [
      ...(source.active === undefined ? [] : [`m.${q(source.active)} IS TRUE`]),
      ...sourceConditions("m", source.where),
    ],
  }
}

/**
 * Крок 1 (Р-A4-9, Р-A4-11): роль, рівень, довідники й `member` — без
 * звернення до бази. Відмова членства «немає каталогу» тут не стоїть: вона
 * лише на гілці вставки нового учасника, після читання стану.
 */
function prepare(
  model: CompiledModel,
  request: RightsMaintenanceRequest
): Prepared | EngineDiagnostic {
  const roles = model.contracts.roles
  const fits = (role: RoleContract): boolean => {
    if (!role.assignable) return false
    switch (request.action) {
      case "firstGlobalAssignment":
        return role.assignedOn.level === "global"
      case "restoreGlobalFullAccess":
        return role.assignedOn.level === "global" && role.fullAccess
      case "tenantFullAccess":
        return (
          role.assignedOn.level === "scope" &&
          role.fullAccess &&
          model.scopeKinds.find((k) => k.name === request.scopeKind)?.id ===
            role.assignedOn.scopeKindId
        )
    }
  }
  const expected =
    request.action === "firstGlobalAssignment"
      ? "assignable on the global level"
      : request.action === "restoreGlobalFullAccess"
        ? "assignable on the global level with fullAccess"
        : `assignable on scope:${request.scopeKind} with fullAccess`
  const kind =
    request.action === "tenantFullAccess"
      ? model.scopeKinds.find((k) => k.name === request.scopeKind)
      : undefined
  if (request.action === "tenantFullAccess" && kind === undefined)
    return refusal("maintenance.unknown-scope-kind", {
      scopeKind: request.scopeKind,
    })
  let role: RoleContract
  if (request.role === undefined) {
    // Лише `restoreGlobalFullAccess` дозволяє не називати роль: вибір за
    // людину робиться, лише коли він єдиний
    const candidates = roles.filter(fits)
    if (candidates.length > 1)
      return refusal("maintenance.role-ambiguous", {
        roles: candidates
          .map((r) => r.name)
          .sort()
          .join(", "),
      })
    if (candidates.length === 0)
      return refusal("maintenance.role-level", { role: "(none)", expected })
    role = candidates[0]!
  } else {
    const named = roles.find((r) => r.name === request.role)
    if (named === undefined)
      return refusal("maintenance.unknown-role", { role: request.role })
    if (!fits(named))
      return refusal("maintenance.role-level", { role: named.name, expected })
    role = named
  }
  const level =
    kind === undefined
      ? { level: "global" as const }
      : { level: "scope" as const, scopeKindId: kind.id }
  const catalog = model.contracts.rightsCatalogs.find(
    (c) =>
      c.level.level === level.level &&
      (level.level === "global" ||
        (c.level.level === "scope" &&
          c.level.scopeKindId === level.scopeKindId))
  )
  if (catalog === undefined)
    return refusal("maintenance.no-catalog", {
      level: kind === undefined ? "global" : `scope:${kind.name}`,
    })
  const prepared: Prepared = {
    user: request.user,
    role,
    catalog,
    assignments: tableOf(model, catalog.assignments.table),
  }
  if (request.action !== "tenantFullAccess" || kind === undefined)
    return prepared
  const membership = membershipOf(model, kind)
  // Без членства виду учасника немає ні наявного, ні нового
  if (membership === undefined)
    return refusal("maintenance.no-catalog", { level: `scope:${kind.name}` })
  let member: { columns: Record<string, unknown> } | undefined
  if (request.member !== undefined && membership.object !== undefined) {
    const object = membership.object
    const nameOf = (physical: string) =>
      object.attributes.find((a) => a.column === physical)?.name
    // Ключ, скоуп і користувача задає інструмент (Р-A4-11)
    const forced = [
      object.keyName,
      nameOf(membership.scope),
      nameOf(membership.user),
    ].filter((name) => name !== undefined)
    const encoded = encodeAttributes(object.attributes, request.member, {
      allowed: (a) => a.insert,
      forced,
      path: "member",
      prefix: "",
    })
    if ("error" in encoded)
      return refusal("maintenance.invalid-member", {
        path: encoded.error.path ?? "member",
      })
    member = encoded
  }
  return {
    ...prepared,
    scope: {
      id: request.scope,
      root: rootOf(model, kind),
      membership,
      ...(member === undefined ? {} : { member }),
      memberGiven: request.member !== undefined,
    },
  }
}

const found = async (
  tx: ApplyTransaction,
  sql: string,
  params: readonly unknown[] = []
): Promise<boolean> => (await tx.query(sql, params)).length > 0

/** Кроки 2–10: одна транзакція запису (порядок — план П4-A4, Задача 7). */
async function maintain(
  tx: ApplyTransaction,
  model: CompiledModel,
  request: RightsMaintenanceRequest,
  p: Prepared
): Promise<RightsMaintenanceDone> {
  const contracts = model.contracts
  const style = model.project.naming.attributeCase
  const [lock] = await tx.query<{ locked: boolean }>(LOCK)
  if (lock?.locked !== true) throw new Refusal(refusal("maintenance.busy"))
  let applied: string | null = null
  try {
    const [row] = await tx.query<{ hash: string | null }>(APPLIED_HASH)
    applied = row?.hash ?? null
  } catch (error) {
    if (
      !(error instanceof ApplyDbError) ||
      error.sqlstate === undefined ||
      !NO_APPLIED_STATE.has(error.sqlstate)
    )
      throw error
  }
  if (applied !== model.hash)
    throw new Refusal(
      refusal("maintenance.model-mismatch", {
        applied: applied ?? "none",
        compiled: model.hash,
      })
    )
  await tx.query(ROW_SECURITY_OFF)
  // Без «Користувачів» у проєкті передперевірки немає: лишається пост-перевірка
  if (contracts.users !== undefined) {
    const users = contracts.users
    const [user] = await tx.query<{ invalid: boolean }>(
      `SELECT u.${q(users.invalidColumn)} AS invalid FROM ${qualified(users.table)} u WHERE u.${q(users.keyColumn)} = $1`,
      [p.user]
    )
    if (user === undefined)
      throw new Refusal(refusal("maintenance.unknown-user", { user: p.user }))
    if (user.invalid)
      throw new Refusal(refusal("maintenance.not-effective", { user: p.user }))
  }
  const level = levelName(model, p.catalog)
  const holders = fullAccessHolderRows(
    p.catalog,
    contracts,
    model.physical,
    style
  )
  const assignments = qualified(p.catalog.assignments.table)
  let subject = p.user
  let member: string | undefined
  let insertMember = false
  switch (request.action) {
    case "firstGlobalAssignment":
      if (
        await found(
          tx,
          `SELECT 1 AS assigned FROM ${assignments} a WHERE NOT a.${q(column(model, p.assignments, deletionMarkColumn()))} LIMIT 1`
        )
      )
        throw new Refusal(refusal("maintenance.not-first"))
      break
    case "restoreGlobalFullAccess":
      if (await found(tx, `SELECT 1 AS holder FROM (${holders}) h LIMIT 1`))
        throw new Refusal(refusal("maintenance.holder-exists", { level }))
      break
    case "tenantFullAccess": {
      const scope = p.scope!
      const { root, membership: m } = scope
      if (
        !(await found(
          tx,
          `SELECT 1 AS root FROM ${qualified(root.table)} r WHERE r.${q(root.column)} = $1`,
          [scope.id]
        ))
      )
        throw new Refusal(
          refusal("maintenance.scope-missing", { scope: scope.id })
        )
      if (
        await found(
          tx,
          `SELECT 1 AS holder FROM (${holders}) h WHERE h.scope = $1 LIMIT 1`,
          [scope.id]
        )
      )
        throw new Refusal(refusal("maintenance.holder-exists", { level }))
      const [existing] = await tx.query<{ member: string }>(
        [
          `SELECT m.${q(m.key)} AS member FROM ${qualified(m.table)} m`,
          `WHERE m.${q(m.scope)} = $1 AND m.${q(m.user)} = $2`,
          ...m.conditions.map((condition) => `AND ${condition}`),
          `ORDER BY m.${q(m.key)} LIMIT 1`,
        ].join(" "),
        [scope.id, p.user]
      )
      if (existing !== undefined) {
        // Наявному учаснику нові значення рядка не застосовуються: мовчки
        // відкинутий `member` приховав би помилку виклику (Р-A4-18)
        if (scope.memberGiven)
          throw new Refusal(
            refusal("maintenance.invalid-member", { path: "member" })
          )
        member = existing.member
      } else {
        if (m.object === undefined)
          throw new Refusal(refusal("maintenance.no-catalog", { level }))
        insertMember = true
      }
      break
    }
  }
  await tx.query(MAINTENANCE_ON, [RIGHTS_MAINTENANCE_SETTING])
  if (insertMember) {
    const scope = p.scope!
    const m = scope.membership
    const [row] = await tx.query<{ id: string }>(NEW_ID)
    member = row!.id
    const values: Record<string, unknown> = {
      ...scope.member?.columns,
      [m.key]: member,
      [m.scope]: scope.id,
      [m.user]: p.user,
    }
    const columns = Object.keys(values).map(q).join(", ")
    const table = qualified(m.table)
    await tx.query(
      `INSERT INTO ${table} (${columns}) SELECT ${columns} FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`,
      [JSON.stringify(values)]
    )
  }
  if (member !== undefined) subject = member
  const [row] = await tx.query<{ id: string }>(NEW_ID)
  const assignment = row!.id
  const scopeColumn = p.assignments.columns.find(
    (c) => c.origin.scopeKindId !== undefined
  )?.name
  const insert: [string, unknown][] = [
    [column(model, p.assignments, keyColumn(false)), assignment],
    ...(p.scope === undefined || scopeColumn === undefined
      ? []
      : [[scopeColumn, p.scope.id] as [string, unknown]]),
    [column(model, p.assignments, R.subject), subject],
    [column(model, p.assignments, R.archetype), p.role.roleId],
  ]
  await tx.query(
    `INSERT INTO ${assignments} (${insert.map(([name]) => q(name)).join(", ")}) VALUES (${insert.map((_, i) => `$${i + 1}`).join(", ")})`,
    insert.map(([, value]) => value)
  )
  // Дієвість (`actor` — завжди користувач): інакше записане не відновило б
  // доступу, а відкат лишає базу як була
  const effective =
    request.action === "firstGlobalAssignment"
      ? await found(
          tx,
          `SELECT 1 AS effective FROM (${effectiveHolderRows(p.catalog, contracts, model.physical, style)}) h WHERE h.actor = $1 AND h.archetype = $2 LIMIT 1`,
          [p.user, p.role.roleId]
        )
      : p.scope === undefined
        ? await found(
            tx,
            `SELECT 1 AS effective FROM (${holders}) h WHERE h.actor = $1 LIMIT 1`,
            [p.user]
          )
        : await found(
            tx,
            `SELECT 1 AS effective FROM (${holders}) h WHERE h.scope = $1 AND h.actor = $2 LIMIT 1`,
            [p.scope.id, p.user]
          )
  if (!effective)
    throw new Refusal(refusal("maintenance.not-effective", { user: p.user }))
  return { assignment, ...(member === undefined ? {} : { member }) }
}

/** Відмова бази, яку інструмент називає сам (Р-A4-5, Р-A4-11). */
function databaseRefusal(
  error: ApplyDbError,
  p: Prepared
): EngineDiagnostic | undefined {
  if (error.sqlstate === "42501") {
    const allowed = ALLOWED_DETAILS.get(error.message)
    const reason =
      error.detail !== undefined && allowed?.includes(error.detail) === true
        ? error.detail
        : "denied"
    return refusal("maintenance.refused", { reason })
  }
  const membership = p.scope?.membership
  if (
    error.sqlstate === "23502" &&
    membership !== undefined &&
    error.table === membership.table.name &&
    error.column !== undefined
  ) {
    const attribute =
      membership.object?.attributes.find((a) => a.column === error.column)
        ?.name ?? error.column
    return refusal("maintenance.member-required", { attribute })
  }
  return undefined
}

/**
 * Runs one rights-maintenance action on the target in a single write
 * transaction under the apply advisory lock (P4 spec §6.12, "Outside
 * commands"). Every refusal is decided before the first write or rolls the
 * transaction back; only a connection lost after the transaction body
 * finished reports `maintenance.outcome-unknown`. Other database errors
 * propagate.
 */
export async function runRightsMaintenance(
  dbs: ApplyDatabase,
  target: DbConnection,
  model: CompiledModel,
  request: RightsMaintenanceRequest
): Promise<
  | { ok: true; done: RightsMaintenanceDone }
  | { ok: false; diagnostic: EngineDiagnostic }
> {
  const prepared = prepare(model, request)
  if (!("catalog" in prepared)) return { ok: false, diagnostic: prepared }
  // Тіло завершилось — порт уже надсилає `COMMIT`: обрив після цього не
  // каже, чи запис закомічено
  let finished = false
  try {
    const done = await dbs.transaction(target, "commit", async (tx) => {
      const result = await maintain(tx, model, request, prepared)
      finished = true
      return result
    })
    return { ok: true, done }
  } catch (error) {
    if (error instanceof Refusal)
      return { ok: false, diagnostic: error.diagnostic }
    if (error instanceof ApplyConnectionLost && finished)
      return {
        ok: false,
        diagnostic: refusal("maintenance.outcome-unknown"),
      }
    if (error instanceof ApplyDbError) {
      const diagnostic = databaseRefusal(error, prepared)
      if (diagnostic !== undefined) return { ok: false, diagnostic }
    }
    throw error
  }
}
