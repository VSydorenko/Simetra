import {
  runtimeObjectSchema,
  type RuntimeAttribute,
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
