import { catalogSchema, type Catalog } from "../schemas/catalog"
import {
  deletionMarkColumn,
  keyColumn,
  keyOrderOf,
  numberingType,
  objectFieldReferences,
  refListReferences,
  serviceDateColumns,
  tabularRowColumns,
  type KindDefinition,
  type StandardColumnDef,
} from "./standard"

function standardColumns(obj: unknown): StandardColumnDef[] {
  const catalog = obj as Catalog
  // Склад визначають налаштування виду (спека §5, М3): нульова довжина
  // вимикає код чи найменування, ієрархія й власники додають свої колонки.
  const columns: StandardColumnDef[] = [keyColumn(false)]

  if (catalog.codeLength > 0) {
    columns.push({
      logicalName: "code",
      physicalName: "code",
      type: numberingType(catalog.codeType, catalog.codeLength),
      notNull: false,
      indexed: true,
      ...(catalog.codeUnique ? { unique: true as const } : {}),
      title: { uk: "Код", en: "Code" },
    })
  }
  if (catalog.descriptionLength > 0) {
    columns.push({
      logicalName: "description",
      physicalName: "description",
      type: { type: "String", length: catalog.descriptionLength },
      notNull: false,
      title: { uk: "Найменування", en: "Description" },
    })
  }

  columns.push(deletionMarkColumn())

  if (catalog.hierarchyType !== "None") {
    columns.push({
      logicalName: "parent",
      physicalName: "parent_id",
      type: { type: "UUID" },
      notNull: false,
      ref: "self",
      indexed: true,
      title: { uk: "Батьківський елемент", en: "Parent item" },
    })
  }
  if (catalog.hierarchyType === "FoldersAndItems") {
    columns.push({
      logicalName: "isFolder",
      physicalName: "is_folder",
      type: { type: "Boolean" },
      notNull: true,
      default: "false",
      title: { uk: "Це група", en: "Is folder" },
    })
  }

  if (catalog.owners.length > 0) {
    // Кілька власників — поліморфне посилання: фізично пара owner_type + owner_id.
    const many = catalog.owners.length > 1
    columns.push({
      logicalName: "owner",
      physicalName: many ? "owner" : "owner_id",
      type: { type: "UUID" },
      notNull: false,
      ref: "owners",
      ...(many ? { polymorphic: "whenMany" as const } : {}),
      indexed: true,
      title: { uk: "Власник", en: "Owner" },
    })
  }

  columns.push(
    {
      logicalName: "predefinedName",
      physicalName: "predefined_name",
      type: { type: "Text" },
      notNull: false,
      title: { uk: "Ім'я наперед визначеного елемента", en: "Predefined name" },
    },
    ...serviceDateColumns()
  )
  return columns
}

export const catalogKind: KindDefinition = {
  kind: "Catalog",
  dir: "catalogs",
  schema: catalogSchema,
  keyOrder: keyOrderOf(catalogSchema),
  referenceable: true,
  writePattern: "optimistic",
  actions: ["read", "create", "update", "markDeletion", "delete"],
  materializes: "table",
  declared: false,
  columnFields: ["attributes"],
  valueElements: false,
  standardColumns,
  tabularSectionColumns: () => tabularRowColumns(false),
  references(obj) {
    const catalog = obj as Catalog
    return [
      ...objectFieldReferences(catalog),
      ...refListReferences(catalog.owners, "/owners", "catalog.owner"),
    ]
  },
}
