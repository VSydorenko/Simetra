import {
  informationRegisterSchema,
  type InformationRegister,
} from "../schemas/information-register"
import {
  fieldListReferences,
  keyOrderOf,
  periodColumn,
  recorderColumns,
  refListReferences,
  type KindDefinition,
  type StandardColumnDef,
} from "./standard"

function standardColumns(obj: unknown): StandardColumnDef[] {
  const register = obj as InformationRegister
  return [
    ...(register.periodicity !== "NonPeriodic" ? [periodColumn()] : []),
    // Незалежний регістр пишуть напряму, тож реєстратора в нього немає.
    ...(register.writeMode === "RecorderSubordinate" ? recorderColumns() : []),
  ]
}

export const informationRegisterKind: KindDefinition = {
  kind: "InformationRegister",
  dir: "information-registers",
  schema: informationRegisterSchema,
  keyOrder: keyOrderOf(informationRegisterSchema),
  referenceable: false,
  writePattern: "server",
  actions: ["read"],
  materializes: "table",
  scope: "required",
  declared: false,
  columnFields: ["dimensions", "resources", "attributes"],
  valueElements: false,
  standardColumns,
  // Незалежний регістр пишуть і оновлюють за ключем запису (PostgREST
  // робить upsert лише за PK); підлеглий переписує рухи за реєстратором, а
  // ключ запису тримає UNIQUE.
  registerKeys(obj) {
    const subordinate =
      (obj as InformationRegister).writeMode === "RecorderSubordinate"
    return {
      movementsPrimaryKey: subordinate ? "recorder" : "dimensions",
      dimensionsUnique: subordinate,
      dimensionsNotNull: true,
      totals: false,
    }
  },
  references(obj) {
    const register = obj as InformationRegister
    return [
      ...refListReferences(
        register.recorderTypes,
        "/recorderTypes",
        "register.recorder"
      ),
      ...fieldListReferences(register.dimensions, "/dimensions"),
      ...fieldListReferences(register.resources, "/resources"),
      ...fieldListReferences(register.attributes, "/attributes"),
    ]
  },
}
