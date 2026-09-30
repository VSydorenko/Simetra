import { constantSchema, type Constant } from "../schemas/constant"
import type { ValueType } from "../schemas/value-type"
import {
  keyOrderOf,
  valueTypeReferences,
  type KindDefinition,
  type StandardColumnDef,
} from "./standard"

/** Лише поля типу: решта полів константи до колонки `value` не належить. */
function valueTypeOf(constant: Constant): ValueType {
  const { type, length, precision, scale, ref, allowedTypes, array } = constant
  const value: ValueType = { type }
  if (length !== undefined) value.length = length
  if (precision !== undefined) value.precision = precision
  if (scale !== undefined) value.scale = scale
  if (ref !== undefined) value.ref = ref
  if (allowedTypes !== undefined) value.allowedTypes = allowedTypes
  if (array !== undefined) value.array = array
  return value
}

function standardColumns(obj: unknown): StandardColumnDef[] {
  const constant = obj as Constant
  return [
    // Глобальна константа — рядок-одинак: ключ, що може мати лише значення true.
    {
      logicalName: "singleton",
      physicalName: "singleton",
      type: { type: "Boolean" },
      notNull: true,
      primaryKey: true,
      singleton: true,
      default: "true",
      check: "singleton",
      title: { uk: "Одинак", en: "Singleton" },
    },
    {
      logicalName: "value",
      physicalName: "value",
      type: valueTypeOf(constant),
      notNull: false,
      title: { uk: "Значення", en: "Value" },
    },
  ]
}

export const constantKind: KindDefinition = {
  kind: "Constant",
  dir: "constants",
  schema: constantSchema,
  keyOrder: keyOrderOf(constantSchema),
  referenceable: false,
  writePattern: "server",
  actions: ["read", "update"],
  materializes: "table",
  scope: "required",
  declared: false,
  columnFields: [],
  valueElements: false,
  standardColumns,
  references: (obj) =>
    valueTypeReferences(obj as Constant, "", {
      ref: "constant.ref",
      allowedType: "constant.allowedType",
    }),
}
