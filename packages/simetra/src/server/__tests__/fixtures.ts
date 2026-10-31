import {
  runtimeCatalogSchema,
  runtimeObjectSchema,
  type RuntimeAttribute,
  type RuntimeCatalog,
  type RuntimeObject,
} from "simetra/model"

/**
 * Значення всіх логічних типів: у довідниках фікстури A2 немає `Json`,
 * `Bytes`, `Numeric`, дат і перерахувань, тож об'єкт каталогу будується тут
 * (він — вхід T3, а не метадані). Форма звіряється схемою T0.
 */
const attr = (
  name: string,
  type: RuntimeAttribute["type"],
  extra: Partial<RuntimeAttribute> = {}
): RuntimeAttribute => ({
  name,
  column: `${name}_col`,
  pgType: "text",
  castType: "text",
  type,
  required: false,
  insert: true,
  update: true,
  ...extra,
})

export const ID = "11111111-1111-4111-8111-111111111111"
export const OTHER = "22222222-2222-4222-8222-222222222222"
const STATUS = attr("status", "Ref", {
  enumValues: [
    { name: "Open", label: "open" },
    { name: "Closed", label: "closed" },
  ],
})
export const SUBJECT = attr("subject", "Ref", {
  pgType: "uuid",
  castType: "uuid",
  pair: {
    typeColumn: "subject_type",
    targets: [
      { object: { kind: "Catalog", name: "Project" }, label: "project" },
      { object: { kind: "Catalog", name: "Region" }, label: "region" },
    ],
  },
})

export const sample: RuntimeObject = runtimeObjectSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Sample",
  kind: "Catalog",
  kindLabel: "sample",
  table: { schema: "public", name: "sample" },
  key: "id",
  keyName: "ref",
  versionColumn: "version",
  versionName: "version",
  attributes: [
    attr("code", "String", { maxLength: 3 }),
    attr("note", "Text"),
    attr("owner", "UUID"),
    attr("count", "Integer"),
    attr("small", "SmallInt"),
    attr("big", "BigInt", { pgType: "bigint" }),
    attr("amount", "Numeric", {
      pgType: "numeric(30,10)",
      precision: 30,
      scale: 10,
    }),
    attr("flag", "Boolean"),
    attr("day", "Date"),
    attr("at", "DateTime"),
    attr("blob", "Bytes"),
    attr("payload", "Json"),
    attr("tags", "Integer", { array: true }),
    attr("bigs", "BigInt", { array: true, pgType: "bigint[]" }),
    STATUS,
    attr("statuses", "Ref", { array: true, enumValues: STATUS.enumValues }),
    SUBJECT,
    attr("link", "Ref"),
    attr("mood", "PgEnum"),
    attr("frozen", "String", { insert: true, update: false }),
    attr("computed", "Integer", { insert: false, update: false }),
    attr("copy_id", "Raw", { insert: false, update: false }),
  ],
  tabularSections: [
    {
      name: "lines",
      table: { schema: "public", name: "sample_lines" },
      key: "id",
      keyName: "ref",
      parent: "parent_id",
      lineNumber: "line_number",
      attributes: [
        attr("qty", "Integer"),
        attr("firstOnly", "Text", { insert: true, update: false }),
        attr("extra", "Json"),
        attr("copy_id", "Raw", { insert: false, update: false }),
      ],
      constraints: [],
    },
  ],
  operations: {},
  constraints: [],
})

export const attributeOf = (name: string): RuntimeAttribute =>
  sample.attributes.find((a) => a.name === name)!

const target = (table: string, fn: string, context: string) => ({
  function: { schema: "public", name: `${table}_${fn}` },
  context,
})

/**
 * Об'єкт каталогу з командами: скоуплений довідник із ключем `ref` і
 * реквізитами `code`, `company` (колонка скоупу). Перевизначення — лише те,
 * про що кейс.
 */
export function commandObject(
  overrides: Omit<Partial<RuntimeObject>, "table"> & {
    name: string
    table: string
  }
): RuntimeObject {
  const { table, ...rest } = overrides
  return runtimeObjectSchema.parse({
    id: "00000000-0000-4000-8000-000000000002",
    kind: "Catalog",
    kindLabel: table,
    key: "id",
    keyName: "ref",
    versionColumn: "version",
    versionName: "version",
    scopeKindId: "00000000-0000-4000-8000-0000000000aa",
    scopeColumn: "company_id",
    attributes: [
      attr("code", "String", { column: "code", maxLength: 10 }),
      attr("company", "Ref", {
        column: "company_id",
        pgType: "uuid",
        castType: "uuid",
        update: false,
      }),
      attr("extra", "Json", { column: "extra" }),
    ],
    tabularSections: [],
    operations: {
      create: target(table, "save", "create"),
      update: target(table, "save", "update"),
      markDeletion: target(table, "mark_deletion", "markDeletion"),
      delete: target(table, "delete", "delete"),
    },
    constraints: [],
    ...rest,
    table: { schema: "public", name: table },
  })
}

export const COMPANY = "33333333-3333-4333-8333-333333333333"
export const client = commandObject({ name: "Client", table: "client" })

/** Системний довідник прав: дія контексту — `administerRights` на кожній операції. */
export const rightsRole = commandObject({
  name: "RightsRole",
  table: "rights_role",
  scopeKindId: undefined,
  scopeColumn: undefined,
  attributes: [attr("code", "String", { column: "code" })],
  operations: {
    create: target("rights_role", "save", "administerRights"),
    update: target("rights_role", "save", "administerRights"),
    markDeletion: target("rights_role", "mark_deletion", "administerRights"),
  },
})

export const catalog: RuntimeCatalog = runtimeCatalogSchema.parse({
  format: 1,
  snapshotHash: "hash-1",
  provider: "supabase",
  objects: [client, rightsRole],
})
