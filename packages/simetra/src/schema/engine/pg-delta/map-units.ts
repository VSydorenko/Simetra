import {
  encodeId,
  FactBase,
  plan as enginePlan,
  type Action,
  type Fact,
  type PlanOptions,
  type StableId,
} from "@supabase/pg-delta"
import { readSqlUnits, type SqlParser } from "simetra/compiler"
import { quoteIdent, type CatalogUnit } from "simetra/model"
import type { MappingIssue } from "./map-tables"

/**
 * SQL-одиниці з фактів класів, які модель тримає дослівно (план E2a,
 * рішення 6). Текст — з дефініції факту (`pg_get_functiondef`,
 * `pg_get_triggerdef`), з payload для дій двигуна без власної цілі (GRANT,
 * `OWNED BY`, `REPLICA IDENTITY`) або з дії плану «база без застосунку →
 * факт»; ідентичність дає той самий класифікатор, що й у компіляторі
 * (`readSqlUnits`). Факт — одна пара (об'єкт, роль) чи (publication,
 * таблиця), тож і одиниця — одна пара (рішення за спайком, 5).
 */

/** Дії плану за кожним фактом, який вони створюють (`produces`). */
export type ProducedBy = ReadonlyMap<string, readonly Action[]>

/**
 * План «база без керованих фактів → база»: двигун сам друкує оператор
 * створення кожного керованого факту. Керовані факти й усі їхні нащадки
 * прибрано з джерела, тож план створює саме застосунок і нічого більше.
 */
export function producedBy(
  raw: FactBase,
  view: FactBase,
  options: PlanOptions
): ProducedBy {
  const managed = new Set(
    view
      .facts()
      .filter((f) => !view.isReferenceOnly(f.id))
      .map((f) => encodeId(f.id))
  )
  const removed = (fact: Fact): boolean => {
    for (let id: StableId | undefined = fact.id; id !== undefined;) {
      if (managed.has(encodeId(id))) return true
      id = raw.get(id)?.parent
    }
    return false
  }
  const kept = raw.facts().filter((f) => !removed(f))
  const keys = new Set(kept.map((f) => encodeId(f.id)))
  const edges = raw.edges.filter(
    (e) => keys.has(encodeId(e.from)) && keys.has(encodeId(e.to))
  )
  const actions = enginePlan(
    new FactBase(kept, edges, raw.source),
    raw,
    options
  ).actions
  const out = new Map<string, Action[]>()
  for (const action of actions) {
    for (const id of action.produces) {
      const key = encodeId(id)
      out.set(key, [...(out.get(key) ?? []), action])
    }
  }
  return out
}

const qualified = (schema: string, name: string) =>
  `${quoteIdent(schema)}.${quoteIdent(name)}`

/** Адреса об'єкта в `GRANT … ON <адреса>`; `undefined` — граматики немає. */
function grantTarget(target: StableId): string | undefined {
  switch (target.kind) {
    case "table":
    case "view":
    case "materializedView":
    case "foreignTable":
      return `TABLE ${qualified(target.schema, target.name)}`
    case "sequence":
      return `SEQUENCE ${qualified(target.schema, target.name)}`
    case "type":
      return `TYPE ${qualified(target.schema, target.name)}`
    case "domain":
      return `DOMAIN ${qualified(target.schema, target.name)}`
    case "schema":
      return `SCHEMA ${quoteIdent(target.name)}`
    case "language":
      return `LANGUAGE ${quoteIdent(target.name)}`
    case "fdw":
      return `FOREIGN DATA WRAPPER ${quoteIdent(target.name)}`
    case "server":
      return `FOREIGN SERVER ${quoteIdent(target.name)}`
    // Агрегат — теж функція `pg_proc`: `GRANT … ON FUNCTION` його приймає.
    // Типи аргументів — у формі `format_type`, валідній як SQL
    case "function":
    case "aggregate":
    case "procedure":
      return `${target.kind === "procedure" ? "PROCEDURE" : "FUNCTION"} ${qualified(target.schema, target.name)}(${target.args.join(", ")})`
    default:
      return undefined
  }
}

/**
 * Єдиний привілей, який Postgres дає `PUBLIC` на свіжий об'єкт виду (таблиця
 * 5.2 документації); той самий перелік, що й у двигуна, який його не
 * експортує.
 */
const PUBLIC_DEFAULT: Partial<Record<StableId["kind"], string>> = {
  type: "USAGE",
  domain: "USAGE",
  language: "USAGE",
  function: "EXECUTE",
  procedure: "EXECUTE",
  aggregate: "EXECUTE",
}

const grantee = (role: string) =>
  role === "PUBLIC" ? "PUBLIC" : quoteIdent(role)

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : []

/**
 * Оператор ACL-пари з payload: дія двигуна для неї цілі не має. Типові права
 * свіжого об'єкта — власника (`_ownerDefault`) і `PUBLIC` — не одиниця й не
 * відмінність (рішення за спайком, 8); явне відкликання такого права —
 * одиниця `REVOKE`. Порожній рядок — пари немає.
 */
function aclStatement(fact: Fact, issues: MappingIssue[]): string {
  const id = fact.id as Extract<StableId, { kind: "acl" }>
  const target = grantTarget(id.target)
  if (target === undefined) {
    issues.push({
      object: id,
      property: "target",
      detail: `privileges on ${id.target.kind} have no GRANT form`,
    })
    return ""
  }
  const privileges = strings(fact.payload.privileges)
  const grantable = strings(fact.payload.grantable)
  const ownerDefault = fact.payload._ownerDefault
  const column = id.column === undefined ? "" : ` (${quoteIdent(id.column)})`
  const list = (privs: readonly string[]) =>
    privs.map((p) => `${p}${column}`).join(", ")
  const revoke = (privs: readonly string[]) =>
    `REVOKE ${list(privs)} ON ${target} FROM ${grantee(id.grantee)}`
  if (Array.isArray(ownerDefault)) {
    const defaults = strings(ownerDefault)
    const missing = defaults.filter((p) => !privileges.includes(p))
    if (missing.length === 0 && privileges.length === defaults.length) return ""
    if (missing.length === 0 || privileges.some((p) => !defaults.includes(p))) {
      issues.push({
        object: id,
        property: "privileges",
        detail: `owner privileges ${privileges.join(",")} differ from the owner default other than by a revoke`,
      })
      return ""
    }
    return revoke(missing)
  }
  const publicDefault =
    id.grantee === "PUBLIC" && id.column === undefined
      ? PUBLIC_DEFAULT[id.target.kind]
      : undefined
  if (publicDefault !== undefined) {
    if (privileges.length === 1 && privileges[0] === publicDefault) return ""
    if (privileges.length === 0) return revoke([publicDefault])
  }
  if (privileges.length === 0) {
    issues.push({
      object: id,
      property: "privileges",
      detail: "a grantee without privileges is not a grant",
    })
    return ""
  }
  // Ідентичність гранту опцію не несе, а частковий `WITH GRANT OPTION` — це
  // два оператори на одну пару
  if (grantable.length > 0 && grantable.length !== privileges.length) {
    issues.push({
      object: id,
      property: "grantable",
      detail: `grant option on ${grantable.join(",")} only of ${privileges.join(",")}`,
    })
    return ""
  }
  return `GRANT ${list(privileges)} ON ${target} TO ${grantee(id.grantee)}${grantable.length > 0 ? " WITH GRANT OPTION" : ""}`
}

const REPLICA_IDENTITY: Readonly<Record<string, string>> = {
  f: "FULL",
  n: "NOTHING",
}

/**
 * `REPLICA IDENTITY` таблиці — одиниця класу `replicaIdentity` (рішення за
 * спайком, 3); типове значення (`d`) одиниці не дає.
 */
export function replicaIdentityStatement(
  table: Fact,
  issues: MappingIssue[]
): string {
  const id = table.id as { schema: string; name: string }
  const mode = String(table.payload.replicaIdentity)
  if (mode === "d") return ""
  const target = `ALTER TABLE ${qualified(id.schema, id.name)} REPLICA IDENTITY`
  if (mode === "i" && typeof table.payload.replicaIdentityIndex === "string")
    return `${target} USING INDEX ${quoteIdent(table.payload.replicaIdentityIndex)}`
  const form = REPLICA_IDENTITY[mode]
  if (form === undefined) {
    issues.push({
      object: table.id,
      property: "replicaIdentity",
      detail: `replica identity "${mode}" has no statement form`,
    })
    return ""
  }
  return `${target} ${form}`
}

/** Чи `id` — сам факт або його нащадок: дія може створювати й дочірні факти. */
function within(view: FactBase, id: StableId, root: string): boolean {
  for (let cur: StableId | undefined = id; cur !== undefined;) {
    if (encodeId(cur) === root) return true
    cur = view.get(cur)?.parent
  }
  return false
}

/**
 * Одна дія плану на факт (рішення плану 6): інакше текст одиниці не
 * однозначний — гучна помилка.
 */
function actionStatement(
  view: FactBase,
  fact: Fact,
  produced: ProducedBy,
  issues: MappingIssue[]
): string {
  const key = encodeId(fact.id)
  const actions = produced.get(key) ?? []
  const [action] = actions
  if (action === undefined || actions.length > 1) {
    issues.push({
      object: fact.id,
      property: "sql",
      detail: `the engine plans ${actions.length} statements for this object, expected one`,
    })
    return ""
  }
  const foreign = action.produces.filter((id) => !within(view, id, key))
  if (foreign.length > 0) {
    issues.push({
      object: fact.id,
      property: "sql",
      detail: `the statement also creates ${foreign.map(encodeId).join(", ")}`,
    })
    return ""
  }
  return action.sql
}

/** Оператори одиниць факту; порожній масив — факт одиниці не дає. */
export function unitStatements(
  view: FactBase,
  fact: Fact,
  produced: ProducedBy,
  issues: MappingIssue[]
): string[] {
  switch (fact.id.kind) {
    case "function":
    case "procedure":
      // `pg_get_functiondef` уже містить `SET` функції (`functionSettings`
      // компілятора база тримає всередині дефініції — рішення за спайком, 4)
      return [String(fact.payload.def)]
    case "trigger":
      if (fact.payload.enabled !== "O")
        issues.push({
          object: fact.id,
          property: "enabled",
          detail: `trigger firing mode "${String(fact.payload.enabled)}" has no unit class`,
        })
      return [String(fact.payload.def)]
    case "acl":
      return [aclStatement(fact, issues)]
    case "sequence": {
      const statements = [actionStatement(view, fact, produced, issues)]
      const owner = fact.payload.ownedBy as {
        schema: string
        table: string
        column: string
      } | null
      const id = fact.id as { schema: string; name: string }
      if (owner !== null && owner !== undefined)
        statements.push(
          `ALTER SEQUENCE ${qualified(id.schema, id.name)} OWNED BY ${qualified(owner.schema, owner.table)}.${quoteIdent(owner.column)}`
        )
      return statements
    }
    case "table":
      return [replicaIdentityStatement(fact, issues)]
    default:
      return [actionStatement(view, fact, produced, issues)]
  }
}

/**
 * Одиниця моделі з оператора: клас, ідентичність, схема й ім'я — від
 * класифікатора компілятора, тож обидві сторони порівняння мають одну мову
 * ідентичностей. Оператор поза мовою компілятора — гучна помилка.
 */
export function classifyUnit(
  object: StableId,
  sql: string,
  parse: SqlParser,
  issues: MappingIssue[]
): CatalogUnit | undefined {
  const file = encodeId(object)
  const { units, diagnostics } = readSqlUnits(
    [{ file, text: sql, schema: "" }],
    parse,
    []
  )
  const [unit] = units
  if (unit === undefined || units.length > 1 || diagnostics.length > 0) {
    issues.push({
      object,
      property: "sql",
      detail: `statement is outside the unit language: ${diagnostics.map((d) => d.message).join("; ") || sql}`,
    })
    return undefined
  }
  return {
    class: unit.class,
    identity: unit.identity,
    schema: unit.schema,
    name: unit.name,
    sql: unit.sql,
  }
}
