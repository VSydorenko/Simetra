import { describe, expect, it } from "vitest"
import { runtimeObjectSchema, type RuntimeAttribute } from "../catalog"
import { encodeAttributes, type EncodeAttributesOptions } from "../values"

// Об'єкт каталогу збирається вручну: T0 не імпортує фікстури вищих ярусів.
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

const OTHER = "22222222-2222-4222-8222-222222222222"

const { attributes } = runtimeObjectSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Member",
  kind: "Catalog",
  kindLabel: "member",
  table: { schema: "public", name: "member" },
  key: "id",
  keyName: "ref",
  versionColumn: "version",
  versionName: "version",
  attributes: [
    attr("user", "UUID", { pgType: "uuid", castType: "uuid" }),
    attr("code", "String", { maxLength: 3 }),
    attr("amount", "Numeric", {
      pgType: "numeric(10,2)",
      precision: 10,
      scale: 2,
    }),
    attr("subject", "Ref", {
      pgType: "uuid",
      castType: "uuid",
      pair: {
        typeColumn: "subject_type",
        targets: [
          { object: { kind: "Catalog", name: "Project" }, label: "project" },
        ],
      },
    }),
    attr("tags", "Integer", { array: true }),
    attr("frozen", "String", { update: false }),
    attr("computed", "Integer", { insert: false, update: false }),
  ],
  tabularSections: [],
  operations: {},
  constraints: [],
})

/**
 * Три споживачі одного обходу (Р-A6-13): шапка `values` (грант вставки чи
 * оновлення), рядок ТЧ (ключ рядка пише викликач, шляхи з префіксом) і
 * `creatorMember` (примушені ключі, префікс): шляхи й порядок помилок у
 * всіх трьох однакові.
 */
const HEADER: EncodeAttributesOptions = {
  allowed: (a) => a.update,
  path: "values",
  prefix: "",
}
const ROW: EncodeAttributesOptions = {
  allowed: (a) => a.insert,
  path: "lines.0",
  prefix: "lines.0.",
  rowKey: "ref",
}
const MEMBER: EncodeAttributesOptions = {
  allowed: (a) => a.insert,
  forced: ["user"],
  path: "creatorMember",
  prefix: "creatorMember.",
}

const revoked = () => {
  const proxy = Proxy.revocable({}, {})
  proxy.revoke()
  return proxy.proxy
}
const throwing = (key: string) =>
  Object.defineProperty({}, key, {
    enumerable: true,
    get() {
      throw new Error("getter")
    },
  })

describe("encodeAttributes", () => {
  it.each<[string, EncodeAttributesOptions, unknown, string]>([
    ["member: a forced key", MEMBER, { user: OTHER }, "creatorMember.user"],
    [
      "member: a key outside insert",
      MEMBER,
      { computed: 1 },
      "creatorMember.computed",
    ],
    ["member: an unknown key", MEMBER, { nope: 1 }, "creatorMember.nope"],
    ["member: the table key", MEMBER, { ref: OTHER }, "creatorMember.ref"],
    [
      "member: an undefined value",
      MEMBER,
      { code: undefined },
      "creatorMember.code",
    ],
    [
      "member: an invalid value",
      MEMBER,
      { code: "abcd" },
      "creatorMember.code",
    ],
    ["member: null", MEMBER, null, "creatorMember"],
    ["member: not an object", MEMBER, [], "creatorMember"],
    ["member: a revoked Proxy", MEMBER, revoked(), "creatorMember"],
    ["member: a value getter", MEMBER, throwing("code"), "creatorMember.code"],
    // Р-A3-8: реквізити за порядком каталогу, невідомі ключі — після них.
    [
      "member: an unknown key before an invalid value",
      MEMBER,
      { nope: 1, code: "abcd" },
      "creatorMember.code",
    ],
    [
      "member: two invalid values",
      MEMBER,
      { amount: 1.5, code: "abcd" },
      "creatorMember.code",
    ],
    ["header: a key outside update", HEADER, { frozen: "x" }, "frozen"],
    ["header: the table key", HEADER, { ref: OTHER }, "ref"],
    ["header: not an object", HEADER, [], "values"],
    ["header: an array element", HEADER, { tags: [1, 2.5] }, "tags.1"],
    [
      "header: outside the grant after a value",
      HEADER,
      { frozen: "x", code: "abcd" },
      "code",
    ],
    [
      "header: unknown keys in input order",
      HEADER,
      { nope: 1, zzz: 2 },
      "nope",
    ],
    [
      "row: a key outside insert",
      ROW,
      { ref: OTHER, computed: 1 },
      "lines.0.computed",
    ],
    ["row: an unknown key", ROW, { ref: OTHER, nope: 1 }, "lines.0.nope"],
    ["row: an invalid value", ROW, { ref: OTHER, code: 1 }, "lines.0.code"],
    ["row: not an object", ROW, null, "lines.0"],
    ["row: a value getter", ROW, throwing("code"), "lines.0.code"],
  ])("rejects %s", (_, options, values, path) => {
    expect(encodeAttributes(attributes, values, options)).toEqual({
      error: { code: "command.invalid", path },
    })
  })

  it.each<[string, EncodeAttributesOptions, unknown, Record<string, unknown>]>([
    [
      "member: values and pairs by physical column",
      MEMBER,
      {
        code: "abc",
        amount: "12.50",
        subject: { type: "Catalog.Project", id: OTHER },
      },
      {
        code_col: "abc",
        amount_col: "12.50",
        subject_type: "project",
        subject_col: OTHER,
      },
    ],
    ["member: null", MEMBER, { code: null }, { code_col: null }],
    ["member: empty", MEMBER, {}, {}],
    // Примушений ключ відхиляється лише тоді, коли він є у вході.
    [
      "header: the same attribute without forced keys",
      HEADER,
      { user: OTHER, tags: [1, null] },
      { user_col: OTHER, tags_col: [1, null] },
    ],
    [
      "row: the row key stays out of the columns",
      ROW,
      { ref: OTHER, frozen: "f", code: "abc" },
      { code_col: "abc", frozen_col: "f" },
    ],
  ])("encodes %s", (_, options, values, columns) => {
    expect(encodeAttributes(attributes, values, options)).toEqual({ columns })
  })
})
