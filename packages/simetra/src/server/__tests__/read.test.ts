import {
  runtimeCatalogSchema,
  runtimeObjectSchema,
  type RuntimeAttribute,
  type RuntimeObject,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { prepareRead } from "../read"
import { ID, SUBJECT, attributeOf, sample } from "./fixtures"

const ref = { kind: "Catalog" as const, name: "Sample" }

// Типи приведення каталогу, як їх дає компілятор; у `sample` усі — `text`.
const object: RuntimeObject = runtimeObjectSchema.parse({
  ...sample,
  attributes: [
    attributeOf("code"),
    { ...attributeOf("count"), castType: "integer" },
    attributeOf("amount"),
    attributeOf("bigs"),
    attributeOf("payload"),
    SUBJECT,
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

const lazy = (attribute: RuntimeAttribute): RuntimeAttribute => ({
  ...attribute,
  load: "lazy",
})
const LAZY = { kind: "Catalog" as const, name: "Lazy" }
const lazyObject = runtimeObjectSchema.parse({
  ...sample,
  id: "00000000-0000-4000-8000-000000000003",
  name: "Lazy",
  attributes: [
    attributeOf("code"),
    lazy(attributeOf("amount")),
    lazy(attributeOf("blob")),
  ],
})

const WIDE = { kind: "Catalog" as const, name: "Wide" }
const wideColumns = Array.from({ length: 60 }, (_, i) => `c${i}`)
const wideObject = runtimeObjectSchema.parse({
  ...sample,
  id: "00000000-0000-4000-8000-000000000004",
  name: "Wide",
  attributes: wideColumns.map((column) => ({
    ...attributeOf("code"),
    name: column,
    column,
  })),
})

const catalog = runtimeCatalogSchema.parse({
  format: 1,
  snapshotHash: "hash-1",
  provider: "supabase",
  objects: [object, lazyObject, wideObject],
})

const FROM = `AS row FROM "public"."sample" t`
const LIST =
  `SELECT jsonb_build_object('id', t."id", 'version', t."version", ` +
  `'code_col', t."code_col", 'count_col', t."count_col", ` +
  `'amount_col', t."amount_col"::text, 'bigs_col', t."bigs_col"::text[], ` +
  `'payload_col', t."payload_col", 'subject_type', t."subject_type", ` +
  `'subject_col', t."subject_col", 'label_col', t."label_col")::text ${FROM}`
const CARD =
  `SELECT (to_jsonb(t) || jsonb_build_object('amount_col', t."amount_col"::text, ` +
  `'bigs_col', t."bigs_col"::text[]))::text ${FROM}`

const statementOf = (query: unknown) => {
  const prepared = prepareRead(catalog, query)
  if ("error" in prepared) return prepared
  return { ...prepared.plan.statement, result: prepared.plan.result }
}
const where = { attribute: "code", op: "eq", value: "A" }

describe("prepareRead", () => {
  it("a card reads the whole row by key", () => {
    expect(statementOf({ object: ref, id: ID })).toEqual({
      text: `${CARD} WHERE "id" = $1::uuid LIMIT 1`,
      params: [ID],
      result: "rows",
    })
  })

  it("a page without orderBy lists named columns ordered by key", () => {
    // Без `to_jsonb(t)` і без `COLLATE` (Рд29): лише перелік колонок.
    expect(statementOf({ object: ref, limit: 200 })).toEqual({
      text: `${LIST} ORDER BY "id" LIMIT $1`,
      params: ["200"],
      result: "rows",
    })
  })

  it("a page filters, orders with direction and nulls, then the key, and offsets", () => {
    expect(
      statementOf({
        object: ref,
        where,
        orderBy: [{ attribute: "label", direction: "desc", nulls: "last" }],
        offset: 100,
        limit: 50,
      })
    ).toEqual({
      text:
        `${LIST} WHERE "code_col" = $1::text` +
        ` ORDER BY "label_col" DESC NULLS LAST, "id" LIMIT $2 OFFSET $3`,
      params: ["A", "50", "100"],
      result: "rows",
    })
  })

  it("an orderBy ending with the key does not repeat it", () => {
    expect(
      statementOf({
        object: ref,
        orderBy: [
          { attribute: "count", direction: "asc", nulls: "first" },
          { attribute: "ref", direction: "desc" },
        ],
        limit: 1,
      })
    ).toEqual({
      text: `${LIST} ORDER BY "count_col" NULLS FIRST, "id" DESC LIMIT $1`,
      params: ["1"],
      result: "rows",
    })
  })

  it("filters by the key and the version with their platform casts", () => {
    expect(
      statementOf({
        object: ref,
        where: {
          and: [
            { attribute: "ref", op: "gt", value: ID },
            { attribute: "version", op: "gte", value: 2 },
          ],
        },
        limit: 1,
      })
    ).toEqual({
      text: `${LIST} WHERE ("id" > $1::uuid AND "version" >= $2::bigint) ORDER BY "id" LIMIT $3`,
      params: [ID, "2", "1"],
      result: "rows",
    })
  })

  it("does not truncate where parameters", () => {
    // `$1::character varying(10)` обрізав би довше значення й знайшов би чужий рядок.
    expect(
      statementOf({
        object: ref,
        where: { attribute: "label", op: "eq", value: "abc" },
        limit: 1,
      })
    ).toMatchObject({
      text: `${LIST} WHERE "label_col" = $1::character varying ORDER BY "id" LIMIT $2`,
    })
  })

  it("a count is capped one past READ_COUNT_CAP", () => {
    expect(statementOf({ object: ref, where, count: true })).toEqual({
      text: `SELECT count(*) AS n FROM (SELECT 1 FROM "public"."sample" t WHERE "code_col" = $1::text LIMIT $2) c`,
      params: ["A", "10001"],
      result: "count",
    })
  })

  it("list omits a lazy text-encoded column, the card keeps it", () => {
    const listed = `jsonb_build_object('id', t."id", 'version', t."version", 'code_col', t."code_col")::text`
    expect(statementOf({ object: LAZY, limit: 1 })).toMatchObject({
      text: `SELECT ${listed} ${FROM} ORDER BY "id" LIMIT $1`,
    })
    expect(statementOf({ object: LAZY, id: ID })).toMatchObject({
      text: `SELECT (to_jsonb(t) || jsonb_build_object('amount_col', t."amount_col"::text))::text ${FROM} WHERE "id" = $1::uuid LIMIT 1`,
    })
  })

  it("a wide object projects in chunks of 50 pairs", () => {
    // `jsonb_build_object` приймає до 100 аргументів.
    const pairs = ["id", "version", ...wideColumns].map(
      (c) => `'${c}', t."${c}"`
    )
    expect(statementOf({ object: WIDE, limit: 1 })).toMatchObject({
      text:
        `SELECT (jsonb_build_object(${pairs.slice(0, 50).join(", ")}) || ` +
        `jsonb_build_object(${pairs.slice(50).join(", ")}))::text ${FROM} ORDER BY "id" LIMIT $1`,
    })
  })

  const order = (...attributes: string[]) =>
    attributes.map((attribute) => ({ attribute, direction: "asc" }))
  it.each<[string, unknown, string, string?]>([
    [
      "an unknown object",
      { object: { kind: "Catalog", name: "Nope" }, id: ID },
      "object",
    ],
    ["a limit over 200", { object: ref, limit: 201 }, "limit"],
    [
      "an offset over 10 000",
      { object: ref, offset: 10_001, limit: 1 },
      "offset",
    ],
    [
      "an unknown filter attribute",
      {
        object: ref,
        where: { attribute: "nope", op: "eq", value: 1 },
        limit: 1,
      },
      "where.attribute",
    ],
    [
      "a filter by a lazy attribute",
      {
        object: LAZY,
        where: { attribute: "amount", op: "eq", value: "1" },
        count: true,
      },
      "where.attribute",
      "lazy",
    ],
    [
      "a bad filter node",
      { object: ref, where: { and: [where, { search: "x" }] }, limit: 1 },
      "where.and.1",
    ],
    [
      "the key not last",
      { object: ref, orderBy: order("ref", "code"), limit: 1 },
      "orderBy.0",
    ],
    [
      "five attributes without the key",
      {
        object: ref,
        orderBy: order("code", "count", "amount", "label", "version"),
        limit: 1,
      },
      "orderBy",
    ],
    [
      "six orderBy entries",
      { object: ref, orderBy: order("a", "b", "c", "d", "e", "f"), limit: 1 },
      "orderBy",
    ],
    [
      "an orderBy by an unknown attribute",
      { object: ref, orderBy: order("nope"), limit: 1 },
      "orderBy.0.attribute",
    ],
    [
      "an orderBy by an array",
      { object: ref, orderBy: order("bigs"), limit: 1 },
      "orderBy.0.attribute",
    ],
    [
      "an orderBy by Json",
      { object: ref, orderBy: order("payload"), limit: 1 },
      "orderBy.0.attribute",
    ],
    [
      "an orderBy by a pair",
      { object: ref, orderBy: order("subject"), limit: 1 },
      "orderBy.0.attribute",
    ],
    [
      "an orderBy by a lazy attribute",
      { object: LAZY, orderBy: order("amount"), limit: 1 },
      "orderBy.0.attribute",
      "lazy",
    ],
  ])(
    "rejects %s as command.invalid with its path",
    (_, query, path, reason) => {
      expect(prepareRead(catalog, query)).toEqual({
        error: {
          code: "command.invalid",
          path,
          ...(reason === undefined ? {} : { reason }),
        },
      })
    }
  )
})
