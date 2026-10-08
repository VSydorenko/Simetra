import { expectsKindLabel, type MetadataKind } from "simetra/model"
import { metaFiles, uuid } from "../helpers"

/**
 * «Kitchen-sink»-проєкт ратчета «поле без споживача»: кожне поле кожної схеми
 * видів і проєкту задане хоча б в одному місці, вкладені включно, і обидві
 * гілки кожного об'єднання (корінь скоупу, ціль FK, ключ індексу). Взаємно
 * виключні поля типу значення (`length` / `precision` / `ref` /
 * `allowedTypes`) розкладено по різних елементах того самого масиву: шлях
 * ратчета не розрізняє елементи. Проєкт мусить компілюватися без помилок —
 * інакше моделі, а з нею й читачів, немає.
 */

const text = (name: string) => ({ uk: `${name} (uk)`, en: `${name} (en)` })

let next = 0
/** Детерміновані id: фікстура будується щоразу однаково. */
const id = () => uuid(9000 + ++next)

const SCHEMA = "$schema"
const schemaHint = (kind: string) => ({
  [SCHEMA]: `../../schemas/${kind}.schema.json`,
})

const ref = (kind: string, name: string) => ({ kind, name })

/**
 * Повний набір полів реквізиту: кожен тип з його параметрами — окремим
 * елементом, бо `length`, `precision` і цілі `Ref` взаємно виключні.
 */
function attributes(prefix: string) {
  const common = (name: string, physicalName: string) => ({
    id: id(),
    name,
    physicalName,
    title: text(name),
    description: text(name),
  })
  return [
    // Межі числа й формат рядка.
    {
      ...common(`${prefix}Rating`, `${prefix}_rating`),
      type: "Integer",
      positive: true,
      minValue: 1,
      maxValue: 5,
    },
    {
      ...common(`${prefix}Sku`, `${prefix}_sku`),
      type: "String",
      length: 12,
      pattern: "^[A-Z]{2,}\\d*$",
      minLength: 2,
      personalData: true,
    },
    {
      ...common(`${prefix}Note`, `${prefix}_note`),
      type: "String",
      length: 50,
      required: true,
      indexed: true,
      unique: true,
      defaultValue: "none",
    },
    {
      ...common(`${prefix}Amount`, `${prefix}_amount`),
      type: "Numeric",
      precision: 15,
      scale: 2,
      defaultValue: 0,
      nonNegative: true,
      maxValue: "1000000",
    },
    {
      ...common(`${prefix}Item`, `${prefix}_item_id`),
      type: "Ref",
      ref: ref("Catalog", "Item"),
    },
    {
      ...common(`${prefix}Owner`, `${prefix}_owner`),
      type: "Ref",
      allowedTypes: [ref("Catalog", "Item"), ref("Catalog", "Partner")],
    },
    {
      ...common(`${prefix}Org`, `${prefix}_org_id`),
      type: "Ref",
      ref: ref("Catalog", "Organization"),
      crossScope: true,
    },
    {
      ...common(`${prefix}Tags`, `${prefix}_tags`),
      type: "Boolean",
      array: true,
      defaultValue: { empty: true },
    },
    // Об'єктні форми типового значення: заповнення й порожнє.
    {
      ...common(`${prefix}Seen`, `${prefix}_seen`),
      type: "DateTime",
      defaultValue: { fill: "now" },
    },
    {
      ...common(`${prefix}Token`, `${prefix}_token`),
      type: "UUID",
      defaultValue: { fill: "newUuid" },
    },
    {
      ...common(`${prefix}Payload`, `${prefix}_payload`),
      type: "Json",
      defaultValue: { empty: "object" },
    },
    {
      ...common(`${prefix}Items`, `${prefix}_items`),
      type: "Json",
      defaultValue: { empty: "array" },
    },
    // Скалярне типове значення масиву схема відхиляє (спека §5).
    {
      ...common(`${prefix}Active`, `${prefix}_active`),
      type: "Boolean",
      defaultValue: false,
    },
  ]
}

/** Перевизначення стандартного реквізиту: ключ — ім'я стандартного реквізиту. */
const overrides = (name: string) => ({
  [name]: { title: text(name), description: text(name) },
})

function header(kind: string, name: string, physicalName: string) {
  return {
    ...schemaHint(kind),
    id: id(),
    kind,
    name,
    physicalName,
    // Мітка — у видів, що її мають без умов; прийнята таблиця з uuid-ключем
    // ставить її сама.
    ...(expectsKindLabel(kind as MetadataKind, {})
      ? { kindLabel: physicalName }
      : {}),
    schema: "public",
    scope: "org",
    title: text(name),
    description: text(name),
  }
}

export function kitchenSink(): Map<string, string> {
  next = 0
  const project = {
    ...schemaHint("project"),
    name: "KitchenSink",
    title: text("KitchenSink"),
    defaultLocale: "en",
    defaultSchema: "public",
    database: { provider: "supabase" },
    naming: { attributeCase: "camelCase" },
    timezone: "Europe/Kyiv",
    scopeKinds: [
      {
        id: id(),
        name: "org",
        physicalName: "org_id",
        title: text("org"),
        root: { object: ref("Catalog", "Organization") },
        setFunction: { schema: "public", name: "org_ids" },
        onRootDelete: "cascade",
      },
      {
        id: id(),
        name: "user",
        physicalName: "user_id",
        title: text("user"),
        root: { external: { schema: "auth", table: "users", column: "id" } },
        setFunction: { schema: "public", name: "user_ids" },
        onRootDelete: "restrict",
      },
    ],
    storageBuckets: [{ bucket: "attachments", scopeKind: "org" }],
  }

  const organization = {
    ...header("Catalog", "Organization", "organization"),
  }
  const partner = { ...header("Catalog", "Partner", "partner") }

  const item = {
    ...header("Catalog", "Item", "item"),
    publicRead: "anon",
    codeLength: 12,
    codeType: "Number",
    descriptionLength: 200,
    hierarchyType: "FoldersAndItems",
    owners: [ref("Catalog", "Partner")],
    autonumber: false,
    codeUnique: false,
    mainPresentation: "Code",
    predefinedItems: [
      {
        id: id(),
        name: "Service",
        physicalName: "service",
        description: text("service"),
      },
    ],
    standardAttributeOverrides: overrides("code"),
    attributes: [
      ...attributes("item"),
      // Унікальність без регістру й у межах батька чи власника.
      {
        id: id(),
        name: "itemSlug",
        physicalName: "item_slug",
        title: text("itemSlug"),
        description: text("itemSlug"),
        type: "String",
        length: 40,
        unique: "ignoreCase",
        uniqueWithin: "parent",
      },
      {
        id: id(),
        name: "itemSerial",
        physicalName: "item_serial",
        title: text("itemSerial"),
        description: text("itemSerial"),
        type: "String",
        length: 40,
        unique: true,
        uniqueWithin: "owner",
      },
    ],
    // Складені індекси довідника й його секції.
    indexes: [
      { attributes: ["itemSku", { name: "itemRating", order: "desc" }] },
    ],
    tabularSections: [
      {
        id: id(),
        name: "barcodes",
        physicalName: "item_barcodes",
        title: text("barcodes"),
        standardAttributeOverrides: overrides("lineNumber"),
        attributes: attributes("barcode"),
        indexes: [
          { attributes: ["barcodeSku", { name: "lineNumber", order: "desc" }] },
        ],
      },
    ],
  }

  const sale = {
    ...header("Document", "Sale", "sale"),
    publicRead: "authenticated",
    numberLength: 9,
    numberType: "Number",
    autonumber: false,
    numberPeriodicity: "Month",
    posting: {
      movements: [
        {
          register: ref("AccumulationRegister", "Stock"),
          source: { tabularSection: "goods" },
          condition: "row.qty > 0",
          movementType: "Expense",
          period: "doc.date",
          fields: {
            item: "row.item",
            qty: "row.qty",
            placeNote: "doc.saleNote",
            stockNote: "doc.saleNote",
          },
        },
        {
          register: ref("InformationRegister", "Prices"),
          source: "document",
          fields: {
            item: "doc.saleItem",
            price: "doc.saleAmount",
            dimNote: "doc.saleNote",
            resNote: "doc.saleNote",
            infoNote: "doc.saleNote",
          },
        },
      ],
    },
    registerMovements: [
      ref("AccumulationRegister", "Stock"),
      ref("InformationRegister", "Prices"),
    ],
    standardAttributeOverrides: overrides("number"),
    attributes: attributes("sale"),
    indexes: [{ attributes: ["saleSku", { name: "date", order: "desc" }] }],
    tabularSections: [
      {
        id: id(),
        name: "goods",
        physicalName: "sale_goods",
        title: text("goods"),
        standardAttributeOverrides: overrides("lineNumber"),
        attributes: [
          {
            id: id(),
            name: "item",
            physicalName: "item_id",
            type: "Ref",
            ref: ref("Catalog", "Item"),
          },
          {
            id: id(),
            name: "qty",
            physicalName: "qty",
            type: "Numeric",
            precision: 15,
            scale: 3,
          },
          ...attributes("goods"),
        ],
        indexes: [{ attributes: ["item", { name: "qty", order: "desc" }] }],
      },
    ],
  }

  const color = {
    ...header("Enumeration", "Color", "color"),
    scope: "none",
    values: [
      { id: id(), name: "Red", physicalName: "red", title: text("Red") },
      { id: id(), name: "Blue", physicalName: "blue", title: text("Blue") },
    ],
  }

  const prices = {
    ...header("InformationRegister", "Prices", "prices"),
    publicRead: "anon",
    periodicity: "Month",
    writeMode: "RecorderSubordinate",
    recorderTypes: [ref("Document", "Sale")],
    standardAttributeOverrides: overrides("period"),
    dimensions: [
      {
        id: id(),
        name: "item",
        physicalName: "item_id",
        type: "Ref",
        ref: ref("Catalog", "Item"),
      },
      ...attributes("dim"),
    ],
    resources: [
      {
        id: id(),
        name: "price",
        physicalName: "price",
        type: "Numeric",
        precision: 15,
        scale: 2,
      },
      ...attributes("res"),
    ],
    attributes: attributes("info"),
  }

  const stock = {
    ...header("AccumulationRegister", "Stock", "stock"),
    publicRead: "authenticated",
    registerType: "Balance",
    recorderTypes: [ref("Document", "Sale")],
    balanceControl: { resources: ["qty"] },
    standardAttributeOverrides: overrides("period"),
    dimensions: [
      {
        id: id(),
        name: "item",
        physicalName: "item_id",
        type: "Ref",
        ref: ref("Catalog", "Item"),
      },
      ...attributes("place"),
    ],
    resources: [
      {
        id: id(),
        name: "qty",
        physicalName: "qty",
        title: text("qty"),
        description: text("qty"),
        type: "Numeric",
        precision: 15,
        scale: 3,
      },
    ],
    attributes: attributes("stock"),
  }

  const constant = (
    name: string,
    physicalName: string,
    value: Record<string, unknown>
  ) => ({ ...header("Constant", name, physicalName), ...value })

  const constants: Record<string, Record<string, unknown>> = {
    MainCurrency: constant("MainCurrency", "main_currency", {
      type: "String",
      length: 3,
      defaultValue: "UAH",
      publicRead: "anon",
    }),
    VatRate: constant("VatRate", "vat_rate", {
      type: "Numeric",
      precision: 5,
      scale: 2,
      defaultValue: 20,
    }),
    Today: constant("Today", "today", {
      type: "Date",
      defaultValue: { fill: "today" },
    }),
    EmptyList: constant("EmptyList", "empty_list", {
      type: "Json",
      defaultValue: { empty: "array" },
    }),
    EmptyTags: constant("EmptyTags", "empty_tags", {
      type: "String",
      length: 10,
      array: true,
      defaultValue: { empty: true },
    }),
    MainItem: constant("MainItem", "main_item", {
      type: "Ref",
      ref: ref("Catalog", "Item"),
      crossScope: true,
    }),
    Favorites: constant("Favorites", "favorites", {
      type: "Ref",
      allowedTypes: [ref("Catalog", "Item"), ref("Catalog", "Partner")],
      array: true,
    }),
  }

  const mood = {
    ...header("PgEnum", "Mood", "mood"),
    // У енам-типу поля `scope` немає: JSON.stringify відкидає undefined.
    scope: undefined,
    values: ["happy", "sad"],
  }

  const ledger = {
    ...header("CustomTable", "Ledger", "ledger"),
    comment: "Ledger",
    columns: [
      {
        id: id(),
        name: "id",
        physicalName: "id",
        title: text("id"),
        notNull: true,
        identity: "always",
        comment: "key",
        type: "BigInt",
      },
      {
        id: id(),
        name: "orgId",
        physicalName: "org_id",
        notNull: true,
        type: "UUID",
      },
      {
        id: id(),
        name: "note",
        physicalName: "note",
        type: "String",
        length: 40,
        default: "'n/a'",
        // Колляція поза `pg_catalog` — зі схемою: так фікстура торкається обох
        // частин імені каталогу.
        collation: { schema: "public", name: "case_insensitive" },
      },
      {
        id: id(),
        name: "amount",
        physicalName: "amount",
        type: "Numeric",
        precision: 12,
        scale: 2,
        generated: { expression: "0" },
      },
      {
        id: id(),
        name: "item",
        physicalName: "item_id",
        type: "Ref",
        ref: ref("Catalog", "Item"),
      },
      {
        id: id(),
        name: "owner",
        physicalName: "owner",
        type: "Ref",
        allowedTypes: [ref("Catalog", "Item"), ref("Catalog", "Partner")],
      },
      {
        id: id(),
        name: "flags",
        physicalName: "flags",
        type: "Boolean",
        array: true,
      },
      {
        id: id(),
        name: "mood",
        physicalName: "mood",
        type: "PgEnum",
        enum: { kind: "PgEnum", name: "Mood" },
      },
      {
        id: id(),
        name: "range",
        physicalName: "range",
        type: "Raw",
        pgType: "int4range",
      },
      {
        id: id(),
        name: "userId",
        physicalName: "user_id",
        type: "UUID",
      },
    ],
    primaryKey: { name: "ledger_pk", columns: ["id"], deferrable: "no" },
    uniques: [
      {
        name: "ledger_note_key",
        columns: ["note"],
        nullsNotDistinct: true,
        deferrable: "initiallyDeferred",
      },
    ],
    checks: [{ name: "ledger_amount_check", expression: "amount >= 0" }],
    foreignKeys: [
      {
        name: "ledger_org_fk",
        columns: ["orgId"],
        references: {
          object: ref("Catalog", "Organization"),
          columns: ["ref"],
        },
        onDelete: "cascade",
        onUpdate: "restrict",
        deferrable: "initiallyDeferred",
      },
      {
        name: "ledger_user_fk",
        columns: ["userId"],
        references: {
          external: { schema: "auth", table: "users", columns: ["id"] },
        },
        onDelete: "setNull",
        onUpdate: "noAction",
        deferrable: "deferrable",
      },
    ],
    indexes: [
      {
        name: "ledger_note_idx",
        unique: true,
        method: "btree",
        keys: [
          {
            column: "note",
            order: "desc",
            nulls: "last",
            opclass: { schema: "public", name: "note_ops" },
            collation: { schema: "public", name: "case_insensitive" },
          },
          { expression: "lower(note)", order: "asc", nulls: "first" },
        ],
        include: ["amount"],
        where: "amount > 0",
        nullsNotDistinct: true,
      },
    ],
    scopeColumn: "orgId",
    rowLevelSecurity: "forced",
  }

  // Оголошено після решти, щоб лічильник id не зсунув id наявних елементів.
  // Константа-перерахування з типовим значенням — роль
  // `constant.enumDefault`.
  constants.MainColor = constant("MainColor", "main_color", {
    type: "Ref",
    ref: ref("Enumeration", "Color"),
    defaultValue: "Red",
  })

  // FK на власну колонку іншої прийнятої таблиці — роль
  // `customTable.foreignKeyTarget` на елемент, який можна перейменувати.
  const ledgerTag = {
    ...header("CustomTable", "LedgerTag", "ledger_tag"),
    columns: [
      {
        id: id(),
        name: "tag",
        physicalName: "tag",
        notNull: true,
        type: "Text",
      },
      {
        id: id(),
        name: "ledgerId",
        physicalName: "ledger_id",
        type: "BigInt",
      },
    ],
    primaryKey: { name: "ledger_tag_pk", columns: ["tag"] },
    foreignKeys: [
      {
        name: "ledger_tag_ledger_fk",
        columns: ["ledgerId"],
        references: {
          object: ref("CustomTable", "Ledger"),
          // Ціль — недеферований PK: деферований ключ FK не приймає.
          columns: ["id"],
        },
      },
    ],
    scope: "none",
  }

  // Прийнята таблиця з єдиним uuid-ключем — єдина, де мітка виду дозволена.
  const note = {
    ...header("CustomTable", "Note", "note"),
    kindLabel: "memo_note",
    columns: [
      {
        id: id(),
        name: "id",
        physicalName: "id",
        notNull: true,
        type: "UUID",
      },
    ],
    primaryKey: { name: "note_pk", columns: ["id"] },
    scope: "none",
  }

  // Підписки без PG-схеми й скоупу: тригер живе на таблиці джерела.
  const subscriptionHeader = (name: string, physicalName: string) => {
    const result: Partial<ReturnType<typeof header>> = header(
      "EventSubscription",
      name,
      physicalName
    )
    delete result.schema
    delete result.scope
    return result
  }
  const stampItem = {
    ...subscriptionHeader("StampItem", "stamp_item"),
    sources: [ref("Catalog", "Item")],
    event: "beforeWrite",
    whenChanged: ["itemSku", "code"],
    handler: { schema: "public", name: "stamp_item" },
  }
  const userDeleted = {
    ...subscriptionHeader("UserDeleted", "user_deleted"),
    sources: [{ providerTable: "auth.users" }],
    event: "onDelete",
    handler: { name: "on_user_deleted" },
  }
  const handlers = ["stamp_item", "on_user_deleted"]
    .map(
      (name) =>
        `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$;`
    )
    .join("\n")

  // Системний довідник «Користувачі»: існує поза тенантами. Оголошено
  // останнім, щоб лічильник id не зсунув id решти фікстури.
  const users = {
    ...header("Catalog", "Users", "users"),
    scope: "none",
    role: "users",
  }

  const entries: Record<string, unknown> = {
    "project.meta.json": project,
    "catalogs/Organization/Organization.meta.json": organization,
    "catalogs/Partner/Partner.meta.json": partner,
    "catalogs/Item/Item.meta.json": item,
    "catalogs/Users/Users.meta.json": users,
    "documents/Sale/Sale.meta.json": sale,
    "enumerations/Color/Color.meta.json": color,
    "information-registers/Prices/Prices.meta.json": prices,
    "accumulation-registers/Stock/Stock.meta.json": stock,
    "pg-enums/Mood/Mood.meta.json": mood,
    "custom-tables/Ledger/Ledger.meta.json": ledger,
    "custom-tables/LedgerTag/LedgerTag.meta.json": ledgerTag,
    "custom-tables/Note/Note.meta.json": note,
    "event-subscriptions/StampItem/StampItem.meta.json": stampItem,
    "event-subscriptions/UserDeleted/UserDeleted.meta.json": userDeleted,
    "sql/public/subscription-handlers.sql": handlers,
  }
  for (const [name, value] of Object.entries(constants)) {
    entries[`constants/${name}/${name}.meta.json`] = value
  }
  return metaFiles(entries)
}
