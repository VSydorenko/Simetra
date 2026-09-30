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
  standardColumns,
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
