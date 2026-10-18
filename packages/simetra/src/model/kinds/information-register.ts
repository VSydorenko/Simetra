import { readAction, writeAction } from "./actions"
import {
  informationRegisterSchema,
  type InformationRegister,
} from "../schemas/information-register"
import {
  fieldListReferences,
  keyOrderOf,
  periodColumn,
  recorderColumns,
  standardRefReferences,
  type KindDefinition,
  type StandardColumnDef,
  customActionReferences,
  accessDimensionReferences,
  accessReferences,
  registerCarrierHost,
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
  // Підлеглий регістр пишуть рухи реєстратора, тож власної дії запису він не має.
  actions: (obj) =>
    (obj as InformationRegister).writeMode === "Independent"
      ? [readAction, writeAction]
      : [readAction],
  rightsExtents: ["any", "dimension"],
  sqlModule: "closed",
  materializes: "table",
  rowLevelSecurity: "enabled",
  scope: "required",
  declared: false,
  kindLabel: true,
  columnFields: ["dimensions", "resources", "attributes"],
  idElementFields: ["customActions"],
  valueElements: false,
  standardColumns,
  // Незалежний регістр пишуть командою T3, тож PK для PostgREST не потрібен,
  // а PK не допускає `NULL` у вимірі: ключ запису тримає UNIQUE NULLS NOT
  // DISTINCT. Підлеглий переписує рухи за реєстратором (PK) і так само тримає
  // ключ запису.
  registerKeys(obj) {
    const subordinate =
      (obj as InformationRegister).writeMode === "RecorderSubordinate"
    return {
      movementsPrimaryKey: subordinate ? "recorder" : "none",
      recordKeyUnique: true,
      movementIndexes: false,
      totals: false,
      additiveResources: false,
      // Зрізи мають сенс лише над періодом, а неперіодичний регістр його не має.
      virtualTables:
        (obj as InformationRegister).periodicity === "NonPeriodic"
          ? []
          : ["sliceLast", "sliceFirst"],
    }
  },
  elementReferences: (obj) => [
    ...customActionReferences(obj as InformationRegister),
    ...accessReferences(
      registerCarrierHost(obj as InformationRegister),
      standardColumns(obj)
    ),
  ],
  projectReferences: (obj) =>
    accessDimensionReferences(obj as InformationRegister),
  references(obj) {
    const register = obj as InformationRegister
    return [
      ...standardRefReferences(
        standardColumns(register),
        "recorders",
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
