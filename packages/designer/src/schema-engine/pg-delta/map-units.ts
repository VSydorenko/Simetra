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
import { unknownKeys, type MappingIssue } from "./map-tables"

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

/** Вид об'єкта в `pg_default_acl` (`defaclobjtype`) за видом факту. */
const ADP_OBJTYPE: Partial<Record<StableId["kind"], string>> = {
  table: "r",
  view: "r",
  materializedView: "r",
  foreignTable: "r",
  sequence: "S",
  function: "f",
  procedure: "f",
  aggregate: "f",
  type: "T",
  domain: "T",
}

interface PrivilegeSet {
  privileges: string[]
  grantable: string[]
}

interface DefaultEntry extends PrivilegeSet {
  schema: string
  objtype: string
  grantee: string
}

/**
 * Що об'єкт отримує при створенні без жодного `GRANT`: права власника,
 * `PUBLIC` за видом і типові привілеї (ADP) його схеми для ролі-власника.
 * Грант, що дорівнює цьому, неявний і одиницею не є (рішення архітектора E2a,
 * задача 4); відмінний — явна одиниця. Правило однакове для обох сторін
 * звірки, бо обидві — extract.
 */
export interface AclDefaults {
  /** Роль, що створює об'єкти без явного власника (ребро `owner` прибрано). */
  owner: string
  entries: readonly DefaultEntry[]
}

export function aclDefaultsOf(view: FactBase, owner: string): AclDefaults {
  const entries: DefaultEntry[] = []
  for (const fact of view.facts()) {
    const id = fact.id
    if (id.kind !== "defaultPrivilege" || view.isReferenceOnly(id)) continue
    // Глобальні типові привілеї межа керування відсікає (політика §6.9), тож
    // тут лише ADP схем ролі-власника
    if (id.role !== owner || id.schema === null) continue
    entries.push({
      schema: id.schema,
      objtype: id.objtype,
      grantee: id.grantee,
      privileges: strings(fact.payload.privileges),
      grantable: strings(fact.payload.grantable),
    })
  }
  return { owner, entries }
}

/** ADP схеми, що стосуються об'єкта; порожньо — об'єкт поза ADP. */
function defaultsFor(target: StableId, defaults: AclDefaults): DefaultEntry[] {
  const objtype = ADP_OBJTYPE[target.kind]
  if (objtype === undefined || !("schema" in target)) return []
  return defaults.entries.filter(
    (e) => e.schema === target.schema && e.objtype === objtype
  )
}

/** Права, які пара (об'єкт, отримувач) має без жодного `GRANT`. */
function expectedPrivileges(fact: Fact, defaults: AclDefaults): PrivilegeSet {
  const id = fact.id as Extract<StableId, { kind: "acl" }>
  const ownerDefault = fact.payload._ownerDefault
  if (Array.isArray(ownerDefault))
    return { privileges: strings(ownerDefault), grantable: [] }
  if (id.column !== undefined) return { privileges: [], grantable: [] }
  const adp = defaultsFor(id.target, defaults).find(
    (e) => e.grantee === id.grantee
  )
  const builtin =
    id.grantee === "PUBLIC" ? PUBLIC_DEFAULT[id.target.kind] : undefined
  // Об'єднання, а не вибір: ADP схеми лише додає права, а для рядка схеми
  // двигун синтезує порожній маркер `PUBLIC`, який відкликання не означає —
  // «або-або» губило б вбудований `EXECUTE`/`USAGE` і явний `REVOKE … FROM PUBLIC`
  return {
    privileges: [
      ...new Set([
        ...(builtin === undefined ? [] : [builtin]),
        ...(adp?.privileges ?? []),
      ]),
    ],
    grantable: adp?.grantable ?? [],
  }
}

const grantee = (role: string) =>
  role === "PUBLIC" ? "PUBLIC" : quoteIdent(role)

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : []

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x))

/**
 * Оператор ACL-пари з payload: дія двигуна для неї цілі не має. Пара, рівна
 * правам свіжого об'єкта (власник, `PUBLIC`, ADP схеми), — не одиниця
 * (рішення за спайком, 8, і рішення архітектора про ADP); відкликане з них —
 * `REVOKE`; решта — `GRANT` усіх прав пари. Розбіжність опції, якої один
 * оператор не виражає, — `engine.unrepresentable`. Порожній рядок — одиниці немає.
 */
function aclStatement(
  fact: Fact,
  defaults: AclDefaults,
  issues: MappingIssue[]
): string {
  unknownKeys(fact, issues)
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
  const expected = expectedPrivileges(fact, defaults)
  if (
    sameSet(privileges, expected.privileges) &&
    sameSet(grantable, expected.grantable)
  )
    return ""
  const column = id.column === undefined ? "" : ` (${quoteIdent(id.column)})`
  const list = (privs: readonly string[]) =>
    privs.map((p) => `${p}${column}`).join(", ")
  const extra = privileges.filter((p) => !expected.privileges.includes(p))
  const missing = expected.privileges.filter((p) => !privileges.includes(p))
  if (extra.length === 0 && missing.length > 0) {
    // `REVOKE` прибирає привілеї разом з опцією; розбіжність опції на тих, що
    // лишилися, — другий оператор на пару, тож гучно, а не тихо
    const keptGrantable = expected.grantable.filter((p) =>
      privileges.includes(p)
    )
    if (!sameSet(grantable, keptGrantable)) {
      issues.push({
        object: id,
        property: "grantable",
        detail: `grant option on ${grantable.join(",") || "nothing"} differs from the default ${keptGrantable.join(",") || "nothing"} besides revoked ${missing.join(",")}`,
      })
      return ""
    }
    return `REVOKE ${list(missing)} ON ${target} FROM ${grantee(id.grantee)}`
  }
  // `GRANT` опцію не відкликає: опція, вужча за типову на наявних правах,
  // потребує `REVOKE GRANT OPTION FOR` — другого оператора на пару
  const narrowed = expected.grantable.filter(
    (p) => privileges.includes(p) && !grantable.includes(p)
  )
  if (narrowed.length > 0) {
    issues.push({
      object: id,
      property: "grantable",
      detail: `grant option on ${narrowed.join(",")} is revoked from the default, which GRANT cannot express`,
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

/**
 * ADP схеми дає права отримувачу на кожен новий об'єкт; якщо в об'єкта такого
 * отримувача немає зовсім (об'єкт старший за ADP або права відкликано), ACL-
 * факту теж немає — тож відкликання видно лише з боку ADP. `object` — і факт,
 * і послідовність identity-колонки, яка окремим фактом не є.
 */
export function revokedDefaultStatements(
  view: FactBase,
  object: StableId,
  defaults: AclDefaults
): string[] {
  const target = grantTarget(object)
  if (target === undefined) return []
  return defaultsFor(object, defaults)
    .filter(
      (e) =>
        e.privileges.length > 0 &&
        view.get({ kind: "acl", target: object, grantee: e.grantee }) ===
          undefined
    )
    .map(
      (e) =>
        `REVOKE ${e.privileges.join(", ")} ON ${target} FROM ${grantee(e.grantee)}`
    )
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
  defaults: AclDefaults,
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
      return [aclStatement(fact, defaults, issues)]
    case "sequence": {
      // Текст послідовності — з дії двигуна, а `OWNED BY` — окрема дія без
      // цілі, тож її форму звіряємо з payload тут
      unknownKeys(fact, issues)
      const statements = [actionStatement(view, fact, produced, issues)]
      const owner = fact.payload.ownedBy as {
        schema: string
        table: string
        column: string
      } | null
      const id = fact.id as { schema: string; name: string }
      if (
        owner !== null &&
        owner !== undefined &&
        !sameSet(Object.keys(owner), ["schema", "table", "column"])
      )
        issues.push({
          object: fact.id,
          property: "ownedBy",
          detail: `owned-by ${JSON.stringify(owner)} has an unknown form`,
        })
      else if (owner !== null && owner !== undefined)
        statements.push(
          `ALTER SEQUENCE ${qualified(id.schema, id.name)} OWNED BY ${qualified(owner.schema, owner.table)}.${quoteIdent(owner.column)}`
        )
      return statements
    }
    case "defaultPrivilege": {
      // ADP схеми лише додає до глобальних і вбудованих типових прав і
      // відкликати їх не може (ALTER DEFAULT PRIVILEGES у документації
      // Postgres): порожній маркер `PUBLIC` на рядку схеми двигун синтезує
      // сам, стану він не несе, тож `REVOKE … FROM PUBLIC` з нього — зайва одиниця
      const id = fact.id as Extract<StableId, { kind: "defaultPrivilege" }>
      if (
        id.schema !== null &&
        id.grantee === "PUBLIC" &&
        strings(fact.payload.privileges).length === 0
      )
        return []
      return [actionStatement(view, fact, produced, issues)]
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
