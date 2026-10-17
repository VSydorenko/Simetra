import type { Node, ObjectType, RangeVar } from "libpg-query"
import type { SqlParser } from "simetra/compiler"
import type { EngineObjectRef } from "../engine"
import type { PlanStep } from "./steps"
import { stringsOf } from "./type-guard"

/**
 * Предмет оператора кроку — те, що оператор змінює (рішення 5 плану
 * П3-2b-2, вердикт архітектора В7): підпрограма чи тип зі схемою й ім'ям,
 * `other` — визначений предмет іншого виду, `unknown` — предмета з дерева не
 * визначити (вузол поза переліком, ім'я без схеми). Лише структурно: вид
 * вузла й його поля імен, без розбору рядків.
 */
export type StatementSubject =
  | { kind: "routine" | "type"; schema: string; name: string }
  | { kind: "other" }
  | { kind: "unknown" }

/** Що з плану читає вираз кроку даних чи замір: підпрограма чи тип. */
export interface UsedObject {
  kind: "routine" | "type"
  schema: string
  name: string
}

const OTHER: StatementSubject = { kind: "other" }
const UNKNOWN: StatementSubject = { kind: "unknown" }

const ROUTINE_TYPES: ReadonlySet<ObjectType> = new Set<ObjectType>([
  "OBJECT_FUNCTION",
  "OBJECT_PROCEDURE",
  "OBJECT_AGGREGATE",
  "OBJECT_ROUTINE",
])
const TYPE_TYPES: ReadonlySet<ObjectType> = new Set<ObjectType>([
  "OBJECT_TYPE",
  "OBJECT_DOMAIN",
])

/** Предмет із переліку імен вузла: лише `схема.ім'я`, інакше — невідомо. */
function named(
  kind: "routine" | "type",
  names: readonly Node[] | undefined
): StatementSubject {
  const parts = stringsOf(names)
  return parts.length === 2 && parts.length === (names?.length ?? 0)
    ? { kind, schema: parts[0]!, name: parts[1]! }
    : UNKNOWN
}

function fromRelation(
  kind: "routine" | "type",
  relation: RangeVar | undefined
): StatementSubject {
  return relation?.schemaname !== undefined && relation.relname !== undefined
    ? { kind, schema: relation.schemaname, name: relation.relname }
    : UNKNOWN
}

/** Імена об'єкта вузла `object`: підпрограма, перелік імен чи тип. */
function objectNames(object: Node | undefined): Node[] | undefined {
  if (object === undefined) return undefined
  if ("ObjectWithArgs" in object) return object.ObjectWithArgs.objname
  if ("List" in object) return object.List.items
  if ("TypeName" in object) return object.TypeName.names
  return undefined
}

/** Перейменування, власник і схема об'єкта: предмет — за видом об'єкта. */
function byObjectType(
  type: ObjectType | undefined,
  object: Node | undefined,
  relation: RangeVar | undefined
): StatementSubject {
  if (type === undefined) return UNKNOWN
  if (ROUTINE_TYPES.has(type)) return named("routine", objectNames(object))
  if (TYPE_TYPES.has(type)) return named("type", objectNames(object))
  // Атрибут композитного типу й обмеження домену змінюють сам тип
  if (type === "OBJECT_DOMCONSTRAINT") return named("type", objectNames(object))
  if (type === "OBJECT_ATTRIBUTE") return fromRelation("type", relation)
  return OTHER
}

/**
 * Перелік вузлів, з яких предмет визначається, — одне місце. Вузол поза ним
 * — `unknown`: відмова «не доведено», якщо крок вживає те, що читає вираз.
 */
function subjectOf(stmt: Node): StatementSubject {
  if ("CreateFunctionStmt" in stmt)
    return named("routine", stmt.CreateFunctionStmt.funcname)
  if ("AlterFunctionStmt" in stmt) {
    const { objtype, func } = stmt.AlterFunctionStmt
    return objtype !== undefined && ROUTINE_TYPES.has(objtype)
      ? named("routine", func?.objname)
      : UNKNOWN
  }
  if ("DefineStmt" in stmt) {
    const { kind, defnames } = stmt.DefineStmt
    if (kind === "OBJECT_AGGREGATE") return named("routine", defnames)
    if (kind === "OBJECT_TYPE") return named("type", defnames)
    return OTHER
  }
  if ("CreateDomainStmt" in stmt)
    return named("type", stmt.CreateDomainStmt.domainname)
  if ("CreateEnumStmt" in stmt)
    return named("type", stmt.CreateEnumStmt.typeName)
  if ("CreateRangeStmt" in stmt)
    return named("type", stmt.CreateRangeStmt.typeName)
  if ("CompositeTypeStmt" in stmt)
    return fromRelation("type", stmt.CompositeTypeStmt.typevar)
  if ("AlterDomainStmt" in stmt)
    return named("type", stmt.AlterDomainStmt.typeName)
  if ("AlterEnumStmt" in stmt) return named("type", stmt.AlterEnumStmt.typeName)
  if ("AlterTypeStmt" in stmt) return named("type", stmt.AlterTypeStmt.typeName)
  if ("AlterTableStmt" in stmt) {
    const { objtype, relation } = stmt.AlterTableStmt
    // `ALTER TABLE … ALTER COLUMN … TYPE <домен>` домен лише читає
    return objtype === "OBJECT_TYPE" ? fromRelation("type", relation) : OTHER
  }
  if ("RenameStmt" in stmt) {
    const { renameType, object, relation } = stmt.RenameStmt
    return byObjectType(renameType, object, relation)
  }
  if ("AlterOwnerStmt" in stmt) {
    const { objectType, object, relation } = stmt.AlterOwnerStmt
    return byObjectType(objectType, object, relation)
  }
  if ("AlterObjectSchemaStmt" in stmt) {
    const { objectType, object, relation } = stmt.AlterObjectSchemaStmt
    return byObjectType(objectType, object, relation)
  }
  // Коментар значень не змінює
  if ("CommentStmt" in stmt) return OTHER
  return UNKNOWN
}

/** Предмет кожного оператора кроку в їхньому порядку. */
export function statementSubjects(
  sql: string,
  parse: SqlParser
): StatementSubject[] {
  const result = parse(sql)
  // Нерозібраний крок план відмовляє раніше (`plan.unparsable-step`)
  if (!result.ok) throw new Error(`plan step does not parse: ${result.message}`)
  return result.statements.map(({ stmt }) => subjectOf(stmt))
}

/** Види об'єктів двигуна, що несуть тип. */
const TYPE_KINDS: ReadonlySet<string> = new Set(["type", "domain"])
/** Види підпрограм двигуна. */
const ROUTINE_KINDS: ReadonlySet<string> = new Set([
  "function",
  "procedure",
  "aggregate",
])

/**
 * Посилання двигуна на об'єкт: підпрограма — за видом, схемою й ім'ям без
 * сигнатури; тип — за видом типу чи домену, а обмеження домену двигун
 * адресує таблицею-доменом (таблиця й тип з одним ім'ям в одній схемі не
 * співіснують).
 */
function refersTo(ref: EngineObjectRef, used: UsedObject): boolean {
  if (ref.schema !== used.schema) return false
  if (used.kind === "routine")
    return ROUTINE_KINDS.has(ref.kind) && ref.name === used.name
  return (
    (TYPE_KINDS.has(ref.kind) && ref.name === used.name) ||
    ref.table === used.name
  )
}

const sameSubject = (s: StatementSubject, used: UsedObject): boolean =>
  (s.kind === "routine" || s.kind === "type") &&
  s.kind === used.kind &&
  s.schema === used.schema &&
  s.name === used.name

/** Як крок плану зачіпає об'єкт: `changed`, `unproven` чи ніяк. */
export interface StepChange {
  verdict: "changed" | "unproven"
  /** Id кроку. */
  step: string
}

/**
 * Чи змінює план об'єкт, який читає вираз кроку даних чи замір (рішення 5,
 * вердикти В7 і R4). `produced`/`destroyed` з об'єктом → `changed`. Далі
 * предмет кожного оператора з дерева, для будь-якої дії: той самий →
 * `changed`, інший визначений → нічого. Дію `alter` двигун у
 * `produced`/`destroyed` не несе, тож лише для неї невизначений предмет при
 * об'єкті в `consumed` → `unproven`. `changed` будь-якого кроку важить
 * більше за `unproven`.
 */
export function planChange(
  steps: readonly Pick<
    PlanStep,
    "id" | "sql" | "verb" | "produced" | "destroyed" | "consumed"
  >[],
  used: UsedObject,
  parse: SqlParser
): StepChange | undefined {
  let unproven: StepChange | undefined
  for (const step of steps) {
    if ([...step.produced, ...step.destroyed].some((r) => refersTo(r, used)))
      return { verdict: "changed", step: step.id }
    // Предмет оператора — для будь-якої дії: `CREATE FUNCTION` нового
    // перевантаження теж змінює те, що розв'яже виклик (вердикт R4)
    const subjects = statementSubjects(step.sql, parse)
    if (subjects.some((s) => sameSubject(s, used)))
      return { verdict: "changed", step: step.id }
    // «Не доведено» — лише для `alter`: у `create`/`drop` `consumed` —
    // залежності, а що крок змінює, кажуть `produced`/`destroyed`
    if (
      step.verb === "alter" &&
      unproven === undefined &&
      subjects.some((s) => s.kind === "unknown") &&
      step.consumed.some((r) => refersTo(r, used))
    )
      unproven = { verdict: "unproven", step: step.id }
  }
  return unproven
}
