import { OBJECT_OPERATIONS, type ObjectOperation } from "simetra/model"

/** Дієслово інструмента запису агента. */
export type AgentVerb = "write" | "remove"

/**
 * Дієслово кожної операції рантайму. Вичерпний запис за `OBJECT_OPERATIONS`:
 * нова операція не компілюється без рядка, тож не лишається поза дієсловами.
 */
export const OPERATION_VERBS: Readonly<Record<ObjectOperation, AgentVerb>> = {
  create: "write",
  update: "write",
  markDeletion: "remove",
  delete: "remove",
}

/** Операції рантайму, які об'єкт каталогу має, у порядку `OBJECT_OPERATIONS`. */
export const operationsOf = (object: {
  operations?: Partial<Record<ObjectOperation, unknown>>
}): ObjectOperation[] =>
  OBJECT_OPERATIONS.filter((op) => object.operations?.[op] !== undefined)

/** Дієслова, доступні об'єкту: ті, чия операція є в його `operations`. */
export const verbsOf = (object: {
  operations?: Partial<Record<ObjectOperation, unknown>>
}): AgentVerb[] => [
  ...new Set(operationsOf(object).map((op) => OPERATION_VERBS[op])),
]
