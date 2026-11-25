import {
  PLATFORM_ROLES,
  keysetFilter,
  objectTable,
  quoteIdent,
  searchNormalization,
  searchPrefixNormalization,
  type Filter,
} from "simetra/model"
import type { CompiledModel } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
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
import { scopeSetCall } from "../../src/compiler/access-units"
import { buildRuntimeCatalog } from "../../src/compiler/runtime-catalog"
import {
  renderCondition,
  rightsPredicates,
} from "../../src/compiler/rights/predicates"
import { fieldInfoOf, nullableOf } from "../../src/data/store/filter"
import { signUp } from "./auth"
import { claimsFor, queryAs, testRoleFor } from "./connection"
import { scansOf, sortsOver } from "./explain-plan"
import {
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  profileLayer,
} from "./rights-seed"

/*
 * Доказ індексів таблиці перекладів під RLS (спека мультимовних даних §5.1,
 * ADR-0112, блок B1): спільні індекси всіх мов із провідною `language_id`
 * мають бути умовою індексу (`Index Cond`) префіксного пошуку й keyset-сторінки
 * мовою L під кожною формою політики, яку дасть B3. Вирішує це лише
 * планувальник справжнього Postgres на засіві зі статистикою: ADR-0097 уже
 * бачив, як складений ключ (скоуп, префікс) переставав діяти під політикою
 * членства з підзапитом. Таблиці мов і перекладів — рукописні в формі §5.2–§5.3
 * (Р-B1-1), бо генератора ще немає; вирази політик — від компілятора там, де
 * він їх уже дає (Р-B1-3). Усе — в одній транзакції, що відкочується.
 */

/** Рядків шапки на скоуп: таблиця перекладів має `SCOPES × SCOPE_ROWS × мови`. */
const SCOPE_ROWS = 5_000
const PAGE = 100
/** Межа префіксного читання — та сама, що в читанні пошуку T3. */
const PREFIX_LIMIT = 200
/** Два hex-знаки `md5`: ~1/256 рядків мови, тож діапазон вибірковий. */
const PREFIX = "a1"

/*
 * Ключі індексів таблиці перекладів (Р-B1-2) — одна стала на індекс, тож
 * мутація форми індексу — одна правка. Перевірка знаходить індекс за хвостом
 * ключів, а не за `language_id`: інакше мутація падала б на пошуку імені, а не
 * на правилі плану.
 */
const PREFIX_KEYS = "language_id, description_search text_pattern_ops"
const KEYSET_KEYS = "language_id, org_id, description, parent_id"
const PREFIX_TAIL = "description_search text_pattern_ops"
const KEYSET_TAIL = "description, parent_id"

/** Фільтр мови `<t>_public_read` частини (спека §5.3). */
const LANGUAGE_FILTER =
  "language_id = ANY (ARRAY(SELECT id FROM public.languages WHERE state = 'published'))"

const ARTICLE_FILE = "catalogs/Article/Article.meta.json"
const NOTICE_FILE = "catalogs/Notice/Notice.meta.json"
const ARTICLE_ID = uuid(9400)
const NOTICE_ID = uuid(9410)
const ARTICLE_READER_ID = uuid(9500)
const NOTICE_EDITOR_ID = uuid(9501)

type LanguageState = "published" | "draft"

const LANGUAGES: { id: string; code: string; state: LanguageState }[] = [
  { id: uuid(9801), code: "en", state: "published" },
  { id: uuid(9802), code: "de", state: "published" },
  { id: uuid(9803), code: "fr", state: "draft" },
]
const PUBLISHED = LANGUAGES[0]!.id
const DRAFT = LANGUAGES[2]!.id

/** Скоуп читача й редактора; два інші йому чужі. */
const OWN = uuid(9901)
const FOREIGN = uuid(9902)
const SCOPES = [OWN, FOREIGN, uuid(9903)]

/**
 * H1 — скоуплений довідник без `publicRead`; H2 — з `publicRead: "anon"` і
 * полем пошуку (Р-B1-3). Читач H1 і редактор H2 — ролі рівня скоупу.
 */
function headersLayer(): Layer {
  return {
    [ARTICLE_FILE]: catalogObject(ARTICLE_ID, "Article", "article"),
    [NOTICE_FILE]: catalogObject(NOTICE_ID, "Notice", "notice", {
      publicRead: "anon",
      search: { mode: "startsWith" },
    }),
    [ROLE_FILE("ArticleReader")]: role(
      ARTICLE_READER_ID,
      "ArticleReader",
      { scopeKind: "org" },
      { grants: [grant(objects(["Catalog", "Article"]), ["read"], "any")] }
    ),
    [ROLE_FILE("NoticeEditor")]: role(
      NOTICE_EDITOR_ID,
      "NoticeEditor",
      { scopeKind: "org" },
      {
        grants: [
          grant(objects(["Catalog", "Notice"]), ["read", "update"], "any"),
        ],
      }
    ),
  }
}

type Purpose = "user" | "anonymous"

/** Форма політики таблиці перекладів (Р-B1-3). */
interface Form {
  name: string
  header: "article" | "notice"
  purpose: Purpose
  /** DDL політик форми на таблиці перекладів. */
  policies: () => Promise<string[]>
  /** Скоупи, рядки яких роль бачить мовою стану `state`. */
  visible: (state: LanguageState) => string[]
  /** Скоуп keyset-сторінки опублікованою мовою. */
  scope: string
}

const translations = (header: string) => `${header}_translations`

/** Параметризований SQL умови keyset (`keysetFilter`) над колонками таблиці. */
function renderFilter(
  filter: Filter,
  params: unknown[],
  casts: Record<string, string>
): string {
  if ("and" in filter)
    return `(${filter.and.map((f) => renderFilter(f, params, casts)).join(" AND ")})`
  if ("or" in filter)
    return `(${filter.or.map((f) => renderFilter(f, params, casts)).join(" OR ")})`
  const ops: Record<string, string> = {
    eq: "=",
    gt: ">",
    gte: ">=",
    lt: "<",
    lte: "<=",
  }
  if (!("attribute" in filter) || !("value" in filter) || !(filter.op in ops))
    throw new Error(
      `keyset filter outside the proof: ${JSON.stringify(filter)}`
    )
  params.push(filter.value)
  return `t.${quoteIdent(filter.attribute)} ${ops[filter.op]} $${params.length}::${casts[filter.attribute]}`
}

describe("translation-table indexes under RLS policy forms (ADR-0112)", () => {
  const tx = describeTransaction()
  let model: CompiledModel
  let reader: string
  let descriptionNullable: boolean
  /** Імена індексів таблиць перекладів: префіксний і keyset. */
  const indexes = new Map<string, { prefix: string; keyset: string }>()

  const userRole = () => testRoleFor("user")!
  const anonRole = () => testRoleFor("anonymous")!

  beforeAll(async () => {
    const result = await compileRights(
      policyDomain(adminRoles(), headersLayer(), profileLayer())
    )
    expect(result.diagnostics).toEqual([])
    model = result.model!
    const notice = buildRuntimeCatalog(model).objects.find(
      (o) => o.name === "Notice"
    )!
    // Видиме значення мови L — копія чи переклад реквізиту шапки, тож
    // NULL-ність keyset бере з факту реквізиту шапки, як читання шапки.
    descriptionNullable = nullableOf(fieldInfoOf(notice))("description")
    const client = await tx.open()
    await deploy(client, model)
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
    )

    // Читач H1 і редактор H2 — один учасник свого скоупу.
    reader = await signUp(client)
    for (const id of SCOPES) await insert(client, "organization", { id })
    const member = uuid(9910)
    await insert(client, "org_member", {
      id: member,
      org_id: OWN,
      user_id: reader,
    })
    for (const archetype of [ARTICLE_READER_ID, NOTICE_EDITOR_ID]) {
      await insert(client, "org_role_assignments", {
        org_id: OWN,
        ...assignmentRow(member, { archetype }),
      })
    }

    // «Мови» у формі §5.2: опубліковані рядки відкриті ролям запиту й команд,
    // тож фільтр мови в політиці — звичайний підзапит від ролі читання.
    const readers = [anonRole(), userRole(), PLATFORM_ROLES.command]
      .map(quoteIdent)
      .join(", ")
    await client.query(`CREATE TABLE public.languages (
      id uuid PRIMARY KEY,
      code varchar(12) NOT NULL UNIQUE,
      state text NOT NULL CHECK (state IN ('draft', 'published', 'disabled'))
    )`)
    await client.query(`ALTER TABLE public.languages ENABLE ROW LEVEL SECURITY`)
    await client.query(
      `GRANT SELECT (id, code, state) ON public.languages TO ${readers}`
    )
    await client.query(
      `CREATE POLICY languages_published_read ON public.languages AS PERMISSIVE FOR SELECT TO ${readers} USING (state = 'published')`
    )
    for (const language of LANGUAGES) {
      await client.query(
        `INSERT INTO public.languages (id, code, state) VALUES ($1, $2, $3)`,
        [language.id, language.code, language.state]
      )
    }

    for (const header of ["article", "notice"] as const) {
      const table = model.physical.tables.find((t) => t.name === header)!
      const description = table.columns.find((c) => c.name === "description")!
      const search = table.columns.find(
        (c) => c.origin.searchOf === "description"
      )!
      const t = translations(header)
      // Щільна таблиця (ADR-0112): мультимовна колонка — тим самим типом і
      // ім'ям, що в шапці, без NOT NULL (§5.3); префіксна — тим самим виразом
      // генерації, що компілятор дав шапці (ADR-0097).
      await client.query(`CREATE TABLE public.${t} (
        parent_id uuid NOT NULL REFERENCES public.${header} (id) ON DELETE CASCADE,
        language_id uuid NOT NULL REFERENCES public.languages (id),
        org_id uuid NOT NULL,
        description ${description.type},
        ${quoteIdent(search.name)} text GENERATED ALWAYS AS (${search.generated!.expression}) STORED,
        source_hashes jsonb NOT NULL DEFAULT '{}',
        PRIMARY KEY (parent_id, language_id)
      )`)
      await client.query(`CREATE INDEX ON public.${t} (${PREFIX_KEYS})`)
      await client.query(`CREATE INDEX ON public.${t} (${KEYSET_KEYS})`)
      await client.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`)
      await client.query(`GRANT SELECT ON public.${t} TO ${readers}`)

      await client.query(
        `INSERT INTO public.${header} (id, org_id, description)
         SELECT gen_random_uuid(), o, md5($3 || o::text || g)
         FROM unnest($1::uuid[]) AS o CROSS JOIN generate_series(1, $2) AS g`,
        [SCOPES, SCOPE_ROWS, header]
      )
      // Значення мови свої для кожної мови: множини мов не збігаються.
      await client.query(
        `INSERT INTO public.${t} (parent_id, language_id, org_id, description)
         SELECT h.id, l.id, h.org_id, md5(l.code || h.id::text)
         FROM public.${header} h CROSS JOIN public.languages l`
      )
      await client.query(`ANALYZE public.${header}, public.${t}`)

      const { rows } = await client.query<{ name: string; def: string }>(
        `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
         WHERE i.indrelid = 'public.${t}'::regclass AND NOT i.indisprimary`
      )
      const byTail = (tail: string) => {
        const found = rows.filter((r) =>
          new RegExp(`USING btree \\((.*, )?${tail}\\)$`).test(r.def)
        )
        expect(found, `the index ending with (${tail})`).toHaveLength(1)
        return found[0]!.name
      }
      indexes.set(t, {
        prefix: byTail(PREFIX_TAIL),
        keyset: byTail(KEYSET_TAIL),
      })
    }
    await client.query(`ANALYZE public.languages`)
  }, 300_000)

  afterAll(() => tx.close())

  /** SELECT-політики шапки так, як їх зберіг Postgres. */
  const headerPolicies = async (header: string) =>
    (
      await tx.client().query<{
        policyname: string
        permissive: string
        roles: string[]
        qual: string
      }>(
        `SELECT policyname, permissive, roles::text[] AS roles, qual
         FROM pg_policies
         WHERE schemaname = 'public' AND tablename = $1 AND cmd = 'SELECT'
         ORDER BY policyname`,
        [header]
      )
    ).rows

  const policy = (
    table: string,
    label: string,
    permissive: string,
    roles: string[],
    using: string
  ) =>
    `CREATE POLICY ${table}_${label} ON public.${table} AS ${permissive} FOR SELECT TO ${roles.map(quoteIdent).join(", ")} USING (${using})`

  /** (в): ролі й умова `public_read` H2 плюс фільтр опублікованих мов. */
  const publicRead = async (): Promise<string> => {
    const found = (await headerPolicies("notice")).filter(
      (p) => p.policyname === "notice_public_read"
    )
    expect(found).toHaveLength(1)
    const { roles, qual } = found[0]!
    return policy(
      translations("notice"),
      "public_read",
      "PERMISSIVE",
      roles,
      `(${qual}) AND ${LANGUAGE_FILTER}`
    )
  }

  const FORMS: Form[] = [
    {
      name: "(а) tenant bound and read by rights of H1",
      header: "article",
      purpose: "user",
      // Межа тенанта й читання за правами — дослівно вирази, які компілятор
      // дав шапці: копія скоупу має те саме ім'я колонки.
      policies: async () => {
        const found = await headerPolicies("article")
        expect(
          found.some(
            (p) =>
              p.permissive === "RESTRICTIVE" &&
              p.qual.includes("org_id = ANY (ARRAY(")
          ),
          "the tenant bound of H1"
        ).toBe(true)
        expect(found.some((p) => p.permissive === "PERMISSIVE")).toBe(true)
        return found.map((p) =>
          policy(
            translations("article"),
            p.policyname.replace(/^article_/, ""),
            p.permissive,
            p.roles,
            p.qual
          )
        )
      },
      visible: () => [OWN],
      scope: OWN,
    },
    {
      name: "(б) membership with a subquery",
      header: "article",
      purpose: "user",
      // Форма, під якою ADR-0097 відкинув складений ключ: атом `IN (SELECT f())`.
      policies: async () => {
        const contract = model.contracts.access.find(
          (c) => c.objectId === ARTICLE_ID
        )!
        return [
          policy(
            translations("article"),
            "member_read",
            "PERMISSIVE",
            [PLATFORM_ROLES.command, userRole()],
            `org_id IN (SELECT ${scopeSetCall(contract.scope!)})`
          ),
        ]
      },
      visible: () => [OWN],
      scope: OWN,
    },
    {
      name: "(в) public read of published languages",
      header: "notice",
      purpose: "anonymous",
      policies: async () => [await publicRead()],
      visible: (state) => (state === "published" ? SCOPES : []),
      scope: FOREIGN,
    },
    {
      name: "(г) public read OR edit read",
      header: "notice",
      purpose: "user",
      // Предикат `<t>_edit_read` — форма читання природного права `update`
      // власника (§5.3): той самий предикат, що в політиці запису «решти»
      // H2, без умови кореня команди.
      policies: async () => {
        const rights = model.contracts.rights.find(
          (c) => c.objectId === NOTICE_ID
        )!
        const main = objectTable(
          model.physical.tables.find((t) => t.name === "notice")!
        )
        const predicates = rightsPredicates(
          rights,
          "update",
          main,
          main,
          "select"
        ).map((p) => p.conditions.map((c) => renderCondition(c)).join(" AND "))
        expect(predicates.length).toBeGreaterThan(0)
        const writes = renderDesiredState(model)
          .sql.split(";\n")
          .filter((s) => s.includes("CREATE POLICY notice_update_rest_"))
        for (const predicate of predicates) {
          expect(
            writes.some((s) => s.includes(` AND ${predicate})`)),
            `${predicate} is the update write predicate of H2`
          ).toBe(true)
        }
        return [
          await publicRead(),
          ...predicates.map((predicate, i) =>
            policy(
              translations("notice"),
              `edit_read_${i}`,
              "PERMISSIVE",
              [PLATFORM_ROLES.command, userRole()],
              predicate
            )
          ),
        ]
      },
      visible: (state) => (state === "published" ? SCOPES : [OWN]),
      scope: FOREIGN,
    },
  ]

  const claims = (purpose: Purpose) =>
    purpose === "user" ? claimsFor("user", reader) : claimsFor("anonymous")

  const read = async (
    purpose: Purpose,
    sql: string,
    params: unknown[]
  ): Promise<string[]> => {
    const result = await queryAs<{ parent_id: string }>(
      tx.client(),
      purpose,
      claims(purpose),
      sql,
      params
    )
    if (!("rows" in result)) throw new Error(`read failed: ${result.code}`)
    return result.rows.map((r) => r.parent_id)
  }

  const explain = async (
    purpose: Purpose,
    sql: string,
    params: unknown[]
  ): Promise<unknown> => {
    const result = await queryAs<{ "QUERY PLAN": unknown }>(
      tx.client(),
      purpose,
      claims(purpose),
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
      params
    )
    if (!("rows" in result)) throw new Error(`EXPLAIN failed: ${result.code}`)
    return result.rows[0]!["QUERY PLAN"]
  }

  /** Префіксне читання мовою: та сама умова, що читання пошуку T3 (ADR-0097). */
  const prefixRead = (table: string, language: string) => ({
    sql: `SELECT t.parent_id FROM public.${table} t
      WHERE t.language_id = $1::uuid
        AND (starts_with(t.description_search, ${searchPrefixNormalization("$2::text")})
          AND starts_with(${searchNormalization("t.description")}, ${searchNormalization("$3::text")}))
      ORDER BY t.parent_id LIMIT $4`,
    params: [language, PREFIX, PREFIX, String(PREFIX_LIMIT)],
  })

  /** Очікуване префіксне читання — від власника, з явними видимими скоупами. */
  const prefixExpected = async (
    table: string,
    language: string,
    visible: string[]
  ) =>
    (
      await tx.client().query<{ parent_id: string }>(
        `SELECT parent_id FROM public.${table}
         WHERE language_id = $1 AND org_id = ANY ($2::uuid[])
           AND lower(description) LIKE lower($3) || '%'
         ORDER BY parent_id LIMIT $4`,
        [language, visible, PREFIX, PREFIX_LIMIT]
      )
    ).rows.map((r) => r.parent_id)

  /** Рядок-курсор посередині скоупу мовою. */
  const cursorOf = async (table: string, language: string, scope: string) => {
    const { rows } = await tx
      .client()
      .query<{ description: string; parent_id: string }>(
        `SELECT description, parent_id FROM public.${table}
         WHERE language_id = $1 AND org_id = $2
         ORDER BY description, parent_id OFFSET $3 LIMIT 1`,
        [language, scope, SCOPE_ROWS / 2]
      )
    return rows[0]!
  }

  /**
   * Keyset-сторінка мовою (за зразком `list-order-plan`): рівність скоупу й
   * мови в самому запиті, бо `= ANY (…)` з RLS порядку індексу не дає.
   */
  const keysetRead = async (table: string, language: string, scope: string) => {
    const cursor = await cursorOf(table, language, scope)
    const keyset = keysetFilter(
      [{ attribute: "description", direction: "asc" }],
      {
        values: { description: cursor.description },
        key: cursor.parent_id,
        direction: "after",
      },
      "parent_id",
      () => descriptionNullable
    )
    const params: unknown[] = [scope, language]
    const condition = renderFilter(keyset, params, {
      description: "text",
      parent_id: "uuid",
    })
    return {
      cursor,
      sql: `SELECT t.parent_id FROM public.${table} t
        WHERE t.org_id = $1::uuid AND t.language_id = $2::uuid AND ${condition}
        ORDER BY t.description, t.parent_id LIMIT ${PAGE}`,
      params,
    }
  }

  const keysetExpected = async (
    table: string,
    language: string,
    scope: string,
    visible: string[],
    cursor: { description: string; parent_id: string }
  ) =>
    (
      await tx.client().query<{ parent_id: string }>(
        `SELECT parent_id FROM public.${table}
         WHERE language_id = $1 AND org_id = $2 AND org_id = ANY ($3::uuid[])
           AND (description, parent_id) > ($4::text, $5::uuid)
         ORDER BY description, parent_id LIMIT $6`,
        [language, scope, visible, cursor.description, cursor.parent_id, PAGE]
      )
    ).rows.map((r) => r.parent_id)

  /**
   * Гілка саме названого індексу з літералом мови й умовою префікса чи
   * провідної межі в її `Index Cond` — не `Filter`, не `Recheck Cond`, не PK.
   */
  const expectArm = (
    plan: unknown,
    table: string,
    index: string,
    language: string,
    bound: string
  ) => {
    const arms = scansOf(plan, table).flatMap((n) => n.arms)
    expect(arms.length, "index arms of the translation table").toBeGreaterThan(
      0
    )
    expect(arms).toContainEqual({
      index,
      condition: expect.stringMatching(
        new RegExp(`^(?=.*language_id = '${language}'::uuid)(?=.*${bound})`)
      ),
    })
  }

  it.each(FORMS)(
    "$name: prefix and keyset read language L through its index",
    async (form) => {
      const client = tx.client()
      const table = translations(form.header)
      const index = indexes.get(table)!
      await client.query("SAVEPOINT translations_form")
      try {
        for (const sql of await form.policies()) await client.query(sql)

        // Префікс опублікованою мовою: діапазон індексу (language_id, префікс).
        const prefix = prefixRead(table, PUBLISHED)
        const prefixPlan = await explain(
          form.purpose,
          prefix.sql,
          prefix.params
        )
        expectArm(
          prefixPlan,
          table,
          index.prefix,
          PUBLISHED,
          "description_search ~>=~ .*description_search ~<~ "
        )
        const prefixRows = await prefixExpected(
          table,
          PUBLISHED,
          form.visible("published")
        )
        expect(prefixRows.length, "visible prefix rows").toBeGreaterThan(0)
        expect(
          await read(form.purpose, prefix.sql, prefix.params),
          "prefix rows of a published language"
        ).toEqual(prefixRows)

        // Keyset опублікованою мовою: провідна межа в умові індексу, без сортування.
        const page = await keysetRead(table, PUBLISHED, form.scope)
        const pagePlan = await explain(form.purpose, page.sql, page.params)
        expectArm(
          pagePlan,
          table,
          index.keyset,
          PUBLISHED,
          "\\bdescription\\)?(::\\w+)?\\s*>="
        )
        expect(sortsOver(pagePlan, table), "a sort over the page").toEqual([])
        const pageRows = await keysetExpected(
          table,
          PUBLISHED,
          form.scope,
          form.visible("published"),
          page.cursor
        )
        expect(pageRows).toHaveLength(PAGE)
        expect(
          await read(form.purpose, page.sql, page.params),
          "keyset page of a published language"
        ).toEqual(pageRows)

        // Мова `draft`: видимість за станом мови — окрема перевірка.
        const draftPrefix = prefixRead(table, DRAFT)
        expect(
          await read(form.purpose, draftPrefix.sql, draftPrefix.params),
          "prefix rows of a draft language"
        ).toEqual(await prefixExpected(table, DRAFT, form.visible("draft")))
        const draftPage = await keysetRead(table, DRAFT, OWN)
        expect(
          await read(form.purpose, draftPage.sql, draftPage.params),
          "keyset page of a draft language"
        ).toEqual(
          await keysetExpected(
            table,
            DRAFT,
            OWN,
            form.visible("draft"),
            draftPage.cursor
          )
        )
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT translations_form")
      }
    },
    120_000
  )
})
