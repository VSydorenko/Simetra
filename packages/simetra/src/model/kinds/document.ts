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
  type FoundReference,
  type KindDefinition,
  type StandardColumnDef,
} from "./standard"

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
      indexed: true,
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
    {
      logicalName: "posted",
      physicalName: "posted",
      type: { type: "Boolean" },
      notNull: true,
      default: "false",
      title: { uk: "Проведений", en: "Posted" },
    },
    deletionMarkColumn(),
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
  scope: "required",
  declared: false,
  columnFields: ["attributes"],
  valueElements: false,
  standardColumns,
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
