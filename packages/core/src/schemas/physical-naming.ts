import type { MetadataKind } from "./metadata-kind"

/**
 * Маппінг MetadataKind → фізичний префікс для SQL-ідентифікаторів.
 * Призначення: усунення колізій між однойменними об'єктами різних kind-ів
 * (наприклад, Catalog.Status і Enumeration.Status → cat_status та enum_status).
 * Живе в core, а не в generator-pg, бо є доменним правилом — будь-який генератор
 * (PostgreSQL, MSSQL, ...) мусить використовувати той самий маппінг.
 */
export const KIND_PREFIX: Record<MetadataKind, string> = {
  Catalog: "cat_",
  Document: "doc_",
  Enumeration: "enum_",
  InformationRegister: "ir_",
  AccumulationRegister: "ar_",
  Constant: "const_",
  CustomTable: "ct_",
}

/**
 * Перетворює PascalCase або camelCase ім'я у snake_case.
 * Приклади: SalesOrder → sales_order, Products → products,
 *           CurrencyExchangeRates → currency_exchange_rates.
 */
export function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase()
}

/**
 * Будує фізичне SQL-ім'я об'єкта: {KIND_PREFIX[kind]}{snake_case(objectName)}.
 * Наприклад: physicalObjectName("Catalog", "Products") → "cat_products".
 */
export function physicalObjectName(kind: MetadataKind, objectName: string): string {
  return `${KIND_PREFIX[kind]}${toSnakeCase(objectName)}`
}

/**
 * Будує фізичне SQL-ім'я табличної частини: {physicalObjectName(kind, parentName)}_{sectionName}.
 * sectionName вже є snake_case — tabularSectionSchema.name валідується regex /^[a-z][a-z0-9_]*$/.
 * Наприклад: physicalTabularName("Catalog", "Products", "barcodes") → "cat_products_barcodes".
 */
export function physicalTabularName(
  kind: MetadataKind,
  parentName: string,
  sectionName: string,
): string {
  return `${physicalObjectName(kind, parentName)}_${sectionName}`
}
