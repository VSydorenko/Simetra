import {
  accumulationRegisterSchema,
  type AccumulationRegister,
} from "../schemas/accumulation-register"
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
  const register = obj as AccumulationRegister
  const columns = [periodColumn(), ...recorderColumns()]
  // Вид руху потрібен лише залишковому регістру: оборотний лише накопичує.
  if (register.registerType === "Balance") {
    columns.push({
      logicalName: "movementType",
      physicalName: "movement_type",
      type: { type: "Text" },
      notNull: true,
      check: "movement_type IN ('Receipt', 'Expense')",
      title: { uk: "Вид руху", en: "Movement type" },
    })
  }
  return columns
}

export const accumulationRegisterKind: KindDefinition = {
  kind: "AccumulationRegister",
  dir: "accumulation-registers",
  schema: accumulationRegisterSchema,
  keyOrder: keyOrderOf(accumulationRegisterSchema),
  referenceable: false,
  writePattern: "server",
  actions: ["read"],
  materializes: "table",
  scope: "required",
  declared: false,
  columnFields: ["dimensions", "resources", "attributes"],
  valueElements: false,
  standardColumns,
  // Рухи пишуть кілька документів, тож ключ рядка — реєстратор; підсумки
  // тримає лише регістр залишків.
  registerKeys: (obj) => ({
    movementsPrimaryKey: "recorder",
    recordKeyUnique: false,
    movementIndexes: true,
    totals: (obj as AccumulationRegister).registerType === "Balance",
    turnoversMonth: {
      split: (obj as AccumulationRegister).registerType === "Balance",
    },
    additiveResources: true,
    virtualTables:
      (obj as AccumulationRegister).registerType === "Balance"
        ? ["balance", "balanceAndTurnovers"]
        : ["turnovers"],
  }),
  references(obj) {
    const register = obj as AccumulationRegister
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
