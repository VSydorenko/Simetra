import type { Node, RangeVar } from "libpg-query"
import type { CatalogUnit, SqlUnitClass } from "simetra/model"
import type { SqlParser } from "./parse"
import { grantParts, targetParts } from "./units"

/**
 * Ціль одиниці — об'єкт, на який діє оператор без власного об'єкта в схемі
 * (грант, коментар, типові привілеї, членство в publication) чи з об'єктом,
 * що висить на чужій таблиці (політика, тригер).
 *
 * `schema` — схема цілі. Некваліфіковане ім'я `unitTargets` бере в
 * `unit.schema` — схемі, яку одиниці призначив компілятор (тека чи схема
 * власника) або extract; на `search_path` тут ніхто не покладається, рендер
 * його не задає. Порожня схема означає одне з двох: ціль без схеми (база,
 * роль, розширення, publication) або некваліфіковане ім'я в одиниці, що сама
 * схеми не має (грант, коментар). Для такої цілі розкладка зворотного
 * генератора підставляє `defaultSchema` проєкту — це її правило розміщення
 * файлу, а не резолюція імені базою.
 *
 * `object` — об'єкт верхнього рівня схеми: функція, сама схема, а для
 * колонки, політики чи тригера (`kind` `column`/`policy`/`trigger`) — їхня
 * таблиця: поверхня провайдера й розкладка файлів читають саме таблицю.
 */
export interface UnitTarget {
  schema: string
  object?: string
  kind?:
    | "table"
    | "column"
    | "policy"
    | "trigger"
    | "schema"
    | "function"
    | "publication"
    | "other"
}

type TargetUnit = Pick<CatalogUnit, "class" | "schema" | "sql">

/**
 * Ціль одиниці, коли вона одна; оператор на кілька об'єктів (грант на дві
 * таблиці) чи одиниця, що сама є об'єктом (функція, в'юха), — без цілі.
 */
export function unitTarget(
  unit: TargetUnit,
  parse: SqlParser
): UnitTarget | undefined {
  const targets = unitTargets(unit, parse)
  return targets.length === 1 ? targets[0] : undefined
}

/**
 * Усі цілі одиниці з дерева розбору (план E2b, рішення 9): межа керування й
 * діагностика межі читають ту саму відповідь, тож схема, яку межа не
 * охопила, не може водночас лишитися без діагностики. Некваліфіковане ім'я
 * бере `unit.schema` — схему, яку одиниці вже призначив компілятор чи
 * extract. Типові привілеї без `IN SCHEMA` цілей не мають.
 */
export function unitTargets(unit: TargetUnit, parse: SqlParser): UnitTarget[] {
  if (!TARGETED.has(unit.class)) return []
  return statements(unit, parse).flatMap((stmt) =>
    statementTargets(stmt, unit.schema)
  )
}

/**
 * Цілі одиниці, а для одиниці без цілі — її власна схема: де одиниця лежить
 * для межі керування й для діагностики межі, одним правилом.
 */
export function unitPlacement(
  unit: TargetUnit,
  parse: SqlParser
): UnitTarget[] {
  const targets = unitTargets(unit, parse)
  return targets.length > 0 ? targets : [{ schema: unit.schema }]
}

/**
 * Схема функції, яку викликає тригер; некваліфіковане ім'я — `undefined`:
 * його резолвить `search_path` бази, а не текст одиниці.
 */
export function triggerFunctionSchema(
  unit: TargetUnit,
  parse: SqlParser
): string | undefined {
  if (unit.class !== "trigger") return undefined
  for (const stmt of statements(unit, parse))
    if ("CreateTrigStmt" in stmt) {
      const names = strings(stmt.CreateTrigStmt.funcname)
      return names.length > 1 ? names.at(-2) : undefined
    }
  return undefined
}

/**
 * Ключ предмета класу конверсії промоції (рішення 7 плану П3-2a): об'єкт,
 * який клас покриває, коли одиниця зникає з бажаного стану. Будується з
 * класу, цілі й імені одиниці, а не з її ідентичності: об'єкти гранту
 * змінюються з перейменуванням таблиці, яку й так дає `table`.
 */
export interface UnitSubjectKey {
  class: SqlUnitClass
  schema: string
  table: string
  name: string
}

/**
 * Ключі одиниці — по одному на ціль: грант на основну таблицю й таблицю ТЧ
 * покриває обидві. `ownerSchema` — схема цілі з порожньою схемою
 * (некваліфікований грант чи коментар компілятора). Ім'я гранту —
 * `<grant|revoke>:<ролі>:<привілеї>`, тож два різні гранти на одну таблицю
 * мають різні ключі й клас одного не покриває інший; ім'я коментаря —
 * член таблиці (колонка) або `""` для коментаря самої таблиці. Одиниця без
 * цілі (функція, в'юха) — один ключ без таблиці на її власне ім'я.
 */
export function unitSubjectKeys(
  unit: Pick<CatalogUnit, "class" | "schema" | "name" | "sql">,
  parse: SqlParser,
  ownerSchema: string
): UnitSubjectKey[] {
  const key = (schema: string, table: string, name: string) => ({
    class: unit.class,
    schema: schema === "" ? ownerSchema : schema,
    table,
    name,
  })
  if (!TARGETED.has(unit.class)) return [key(unit.schema, "", unit.name)]
  return statements(unit, parse).flatMap((stmt) => {
    const name = subjectName(stmt, unit.name)
    return statementTargets(stmt, unit.schema).map((t) =>
      key(t.schema, t.object ?? "", name)
    )
  })
}

/** Ім'я ключа предмета за оператором одиниці (`unitSubjectKeys`). */
function subjectName(stmt: Node, unitName: string): string {
  if ("GrantStmt" in stmt) {
    const { action, roles, privileges } = grantParts(stmt.GrantStmt)
    return `${action}:${roles}:${privileges}`
  }
  if ("CommentStmt" in stmt) {
    const { object, objtype } = stmt.CommentStmt
    // Член таблиці (колонка, політика, тригер) — список `[схема,] таблиця, ім'я`.
    if (object === undefined || !TABLE_MEMBERS.has(objtype ?? "")) return ""
    return targetParts(object).at(-1) ?? ""
  }
  return unitName
}

const TARGETED: ReadonlySet<CatalogUnit["class"]> = new Set([
  "grant",
  "comment",
  "policy",
  "trigger",
  "publication",
  "defaultPrivileges",
])

function statements(unit: TargetUnit, parse: SqlParser): Node[] {
  const parsed = parse(unit.sql)
  // Текст одиниці вже розібрали компілятор чи extract: збій тут — порушений
  // інваріант, а не помилка автора, і тихо пропустити ціль не можна
  if (!parsed.ok)
    throw new Error(`${unit.class} unit does not parse: ${parsed.message}`)
  return parsed.statements.map((s) => s.stmt)
}

const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "OBJECT_FUNCTION",
  "OBJECT_PROCEDURE",
  "OBJECT_ROUTINE",
  "OBJECT_AGGREGATE",
])

/**
 * Цілі, що висять на таблиці: ім'я — `[схема,] таблиця, ім'я`. Вид члена
 * зберігається: коментар на політиці поверхні провайдера двигун пускає в
 * межу, а коментар на колонці чи тригері тієї ж таблиці — ні.
 */
const TABLE_MEMBERS: ReadonlyMap<string, UnitTarget["kind"]> = new Map([
  ["OBJECT_COLUMN", "column"],
  ["OBJECT_TRIGGER", "trigger"],
  ["OBJECT_POLICY", "policy"],
  ["OBJECT_RULE", "other"],
  ["OBJECT_TABCONSTRAINT", "other"],
])

/**
 * Цілі одного оператора з уже розібраного дерева: компілятор читає їх із
 * дерева одиниці (резервування схеми платформи), не розбираючи текст удруге.
 * `schema` — схема некваліфікованих імен; оператор без цілі дає порожній список.
 */
export function statementTargets(stmt: Node, schema: string): UnitTarget[] {
  if ("CreatePolicyStmt" in stmt)
    return [table(stmt.CreatePolicyStmt.table, schema)]
  if ("CreateTrigStmt" in stmt)
    return [table(stmt.CreateTrigStmt.relation, schema)]
  if ("GrantStmt" in stmt) {
    const node = stmt.GrantStmt
    const objects = node.objects ?? []
    // `ON ALL … IN SCHEMA s` перелічує схеми, а не об'єкти: ціль — сама
    // схема, як у типових привілеїв `IN SCHEMA`.
    if (node.targtype === "ACL_TARGET_ALL_IN_SCHEMA")
      return objects.map((o) => schemaTarget(strings([o])[0]!))
    return objects.map((o) => objectTarget(o, node.objtype, schema))
  }
  if ("CommentStmt" in stmt) {
    const { object, objtype } = stmt.CommentStmt
    return object === undefined ? [] : [objectTarget(object, objtype, schema)]
  }
  if ("AlterPublicationStmt" in stmt)
    return (stmt.AlterPublicationStmt.pubobjects ?? []).flatMap((o) => {
      if (!("PublicationObjSpec" in o)) return []
      const spec = o.PublicationObjSpec
      if (spec.pubtable !== undefined)
        return [table(spec.pubtable.relation, schema)]
      return [schemaTarget(spec.name ?? schema)]
    })
  if ("AlterDefaultPrivilegesStmt" in stmt)
    return (stmt.AlterDefaultPrivilegesStmt.options ?? []).flatMap((o) =>
      "DefElem" in o && o.DefElem.defname === "schemas" && o.DefElem.arg
        ? listItems(o.DefElem.arg).map((s) => schemaTarget(strings([s])[0]!))
        : []
    )
  return []
}

/**
 * Оператори, що лише читають чи пишуть рядки, і `LOCK`: на них діють RLS і
 * права таблиці, як на запит команди, тож відношень вони не змінюють.
 */
const DATA_STATEMENTS: ReadonlySet<string> = new Set([
  "SelectStmt",
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "LockStmt",
])

/** Види об'єктів простору `pg_class`, які оператор називає списком імен. */
const RELATION_TYPES: ReadonlySet<string> = new Set([
  "OBJECT_TABLE",
  "OBJECT_FOREIGN_TABLE",
  "OBJECT_VIEW",
  "OBJECT_MATVIEW",
  "OBJECT_SEQUENCE",
  "OBJECT_INDEX",
])

/**
 * Відношення, які змінює оператор тіла функції (Р2c1-15). DML і `LOCK` — без
 * цілей. Решта — fail-closed: кожне відношення оператора поза вкладеним
 * оператором (`ALTER TABLE`, `TRUNCATE`, `CREATE INDEX`, політика, тригер,
 * грант, `INHERITS`/`PARTITION OF`, `REFERENCES`, `LIKE` — без розбору, що
 * саме оператор з ним робить) і відношення чи його член, названий списком
 * імен (`COMMENT`, `SECURITY LABEL`, `DROP`), тим самим розбором імен, що й
 * `statementTargets`. Таблиця, яку оператор лише читає вкладеним запитом
 * (`CREATE TABLE … AS SELECT`, підзапит політики), його ціллю не є: запит
 * читає рядки під RLS, а вкладений оператор судиться окремо. Оператор над
 * схемою цілком, що діє на кожну її таблицю (`DROP SCHEMA`, `ALTER SCHEMA …
 * RENAME`/`OWNER`, `GRANT … ON ALL TABLES IN SCHEMA`), дає ціль `kind:
 * "schema"`. `statementTargets` цим не годиться: він знає лише класи одиниць
 * файлів і цілей `ALTER TABLE`, `TRUNCATE` чи `DROP` не має.
 */
export function bodyStatementTargets(stmt: Node, schema: string): UnitTarget[] {
  const [key] = Object.keys(stmt)
  if (key === undefined || DATA_STATEMENTS.has(key)) return []
  return [
    ...namedTargets(stmt, schema),
    ...relations((stmt as Record<string, unknown>)[key], schema),
  ]
}

/** Відношення, назване списком імен, і оператори над схемою цілком. */
function namedTargets(stmt: Node, schema: string): UnitTarget[] {
  const relation = (object: Node | undefined, objtype: string | undefined) =>
    object !== undefined &&
    (RELATION_TYPES.has(objtype ?? "") || TABLE_MEMBERS.has(objtype ?? ""))
      ? [objectTarget(object, objtype, schema)]
      : []
  if ("CommentStmt" in stmt)
    return relation(stmt.CommentStmt.object, stmt.CommentStmt.objtype)
  if ("SecLabelStmt" in stmt)
    return relation(stmt.SecLabelStmt.object, stmt.SecLabelStmt.objtype)
  if ("DropStmt" in stmt) {
    const { objects, removeType } = stmt.DropStmt
    if (removeType === "OBJECT_SCHEMA")
      return strings(objects).map((name) => schemaTarget(name))
    return (objects ?? []).flatMap((o) => relation(o, removeType))
  }
  if ("GrantStmt" in stmt) {
    const node = stmt.GrantStmt
    return node.targtype === "ACL_TARGET_ALL_IN_SCHEMA" &&
      node.objtype === "OBJECT_TABLE"
      ? strings(node.objects).map((name) => schemaTarget(name))
      : []
  }
  if ("RenameStmt" in stmt && stmt.RenameStmt.renameType === "OBJECT_SCHEMA")
    return [schemaTarget(stmt.RenameStmt.subname ?? "")]
  if (
    "AlterOwnerStmt" in stmt &&
    stmt.AlterOwnerStmt.objectType === "OBJECT_SCHEMA" &&
    stmt.AlterOwnerStmt.object !== undefined
  )
    return strings([stmt.AlterOwnerStmt.object]).map((name) =>
      schemaTarget(name)
    )
  return []
}

/**
 * Кожне відношення (`RangeVar`) вузла поза вкладеними операторами: дерево
 * розбору дає його і вузлом `RangeVar`, і голим полем (`relation`, `table`),
 * тож відношення впізнається за `relname`.
 */
function relations(value: unknown, schema: string): UnitTarget[] {
  if (Array.isArray(value)) return value.flatMap((v) => relations(v, schema))
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  if (typeof node.relname === "string") return [table(node as RangeVar, schema)]
  return Object.entries(node).flatMap(([key, child]) =>
    isStatementKey(key) ? [] : relations(child, schema)
  )
}

/**
 * Ключ вузла оператора (`SelectStmt`, `CreatePolicyStmt`): вид вузла пишеться
 * з великої літери, а поле з тим самим закінченням (`selectStmt` у
 * `INSERT … SELECT`) — з малої.
 */
export function isStatementKey(key: string): boolean {
  return key.endsWith("Stmt") && key[0] !== key[0]?.toLowerCase()
}

/** Ціль гранту чи коментаря за видом об'єкта в дереві розбору. */
function objectTarget(
  node: Node,
  objtype: string | undefined,
  schema: string
): UnitTarget {
  const type = objtype ?? ""
  if ("RangeVar" in node) {
    const target = table(node.RangeVar, schema)
    return type === "OBJECT_TABLE" ? target : { ...target, kind: "other" }
  }
  if ("ObjectWithArgs" in node) {
    const { schema: s, name } = qualify(
      strings(node.ObjectWithArgs.objname),
      schema
    )
    const kind = FUNCTION_TYPES.has(type) ? "function" : "other"
    return { schema: s, object: name, kind }
  }
  if ("String" in node) {
    const name = node.String.sval ?? ""
    if (type === "OBJECT_SCHEMA") return schemaTarget(name)
    // Решта однословних цілей схеми не має: база, роль, розширення, мова.
    return {
      schema: "",
      object: name,
      kind: type === "OBJECT_PUBLICATION" ? "publication" : "other",
    }
  }
  if (type === "OBJECT_CAST" || type === "OBJECT_TRANSFORM")
    return { schema: "", kind: "other" }
  const parts = nameParts(node)
  // Клас і сімейство операторів пишуть метод доступу першим: `USING btree`.
  const named =
    type === "OBJECT_OPCLASS" || type === "OBJECT_OPFAMILY"
      ? parts.slice(1)
      : parts
  const member = TABLE_MEMBERS.get(type)
  if (member !== undefined) {
    const { schema: s, name } = qualify(named.slice(0, -1), schema)
    return { schema: s, object: name, kind: member }
  }
  const { schema: s, name } = qualify(
    type === "OBJECT_DOMCONSTRAINT" ? named.slice(0, -1) : named,
    schema
  )
  return {
    schema: s,
    object: name,
    kind: type === "OBJECT_TABLE" ? "table" : "other",
  }
}

function table(rv: RangeVar | undefined, schema: string): UnitTarget {
  return {
    schema: rv?.schemaname ?? schema,
    object: rv?.relname ?? "",
    kind: "table",
  }
}

function schemaTarget(name: string): UnitTarget {
  return { schema: name, object: name, kind: "schema" }
}

/** Частини імені як у тексті; `TypeName` домену розгорнуто. */
function nameParts(node: Node): string[] {
  if ("List" in node) return (node.List.items ?? []).flatMap(nameParts)
  if ("TypeName" in node) return strings(node.TypeName.names)
  if ("String" in node) return [node.String.sval ?? ""]
  return []
}

/** Останні дві частини імені; без схеми — схема одиниці. */
function qualify(
  names: readonly string[],
  schema: string
): { schema: string; name: string } {
  return {
    schema: names.length > 1 ? names.at(-2)! : schema,
    name: names.at(-1) ?? "",
  }
}

function strings(nodes: readonly Node[] | undefined): string[] {
  return (nodes ?? []).map((n) => ("String" in n ? (n.String.sval ?? "") : ""))
}

function listItems(node: Node): Node[] {
  return "List" in node ? (node.List.items ?? []) : [node]
}
