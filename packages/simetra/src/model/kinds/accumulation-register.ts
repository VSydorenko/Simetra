import { readAction } from "./actions"
import {
  accumulationRegisterSchema,
  type AccumulationRegister,
} from "../schemas/accumulation-register"
import {
  fieldListReferences,
  keyOrderOf,
  periodColumn,
  recorderColumns,
  standardRefReferences,
  type KindDefinition,
  type StandardColumnDef,
  customActionReferences,
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
  actions: () => [readAction],
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
  elementReferences: (obj) =>
    customActionReferences(obj as AccumulationRegister),
  references(obj) {
    const register = obj as AccumulationRegister
    return [
      ...standardRefReferences(
        standardColumns(register),
        "recorders",
        register.recorderTypes,
        "/recorderTypes",
        "register.recorder"
      ),
      ...fieldListReferences(register.dimensions, "/dimensions"),
      // Ресурси — числа без посилань (схема ресурсу), тож їх не обходимо.
      ...fieldListReferences(register.attributes, "/attributes"),
    ]
  },
}
