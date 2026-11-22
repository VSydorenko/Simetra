import {
  PLATFORM_ROLES,
  runtimeCatalogSchema,
  runtimeObjectSchema,
  type Filter,
  type RuntimeAttribute,
  type RuntimeCatalog,
} from "simetra/model"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { uuid } from "../../src/compiler/__tests__/helpers"
import {
  ROLE_FILE,
  adminRoles,
  catalog as catalogObject,
  compileRights,
  grant,
  objects,
  policyDomain,
  role,
  type Layer,
} from "../../src/compiler/__tests__/fixtures/rights"
import { buildRuntimeCatalog } from "../../src/compiler/runtime-catalog"
import {
  compileFilter,
  fieldInfoOf,
  filterCollator,
} from "../../src/data/store/filter"
import { executeRead, prepareRead, renderKnown } from "../../src/server/read"
import { signUp } from "./auth"
import { claimsFor, queryAs, withRollback } from "./connection"
import { scansOf } from "./explain-plan"
import { testProvider } from "./profile"
import {
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  profileLayer,
} from "./rights-seed"

/*
 * Читання `startsWith` (спека П4-B §4.1): `starts_with` за нормалізованою
 * колонкою поля пошуку і за `lower(<колонка> COLLATE "default")` для решти.
 * DB, а не юніт: що обидва вирази дають ту саму множину на будь-якій колляції
 * колонки і що умова стає діапазоном індексу під RLS ролі запиту, вирішує
 * лише справжній Postgres. Усе — у транзакціях, що відкочуються.
 */

// ---------------------------------------------------------------- семантика

const text = (
  name: string,
  extra: Partial<RuntimeAttribute> = {}
): RuntimeAttribute => ({
  name,
  column: `${name}_col`,
  pgType: "text",
  castType: "text",
  type: "Text",
  required: false,
  insert: true,
  update: true,
  ...extra,
})

/**
 * Одне значення в чотирьох колонках: з полем пошуку й без, на колляції бази й
 * на `C`. Нормалізовані колонки — тим самим виразом, що генерує компілятор
 * (`search-columns.test.ts`, «normalizes under the database collation»).
 */
const semanticsObject = runtimeObjectSchema.parse({
  id: "00000000-0000-4000-8000-000000000301",
  name: "Word",
  kind: "Catalog",
  kindLabel: "word",
  table: { schema: "pg_temp", name: "search_words" },
  key: "id",
  keyName: "ref",
  versionColumn: "version",
  versionName: "version",
  kernelHash: "0".repeat(64),
  signal: false,
  attributes: [
    text("indexed", { search: "indexed_col_search" }),
    text("plain"),
    text("cIndexed", { search: "cIndexed_col_search" }),
    text("cPlain"),
  ],
  tabularSections: [],
  constraints: [],
})

const FIELDS = ["indexed", "plain", "cIndexed", "cPlain"] as const

const SEMANTICS_DDL = `CREATE TEMP TABLE search_words (
  id uuid PRIMARY KEY,
  version bigint NOT NULL DEFAULT 1,
  indexed_col text,
  "indexed_col_search" text GENERATED ALWAYS AS (lower(indexed_col COLLATE "default")) STORED,
  plain_col text,
  "cIndexed_col" text COLLATE "C",
  "cIndexed_col_search" text GENERATED ALWAYS AS (lower("cIndexed_col" COLLATE "default")) STORED,
  "cPlain_col" text COLLATE "C"
)`

/** Значення рядків: кирилиця, `İ` (у нижньому регістрі — два символи), `ß`/`ẞ`, символи шаблону. */
const WORDS: (string | null)[] = [
  "Київ",
  "КИЇВ",
  "київська",
  "İstanbul",
  "istanbul",
  "ISTANBUL",
  "i̇stanbul",
  "Straße",
  "STRASSE",
  "ẞtraße",
  "a%b",
  "a_b",
  "axb",
  "",
  null,
]

const refOf = (i: number) =>
  `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`

/** Префікси, на яких колляція чи нормалізація могли б розійтися. */
const PREFIXES = [
  "ки",
  "КИЇ",
  "ї",
  "i",
  "I",
  "İ",
  "i̇",
  "ist",
  "stra",
  "STRAß",
  "ß",
  "ẞ",
  "a%",
  "a_",
  "",
]

/** Очікувані множини там, де стара `ILIKE` на колонці `C` давала інше. */
const EXPECTED: [string, number[]][] = [
  // `lower` колляції бази бачить кирилицю й на колонці `C`.
  ["КИЇ", [0, 1, 2]],
  // `İ` → `i̇`: префікс `İ` — це `i̇`, а не `i`.
  ["İ", [3, 6]],
  ["i", [3, 4, 5, 6]],
  // Шаблону немає: `%` і `_` — літерали.
  ["a%", [10]],
  ["a_", [11]],
]

async function serverKeys(
  client: pg.Client,
  catalog: RuntimeCatalog,
  where: Filter
): Promise<string[]> {
  const prepared = prepareRead(catalog, {
    object: { kind: "Catalog", name: "Word" },
    limit: 200,
    where,
  })
  if ("error" in prepared) throw new Error(JSON.stringify(prepared.error))
  const result = await executeRead(
    prepared.object,
    prepared.plan,
    async (statement) =>
      (await client.query(statement.text, statement.params)).rows as Record<
        string,
        unknown
      >[],
    null
  )
  if (!("rows" in result)) throw new Error(JSON.stringify(result))
  return (result.rows as Record<string, unknown>[])
    .map((row) => row.ref as string)
    .sort()
}

describe("startsWith semantics", () => {
  it("is one set with and without a search field, on any column collation, and matches the T4 evaluator", async () => {
    const catalog = runtimeCatalogSchema.parse({
      format: 1,
      snapshotHash: "search-starts-with",
      provider: testProvider(),
      objects: [semanticsObject],
    })
    const info = fieldInfoOf(semanticsObject)
    await withRollback(async (client) => {
      await client.query(SEMANTICS_DDL)
      const rows: Record<string, unknown>[] = []
      for (const [i, word] of WORDS.entries()) {
        await client.query(
          `INSERT INTO pg_temp.search_words
             (id, indexed_col, plain_col, "cIndexed_col", "cPlain_col")
           VALUES ($1, $2, $2, $2, $2)`,
          [refOf(i), word]
        )
        rows.push({
          ref: refOf(i),
          ...Object.fromEntries(FIELDS.map((f) => [f, word])),
        })
      }
      const expected = new Map(EXPECTED)
      for (const prefix of PREFIXES) {
        const sets: Record<string, string[]> = {}
        for (const field of FIELDS) {
          const where: Filter = {
            attribute: field,
            op: "startsWith",
            value: prefix,
          }
          sets[field] = await serverKeys(client, catalog, where)
          // Обчислювач T4 (toLowerCase) — та сама множина, що й сервер.
          expect(
            rows
              .filter(compileFilter(where, info, filterCollator()))
              .map((r) => r.ref as string)
              .sort(),
            `T4 ${field} ${prefix}`
          ).toEqual(sets[field])
        }
        for (const field of FIELDS) {
          expect(sets[field], `${field} ${JSON.stringify(prefix)}`).toEqual(
            sets.indexed
          )
        }
        const wanted = expected.get(prefix)
        if (wanted !== undefined) {
          expect(sets.indexed, JSON.stringify(prefix)).toEqual(
            wanted.map(refOf).sort()
          )
        }
      }
    })
  })
})

// ------------------------------------------------------------ індекс під RLS

const SCOPE_ROWS = 20_000
const TABLE = "party"
const PARTY_FILE = "catalogs/Party/Party.meta.json"
const PARTY_READER_ID = uuid(9500)

function partyLayer(): Layer {
  return {
    [PARTY_FILE]: catalogObject(uuid(9400), "Party", TABLE, {
      // Типове поле довідника — найменування (`mainPresentation`).
      search: { mode: "startsWith" },
    }),
    [ROLE_FILE("PartyReader")]: role(
      PARTY_READER_ID,
      "PartyReader",
      { scopeKind: "org" },
      { grants: [grant(objects(["Catalog", "Party"]), ["read"], "any")] }
    ),
  }
}

describe("startsWith on a search field under RLS", () => {
  const tx = describeTransaction()
  let catalog: RuntimeCatalog
  let reader: string
  let searchIndex: string
  let prefix: string
  let visible: number

  beforeAll(async () => {
    const result = await compileRights(
      policyDomain(adminRoles(), partyLayer(), profileLayer())
    )
    expect(result.diagnostics).toEqual([])
    catalog = buildRuntimeCatalog(result.model!)
    const party = catalog.objects.find((o) => o.name === "Party")!
    const description = party.attributes.find((a) => a.name === "description")!
    expect(description.search).toBe("description_search")
    const client = await tx.open()
    await deploy(client, result.model!)
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
    )

    // Читач — учасник першого скоупу; другий скоуп з тими самими
    // найменуваннями йому чужий.
    reader = await signUp(client)
    const orgs = [uuid(9901), uuid(9902)]
    for (const id of orgs) await insert(client, "organization", { id })
    const member = uuid(9910)
    await insert(client, "org_member", {
      id: member,
      org_id: orgs[0],
      user_id: reader,
    })
    await insert(client, "org_role_assignments", {
      org_id: orgs[0],
      ...assignmentRow(member, { archetype: PARTY_READER_ID }),
    })
    // Великі літери: префікс запиту в іншому регістрі за рядок.
    await client.query(
      `INSERT INTO public.${TABLE} (id, org_id, description)
       SELECT gen_random_uuid(), o, upper(md5(g::text))
       FROM unnest($1::uuid[]) AS o CROSS JOIN generate_series(1, $2) AS g`,
      [orgs, SCOPE_ROWS]
    )
    await client.query(`ANALYZE public.${TABLE}`)

    const { rows: indexes } = await client.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'public.${TABLE}'::regclass
         AND pg_get_indexdef(i.indexrelid) LIKE '%(description_search text_pattern_ops)%'`
    )
    expect(indexes).toHaveLength(1)
    searchIndex = indexes[0]!.name
    prefix = "a1b"
    const { rows: counted } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.${TABLE}
       WHERE org_id = $1 AND description LIKE upper($2) || '%'`,
      [orgs[0], prefix]
    )
    visible = counted[0]!.n
    expect(visible).toBeGreaterThan(0)
  }, 300_000)

  afterAll(() => tx.close())

  const statement = () => {
    const prepared = prepareRead(catalog, {
      object: { kind: "Catalog", name: "Party" },
      limit: 200,
      where: { attribute: "description", op: "startsWith", value: prefix },
    })
    if ("error" in prepared) throw new Error(JSON.stringify(prepared.error))
    return renderKnown(prepared.plan, null)
  }

  it("reads the normalized column's index from the request role", async () => {
    const { text: sql, params } = statement()
    const plan = await queryAs<{ "QUERY PLAN": unknown }>(
      tx.client(),
      "user",
      claimsFor("user", reader),
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
      params
    )
    if (!("rows" in plan)) throw new Error(`EXPLAIN failed: ${plan.code}`)
    const arms = scansOf(plan.rows[0]!["QUERY PLAN"], TABLE).flatMap(
      (n) => n.arms
    )
    // Діапазон `text_pattern_ops` — `starts_with` став умовою індексу, а не
    // фільтром після скану скоупу.
    expect(arms).toContainEqual({
      index: searchIndex,
      condition: expect.stringMatching(
        /description_search ~>=~ .*description_search ~<~ /
      ),
    })

    const read = await queryAs<{ id: string }>(
      tx.client(),
      "user",
      claimsFor("user", reader),
      sql,
      params
    )
    if (!("rows" in read)) throw new Error(`read failed: ${read.code}`)
    // Лише свій скоуп: однакові найменування чужого скоупу RLS ховає.
    expect(read.rows).toHaveLength(visible)
  })
})
