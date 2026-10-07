import type { PeriodUnit } from "../physical/period"
import { documentSchema, type Document } from "../schemas/document"
import {
  deletionMarkColumn,
  keyColumn,
  keyOrderOf,
  numberingType,
  objectFieldReferences,
  refListReferences,
  serviceDateColumns,
  tabularRowColumns,
  versionColumn,
  type FoundReference,
  type KindDefinition,
  type NumberingSpec,
  type StandardColumnDef,
} from "./standard"

const periodUnits = {
  Year: "year",
  Quarter: "quarter",
  Month: "month",
  Day: "day",
} as const satisfies Record<
  Exclude<Document["numberPeriodicity"], "None">,
  PeriodUnit
>

function numbering(obj: unknown): NumberingSpec {
  const document = obj as Document
  return {
    column: "number",
    ...(document.numberPeriodicity === "None"
      ? {}
      : { periodColumn: "numberPeriod" as const }),
    type: document.numberType,
    length: document.numberLength,
    autonumber: document.autonumber,
    periodicity: document.numberPeriodicity,
    unique: true,
  }
}

function standardColumns(obj: unknown): StandardColumnDef[] {
  const document = obj as Document
  return [
    // Серверний патерн: ключ призначає база.
    keyColumn(true),
    {
      logicalName: "number",
      physicalName: "number",
      type: numberingType(document.numberType, document.numberLength),
      notNull: false,
      // Окремого індексу немає: UNIQUE нумерації веде пошук за номером у межах
      // періоду (він починається з `number_period`). Глобального пошуку за
      // одним номером індекс не обслуговує — так задумано.
      title: { uk: "Номер", en: "Number" },
    },
    {
      logicalName: "date",
      physicalName: "date",
      type: { type: "DateTime" },
      notNull: true,
      indexed: true,
      title: { uk: "Дата", en: "Date" },
    },
    ...(document.numberPeriodicity === "None"
      ? []
      : [
          {
            logicalName: "numberPeriod",
            physicalName: "number_period",
            type: { type: "Date" as const },
            notNull: true,
            // Номер унікальний у межах періоду, а період рахує база, щоб
            // жоден клієнт не міг його розійтися з датою.
            generated: {
              truncate: {
                column: "date",
                unit: periodUnits[document.numberPeriodicity],
              },
            },
            title: { uk: "Період номера", en: "Number period" },
          },
        ]),
    {
      logicalName: "posted",
      physicalName: "posted",
      type: { type: "Boolean" },
      notNull: true,
      default: "false",
      title: { uk: "Проведений", en: "Posted" },
    },
    deletionMarkColumn(),
    versionColumn(),
    ...serviceDateColumns(),
  ]
}

function postingReferences(document: Document): FoundReference[] {
  if (document.posting === undefined) return []
  return [
    ...document.posting.movements.map((movement, index) => ({
      pointer: `/posting/movements/${index}/register`,
      ref: movement.register,
      role: "posting.register" as const,
    })),
  ]
}

export const documentKind: KindDefinition = {
  kind: "Document",
  dir: "documents",
  schema: documentSchema,
  keyOrder: keyOrderOf(documentSchema),
  referenceable: true,
  writePattern: "server",
  actions: [
    "read",
    "create",
    "update",
    "markDeletion",
    "delete",
    "post",
    "unpost",
  ],
  materializes: "table",
  rowLevelSecurity: "enabled",
  scope: "required",
  declared: false,
  kindLabel: true,
  requiredOnPost: true,
  columnFields: ["attributes"],
  valueElements: false,
  standardColumns,
  numbering,
  tabularSectionColumns: () => tabularRowColumns(true),
  references(obj) {
    const document = obj as Document
    return [
      ...objectFieldReferences(document),
      ...refListReferences(
        document.registerMovements,
        "/registerMovements",
        "document.registerMovement"
      ),
      ...postingReferences(document),
    ]
  },
}
