import { runtimeObjectSchema, type RuntimeObject } from "simetra/model"
import { describe, expect, it } from "vitest"
import { buildReadStatement } from "../read"
import { ID, OTHER, attributeOf, sample } from "./fixtures"

// Типи приведення каталогу, як їх дає компілятор; у `sample` усі — `text`.
const object: RuntimeObject = runtimeObjectSchema.parse({
  ...sample,
  attributes: [
    ...sample.attributes.map((a) =>
      a.name === "count" ? { ...a, castType: "integer" } : a
    ),
    {
      ...attributeOf("code"),
      name: "label",
      column: "label_col",
      pgType: "character varying(10)",
      castType: "character varying",
      maxLength: 10,
    },
  ],
})

const SELECT =
  `SELECT (to_jsonb(t) || jsonb_build_object('big_col', t."big_col"::text, ` +
  `'amount_col', t."amount_col"::text, 'bigs_col', t."bigs_col"::text[]))::text ` +
  `AS row FROM "public"."sample" t`

const ref = { kind: "Catalog" as const, name: "Sample" }

describe("buildReadStatement", () => {
  it("reads one row by id", () => {
    expect(buildReadStatement(object, { object: ref, id: ID })).toEqual({
      text: `${SELECT} WHERE "id" = $1::uuid ORDER BY "id" LIMIT $2`,
      params: [ID, "1"],
    })
  })

  it("reads a page without a filter", () => {
    expect(
      buildReadStatement(object, { object: ref, where: {}, limit: 200 })
    ).toEqual({
      text: `${SELECT} ORDER BY "id" LIMIT $1`,
      params: ["200"],
    })
  })

  it("filters by equality, a pair, null and the keyset after", () => {
    expect(
      buildReadStatement(object, {
        object: ref,
        where: {
          count: 5,
          subject: { type: "Catalog.Project", id: OTHER },
          note: null,
          status: "Open",
        },
        after: ID,
        limit: 50,
      })
    ).toEqual({
      text:
        `${SELECT} WHERE "count_col" = $1::integer AND "subject_type" = $2::text` +
        ` AND "subject_col" = $3::uuid AND "note_col" IS NULL` +
        ` AND "status_col" = $4::text AND "id" > $5::uuid` +
        ` ORDER BY "id" LIMIT $6`,
      params: ["5", "project", OTHER, "open", ID, "50"],
    })
  })

  it("a null pair is two IS NULL", () => {
    expect(
      buildReadStatement(object, {
        object: ref,
        where: { subject: null },
        limit: 1,
      })
    ).toEqual({
      text: `${SELECT} WHERE "subject_type" IS NULL AND "subject_col" IS NULL ORDER BY "id" LIMIT $1`,
      params: ["1"],
    })
  })

  it("does not truncate where parameters", () => {
    // `$1::character varying(10)` обрізав би довше значення й знайшов би чужий рядок.
    expect(
      buildReadStatement(object, {
        object: ref,
        where: { label: "abc" },
        limit: 1,
      })
    ).toEqual({
      text: `${SELECT} WHERE "label_col" = $1::character varying ORDER BY "id" LIMIT $2`,
      params: ["abc", "1"],
    })
  })

  it("an object without numeric or bigint columns projects to_jsonb", () => {
    const plain = runtimeObjectSchema.parse({
      ...object,
      attributes: [attributeOf("code")],
    })
    expect(buildReadStatement(plain, { object: ref, id: ID })).toEqual({
      text: `SELECT to_jsonb(t)::text AS row FROM "public"."sample" t WHERE "id" = $1::uuid ORDER BY "id" LIMIT $2`,
      params: [ID, "1"],
    })
  })

  it.each([
    ["an unknown attribute", { nope: 1 }, "nope"],
    ["the key name", { ref: ID }, "ref"],
    ["a value of another type", { count: "5" }, "count"],
    ["a Json attribute", { payload: {} }, "payload"],
    ["an array attribute", { tags: [1] }, "tags"],
    ["an unknown pair target", { subject: { type: "X.Y", id: ID } }, "subject"],
    ["an unknown enumeration value", { status: "Pending" }, "status"],
    ["the first invalid key in input order", { code: "abcd", nope: 1 }, "code"],
  ])("%s is command.invalid with its path", (_, where, path) => {
    expect(
      buildReadStatement(object, { object: ref, where, limit: 1 })
    ).toEqual({ error: { code: "command.invalid", path } })
  })
})
