import { constantSchema, type Constant } from "../schemas/constant"
import type { ValueType } from "../schemas/value-type"
import {
  keyOrderOf,
  singletonColumn,
  valueTypeReferences,
  type KindDefinition,
  type StandardColumnDef,
} from "./standard"

/** Лише поля типу: решта полів константи до колонки `value` не належить. */
function valueTypeOf(constant: Constant): ValueType {
  const { type, length, precision, scale, ref, allowedTypes, array } = constant
  const { crossScope } = constant
  const value: ValueType = { type }
  if (length !== undefined) value.length = length
  if (precision !== undefined) value.precision = precision
  if (scale !== undefined) value.scale = scale
  if (ref !== undefined) value.ref = ref
  if (allowedTypes !== undefined) value.allowedTypes = allowedTypes
  if (array !== undefined) value.array = array
  if (crossScope !== undefined) value.crossScope = crossScope
  return value
}

function standardColumns(obj: unknown): StandardColumnDef[] {
  const constant = obj as Constant
  return [
    // Глобальна константа — рядок-одинак.
    singletonColumn(),
    {
      logicalName: "value",
      physicalName: "value",
      type: valueTypeOf(constant),
      notNull: false,
      ...(constant.defaultValue !== undefined
        ? { defaultValue: constant.defaultValue }
        : {}),
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
  rowLevelSecurity: "enabled",
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
