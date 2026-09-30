import type { Expr, LogicalType } from "simetra/model"

/**
 * Тип значення виразу конструктора рухів (спека П2 §7). `unknown` — тип, який
 * не вивести (ім'я не резолвилось, тип без аналога у виразах): з ним жодна
 * перевірка не спрацьовує, щоб одна причина не давала каскаду помилок.
 */
export type InferredType =
  | { kind: "numeric"; integer: boolean }
  | { kind: "text" }
  | { kind: "boolean" }
  | { kind: "date" }
  /** `pair` — поліморфне посилання: у таблиці це пара `<ім'я>_type` + `<ім'я>_id`. */
  | { kind: "ref"; targets: string[]; pair?: true }
  | { kind: "null" }
  | { kind: "unknown" }

type NamedNode = Extract<Expr, { type: "field" } | { type: "sum" }>

/** Звідки береться тип імені: стадія 4 знає резолвлені елементи й їхні типи. */
export interface PostingContext {
  typeOf(node: NamedNode): InferredType
}

const UNKNOWN: InferredType = { kind: "unknown" }

/**
 * Логічний тип поля як тип виразу. `targets` — UUID цілей `Ref`. Масив,
 * UUID, байти й JSON у граматиці виразів не мають літералів чи операцій, тож
 * порівнювати їх нема з чим.
 */
export function typeOfLogical(
  type: LogicalType,
  targets: readonly string[] = [],
  array = false,
  pair = false
): InferredType {
  if (array) return UNKNOWN
  switch (type) {
    case "SmallInt":
    case "Integer":
    case "BigInt":
      return { kind: "numeric", integer: true }
    case "Numeric":
      return { kind: "numeric", integer: false }
    case "String":
    case "Text":
      return { kind: "text" }
    case "Boolean":
      return { kind: "boolean" }
    case "Date":
    case "DateTime":
      return { kind: "date" }
    case "Ref":
      return targets.length === 0
        ? UNKNOWN
        : { kind: "ref", targets: [...targets], ...(pair ? { pair } : {}) }
    default:
      return UNKNOWN
  }
}

/** Операнд, чий тип не підходить оператору: діагностика вказує на його початок. */
export interface OperandError {
  node: Expr
  expected: string
  actual: InferredType
}

const ARITHMETIC: ReadonlySet<string> = new Set(["+", "-", "*", "/"])
const LOGICAL: ReadonlySet<string> = new Set(["and", "or"])
const ORDERING: ReadonlySet<string> = new Set(["<", "<=", ">", ">="])

/**
 * Тип виразу. Операнд невідповідного типу потрапляє в `errors`, а вузол над
 * ним стає `unknown`: одна причина — одна діагностика, без каскаду вгору до
 * поля. `unknown` операнда (нерезолвлене ім'я, тип без аналога) мовчить.
 */
export function inferType(
  expr: Expr,
  ctx: PostingContext,
  errors: OperandError[] = []
): InferredType {
  const before = errors.length
  const result = inferNode(expr, ctx, errors)
  return errors.length > before ? UNKNOWN : result
}

function inferNode(
  expr: Expr,
  ctx: PostingContext,
  errors: OperandError[]
): InferredType {
  // Операнд, що мусить мати тип `kind`; false — уже звітовано або невідомий.
  const operand = (
    node: Expr,
    kind: "numeric" | "boolean"
  ): InferredType | undefined => {
    const type = inferType(node, ctx, errors)
    if (type.kind === "unknown") return undefined
    if (type.kind !== kind) {
      errors.push({ node, expected: kind, actual: type })
      return undefined
    }
    return type
  }
  switch (expr.type) {
    case "number":
      return { kind: "numeric", integer: !expr.value.includes(".") }
    case "string":
      return { kind: "text" }
    case "boolean":
      return { kind: "boolean" }
    case "null":
      return { kind: "null" }
    case "count":
      return { kind: "numeric", integer: true }
    case "field":
    case "sum":
      return ctx.typeOf(expr)
    case "unary": {
      if (expr.op === "not") {
        operand(expr.operand, "boolean")
        return { kind: "boolean" }
      }
      return operand(expr.operand, "numeric") ?? UNKNOWN
    }
    case "binary": {
      if (ARITHMETIC.has(expr.op)) {
        const left = operand(expr.left, "numeric")
        const right = operand(expr.right, "numeric")
        // Невідомий операнд робить невідомою й цілість результату.
        if (left?.kind !== "numeric" || right?.kind !== "numeric") {
          return UNKNOWN
        }
        return {
          kind: "numeric",
          integer: expr.op !== "/" && left.integer && right.integer,
        }
      }
      if (LOGICAL.has(expr.op)) {
        operand(expr.left, "boolean")
        operand(expr.right, "boolean")
        return { kind: "boolean" }
      }
      // Порівняння: результат завжди boolean, операнди — одного роду.
      const left = inferType(expr.left, ctx, errors)
      const right = inferType(expr.right, ctx, errors)
      const ordering = ORDERING.has(expr.op)
      // Поліморфна пара — дві колонки: у SQL її можна лише перевірити на
      // порожнечу (`_id`), а порівняння зі значенням мовчки порівняло б лише
      // id без виду цілі.
      const pairSide = [expr.left, expr.right].find((_, i) => {
        const type = i === 0 ? left : right
        return type.kind === "ref" && type.pair === true
      })
      const otherIsNull = left.kind === "null" || right.kind === "null"
      if (pairSide !== undefined && (ordering || !otherIsNull)) {
        errors.push({
          node: pairSide,
          expected: "a single-target reference or null",
          actual: pairSide === expr.left ? left : right,
        })
      } else if (ordering && otherIsNull) {
        // Порожнє значення не має порядку: `x < null` у SQL ніколи не істинне.
        const nullSide = left.kind === "null" ? expr.left : expr.right
        errors.push({
          node: nullSide,
          expected: "numeric, text or date",
          actual: { kind: "null" },
        })
      } else if (!comparable(left, right)) {
        errors.push({
          node: expr.right,
          expected: describeType(left),
          actual: right,
        })
      } else if (ordering) {
        // Порядок має сенс лише для чисел, тексту й дат: посилання (UUID) і
        // булеве лише рівні чи ні, а `<` на них SQL або відкине, або
        // порівняє довільно.
        const unordered = [left, right].find(
          (t) => t.kind === "ref" || t.kind === "boolean"
        )
        if (unordered !== undefined) {
          errors.push({
            node: expr,
            expected: "numeric, text or date",
            actual: unordered,
          })
        }
      }
      return { kind: "boolean" }
    }
  }
}

/**
 * Порівнянні типи: той самий рід, `null` — з будь-чим; посилання — лише коли
 * множини цілей перетинаються, інакше рівність завжди хибна.
 */
function comparable(left: InferredType, right: InferredType): boolean {
  if (left.kind === "unknown" || right.kind === "unknown") return true
  if (left.kind === "null" || right.kind === "null") return true
  if (left.kind !== right.kind) return false
  if (left.kind === "ref" && right.kind === "ref") {
    return left.targets.some((target) => right.targets.includes(target))
  }
  return true
}

/**
 * Чи приймає поле значення виразу. Цілому полю неціле число не підходить
 * (обрізання мовчки загубило б дріб), навпаки — можна. Поліморфне поле
 * приймає вираз, чиї цілі — частина його цілей. `null` вирішує викликач: це
 * питання nullable-колонки, а не типу.
 */
export function accepts(field: InferredType, value: InferredType): boolean {
  if (field.kind === "unknown" || value.kind === "unknown") return true
  if (value.kind === "null") return true
  if (field.kind !== value.kind) return false
  if (field.kind === "numeric" && value.kind === "numeric") {
    return !field.integer || value.integer
  }
  if (field.kind === "ref" && value.kind === "ref") {
    return value.targets.every((target) => field.targets.includes(target))
  }
  return true
}

/** Назва типу для тексту діагностики. */
export function describeType(type: InferredType): string {
  switch (type.kind) {
    case "numeric":
      return type.integer ? "integer" : "numeric"
    case "ref":
      return type.pair === true ? "polymorphic reference" : "reference"
    case "unknown":
      return "value"
    default:
      return type.kind
  }
}
