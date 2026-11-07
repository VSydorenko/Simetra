import {
  runtimeCatalogSchema,
  runtimeObjectSchema,
  type RuntimeAttribute,
  type RuntimeObject,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { executeRead, prepareRead } from "../read"
import {
  ID,
  LINK,
  OTHER,
  SUBJECT,
  attributeOf,
  link,
  region,
  sample,
} from "./fixtures"

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

// Картка з понад 50 текстовими приведеннями (`bigint`): один
// `jsonb_build_object` отримав би понад 100 аргументів.
const WIDE_TEXT = { kind: "Catalog" as const, name: "WideText" }
const wideTextObject = runtimeObjectSchema.parse({
  ...sample,
  id: "00000000-0000-4000-8000-000000000006",
  name: "WideText",
  attributes: wideColumns.map((column) => ({
    ...attributeOf("big"),
    name: column,
    column,
  })),
})

// ТЧ скоупленого власника: FK рядка — складений `(org_id, parent_id)`.
const SCOPED = { kind: "Catalog" as const, name: "Scoped" }
const [lines] = sample.tabularSections
const scopedObject = runtimeObjectSchema.parse({
  ...sample,
  id: "00000000-0000-4000-8000-000000000005",
  name: "Scoped",
  table: { schema: "public", name: "scoped" },
  attributes: [attributeOf("code")],
  tabularSections: [
    {
      ...lines,
      table: { schema: "public", name: "scoped_lines" },
      parentConstraint: "scoped_lines_parent_fkey",
      constraints: [
        {
          name: "scoped_lines_parent_fkey",
          kind: "foreignKey",
          columns: ["org_id", "parent_id"],
          references: ["org_id", "id"],
        },
      ],
    },
  ],
})

const catalog = runtimeCatalogSchema.parse({
  format: 1,
  snapshotHash: "hash-1",
  provider: "supabase",
  objects: [
    object,
    lazyObject,
    wideObject,
    wideTextObject,
    region,
    link,
    scopedObject,
  ],
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

/** Виконує план на фейку: відповіді по черзі, оператори — з об'єктом фази. */
async function execute(query: unknown, answers: Record<string, unknown>[][]) {
  const prepared = prepareRead(catalog, query)
  if ("error" in prepared) throw new Error(prepared.error.code)
  const calls: unknown[] = []
  const result = await executeRead(
    prepared.object,
    prepared.plan,
    (statement, target) => {
      calls.push({ ...statement, object: target.name })
      return Promise.resolve(answers.shift() ?? [])
    }
  )
  return { calls, result }
}

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
      text: `${LIST} ORDER BY t."id" LIMIT $1`,
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
        ` ORDER BY t."label_col" DESC NULLS LAST, t."id" LIMIT $2 OFFSET $3`,
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
      text: `${LIST} ORDER BY t."count_col" NULLS FIRST, t."id" DESC LIMIT $1`,
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
      text: `${LIST} WHERE ("id" > $1::uuid AND "version" >= $2::bigint) ORDER BY t."id" LIMIT $3`,
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
      text: `${LIST} WHERE "label_col" = $1::character varying ORDER BY t."id" LIMIT $2`,
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
      text: `SELECT ${listed} ${FROM} ORDER BY t."id" LIMIT $1`,
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
        `jsonb_build_object(${pairs.slice(50).join(", ")}))::text ${FROM} ORDER BY t."id" LIMIT $1`,
    })
  })

  it("a card with over 50 text casts projects them in chunks of 50 pairs", () => {
    const pairs = wideColumns.map((c) => `'${c}', t."${c}"::text`)
    expect(statementOf({ object: WIDE_TEXT, id: ID })).toMatchObject({
      text:
        `SELECT (to_jsonb(t) || (jsonb_build_object(${pairs.slice(0, 50).join(", ")}) || ` +
        `jsonb_build_object(${pairs.slice(50).join(", ")})))::text ${FROM} WHERE "id" = $1::uuid LIMIT 1`,
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
    [
      "an include of an unknown attribute",
      { object: LINK, id: ID, include: ["nope"] },
      "include.0",
    ],
    [
      "an include of an attribute without ref",
      { object: LINK, id: ID, include: ["region", "code"] },
      "include.1",
    ],
    [
      "an include of a target outside the catalog",
      { object: LINK, id: ID, include: ["ghost"] },
      "include.0",
    ],
    [
      "a repeated include",
      { object: LINK, id: ID, include: ["region", "region"] },
      "include.1",
    ],
    [
      "an unknown section of a card",
      { object: ref, id: ID, tabularSections: ["lines", "nope"] },
      "tabularSections.1",
    ],
    [
      "an unknown section of an owner",
      { object: ref, tabularSection: "nope", owner: ID },
      "tabularSection",
    ],
    [
      "a section filter by an owner attribute",
      {
        object: ref,
        tabularSection: "lines",
        where: { attribute: "code", op: "eq", value: "A" },
        limit: 1,
      },
      "where.attribute",
    ],
    [
      "a section orderBy with the key not last",
      {
        object: ref,
        tabularSection: "lines",
        orderBy: order("ref", "qty"),
        limit: 1,
      },
      "orderBy.0",
    ],
    [
      "a section orderBy by Json",
      {
        object: ref,
        tabularSection: "lines",
        orderBy: order("extra"),
        limit: 1,
      },
      "orderBy.0.attribute",
    ],
    [
      // Колонки немає в проєкції списку: `included` мовчки був би порожнім (В11).
      "an include of a lazy Ref in a page",
      { object: LINK, include: ["archive"], limit: 1 },
      "include.0",
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

describe("executeRead include", () => {
  const R1 = "77777777-7777-4777-8777-777777777777"
  const R2 = "88888888-8888-4888-8888-888888888888"
  const LINK_FROM = `AS row FROM "public"."link" t`
  const REGION =
    `SELECT jsonb_build_object('id', t."id", 'version', t."version", ` +
    `'code', t."code")::text AS row FROM "public"."region" t`
  const linkRow = (
    id: string,
    region: string | null,
    backup: string | null
  ) => ({
    row: JSON.stringify({
      id,
      version: 1,
      region_id: region,
      backup_id: backup,
    }),
  })
  const regionRow = (id: string) => ({
    row: JSON.stringify({ id, version: 2, code: "N" }),
  })

  it("reads every target once by the unique ids of the first statement", async () => {
    const { calls, result } = await execute(
      { object: LINK, include: ["region", "backup"], limit: 10 },
      [
        [linkRow(ID, R1, R2), linkRow(OTHER, R1, null)],
        [regionRow(R1), regionRow(R2)],
      ]
    )
    expect(calls).toEqual([
      {
        text:
          `SELECT jsonb_build_object('id', t."id", 'version', t."version", ` +
          `'code', t."code", 'region_id', t."region_id", ` +
          `'backup_id', t."backup_id", 'ghost_id', t."ghost_id")::text ` +
          `${LINK_FROM} ORDER BY t."id" LIMIT $1`,
        params: ["10"],
        object: "Link",
      },
      {
        text: `${REGION} WHERE "id" = ANY(ARRAY[$1::uuid, $2::uuid])`,
        params: [R1, R2],
        object: "Region",
      },
    ])
    expect(result).toEqual({
      rows: [
        { ref: ID, version: 1, region: R1, backup: R2 },
        { ref: OTHER, version: 1, region: R1, backup: null },
      ],
      included: {
        "Catalog.Region": [
          { ref: R1, version: 2, code: "N" },
          { ref: R2, version: 2, code: "N" },
        ],
      },
    })
  })

  it("a card includes a lazy Ref: the card carries lazy columns", async () => {
    const { calls } = await execute(
      { object: LINK, id: ID, include: ["archive"] },
      [[{ row: JSON.stringify({ id: ID, version: 1, archive_id: R1 }) }]]
    )
    expect(calls).toEqual([
      {
        text: `SELECT to_jsonb(t)::text ${LINK_FROM} WHERE "id" = $1::uuid LIMIT 1`,
        params: [ID],
        object: "Link",
      },
      {
        text: `${REGION} WHERE "id" = ANY(ARRAY[$1::uuid])`,
        params: [R1],
        object: "Region",
      },
    ])
  })

  it("without ids sends no include statement and includes an empty list", async () => {
    const { calls, result } = await execute(
      { object: LINK, id: ID, include: ["region"] },
      [[linkRow(ID, null, R2)]]
    )
    expect(calls).toHaveLength(1)
    expect(result).toEqual({
      rows: [{ ref: ID, version: 1, region: null, backup: R2 }],
      included: { "Catalog.Region": [] },
    })
  })
})

describe("tabular sections", () => {
  const line = (a: string) =>
    `jsonb_build_object('id', ${a}."id", 'parent_id', ${a}."parent_id", ` +
    `'line_number', ${a}."line_number", 'qty_col', ${a}."qty_col", ` +
    `'firstOnly_col', ${a}."firstOnly_col", 'extra_col', ${a}."extra_col", ` +
    `'copy_id_col', ${a}."copy_id_col")`
  const lineAgg = (table: string, corr: string, k: number) =>
    `(SELECT coalesce(jsonb_agg(${line("l")} ORDER BY l."line_number", l."id"), '[]')` +
    ` FROM (SELECT * FROM "public"."${table}" s WHERE ${corr}` +
    ` ORDER BY s."line_number", s."id" LIMIT $${k}) l)`
  const SINGLE = `s."parent_id" = t."id"`
  // Складений FK — кореляція за всіма колонками: інакше індекс `(org_id, parent_id)` не працює.
  const COMPOSITE = `s."org_id" = t."org_id" AND s."parent_id" = t."id"`
  const CARD_HEAD =
    `(to_jsonb(t) || jsonb_build_object('amount_col', t."amount_col"::text, ` +
    `'bigs_col', t."bigs_col"::text[]))::text`
  const PAGE = (
    where: string,
    order = `t."line_number", t."id"`,
    tail = "LIMIT $3"
  ) =>
    `FROM (SELECT ${line("t")} AS r, row_number() OVER (ORDER BY ${order}) AS n` +
    ` FROM "public"."sample_lines" t WHERE ${where} ORDER BY ${order} ${tail}) x`
  const AGG = `jsonb_build_object('sample_lines', coalesce(jsonb_agg(x.r ORDER BY x.n), '[]'))::text AS tabular`
  const parentEq = { attribute: "parent", op: "eq", value: OTHER }

  it.each<[string, unknown, string, string]>([
    [
      "a card with every section",
      { object: ref, id: ID, tabularSections: true },
      CARD_HEAD,
      `jsonb_build_object('sample_lines', ${lineAgg("sample_lines", SINGLE, 2)})::text AS tabular FROM "public"."sample" t`,
    ],
    [
      "a card of a scoped owner",
      { object: SCOPED, id: ID, tabularSections: ["lines"] },
      "to_jsonb(t)::text",
      `jsonb_build_object('scoped_lines', ${lineAgg("scoped_lines", COMPOSITE, 2)})::text AS tabular FROM "public"."scoped" t`,
    ],
  ])("%s is one statement with a tabular column", (_, query, head, rest) => {
    expect(statementOf(query)).toEqual({
      text: `SELECT ${head} AS row, ${rest} WHERE "id" = $1::uuid LIMIT 1`,
      params: [ID, "5001"],
      result: "rows",
    })
  })

  it("the lines of an owner read the owner version by the same statement", () => {
    expect(
      statementOf({ object: ref, tabularSection: "lines", owner: ID })
    ).toEqual({
      text:
        `SELECT t."version"::text AS owner_version, jsonb_build_object('sample_lines', ` +
        `${lineAgg("sample_lines", SINGLE, 2)})::text AS tabular` +
        ` FROM "public"."sample" t WHERE "id" = $1::uuid LIMIT 1`,
      params: [ID, "5001"],
      result: "lines",
    })
  })

  it("a page of one owner aggregates numbered lines and reads the owner version", () => {
    expect(
      statementOf({
        object: ref,
        tabularSection: "lines",
        where: { and: [parentEq, { attribute: "qty", op: "gt", value: 1 }] },
        limit: 10,
      })
    ).toEqual({
      text:
        `SELECT (SELECT o."version"::text FROM "public"."sample" o WHERE o."id" = $3::uuid)` +
        ` AS owner_version, ${AGG} ` +
        PAGE(
          `("parent_id" = $1::uuid AND "qty_col" > $2::text)`,
          undefined,
          "LIMIT $4"
        ),
      params: [OTHER, "1", OTHER, "10"],
      result: "lines",
    })
  })

  it("a page of a scoped owner adds the owner scope from the same subquery", () => {
    const text = (
      statementOf({
        object: SCOPED,
        tabularSection: "lines",
        where: parentEq,
        limit: 10,
      }) as { text: string }
    ).text
    expect(text).toContain(
      `FROM "public"."scoped_lines" t WHERE "parent_id" = $1::uuid AND ` +
        `"org_id" = (SELECT o."org_id" FROM "public"."scoped" o WHERE o."id" = $2::uuid) ORDER BY`
    )
    expect(text).toMatch(
      /^SELECT \(SELECT o\."version"::text FROM "public"\."scoped" o WHERE o\."id" = \$2::uuid\) AS owner_version, /
    )
  })

  it("a page without one owner orders by orderBy, then the key, and has no owner version", () => {
    expect(
      statementOf({
        object: ref,
        tabularSection: "lines",
        where: { or: [parentEq, { attribute: "parent", op: "eq", value: ID }] },
        orderBy: [{ attribute: "lineNumber", direction: "desc" }],
        offset: 5,
        limit: 10,
      })
    ).toEqual({
      text:
        `SELECT ${AGG} ` +
        PAGE(
          `("parent_id" = $1::uuid OR "parent_id" = $2::uuid)`,
          `t."line_number" DESC, t."id"`,
          "LIMIT $3 OFFSET $4"
        ),
      params: [OTHER, ID, "10", "5"],
      result: "lines",
    })
  })

  const COUNT_FROM = `FROM "public"."sample_lines" t WHERE`
  it.each<[string, unknown, string, string[]]>([
    [
      "one owner — uncapped",
      { and: [parentEq] },
      `SELECT count(*) AS n ${COUNT_FROM} ("parent_id" = $1::uuid)`,
      [OTHER],
    ],
    [
      "or over owners — capped",
      { or: [parentEq, parentEq] },
      `SELECT count(*) AS n FROM (SELECT 1 ${COUNT_FROM} ("parent_id" = $1::uuid OR "parent_id" = $2::uuid) LIMIT $3) c`,
      [OTHER, OTHER, "10001"],
    ],
    [
      "in over owners — capped",
      { attribute: "parent", op: "in", value: [OTHER] },
      `SELECT count(*) AS n FROM (SELECT 1 ${COUNT_FROM} "parent_id" = ANY(ARRAY[$1::uuid]) LIMIT $2) c`,
      [OTHER, "10001"],
    ],
    [
      "not over an owner — capped",
      { not: parentEq },
      `SELECT count(*) AS n FROM (SELECT 1 ${COUNT_FROM} NOT ("parent_id" = $1::uuid) LIMIT $2) c`,
      [OTHER, "10001"],
    ],
  ])("a section count of %s", (_, filter, text, params) => {
    expect(
      statementOf({
        object: ref,
        tabularSection: "lines",
        where: filter,
        count: true,
      })
    ).toEqual({ text, params, result: "count" })
  })

  const lineRow = (n: number) => ({
    id: OTHER,
    parent_id: ID,
    line_number: n,
    qty_col: 2,
  })
  const tabular = (rows: unknown[]) => JSON.stringify({ sample_lines: rows })

  it("decodes the sections of a card into tabularSections", async () => {
    const { result } = await execute(
      { object: ref, id: ID, tabularSections: true },
      [
        [
          {
            row: JSON.stringify({ id: ID, version: 1 }),
            tabular: tabular([lineRow(1)]),
          },
        ],
      ]
    )
    expect(result).toEqual({
      rows: [
        {
          ref: ID,
          version: 1,
          tabularSections: {
            lines: [{ ref: OTHER, parent: ID, lineNumber: 1, qty: 2 }],
          },
        },
      ],
    })
  })

  it.each<[string, unknown]>([
    ["a card", { object: ref, id: ID, tabularSections: ["lines"] }],
    [
      "the lines of an owner",
      { object: ref, tabularSection: "lines", owner: ID },
    ],
  ])(
    "refuses %s over TABULAR_LINES_MAX lines without truncating",
    async (_, query) => {
      const many = Array.from({ length: 5001 }, (_, i) => lineRow(i + 1))
      const { result } = await execute(query, [
        [
          {
            row: JSON.stringify({ id: ID, version: 1 }),
            owner_version: "1",
            tabular: tabular(many),
          },
        ],
      ])
      expect(result).toEqual({
        error: {
          code: "command.invalid",
          reason: "tabular-too-large",
          path: "lines",
        },
      })
    }
  )

  it.each<[string, unknown, Record<string, unknown>[], unknown]>([
    [
      "an invisible owner",
      { object: ref, tabularSection: "lines", owner: ID },
      [],
      { rows: [] },
    ],
    [
      "a visible owner with no lines",
      { object: ref, tabularSection: "lines", owner: ID },
      [{ owner_version: "3", tabular: tabular([]) }],
      { rows: [], ownerVersion: 3 },
    ],
    [
      "a page of an invisible owner",
      { object: ref, tabularSection: "lines", where: parentEq, limit: 1 },
      [{ owner_version: null, tabular: tabular([]) }],
      { rows: [] },
    ],
    [
      "a page of a visible owner",
      { object: ref, tabularSection: "lines", where: parentEq, limit: 1 },
      [{ owner_version: "4", tabular: tabular([lineRow(1)]) }],
      {
        rows: [{ ref: OTHER, parent: ID, lineNumber: 1, qty: 2 }],
        ownerVersion: 4,
      },
    ],
    [
      "an uncapped section count",
      { object: ref, tabularSection: "lines", where: parentEq, count: true },
      [{ n: "20000" }],
      { count: 20_000 },
    ],
  ])("reads %s", async (_, query, rows, expected) => {
    const { result } = await execute(query, [rows])
    expect(result).toEqual(expected)
  })
})

describe("ORDER BY names table columns, not output columns", () => {
  // Голе ім'я в `ORDER BY` Postgres спершу шукає серед вихідних колонок:
  // колонка `row` списку чи `r` сторінки ТЧ сортувала б за текстом jsonb.
  const [section] = sample.tabularSections
  const shadowing = runtimeObjectSchema.parse({
    ...sample,
    id: "00000000-0000-4000-8000-000000000006",
    name: "Shadow",
    table: { schema: "public", name: "shadow" },
    attributes: [{ ...attributeOf("code"), name: "row", column: "row" }],
    tabularSections: [
      {
        ...section,
        attributes: [{ ...attributeOf("code"), name: "r", column: "r" }],
      },
    ],
  })
  const SHADOW = { kind: "Catalog" as const, name: "Shadow" }
  const shadowCatalog = runtimeCatalogSchema.parse({
    format: 1,
    snapshotHash: "hash-1",
    provider: "supabase",
    objects: [shadowing],
  })
  const textOf = (query: unknown) => {
    const prepared = prepareRead(shadowCatalog, query)
    if ("error" in prepared) throw new Error(prepared.error.code)
    return prepared.plan.statement.text
  }

  it("a list column named row", () => {
    expect(
      textOf({
        object: SHADOW,
        orderBy: [{ attribute: "row", direction: "desc" }],
        limit: 10,
      })
    ).toBe(
      `SELECT jsonb_build_object('id', t."id", 'version', t."version", 'row', t."row")::text` +
        ` AS row FROM "public"."shadow" t ORDER BY t."row" DESC, t."id" LIMIT $1`
    )
  })

  it("a section page column named r, by orderBy and by default", () => {
    const line =
      `jsonb_build_object('id', t."id", 'parent_id', t."parent_id", ` +
      `'line_number', t."line_number", 'r', t."r")`
    const page = (order: string) =>
      `SELECT jsonb_build_object('sample_lines', coalesce(jsonb_agg(x.r ORDER BY x.n), '[]'))::text` +
      ` AS tabular FROM (SELECT ${line} AS r, row_number() OVER (ORDER BY ${order}) AS n` +
      ` FROM "public"."sample_lines" t WHERE "r" = $1::text ORDER BY ${order} LIMIT $2) x`
    const where = { attribute: "r", op: "eq", value: "A" }
    expect(
      textOf({
        object: SHADOW,
        tabularSection: "lines",
        where,
        orderBy: [{ attribute: "r", direction: "asc" }],
        limit: 10,
      })
    ).toBe(page(`t."r", t."id"`))
    expect(
      textOf({ object: SHADOW, tabularSection: "lines", where, limit: 10 })
    ).toBe(page(`t."line_number", t."id"`))
  })
})
