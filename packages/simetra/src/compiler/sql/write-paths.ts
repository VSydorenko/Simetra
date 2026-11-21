import type {
  AccessPriv,
  FuncCall,
  GrantStmt,
  Node,
  RangeVar,
  RoleSpec,
} from "libpg-query"
import {
  PLATFORM_SCHEMA,
  PROVIDER_API_ROLES,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_OWNER_ROLES,
  type DatabaseProvider,
} from "simetra/model"
import { grantTargetKeys } from "../function-execute"
import { isSecurityInvoker } from "./definer-reads"
import {
  PUBLIC,
  WRITE_PRIVILEGES,
  grantFacts,
  privilegedRoles,
} from "./grant-facts"
import { modelViews, routineBody, type ModelView } from "./function-body"
import { qualifiedName, splitIdentity, unquoteIdent } from "./identity"
import {
  kindTableNamed,
  ruleOneTables,
  writtenKindTable,
  type KindTables,
} from "./kind-tables"
import { relationNameText, type SqlParser } from "./parse"
import type { PlpgsqlParser } from "./plpgsql"
import {
  bodyStatementTargets,
  statementTargets,
  unitTargets,
} from "./unit-target"
import type { VerbatimUnit } from "./units"

/** Форма шляху запису (спека прав §6.1, підрозділ «Шляхи запису й посилання на функції»). */
export type WriteForm =
  | "functionBody"
  | "view"
  | "grant"
  | "defaultPrivileges"
  | "policy"
  | "trigger"
  | "sequence"

/**
 * Шлях запису в ціль Правила 1: одиниця, форма, ціль і ролі, що дістають
 * запис. Правило 1, гейти промоції й виняток знімка фільтрують цей перелік,
 * а не будують власного обходу.
 */
export interface WritePath {
  unit: VerbatimUnit
  form: WriteForm
  /**
   * `схема.ім'я` таблиці чи послідовності; `*` — ціль, яку статично не назвати
   * (глобальне ADP, нелітеральний аргумент `setval`), `схема.*` — ADP схеми.
   */
  target: string
  /** Ролі, що дістають запис цим шляхом (`PUBLIC` чи ім'я ролі); для форм без ролей порожньо. */
  roles: readonly string[]
  /** `functionBody`: вузол оператора; `sequence`: `setval` чи `nextval`. */
  statement?: string
  /**
   * Ціль виникла з імені без схеми й розв'язана fail-closed: кваліфікація
   * своєю схемою знімає відмову (`sql.kind-table-verbatim` каже про це).
   */
  unqualified?: boolean
}

export interface WritePathContext {
  /** Таблиці видів знімка — ціль форм `policy`/`trigger`; основа `ruleOneTables`. */
  kind: KindTables
  provider: DatabaseProvider | undefined
  parse: SqlParser
  plpgsql: PlpgsqlParser
}

/**
 * Усі шляхи, якими одиниці SQL застосунку пишуть ціль Правила 1: таблицю виду,
 * джерело ідентичностей, відношення схеми `simetra` (спека прав §6.1). Невідоме
 * значення опції, ім'я без схеми й ціль поза знімком судяться як найгірший
 * випадок. Одиниця дає не більше одного шляху кожної форми.
 */
export function writePaths(
  units: readonly VerbatimUnit[],
  ctx: WritePathContext
): WritePath[] {
  const written = ruleOneTables(ctx.kind, ctx.provider)
  const views = modelViews(units)
  const grants = grantFacts(units, ctx.parse)
  const adp = defaultPrivilegeFacts(units)
  const identity = ctx.provider && PROVIDER_IDENTITY_SOURCES[ctx.provider].table
  const identityTables: KindTables | undefined =
    identity === undefined
      ? undefined
      : {
          qualified: new Set([`${identity.schema}.${identity.name}`]),
          byName: new Map([
            [identity.name, [`${identity.schema}.${identity.name}`]],
          ]),
          bySchema: new Map([
            [identity.schema, [`${identity.schema}.${identity.name}`]],
          ]),
        }
  const apiRoles = apiRolesOf(ctx.provider)
  const owner = ctx.provider && PROVIDER_OWNER_ROLES[ctx.provider]
  const writers = (view: ModelView): string[] => {
    // Ключ цілі гранту — за правилом ідентичності (`grantTargetKeys`): сирий
    // `схема.ім'я` не збігся б із грантом на подання `"V"`.
    const key = `table|${qualifiedName(view.schema, view.name)}`
    const named = [
      ...new Set(
        grants
          .filter((f) => f.grant && f.keys.includes(key))
          .flatMap((f) => [...f.roles])
      ),
    ].filter((r) => r !== PUBLIC && !apiRoles.includes(r))
    const direct = privilegedRoles(
      (k) => k === key,
      "write",
      grants,
      apiRoles,
      named
    )
    // ADP схеми ставить рушій перед вузлами схеми, тож порядок операторів не
    // має значення (`defaultPrivilegeEdges`).
    const fromAdp = adp.flatMap((f) =>
      f.write && f.schemas.includes(view.schema) ? f.grantees : []
    )
    return [...new Set([...direct, ...fromAdp])].filter((r) => r !== owner)
  }
  return units.flatMap((unit): WritePath[] => {
    switch (unit.class) {
      case "function":
      case "procedure":
        return [
          ...optional(functionBodyPath(unit, written, views, ctx)),
          ...optional(sequencePath(unit, ctx)),
        ]
      case "policy":
      case "trigger":
        return [
          ...optional(policyTriggerPath(unit, ctx.kind, identityTables)),
          ...optional(sequencePath(unit, ctx)),
        ]
      case "view":
        return [
          ...optional(viewPath(unit, written, views, writers, ctx)),
          ...optional(sequencePath(unit, ctx)),
        ]
      case "grant":
        return optional(grantPath(unit, written, owner, ctx.parse))
      case "defaultPrivileges":
        return optional(defaultPrivilegesPath(unit, adp, apiRoles, ctx))
      default:
        // `setval`/`nextval` можуть стояти в будь-якій одиниці з виразом
        // (подання, домен, політика, `WHEN` тригера): дерево обходить кожна.
        return optional(sequencePath(unit, ctx))
    }
  })
}

const optional = <T>(value: T | undefined): T[] =>
  value === undefined ? [] : [value]

/** Ролі API профілю — ті, що мають значення (`null` у профілі — ролі немає). */
function apiRolesOf(provider: DatabaseProvider | undefined): string[] {
  if (provider === undefined) return []
  return Object.values(PROVIDER_API_ROLES[provider]).filter(
    (role): role is string => typeof role === "string"
  )
}

function functionBodyPath(
  unit: VerbatimUnit,
  written: KindTables,
  views: readonly ModelView[],
  ctx: WritePathContext
): WritePath | undefined {
  const hit = bodyKindTable(unit, written, ctx.parse, ctx.plpgsql, views)
  return hit === undefined
    ? undefined
    : {
        unit,
        form: "functionBody",
        target: hit.table,
        roles: [],
        statement: hit.statement,
        ...(hit.unqualified ? { unqualified: true } : {}),
      }
}

/** Оператор тіла функції, що пише таблицю виду, і ця таблиця. */
export interface BodyKindTable {
  table: string
  /** Вузол оператора в дереві розбору: `InsertStmt`, `UpdateStmt`… */
  statement: string
  /** Ціль — ім'я без схеми. */
  unqualified: boolean
}

/**
 * Перший DML тіла функції чи процедури, чия ціль (`bodyStatementTargets`) —
 * таблиця з `tables` (Правило 1, спека прав §6.1); інший клас чи тіло без такого
 * оператора — `undefined`. Судяться оператори, які тіло виконує
 * (`routineBody`), і вкладені в них. Ціль, що є поданням моделі,
 * розгортається до кожного відношення його визначення, рекурсивно: Postgres
 * переписує запис в автооновлюване подання на базову таблицю, а котре
 * відношення базове, без каталогу не видно (fail-closed).
 */
export function bodyKindTable(
  unit: Pick<VerbatimUnit, "class" | "schema" | "sql" | "tree">,
  tables: KindTables,
  parse: SqlParser,
  plpgsql: PlpgsqlParser,
  views: readonly ModelView[]
): BodyKindTable | undefined {
  if (unit.class !== "function" && unit.class !== "procedure") return undefined
  if (tables.qualified.size === 0) return undefined
  const body = routineBody(unit.tree as Node, unit.sql, parse, plpgsql)
  for (const { stmt } of body.statements) {
    for (const target of bodyStatementTargets(stmt, "")) {
      const table = writtenKindTable(
        target,
        unit.schema,
        tables,
        views,
        parse,
        new Set()
      )
      if (table !== undefined)
        return {
          table,
          statement: Object.keys(stmt)[0] ?? "",
          unqualified: target.schema === "",
        }
    }
  }
  return undefined
}

const SEQUENCE_FUNCTIONS: ReadonlySet<string> = new Set(["setval", "nextval"])

/**
 * Функції, чий аргумент називає послідовність текстом: ім'я без схеми в них
 * судиться (`currval` теж — правило про ім'я, не про запис).
 */
const SEQUENCE_NAMING_FUNCTIONS: ReadonlySet<string> = new Set([
  ...SEQUENCE_FUNCTIONS,
  "currval",
])

/**
 * Ціль Правила 1 серед послідовностей за іменем: будь-яке ім'я в `simetra` і
 * будь-яке ім'я без схеми. Ім'я без схеми Postgres розв'язує за шляхом пошуку
 * сесії, який може вести в `simetra`, а перелік послідовностей платформи
 * пропускав кожну нову (identity таблиці стану поза знімком), тож правило
 * структурне: кваліфікуйте ім'я схемою. Ціль імені без схеми — саме ім'я.
 * `undefined` — кваліфіковане ім'я поза `simetra`.
 */
function ruleOneSequence(
  schema: string | undefined,
  name: string
): string | undefined {
  if (schema === PLATFORM_SCHEMA) return `${schema}.${name}`
  if (schema === undefined || schema === "") return name
  return undefined
}

/**
 * Перший виклик послідовності в одиниці, який судить Правило 1 (Р4б,
 * `sequenceCallTarget`): ім'я без схеми, `setval`/`nextval` над `simetra` чи
 * нелітеральний аргумент, який статично не прочитати. Виклик може стояти не лише в тілі
 * функції, а й у поданні, `DEFAULT` домену, політиці чи `WHEN` тригера, тож
 * для решти класів обходиться дерево самої одиниці.
 */
function sequencePath(
  unit: VerbatimUnit,
  ctx: WritePathContext
): WritePath | undefined {
  const routine = unit.class === "function" || unit.class === "procedure"
  const body = routine
    ? routineBody(unit.tree as Node, unit.sql, ctx.parse, ctx.plpgsql)
    : undefined
  const trees: unknown[] = [
    unit.tree,
    ...(body?.statements.map((s) => s.stmt) ?? []),
    ...(body?.values.flatMap(({ text }) => {
      const parsed = ctx.parse(text)
      return parsed.ok ? parsed.statements.map((s) => s.stmt) : []
    }) ?? []),
  ]
  for (const tree of trees) {
    const hit = findSequenceCall(tree)
    if (hit !== undefined)
      return {
        unit,
        form: "sequence",
        target: hit.target,
        roles: [],
        statement: hit.call,
        ...(hit.unqualified ? { unqualified: true } : {}),
      }
  }
  return undefined
}

/**
 * Чи виклик вбудованої `setval`/`nextval`/`currval` судить форма `sequence`
 * (Р4б): ім'я послідовності без схеми (будь-яка з трьох), а для
 * `setval`/`nextval` ще й послідовність `simetra` чи нелітерал. `undefined` —
 * не судить: інший виклик, кваліфіковане ім'я поза `simetra`, `currval` над
 * кваліфікованим чи нелітералом (читання). Один суддя для перелічувача й для
 * виразів (`sql.expression-call-not-allowed` такий виклик пропускає).
 */
export function sequenceCallTarget(
  call: FuncCall
): { call: string; target: string; unqualified: boolean } | undefined {
  const names = (call.funcname ?? []).map((n) =>
    "String" in n ? (n.String.sval ?? "") : ""
  )
  const name = names.at(-1) ?? ""
  const builtin =
    names.length === 1 || (names.length === 2 && names[0] === "pg_catalog")
  if (!builtin || !SEQUENCE_NAMING_FUNCTIONS.has(name)) return undefined
  const target = sequenceTarget(call.args?.[0])
  if (target === undefined) return undefined
  if (!target.unqualified && !SEQUENCE_FUNCTIONS.has(name)) return undefined
  return { call: name, target: target.target, unqualified: target.unqualified }
}

function findSequenceCall(
  value: unknown
): { call: string; target: string; unqualified: boolean } | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSequenceCall(item)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const call = record.FuncCall as FuncCall | undefined
  if (call !== undefined) {
    const hit = sequenceCallTarget(call)
    if (hit !== undefined) return hit
  }
  for (const child of Object.values(record)) {
    const hit = findSequenceCall(child)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * Ціль виклику: `*` — нелітеральний аргумент; `undefined` — кваліфіковане ім'я
 * поза `simetra` (`ruleOneSequence`).
 */
function sequenceTarget(
  arg: Node | undefined
): { target: string; unqualified: boolean } | undefined {
  let node: Node | undefined = arg
  while (node !== undefined && "TypeCast" in node) node = node.TypeCast.arg
  const text =
    node !== undefined && "A_Const" in node
      ? node.A_Const.sval?.sval
      : undefined
  if (text === undefined) return { target: "*", unqualified: false }
  const names = relationNameText(text)
  if (names === undefined) return { target: "*", unqualified: false }
  const schema = names.length > 1 ? names.at(-2) : undefined
  const target = ruleOneSequence(schema, names.at(-1) ?? "")
  return target === undefined
    ? undefined
    : { target, unqualified: schema === undefined }
}

/**
 * Дослівна політика чи тригер на таблиці виду (будь-який) і на таблиці джерела
 * ідентичностей (лише політика й тригер `BEFORE`/`INSTEAD OF`: тригер `BEFORE`
 * змінює `NEW`, тож пише джерело без DML; `AFTER` — форма підписок платформи).
 * Некваліфіковане ім'я — fail-closed (`kindTableNamed`).
 */
function policyTriggerPath(
  unit: VerbatimUnit,
  kind: KindTables,
  identity: KindTables | undefined
): WritePath | undefined {
  const tree = unit.tree as Node
  const form = unit.class as "policy" | "trigger"
  const timing =
    "CreateTrigStmt" in tree ? (tree.CreateTrigStmt.timing ?? 0) : 0
  // TRIGGER_TYPE_BEFORE = 1 << 1, TRIGGER_TYPE_INSTEAD = 1 << 6.
  const writesNew = form === "policy" || (timing & (2 | 64)) !== 0
  for (const target of statementTargets(tree, "")) {
    const table = kindTableNamed(target, unit.schema, kind)
    if (table !== undefined) return { unit, form, target: table, roles: [] }
    if (identity !== undefined && writesNew) {
      const source = kindTableNamed(target, unit.schema, identity)
      if (source !== undefined) return { unit, form, target: source, roles: [] }
    }
  }
  return undefined
}

/**
 * Подання, крізь яке пишуть ціль Правила 1 (Р3): автооновлюване за деревом (одне
 * відношення у `FROM`, без `WITH`, `DISTINCT`, `GROUP BY`, `HAVING`,
 * `LIMIT`/`OFFSET`, множин, агрегатів і віконних функцій у списку вибору),
 * без `security_invoker`, з непорожніми ролями-письменниками. Невпізнана
 * функція у списку вибору неоновлюваність не доводить (fail-closed). Ціль —
 * `writtenKindTable` над відношенням `FROM`.
 */
function viewPath(
  unit: VerbatimUnit,
  written: KindTables,
  views: readonly ModelView[],
  writers: (view: ModelView) => string[],
  ctx: WritePathContext
): WritePath | undefined {
  if (isSecurityInvoker(unit)) return undefined
  const relation = updatableRelation(unit.tree as Node)
  if (relation === undefined) return undefined
  const table = writtenKindTable(
    {
      schema: relation.schemaname ?? "",
      object: relation.relname,
      kind: "table",
    },
    unit.schema,
    written,
    views,
    ctx.parse,
    new Set([`${unit.schema}.${unit.name}`])
  )
  if (table === undefined) return undefined
  const roles = writers(unit)
  return roles.length === 0
    ? undefined
    : { unit, form: "view", target: table, roles }
}

// Клаузу WINDOW не перевіряємо: Postgres судить за використанням віконної
// функції (`aggregates` через `over`), а невикористане вікно подання не закриває.
function updatableRelation(tree: Node): RangeVar | undefined {
  const query = "ViewStmt" in tree ? tree.ViewStmt.query : undefined
  const select =
    query !== undefined && "SelectStmt" in query ? query.SelectStmt : undefined
  if (select === undefined) return undefined
  if (select.op !== undefined && select.op !== "SETOP_NONE") return undefined
  if (
    select.withClause !== undefined ||
    select.distinctClause !== undefined ||
    select.groupClause !== undefined ||
    select.havingClause !== undefined ||
    select.limitCount !== undefined ||
    select.limitOffset !== undefined
  )
    return undefined
  const from = select.fromClause ?? []
  const only = from.length === 1 ? from[0] : undefined
  if (only === undefined || !("RangeVar" in only)) return undefined
  if (select.targetList?.some(aggregates) === true) return undefined
  return only.RangeVar
}

/** Агрегат чи віконна функція у виразі списку вибору (підзапит — окремий вираз). */
function aggregates(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(aggregates)
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  const call = record.FuncCall as Record<string, unknown> | undefined
  if (
    call !== undefined &&
    (call.over !== undefined ||
      call.agg_star === true ||
      call.agg_distinct === true ||
      call.agg_filter !== undefined ||
      call.agg_within_group === true ||
      call.agg_order !== undefined)
  )
    return true
  return Object.entries(record).some(
    ([key, child]) => key !== "SubLink" && aggregates(child)
  )
}

const writesOf = (privileges: readonly Node[]) =>
  privileges.length === 0 ||
  privileges.some((node) => {
    const priv = "AccessPriv" in node ? (node.AccessPriv as AccessPriv) : {}
    const name = priv.priv_name ?? "all"
    return name === "all" || WRITE_PRIVILEGES.has(name)
  })

/** Привілеї послідовності, що дають `setval`/`nextval`; `SELECT` — лише `currval`. */
const SEQUENCE_WRITE_PRIVILEGES: ReadonlySet<string> = new Set([
  "usage",
  "update",
])

const sequenceWritesOf = (privileges: readonly Node[]) =>
  privileges.length === 0 ||
  privileges.some((node) => {
    const priv = "AccessPriv" in node ? (node.AccessPriv as AccessPriv) : {}
    const name = priv.priv_name ?? "all"
    return name === "all" || SEQUENCE_WRITE_PRIVILEGES.has(name)
  })

/**
 * Динамічні позначки отримувача: хто це, статично не відомо, тож вони — «інша
 * роль», а не відповідник імені власника чи ролі `FOR ROLE`.
 */
const DYNAMIC_ROLES: ReadonlySet<string> = new Set([
  "CURRENT_USER",
  "SESSION_USER",
  "CURRENT_ROLE",
])

/** Отримувачі гранту: `PUBLIC`, ім'я ролі чи ключове слово (`CURRENT_USER`…). */
function granteeNames(grantees: readonly Node[] | undefined): string[] {
  return (grantees ?? []).flatMap((n) => {
    if (!("RoleSpec" in n)) return []
    const spec = n.RoleSpec as RoleSpec
    if (spec.roletype === "ROLESPEC_PUBLIC") return [PUBLIC]
    if (spec.roletype === "ROLESPEC_CSTRING") return [spec.rolename ?? ""]
    return [spec.roletype?.replace("ROLESPEC_", "") ?? ""]
  })
}

/**
 * Явний грант запису на ціль Правила 1 (Р2): помилка будь-якій ролі, крім
 * власника; `CURRENT_USER`/`SESSION_USER`/`CURRENT_ROLE` — інша роль. Привілеї
 * `USAGE`/`UPDATE` на послідовність — теж запис (`setval`/`nextval`), ціль ту
 * саму, що в виклику, дає `ruleOneSequence`: послідовність `simetra` чи
 * будь-яке ім'я без схеми. Таблиця з грантами генератора
 * `access` — його власна діагностика `sql.generated-grant`, тож другої не
 * дає, але лише коли ця діагностика справді називає саме цю одиницю: її ключ
 * `table|схема.ім'я` бере ім'я з одиниці, а некваліфіковане ім'я Правило 1
 * судить за всіма схемами. Грант на `simetra` відмовляє `schema.reserved` ще
 * до цього правила.
 */
function grantPath(
  unit: VerbatimUnit,
  written: KindTables,
  owner: string | undefined,
  parse: SqlParser
): WritePath | undefined {
  const grant = (unit.tree as { GrantStmt?: GrantStmt }).GrantStmt
  if (grant === undefined || grant.is_grant !== true) return undefined
  const objtype = grant.objtype
  if (objtype !== "OBJECT_TABLE" && objtype !== "OBJECT_SEQUENCE")
    return undefined
  const privileges = grant.privileges ?? []
  const tableWrite = objtype === "OBJECT_TABLE" && writesOf(privileges)
  const sequenceWrite = sequenceWritesOf(privileges)
  if (!tableWrite && !sequenceWrite) return undefined
  const roles = granteeNames(grant.grantees).filter(
    (r) => DYNAMIC_ROLES.has(r) || r !== owner
  )
  if (roles.length === 0) return undefined
  // Некваліфіковане ім'я — fail-closed: ціль береться з дерева без схеми
  // файлу, а не з `unit.schema`, як у політики й тригера.
  // Цілі-таблиці гранту частинами імені: ключ `grantTargetKeys` — за
  // правилом ідентичності (ім'я в лапках), а таблиці виду (`KindTables`) —
  // сирим `схема.ім'я`, тож порівнюються розібрані частини.
  const resolved = new Set(
    grantTargetKeys(unit, parse).flatMap((key) =>
      key.startsWith("table|")
        ? [
            splitIdentity(key.slice("table|".length), ".")
              .map(unquoteIdent)
              .join("."),
          ]
        : []
    )
  )
  const path = (target: string, unqualified: boolean): WritePath => ({
    unit,
    form: "grant",
    target,
    roles,
    ...(unqualified ? { unqualified: true } : {}),
  })
  for (const target of statementTargets(unit.tree as Node, "")) {
    const unqualified = target.schema === ""
    // Таблиця виду за іменем — перша: ціль з її схемою точніша за голе ім'я.
    if (tableWrite) {
      const table = kindTableNamed(target, unit.schema, written)
      if (table !== undefined) {
        if (
          target.kind !== "schema" &&
          written.generatedGrants?.has(table) === true &&
          resolved.has(table)
        )
          continue
        return path(table, unqualified)
      }
    }
    if (!sequenceWrite) continue
    // Postgres приймає і `GRANT … ON TABLE <послідовність>` (залишає лише
    // `USAGE`/`SELECT`/`UPDATE`), тож ціль гранту будь-якого з двох синтаксисів
    // судиться і як послідовність: ім'я без схеми — помилка будь-якій ролі.
    const sequence =
      target.kind === "schema"
        ? objtype === "OBJECT_SEQUENCE" && target.schema === PLATFORM_SCHEMA
          ? `${PLATFORM_SCHEMA}.*`
          : undefined
        : ruleOneSequence(target.schema, target.object ?? "")
    if (sequence !== undefined) return path(sequence, unqualified)
  }
  return undefined
}

/** `ALTER DEFAULT PRIVILEGES … GRANT` застосунку: що, кому, де. */
export interface DefaultPrivilegeFact {
  unit: VerbatimUnit
  objtype: string
  /** Схеми `IN SCHEMA`; порожньо — глобальне ADP. */
  schemas: readonly string[]
  /** `FOR ROLE`: імена; `undefined` — не названо. */
  forRoles: readonly string[] | undefined
  grantees: readonly string[]
  grantOption: boolean
  /** Привілей запису на `TABLES`. */
  write: boolean
}

interface DefaultPrivilegesTree {
  options?: { DefElem?: { defname?: string; arg?: Node } }[]
  action?: GrantStmt
}

export function defaultPrivilegeFacts(
  units: readonly VerbatimUnit[]
): DefaultPrivilegeFact[] {
  return units.flatMap((unit) => {
    const stmt = (
      unit.tree as { AlterDefaultPrivilegesStmt?: DefaultPrivilegesTree }
    ).AlterDefaultPrivilegesStmt
    if (
      unit.class !== "defaultPrivileges" ||
      stmt?.action === undefined ||
      stmt.action.is_grant !== true
    )
      return []
    const items = (name: string): Node[] | undefined => {
      const arg = (stmt.options ?? []).find((o) => o.DefElem?.defname === name)
        ?.DefElem?.arg
      return arg !== undefined && "List" in arg
        ? (arg.List.items ?? [])
        : undefined
    }
    const roles = items("roles")
    return [
      {
        unit,
        objtype: stmt.action.objtype ?? "",
        schemas: (items("schemas") ?? []).map((n) =>
          "String" in n ? (n.String.sval ?? "") : ""
        ),
        forRoles: roles === undefined ? undefined : granteeNames(roles),
        grantees: granteeNames(stmt.action.grantees),
        grantOption: stmt.action.grant_option === true,
        write:
          stmt.action.objtype === "OBJECT_TABLE" &&
          writesOf(stmt.action.privileges ?? []),
      },
    ]
  })
}

/** Класи об'єктів правила ADP; `FUNCTIONS`/`ROUTINES` судить `sql.default-privileges-execute`. */
const DEFAULT_PRIVILEGE_CLASSES: ReadonlySet<string> = new Set([
  "OBJECT_TABLE",
  "OBJECT_SEQUENCE",
  "OBJECT_TYPE",
  "OBJECT_SCHEMA",
])

/**
 * ACL того, що створює платформа, належить платформі (Р4): `GRANT`-форма ADP
 * на `TABLES`/`SEQUENCES`/`TYPES`/`SCHEMAS`. Глобальне ADP — помилка будь-якого
 * отримувача (воно досягає й `simetra`). ADP `IN SCHEMA` називає лише ролі API;
 * отримувач поза ними — лише коли `FOR ROLE` називає рівно його одного або
 * `FOR ROLE` немає, а кожен отримувач — власник чи роль API (так виглядає ADP
 * провайдера в керованій схемі); право передачі (`WITH GRANT OPTION`) — помилка.
 * Ролі шляху — отримувачі, що судяться.
 */
function defaultPrivilegesPath(
  unit: VerbatimUnit,
  facts: readonly DefaultPrivilegeFact[],
  apiRoles: readonly string[],
  ctx: WritePathContext
): WritePath | undefined {
  const fact = facts.find((f) => f.unit === unit)
  if (fact === undefined || !DEFAULT_PRIVILEGE_CLASSES.has(fact.objtype))
    return undefined
  const target =
    fact.schemas.length === 0
      ? "*"
      : fact.schemas.map((s) => `${s}.*`).join(", ")
  if (fact.schemas.length === 0 || fact.grantOption)
    return { unit, form: "defaultPrivileges", target, roles: fact.grantees }
  const owner = ctx.provider && PROVIDER_OWNER_ROLES[ctx.provider]
  const outside = fact.grantees.filter((r) => !apiRoles.includes(r))
  const providerPreset =
    fact.forRoles === undefined &&
    fact.grantees.every((r) => r === owner || apiRoles.includes(r))
  const bad = providerPreset
    ? []
    : outside.filter(
        (r) =>
          !(
            fact.forRoles?.length === 1 &&
            fact.forRoles[0] === r &&
            !DYNAMIC_ROLES.has(r)
          )
      )
  return bad.length === 0
    ? undefined
    : { unit, form: "defaultPrivileges", target, roles: bad }
}

/** Таблиця у фізичних іменах. */
export interface QualifiedTable {
  schema: string
  name: string
}

/**
 * Таблиці `tables` як `KindTables`: ціль форм перелічувача для гейтів
 * промоції (таблиці до промоції ще не таблиці виду) і винятків знімка, де
 * знімок не дає таблиць виду потрібного складу.
 */
export function qualifiedKindTables(
  tables: readonly QualifiedTable[]
): KindTables {
  const qualified = new Set<string>()
  const byName = new Map<string, string[]>()
  const bySchema = new Map<string, string[]>()
  for (const { schema, name } of tables) {
    const key = `${schema}.${name}`
    qualified.add(key)
    byName.set(name, [...(byName.get(name) ?? []), key])
    bySchema.set(schema, [...(bySchema.get(schema) ?? []), key])
  }
  return { qualified, byName, bySchema }
}

/** Привілеї запису гранта чи ADP для тексту діагностики; `ALL`, коли їх не названо. */
function writePrivilegeText(unit: VerbatimUnit): string {
  const tree = unit.tree as {
    GrantStmt?: GrantStmt
    AlterDefaultPrivilegesStmt?: { action?: GrantStmt }
  }
  const privileges = (tree.GrantStmt ?? tree.AlterDefaultPrivilegesStmt?.action)
    ?.privileges
  const names = (privileges ?? []).map((node) =>
    "AccessPriv" in node ? (node.AccessPriv.priv_name ?? "all") : "all"
  )
  const writes = names.filter((n) => n === "all" || WRITE_PRIVILEGES.has(n))
  return (writes.length > 0 ? writes : names.length > 0 ? names : ["all"])
    .map((n) => n.toUpperCase())
    .join(", ")
}

/** Текст діагностики гранта: які привілеї й кому. */
export function grantDetail(unit: VerbatimUnit, roles: readonly string[]) {
  return `GRANT ${writePrivilegeText(unit)} TO ${roles.join(", ")}`
}

/**
 * Таблиці з `tables`, на які ADP `IN SCHEMA` застосунку дає запис (`TABLES`)
 * ролям `roles` (`PUBLIC` — теж роль). Глобальні ADP (без `IN SCHEMA`) поза
 * межею: вони належать ролі, а не схемі (спека промоції §9.9). Перелічувач
 * ADP ролям API не дає — Правило 1 його дозволяє, а гейти судять інші ролі,
 * тож гейт промоції й виняток знімка читають факти цим помічником.
 */
export function defaultPrivilegeTables(
  facts: readonly DefaultPrivilegeFact[],
  roles: ReadonlySet<string>,
  tables: readonly QualifiedTable[]
): {
  unit: VerbatimUnit
  table: QualifiedTable
  roles: string[]
  detail: string
}[] {
  return facts.flatMap((fact) => {
    const hit = fact.grantees.filter((r) => roles.has(r))
    if (!fact.write || hit.length === 0) return []
    return fact.schemas.flatMap((schema) =>
      tables
        .filter((t) => t.schema === schema)
        .map((table) => ({
          unit: fact.unit,
          table,
          roles: hit,
          detail: `default privileges of schema ${schema} ${grantDetail(fact.unit, hit)} ON TABLES`,
        }))
    )
  })
}

/**
 * Таблиці з `tables`, які охоплює шлях-грант: його ціль, кожна таблиця, яку
 * називає оператор (`GRANT … ON a, b`), і, коли грант — на всі таблиці схеми
 * (`ON ALL TABLES IN SCHEMA`), кожна таблиця цієї схеми. Перелічувач називає
 * лише одну ціль на одиницю, а гейт має назвати всі.
 */
export function grantedTables(
  path: WritePath,
  tables: readonly QualifiedTable[],
  parse: SqlParser
): QualifiedTable[] {
  const targets = unitTargets(path.unit, parse)
  return tables.filter(
    (t) =>
      `${t.schema}.${t.name}` === path.target ||
      targets.some((target) =>
        target.kind === "schema"
          ? target.schema === t.schema
          : target.schema === t.schema && target.object === t.name
      )
  )
}
