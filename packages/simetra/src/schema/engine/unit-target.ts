import type { Node, RangeVar, SqlParser } from "simetra/compiler"
import type { CatalogUnit } from "simetra/model"

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
  return statements(unit, parse).flatMap((stmt) => targetsOf(stmt, unit.schema))
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

function targetsOf(stmt: Node, schema: string): UnitTarget[] {
  if ("CreatePolicyStmt" in stmt)
    return [table(stmt.CreatePolicyStmt.table, schema)]
  if ("CreateTrigStmt" in stmt)
    return [table(stmt.CreateTrigStmt.relation, schema)]
  if ("GrantStmt" in stmt) {
    const node = stmt.GrantStmt
    const objects = node.objects ?? []
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
