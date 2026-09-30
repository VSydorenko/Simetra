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
  | { kind: "ref"; targets: string[] }
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
  array = false
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
        : { kind: "ref", targets: [...targets] }
    default:
      return UNKNOWN
  }
}

export function inferType(expr: Expr, ctx: PostingContext): InferredType {
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
      if (expr.op === "not") return { kind: "boolean" }
      const operand = inferType(expr.operand, ctx)
      return operand.kind === "numeric" ? operand : UNKNOWN
    }
    case "binary": {
      if (
        expr.op === "+" ||
        expr.op === "-" ||
        expr.op === "*" ||
        expr.op === "/"
      ) {
        const left = inferType(expr.left, ctx)
        const right = inferType(expr.right, ctx)
        // Невідомий операнд робить невідомою й цілість результату.
        if (left.kind === "unknown" || right.kind === "unknown") return UNKNOWN
        const integer =
          expr.op !== "/" &&
          left.kind === "numeric" &&
          left.integer &&
          right.kind === "numeric" &&
          right.integer
        return { kind: "numeric", integer }
      }
      return { kind: "boolean" }
    }
  }
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
      return "reference"
    case "unknown":
      return "value"
    default:
      return type.kind
  }
}
