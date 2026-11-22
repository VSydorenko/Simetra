import {
  PLATFORM_ROLES,
  SEARCH_PREFIX_CHARS,
  quoteIdent,
  runtimeCatalogSchema,
  runtimeObjectSchema,
  type Filter,
  type RuntimeAttribute,
  type RuntimeCatalog,
  type RuntimeObject,
} from "simetra/model"
import type pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  customTable,
  metaFiles,
  project,
  uuid,
} from "../../src/compiler/__tests__/helpers"
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
 * Читання `startsWith` (спека П4-B §4.1): для поля пошуку — діапазон за
 * обмеженим префіксом нормалізованої колонки плюс точна умова за повним
 * значенням, для решти — лише точна умова `searchNormalization(<колонка>)`.
 * DB, а не юніт: що обидва вирази дають ту саму множину на будь-якій колляції
 * колонки і що умова стає діапазоном індексу під RLS ролі запиту, вирішує
 * лише справжній Postgres. Усе — у транзакціях, що відкочуються.
 */

// ---------------------------------------------------------------- семантика

const text = (
  name: string,
  column: string,
  extra: Partial<RuntimeAttribute> = {}
): RuntimeAttribute => ({
  name,
  column,
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
 * на `C`. Нормалізовані колонки — з фізичної схеми компілятора (ім'я й вираз
 * генерації), а не переписані тут: інакше зміна виразу в компіляторі лишила б
 * тест зеленим.
 */
async function semanticsTable(): Promise<{
  object: RuntimeObject
  ddl: string
}> {
  const result = await compile(
    metaFiles({
      "project.meta.json": project(),
      "custom-tables/Word/Word.meta.json": customTable("Word", {
        columns: [
          {
            id: uuid(1),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          {
            id: uuid(2),
            name: "indexed",
            physicalName: "indexed_col",
            type: "Text",
          },
          {
            id: uuid(3),
            name: "cIndexed",
            physicalName: "c_indexed_col",
            type: "Text",
            collation: { name: "C" },
          },
        ],
        primaryKey: { columns: ["id"] },
        search: { fields: ["indexed", "cIndexed"] },
      }),
    })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const table = result.model!.physical.tables.find((t) => t.name === "word")!
  const derived = (source: string) => {
    const column = table.columns.find((c) => c.origin.searchOf === source)!
    return { name: column.name, expression: column.generated!.expression }
  }
  const indexed = derived("indexed_col")
  const cIndexed = derived("c_indexed_col")
  return {
    object: runtimeObjectSchema.parse({
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
        text("indexed", "indexed_col", { search: indexed.name }),
        text("plain", "plain_col"),
        text("cIndexed", "c_indexed_col", { search: cIndexed.name }),
        text("cPlain", "c_plain_col"),
      ],
      tabularSections: [],
      constraints: [],
    }),
    ddl: `CREATE TEMP TABLE search_words (
  id uuid PRIMARY KEY,
  version bigint NOT NULL DEFAULT 1,
  indexed_col text,
  ${quoteIdent(indexed.name)} text GENERATED ALWAYS AS (${indexed.expression}) STORED,
  plain_col text,
  c_indexed_col text COLLATE "C",
  ${quoteIdent(cIndexed.name)} text GENERATED ALWAYS AS (${cIndexed.expression}) STORED,
  c_plain_col text COLLATE "C"
)`,
  }
}

const FIELDS = ["indexed", "plain", "cIndexed", "cPlain"] as const

/**
 * Спільний початок, довший за межу нормалізованої колонки: два значення
 * різняться лише після неї.
 */
const LONG = "Ж".repeat(SEARCH_PREFIX_CHARS + 40)

/**
 * Значення рядків: кирилиця, `İ` (у нижньому регістрі — два символи), `ß`/`ẞ`,
 * символи шаблону, значення довші за межу префікса.
 */
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
  `${LONG}a`,
  `${LONG}b`,
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
  LONG.toLowerCase(),
  `${LONG}A`,
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
  // Префікс довший за межу: нормалізована колонка обох рядків однакова, і
  // лише точна умова за повним значенням лишає свій.
  [LONG.toLowerCase(), [15, 16]],
  [`${LONG}A`, [15]],
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
    const { object: semanticsObject, ddl } = await semanticsTable()
    const catalog = runtimeCatalogSchema.parse({
      format: 1,
      snapshotHash: "search-starts-with",
      provider: testProvider(),
      objects: [semanticsObject],
    })
    const info = fieldInfoOf(semanticsObject)
    await withRollback(async (client) => {
      await client.query(ddl)
      const rows: Record<string, unknown>[] = []
      for (const [i, word] of WORDS.entries()) {
        await client.query(
          `INSERT INTO pg_temp.search_words
             (id, indexed_col, plain_col, c_indexed_col, c_plain_col)
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
