import { administerRightsAction, readAction, recordActions } from "./actions"
import { catalogSchema, type Catalog } from "../schemas/catalog"
import {
  authorColumns,
  deletionMarkColumn,
  keyColumn,
  keyOrderOf,
  numberingType,
  objectFieldReferences,
  standardRefReferences,
  serviceDateColumns,
  tabularRowColumns,
  versionColumn,
  type KindDefinition,
  type NumberingSpec,
  type RightsSystemCatalog,
  type StandardColumnDef,
  type StandardTabularSectionDef,
  customActionReferences,
  accessDimensionReferences,
  accessReferences,
  bindingReferences,
  ownershipReferences,
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
      // Унікальність коду дає NumberingSpec, тож власного `unique` немає.
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
  // Колонки ролі беремо з її опису, а не з перевірки імені ролі: опис ролі —
  // єдине місце фактів ролі (див. CATALOG_ROLES).
  if (catalog.role !== undefined) {
    columns.push(...(CATALOG_ROLES[catalog.role].columns?.(catalog) ?? []))
  }

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
    predefinedNameColumn(),
    versionColumn(),
    ...serviceDateColumns(),
    ...(catalog.trackAuthor ? authorColumns() : [])
  )
  return columns
}

/**
 * Ім'я предвизначеного елемента: його пише платформа з `predefinedItems`, а
 * не команда, тож грант ролі команд його оминає (спека П4 §6.2).
 */
export function predefinedNameColumn(): StandardColumnDef {
  return {
    logicalName: "predefinedName",
    physicalName: "predefined_name",
    type: { type: "Text" },
    notNull: false,
    // Фізична мітка предвизначеного елемента (`predefinedItems[].physicalName`)
    // унікальна в межах скоупу, а звичайні елементи її не мають.
    partialUnique: "predefined_name IS NOT NULL",
    title: { uk: "Ім'я наперед визначеного елемента", en: "Predefined name" },
  }
}

/**
 * Платформні реквізити «Користувачів» (спека користувачів §4): провізія
 * вставляє рядок лише з ключем і найменуванням, тож обидва мають DEFAULT.
 * Недійсність не видаляє рядок — на нього можуть посилатися дані застосунку.
 */
export function userPlatformColumns(): StandardColumnDef[] {
  return [
    {
      logicalName: "userKind",
      physicalName: "user_kind",
      type: { type: "Text" },
      notNull: true,
      default: "'human'",
      check: "user_kind IN ('human', 'agent')",
      title: { uk: "Вид користувача", en: "User kind" },
    },
    {
      logicalName: "invalid",
      physicalName: "invalid",
      type: { type: "Boolean" },
      notNull: true,
      default: "false",
      title: { uk: "Недійсний", en: "Invalid" },
    },
  ]
}

/**
 * «Ролі» рівня (спека прав §4.6): базовий архетип — UUID ролі
 * метаданих без FK (ролі метаданих таблиць не мають), назва — стандартне
 * найменування, порядок — для показу.
 */
function rightsRolesColumns(): StandardColumnDef[] {
  return [
    {
      logicalName: "archetype",
      physicalName: "archetype",
      type: { type: "UUID" },
      notNull: true,
      title: { uk: "Архетип", en: "Archetype" },
    },
    {
      logicalName: "order",
      physicalName: "order",
      type: { type: "Integer" },
      notNull: false,
      title: { uk: "Порядок", en: "Order" },
    },
  ]
}

/**
 * Дельта кастомної ролі відносно архетипу: мітка виду об'єкта, ключ дії
 * (слово словника чи UUID кастомної дії, Рх18), обсяг і ефект. Значення —
 * дані цілі, тож невідоме значення функції прав ігнорують (fail-closed), а
 * CHECK тримає лише форму, яку видно без метаданих.
 */
function deltaColumns(): StandardColumnDef[] {
  return [
    {
      logicalName: "object",
      physicalName: "object",
      type: { type: "Text" },
      notNull: true,
      title: { uk: "Об'єкт", en: "Object" },
    },
    {
      logicalName: "action",
      physicalName: "action",
      type: { type: "Text" },
      notNull: true,
      title: { uk: "Дія", en: "Action" },
    },
    {
      logicalName: "extent",
      physicalName: "extent",
      type: { type: "Text" },
      notNull: true,
      check: "extent IN ('any', 'own', 'dimension')",
      title: { uk: "Обсяг", en: "Extent" },
    },
    {
      logicalName: "dimension",
      physicalName: "dimension",
      type: { type: "UUID" },
      notNull: false,
      // Вимір має лише обсяг `dimension`: інакше рядок означав би два різні
      // обсяги залежно від того, яку колонку читає функція.
      check: "(extent = 'dimension') = (dimension IS NOT NULL)",
      title: { uk: "Вимір доступу", en: "Access dimension" },
    },
    {
      logicalName: "effect",
      physicalName: "effect",
      type: { type: "Text" },
      notNull: true,
      check: "effect IN ('allow', 'deny')",
      title: { uk: "Ефект", en: "Effect" },
    },
  ]
}

/**
 * Логічне ім'я стандартної ТЧ дельти «Ролей» (спека прав §4.6): за ним компілятор
 * знаходить її таблицю для контракту довідників прав.
 */
export const RIGHTS_DELTA_SECTION = "delta"

const DELTA_SECTION: StandardTabularSectionDef = {
  logicalName: RIGHTS_DELTA_SECTION,
  physicalSuffix: "delta",
  columns: deltaColumns,
  title: { uk: "Дельта", en: "Delta" },
}

/**
 * «Призначення ролей» рівня (спека прав §4.6): суб'єкт — учасник рівня скоупу (у
 * глобальному довіднику — користувач), роль — архетип або кастомна роль того
 * самого рівня, рівно одне з двох. Контейнер без FK: цілі — різні
 * довідники-контейнери, а належність тенанту перевіряють функції прав.
 */
function roleAssignmentsColumns(catalog: Catalog): StandardColumnDef[] {
  const scoped = catalog.scope !== undefined && catalog.scope !== "none"
  return [
    {
      logicalName: "subject",
      physicalName: "subject",
      type: { type: "UUID" },
      notNull: true,
      ref: "member",
      indexed: true,
      title: scoped
        ? { uk: "Учасник", en: "Member" }
        : { uk: "Користувач", en: "User" },
    },
    {
      logicalName: "archetype",
      physicalName: "archetype",
      type: { type: "UUID" },
      notNull: false,
      title: { uk: "Архетип", en: "Archetype" },
    },
    {
      logicalName: "customRole",
      physicalName: "custom_role",
      type: { type: "UUID" },
      notNull: false,
      ref: "rightsRoles",
      check: "num_nonnulls(archetype, custom_role) = 1",
      title: { uk: "Кастомна роль", en: "Custom role" },
    },
    {
      logicalName: "container",
      physicalName: "container",
      type: { type: "UUID" },
      notNull: false,
      indexed: true,
      title: { uk: "Контейнер", en: "Container" },
    },
  ]
}

/**
 * Визначення стандартних колонок довідників прав за логічним ім'ям: функції
 * прав шукають за ними колонки в стилі проєкту, а не літералом
 * імені. Заголовок «Суб'єкта» залежить від скоупу, але пошук читає лише
 * логічне ім'я.
 */
export const RIGHTS_COLUMNS = Object.fromEntries(
  [
    ...rightsRolesColumns(),
    ...deltaColumns(),
    ...roleAssignmentsColumns({ scope: "none" } as Catalog),
  ].map((def) => [def.logicalName, def])
) as Readonly<
  Record<
    | "archetype"
    | "order"
    | "object"
    | "action"
    | "extent"
    | "dimension"
    | "effect"
    | "subject"
    | "customRole"
    | "container",
    StandardColumnDef
  >
>

/** Факти системної ролі довідника: що платформа виводить із ролі. */
interface CatalogRoleDefinition {
  /**
   * Глобальний корінь (спека П2 §6): довідник лишається `scope: "none"`, але
   * може бути коренем виду скоупу, а посилання на нього з будь-якого виду —
   * простий FK, не перетин видів. «Користувачі» глобальні за природою: один
   * обліковий запис належить багатьом тенантам.
   */
  globalRoot?: true
  /**
   * Стандартні колонки, які роль додає одразу після позначки видалення:
   * порядок колонок входить у фізичну форму таблиці.
   */
  columns?: (catalog: Catalog) => StandardColumnDef[]
  /** Стандартна ТЧ, яку роль додає довіднику. */
  tabularSection?: StandardTabularSectionDef
  /**
   * Системні довідники прав мають лише читання й окрему дію запису
   * (спека прав §4.6): природні дії запису відкрили б родину «решта».
   */
  actions?: "read" | "rights"
  /** Роль системного довідника прав. */
  rightsSystem?: RightsSystemCatalog
}

/** Ролі довідника — одне місце, звідки компілятор бере їхні факти. */
const CATALOG_ROLES: Record<
  NonNullable<Catalog["role"]>,
  CatalogRoleDefinition
> = {
  users: { globalRoot: true, columns: userPlatformColumns },
  rightsRoles: {
    columns: rightsRolesColumns,
    tabularSection: DELTA_SECTION,
    actions: "rights",
    rightsSystem: "rightsRoles",
  },
  roleAssignments: {
    columns: roleAssignmentsColumns,
    actions: "rights",
    rightsSystem: "roleAssignments",
  },
}

/** Опис ролі довідника; без ролі — порожній. */
function roleOf(obj: unknown): CatalogRoleDefinition {
  const { role } = obj as Catalog
  return role === undefined ? {} : CATALOG_ROLES[role]
}

function numbering(obj: unknown): NumberingSpec | undefined {
  const catalog = obj as Catalog
  if (catalog.codeLength === 0) return undefined
  return {
    column: "code",
    type: catalog.codeType,
    length: catalog.codeLength,
    autonumber: catalog.autonumber,
    periodicity: "None",
    unique: catalog.codeUnique,
  }
}

export const catalogKind: KindDefinition = {
  kind: "Catalog",
  dir: "catalogs",
  schema: catalogSchema,
  keyOrder: keyOrderOf(catalogSchema),
  referenceable: true,
  compositeIndexes: true,
  writePattern: "optimistic",
  actions(obj) {
    const actions = roleOf(obj).actions
    if (actions === "read") return [readAction]
    if (actions === "rights") return [readAction, administerRightsAction]
    return recordActions(catalogKind.tabularSectionColumns !== undefined)
  },
  rightsExtents: ["any", "own", "dimension"],
  rightsContainer: true,
  rightsBinding: true,
  accessDimensionTarget: true,
  commandWrites: true,
  sqlModule: "closed",
  materializes: "table",
  rowLevelSecurity: "enabled",
  authorTracking: true,
  scope: "required",
  declared: false,
  kindLabel: true,
  columnFields: ["attributes"],
  idElementFields: ["customActions"],
  valueElements: false,
  namedElementFields: ["predefinedItems"],
  ownerKinds: ["Catalog"],
  standardColumns,
  globalRoot: (obj) => roleOf(obj).globalRoot === true,
  standardTabularSections(obj) {
    const section = roleOf(obj).tabularSection
    return section === undefined ? [] : [section]
  },
  rightsSystem: (obj) => roleOf(obj).rightsSystem,
  numbering,
  tabularSectionColumns: () => tabularRowColumns(false),
  elementReferences: (obj) => [
    ...customActionReferences(obj as Catalog),
    ...ownershipReferences(obj as Catalog, standardColumns(obj)),
    ...bindingReferences(obj as Catalog, standardColumns(obj)),
    ...accessReferences(obj as Catalog, standardColumns(obj)),
  ],
  projectReferences: (obj) => accessDimensionReferences(obj as Catalog),
  references(obj) {
    const catalog = obj as Catalog
    return [
      ...objectFieldReferences(catalog),
      ...standardRefReferences(
        standardColumns(catalog),
        "owners",
        catalog.owners,
        "/owners",
        "catalog.owner"
      ),
    ]
  },
}
