import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  PLATFORM_ROLES,
  keysetFilter,
  type Filter,
  type KeysetCursor,
  type OrderBy,
  type RuntimeCatalog,
} from "simetra/model"
import { uuid } from "../../src/compiler/__tests__/helpers"
import {
  ROLE_FILE,
  adminRoles,
  catalog as catalogObject,
  compileRights,
  grant,
  objects,
  policyDomain,
  refAttribute,
  role,
  type Layer,
} from "../../src/compiler/__tests__/fixtures/rights"
import { fieldInfoOf, nullableOf } from "../../src/data/store/filter"
import { buildRuntimeCatalog } from "../../src/compiler/runtime-catalog"
import { prepareRead } from "../../src/server/read"
import { signUp } from "./auth"
import { queryAs, runTag } from "./connection"
import { type PlanNode, planNodes, scansOf, sortsOver } from "./explain-plan"
import {
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
} from "./rights-seed"

/**
 * План keyset-сторінки під RLS (спека П4-B §6.4, рішення плану B1d Р2, Р8):
 * чи читає кожен оголошений порядок списку сторінку зі свого індексу, не
 * сортуючи видиму множину і не читаючи рядків до курсора, — вирішує
 * планувальник Postgres на засіві з реальною статистикою, а політики RLS
 * (предикат скоупу в `Index Cond`) бачить лише справжня база. Компілятор
 * бачить тільки форму індексів, юніт-тест — тільки текст умови. Одне
 * розгортання й один засів на опис; транзакція опису відкочується, тож на
 * стеку нічого не лишається.
 *
 * Засів: два скоупи по `SCOPE_ROWS` рядків довідника `Listing`; читач
 * бачить лише перший (другий для нього чужий). Розподіл значень задає розмір груп
 * рівних значень: від 100 рядків (`a`) до 20 000 (`s`).
 */

const SCOPE_ROWS = 100_000
const REGIONS_PER_SCOPE = 500
const PAGE = 100
/** Рядків скоупу з однаковим `a`: `a = g % 1000`. */
const A_GROUP = SCOPE_ROWS / 1000
const TABLE = "listing"
/** Рівність скоупу з літералом у `Index Cond`: те, що дає порядок індексу. */
const SCOPE_EQUALITY = /\borg_id = '[0-9a-f-]{36}'/

const LISTING_FILE = "catalogs/Listing/Listing.meta.json"
const LISTING_READER_ID = uuid(9300)

const integer = (
  id: number,
  name: string,
  extra: Record<string, unknown> = {}
) => ({
  id: uuid(id),
  name,
  physicalName: name,
  type: "Integer",
  required: true,
  ...extra,
})

/**
 * Довідник скоупу `org` з усіма видами індексу порядку (Р2): `indexed`,
 * `unique`, складений з `desc`, `indexed` `Ref`; `description` — стандартний.
 */
function listingLayer(): Layer {
  return {
    [LISTING_FILE]: catalogObject(uuid(9100), "Listing", TABLE, {
      attributes: [
        integer(9101, "a", { indexed: true }),
        integer(9102, "s", { indexed: true }),
        integer(9103, "n", { indexed: true, required: false }),
        integer(9104, "u", { unique: true }),
        integer(9105, "b"),
        {
          ...refAttribute(9106, "r", "r_id", {
            kind: "Catalog",
            name: "Region",
          }),
          required: true,
          indexed: true,
        },
      ],
      indexes: [{ attributes: ["a", { name: "b", order: "desc" }] }],
    }),
    [ROLE_FILE("ListingReader")]: role(
      LISTING_READER_ID,
      "ListingReader",
      { scopeKind: "org" },
      { grants: [grant(objects(["Catalog", "Listing"]), ["read"], "any")] }
    ),
  }
}

interface Case {
  name: string
  orderBy: OrderBy
  /** Колонки очікуваного індексу так, як їх друкує `pg_get_indexdef`. */
  index: string
  /** Вид індексу: `unique` — UNIQUE-обмеження. */
  kind?: "unique"
  /**
   * Сортування над видимою множиною: `none` — жодного; `incremental` —
   * Incremental Sort за ключем (повний Sort — ніколи); `any` — лише
   * фіксується (відоме обмеження §4.2).
   */
  sort: "none" | "incremental" | "any"
  /** Ім'я очікуваного індексу, коли воно частина контракту плану. */
  indexName?: string
  /** Розмір групи рівних значень порядку в скоупі (за замовчуванням 1). */
  group?: number
  /** Колонка провідної межі в `Index Cond`; без неї межі не вимагають. */
  bound?: string
  /** Бюджет прочитаних рядків сторінки (вузол таблиці). */
  readBudget?: number
  /**
   * Межу `Index Cond` і бюджет читання не судити, лише записати числа
   * («Виміри» плану): відоме обмеження Р8(2) для nullable-колонок.
   */
  record?: true
}

/** Порядки таблиці з Task 5 плану B1d. */
const CASES: Case[] = [
  {
    name: "a",
    orderBy: [{ attribute: "a", direction: "asc" }],
    index: "org_id, a, id",
    sort: "none",
    bound: "a",
    group: A_GROUP,
    readBudget: PAGE + A_GROUP + 1,
  },
  {
    name: "a desc",
    orderBy: [{ attribute: "a", direction: "desc" }],
    index: "org_id, a, id",
    sort: "incremental",
    bound: "a",
    group: A_GROUP,
  },
  {
    name: "a, b desc",
    orderBy: [
      { attribute: "a", direction: "asc" },
      { attribute: "b", direction: "desc" },
    ],
    index: "org_id, a, b DESC, id",
    sort: "none",
    bound: "a",
    group: A_GROUP,
  },
  {
    name: "r",
    orderBy: [{ attribute: "r", direction: "asc" }],
    index: "org_id, r_id, id",
    sort: "none",
    bound: "r_id",
    group: SCOPE_ROWS / REGIONS_PER_SCOPE,
  },
  {
    name: "description",
    orderBy: [{ attribute: "description", direction: "asc" }],
    index: "org_id, description, id",
    sort: "none",
    // Стандартне найменування — NOT NULL DEFAULT '' (Р9): keyset без гілки
    // NULL, межа — діапазон індексу, критерій як у `a` (значення унікальні).
    bound: "description",
    group: 1,
    readBudget: PAGE + 1 + 1,
  },
  {
    name: "u",
    orderBy: [{ attribute: "u", direction: "asc" }],
    index: "org_id, u",
    kind: "unique",
    sort: "incremental",
    bound: "u",
  },
  {
    name: "key",
    orderBy: [],
    // Читання йде UNIQUE-індексом (org_id, id), який є в таблиці для FK
    // скоупу, а не PK (id): скоуп у `Index Cond` дає той самий порядок.
    index: "org_id, id",
    indexName: "listing_org_id_id_key",
    kind: "unique",
    sort: "none",
    readBudget: PAGE + 1,
  },
  {
    name: "s",
    orderBy: [{ attribute: "s", direction: "asc" }],
    index: "org_id, s, id",
    sort: "none",
    group: SCOPE_ROWS / 5,
    record: true,
  },
  {
    name: "n",
    orderBy: [{ attribute: "n", direction: "asc" }],
    index: "org_id, n, id",
    sort: "any",
    record: true,
  },
]

/** Колонка таблиці для атрибута порядку. */
const COLUMN: Record<string, string> = {
  a: "a",
  b: "b",
  s: "s",
  n: "n",
  u: "u",
  r: "r_id",
  description: "description",
}

type Page = "first" | "middle" | "end"
/** Зсув рядка-курсора в порядку скоупу; перша сторінка курсора не має. */
const OFFSET: Record<Exclude<Page, "first">, number> = {
  middle: SCOPE_ROWS / 2 - 1,
  end: SCOPE_ROWS - PAGE - 1,
}

/** Короткий опис вузлів таблиці для повідомлень і журналу вимірів. */
const describe_ = (nodes: PlanNode[]) =>
  nodes.map((n) => ({
    type: n.type,
    index: n.arms.map((a) => a.index).join(","),
    cond: n.arms.map((a) => a.condition).join(" ; "),
    filter: n.filter,
    rows: n.rows,
    removed: n.rowsRemovedByFilter ?? 0,
    ms: n.time,
  }))

describe("list order plans under RLS", () => {
  const tx = describeTransaction()
  let catalog: RuntimeCatalog
  let keyName: string
  let keyColumn: string
  let scopeAttribute: string
  let nullable: (attribute: string) => boolean
  let foreignScope: string
  let scope: string
  let reader: string
  /** Індекси таблиці: ім'я → колонки, вид. */
  const indexes = new Map<string, { keys: string; unique: boolean }>()

  beforeAll(async () => {
    const result = await compileRights(
      policyDomain(adminRoles(), listingLayer())
    )
    expect(result.diagnostics).toEqual([])
    catalog = buildRuntimeCatalog(result.model!)
    const listing = catalog.objects.find((o) => o.name === "Listing")!
    keyName = listing.keyName
    keyColumn = listing.key
    scopeAttribute = listing.attributes.find(
      (a) => a.column === listing.scopeColumn
    )!.name
    nullable = nullableOf(fieldInfoOf(listing))
    const client = await tx.open()
    await deploy(client, result.model!)
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
    )
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )

    // Читач — учасник першого скоупу; другий скоуп повний, але читачу чужий.
    reader = await signUp(client)
    const orgs = [uuid(9901), uuid(9902)]
    scope = orgs[0]!
    foreignScope = orgs[1]!
    for (const id of orgs) await insert(client, "organization", { id })
    const member = uuid(9910)
    await insert(client, "org_member", {
      id: member,
      org_id: scope,
      user_id: reader,
    })
    await insert(client, "org_role_assignments", {
      org_id: scope,
      ...assignmentRow(member, { archetype: LISTING_READER_ID }),
    })
    const filled = [orgs[0], orgs[1]]
    await client.query(
      `INSERT INTO public.region (id, org_id)
       SELECT gen_random_uuid(), o FROM unnest($1::uuid[]) AS o CROSS JOIN generate_series(1, $2)`,
      [filled, REGIONS_PER_SCOPE]
    )
    // Значення розкидані за номером рядка, а не за порядком вставки: фізична
    // кореляція колонки зробила б індексне читання дешевшим, ніж воно є.
    await client.query(
      `INSERT INTO public.${TABLE} (id, org_id, description, a, s, n, u, b, r_id)
       SELECT gen_random_uuid(), o.id, md5(o.id::text || g), g % 1000, g % 5,
              CASE WHEN g % 10 < 3 THEN NULL ELSE (g * 7) % 1000 END,
              g, (g * 13) % 100, r.id
       FROM unnest($1::uuid[]) AS o(id)
       CROSS JOIN generate_series(1, $2) AS g
       JOIN (SELECT org_id, id, row_number() OVER (PARTITION BY org_id ORDER BY id) - 1 AS k
             FROM public.region) r ON r.org_id = o.id AND r.k = g % $3`,
      [filled, SCOPE_ROWS, REGIONS_PER_SCOPE]
    )
    // Без статистики планувальник оцінює таблицю за замовчуванням; лише
    // таблиці фікстури — не вся спільна база.
    await client.query(`ANALYZE public.${TABLE}, public.region`)

    const { rows } = await client.query<{
      name: string
      def: string
      unique: boolean
    }>(
      `SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS def,
              i.indisunique AS "unique"
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'public.${TABLE}'::regclass`
    )
    for (const row of rows) {
      const keys = /USING btree \((.*?)\)(?: WHERE .*)?$/.exec(row.def)?.[1]
      expect(keys, row.def).toBeDefined()
      indexes.set(row.name, {
        keys: keys!,
        unique: row.unique,
      })
    }
  }, 300_000)

  afterAll(() => tx.close())

  /** Рядок-курсор порядку: значення колонок порядку й ключ рядка зі зсувом `offset`. */
  const cursorAt = async (
    order: OrderBy,
    offset: number
  ): Promise<KeysetCursor> => {
    const terms = [
      ...order.map(
        (o) => `${COLUMN[o.attribute]}${o.direction === "desc" ? " DESC" : ""}`
      ),
      keyColumn,
    ]
    const { rows } = await tx
      .client()
      .query<Record<string, unknown>>(
        `SELECT * FROM public.${TABLE} WHERE org_id = $1 ORDER BY ${terms.join(", ")} OFFSET $2 LIMIT 1`,
        [scope, offset]
      )
    const row = rows[0]!
    return {
      values: Object.fromEntries(
        order.map((o) => [o.attribute, row[COLUMN[o.attribute]!]])
      ),
      key: row[keyColumn] as string,
      direction: "after",
    }
  }

  /** Оператор сторінки, збудований T3 з умовою `where`. */
  const statementOf = (orderBy: OrderBy, where?: Filter) => {
    const prepared = prepareRead(catalog, {
      object: { kind: "Catalog", name: "Listing" },
      limit: PAGE,
      ...(orderBy.length === 0 ? {} : { orderBy }),
      ...(where === undefined ? {} : { where }),
    })
    if ("error" in prepared)
      throw new Error(`prepareRead refused: ${JSON.stringify(prepared.error)}`)
    return prepared.plan.statement
  }

  /** План `EXPLAIN (ANALYZE, FORMAT JSON)` від імені `user`; другий прогін — прогрітий. */
  const explain = async (
    user: string,
    statement: { text: string; params: (string | null)[] }
  ): Promise<unknown> => {
    let plan: unknown
    for (let run = 0; run < 2; run++) {
      const result = await queryAs<{ "QUERY PLAN": unknown }>(
        tx.client(),
        "authenticated",
        { sub: user, role: "authenticated" },
        `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
        statement.params
      )
      if (!("rows" in result)) throw new Error(`EXPLAIN failed: ${result.code}`)
      plan = result.rows[0]!["QUERY PLAN"]
    }
    return plan
  }

  /** Сторінка порядку: план читання від імені `user` і число повернутих рядків. */
  const pageOf = async (
    user: string,
    c: Case,
    page: Page,
    options: {
      mutate?: (where: Filter, cursor: KeysetCursor) => Filter
      scopeId?: string
    } = {}
  ) => {
    // Запит списку одного скоупу несе рівність скоупу явно: політики RLS дають
    // лише `org_id = ANY (набір)`, що порядку індексу не дає.
    const scopeEquals: Filter = {
      attribute: scopeAttribute,
      op: "eq",
      value: options.scopeId ?? scope,
    }
    let where: Filter = scopeEquals
    if (page !== "first") {
      const cursor = await cursorAt(c.orderBy, OFFSET[page])
      const keyset = keysetFilter(c.orderBy, cursor, keyName, nullable)
      where = {
        and: [scopeEquals, options.mutate?.(keyset, cursor) ?? keyset],
      }
    }
    const plan = await explain(user, statementOf(c.orderBy, where))
    return {
      plan,
      scans: scansOf(plan, TABLE),
      sorts: sortsOver(plan, TABLE),
      returned: planNodes(plan)[0]!.rows ?? 0,
    }
  }

  /**
   * Порушення правил плану сторінки порядку `c` (порожній список — план
   * правильний). Ті самі правила судять справжні порядки і негативні
   * контролі: контроль червоний, лише коли правило справді ловить мутацію.
   */
  const violations = (
    c: Case,
    scans: PlanNode[],
    sorts: { type: string; input: number }[],
    page: Page
  ): string[] => {
    const found: string[] = []
    if (scans.length === 0) return ["the table is not read"]
    if (scans.some((n) => n.type === "Seq Scan")) found.push("Seq Scan")
    const arms = scans.flatMap((n) => n.arms)
    // Хвіст за курсором (≤ сторінка + група рівних) планувальник вільний читати
    // bitmap-ом іншого індексу таблиці з малим Sort — це не сортування видимої
    // множини (Рд43), тож порядок індексу тут не вимагають, а межують роботу:
    // вхід Sort і прочитані рядки не більші за хвіст.
    const bound = PAGE + (c.group ?? 1) + 1
    const tail = page === "end" && sorts.length > 0
    const wanted = arms.filter((a) => {
      const index = indexes.get(a.index)
      return (
        index !== undefined &&
        index.keys === c.index &&
        (c.kind !== "unique" || index.unique) &&
        (c.indexName === undefined || a.index === c.indexName)
      )
    })
    if (!tail && wanted.length === 0)
      found.push(
        `index (${c.index}) is not read: ${arms.map((a) => `${a.index} (${indexes.get(a.index)?.keys})`).join("; ")}`
      )
    if (!arms.every((a) => SCOPE_EQUALITY.test(a.condition)))
      found.push("scope is not in Index Cond")
    const types = sorts.map((x) => x.type)
    if (tail) {
      for (const x of sorts)
        if (x.input > bound)
          found.push(`${x.type} of ${x.input} rows, tail bound ${bound}`)
    } else if (c.sort !== "any") {
      if (types.includes("Sort")) found.push("full Sort")
      if (c.sort === "none" && types.length > 0)
        found.push(`sort: ${types.join(", ")}`)
      if (c.sort === "incremental" && !types.includes("Incremental Sort"))
        found.push("Incremental Sort by key is expected")
    }
    if (
      c.bound !== undefined &&
      c.record !== true &&
      page !== "first" &&
      !tail
    ) {
      // `varchar` порівнюється як `(description)::text >= …`: дужка й приведення
      // типу стоять між іменем колонки і знаком
      const leading = new RegExp(`\\b${c.bound}\\)?(::\\w+)?\\s*[<>]=`)
      if (!wanted.some((a) => leading.test(a.condition)))
        found.push(`no leading bound on ${c.bound} in Index Cond`)
    }
    const read = scans.reduce(
      (sum, n) =>
        sum + ((n.rows ?? 0) + (n.rowsRemovedByFilter ?? 0)) * (n.loops ?? 1),
      0
    )
    if (tail && read > bound)
      found.push(`tail read ${read} rows, bound ${bound}`)
    if (c.readBudget !== undefined && c.record !== true && read > c.readBudget)
      found.push(`read ${read} rows, budget ${c.readBudget}`)
    return found
  }

  const PAGES: Page[] = ["first", "middle", "end"]

  it.each(CASES.flatMap((c) => PAGES.map((page) => ({ c, page }))))(
    "order $c.name, $page page: reads its index under RLS",
    async ({ c, page }) => {
      const { scans, sorts, returned } = await pageOf(reader, c, page)
      console.info(
        `list-order-plan ${c.name} / ${page}: returned ${returned}, sorts ${JSON.stringify(sorts)}, ${JSON.stringify(describe_(scans))}`
      )
      expect(returned, "the page has rows").toBeGreaterThan(0)
      expect(violations(c, scans, sorts, page)).toEqual([])
    }
  )

  it("a foreign scope reads no rows: RLS applies, no Seq Scan, scope equality in Index Cond", async () => {
    const c = CASES[0]!
    const { scans, returned } = await pageOf(reader, c, "middle", {
      scopeId: foreignScope,
    })
    expect(returned, "rows of a foreign scope").toBe(0)
    expect(scans.length, "the table is read").toBeGreaterThan(0)
    expect(scans.filter((n) => n.type === "Seq Scan")).toEqual([])
    expect(scans.flatMap((n) => n.arms).length).toBeGreaterThan(0)
    expect(
      scans.every((n) => n.arms.every((a) => SCOPE_EQUALITY.test(a.condition)))
    ).toBe(true)
  })

  /** Мутація в точці збереження: DDL від власника, відкат після випадку. */
  const mutated = async <T>(
    ddl: string[],
    run: () => Promise<T>
  ): Promise<T> => {
    const client = tx.client()
    await client.query("SAVEPOINT list_order_control")
    try {
      for (const sql of ddl) await client.query(sql)
      await client.query(`ANALYZE public.${TABLE}`)
      return await run()
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT list_order_control")
    }
  }

  it("control: the old index form (org_id, s) turns the s rule red", async () => {
    const c = CASES.find((x) => x.name === "s")!
    const fresh = [...indexes].find(([, i]) => i.keys === c.index)![0]
    const { scans, sorts } = await mutated(
      [
        `DROP INDEX public.${fresh}`,
        `CREATE INDEX list_order_ctl_${runTag()} ON public.${TABLE} (org_id, s)`,
      ],
      () => pageOf(reader, c, "middle")
    )
    console.info(
      `list-order-plan control s: sorts ${JSON.stringify(sorts)}, ${JSON.stringify(describe_(scans))}`
    )
    expect(sorts.length, "a Sort over the visible set").toBeGreaterThan(0)
  })

  it("control: keyset without the leading bound turns the a rule red", async () => {
    const c = CASES.find((x) => x.name === "a")!
    const noBound = (_: Filter, cursor: KeysetCursor): Filter => ({
      or: [
        { attribute: "a", op: "gt", value: cursor.values.a },
        {
          and: [
            { attribute: "a", op: "eq", value: cursor.values.a },
            { attribute: keyName, op: "gt", value: cursor.key },
          ],
        },
      ],
    })
    const { scans, sorts } = await pageOf(reader, c, "middle", {
      mutate: noBound,
    })
    console.info(
      `list-order-plan control a: sorts ${JSON.stringify(sorts)}, ${JSON.stringify(describe_(scans))}`
    )
    // Правило межі (регулярка) тут спрацьовує завжди, тож контроль судить саме
    // бюджет читання — єдину перевірку розбору `rowsRemovedByFilter`; зелений
    // базис того самого правила — сторінка з провідною межею.
    expect(
      violations(c, scans, sorts, "middle").filter((v) => v.startsWith("read "))
    ).not.toEqual([])
    const baseline = await pageOf(reader, c, "middle")
    expect(violations(c, baseline.scans, baseline.sorts, "middle")).toEqual([])
  })
})
