import { beforeAll, describe, expect, it } from "vitest"
import {
  compile,
  loadSqlParser,
  withoutLocations,
  type AssignmentSourceContract,
  type CompiledModel,
  type SqlParser,
} from "simetra/compiler"
import type { ApplyTransaction } from "../port"
import {
  RIGHTS_SOURCE_LIMIT,
  readRightsSourceFacts,
  rightsSourceDiagnostics,
  rightsSourceInput,
  unknownKeysQuery,
  type RightsSourceFacts,
} from "../rights-sources"
import {
  ADOPTED_LEAD_KEY,
  ADOPTED_MEMBER_KEY,
  ADOPTED_SUPPORT_KEY,
  adoptedSourcesDomain,
  polymorphicGrants,
} from "../../../compiler/__tests__/fixtures/rights"

let parse: SqlParser
let adopted: CompiledModel
let poly: CompiledModel
beforeAll(async () => {
  parse = await loadSqlParser()
  adopted = (await compile(adoptedSourcesDomain())).model!
  poly = (await compile(adoptedSourcesDomain(polymorphicGrants()))).model!
})

const sourceNamed = (
  model: CompiledModel,
  name: string
): AssignmentSourceContract => {
  const found = model.contracts.assignmentSources.find((s) => s.name === name)
  if (found === undefined) throw new Error(`no source ${name}`)
  return found
}

/** SQL як дерево без позицій: форма запиту, а не пробіли. */
function tree(sql: string): unknown {
  const parsed = parse(sql)
  if (!parsed.ok) throw new Error(`SQL does not parse: ${sql}`)
  expect(parsed.statements).toHaveLength(1)
  return withoutLocations(parsed.statements[0]!.stmt)
}

const tables = (n: number) =>
  Array.from({ length: n }, (_, i) => `public.t${String(i).padStart(2, "0")}`)

describe("rightsSourceDiagnostics", () => {
  it.each([
    {
      case: "a table the apply role cannot read past RLS",
      facts: {
        owners: [
          { table: "public.membership", owned: true },
          { table: "public.role_grant", owned: false },
        ],
        unknownKeys: [],
      },
      refusal: { tables: "public.role_grant" },
      warnings: [],
    },
    {
      case: "more refused tables than the limit",
      facts: {
        owners: tables(25).map((table) => ({ table, owned: false })),
        unknownKeys: [],
      },
      refusal: {
        tables: [...tables(RIGHTS_SOURCE_LIMIT), "… (+5)"].join(", "),
      },
      warnings: [],
    },
    {
      case: "every table readable",
      facts: {
        owners: tables(3).map((table) => ({ table, owned: true })),
        unknownKeys: [{ source: "grants", keys: [], more: 0 }],
      },
      refusal: undefined,
      warnings: [],
    },
    {
      case: "unknown keys",
      facts: {
        owners: [{ table: "public.role_grant", owned: true }],
        unknownKeys: [
          { source: "grants", keys: ["boss", "chief"], more: 3 },
          { source: "globalGrants", keys: ["root"], more: 0 },
        ],
      },
      refusal: undefined,
      warnings: [
        { source: "grants", keys: "boss, chief", more: 3 },
        { source: "globalGrants", keys: "root", more: 0 },
      ],
    },
  ] satisfies {
    case: string
    facts: RightsSourceFacts
    refusal: Record<string, string> | undefined
    warnings: Record<string, string | number>[]
  }[])("$case", ({ facts, refusal, warnings }) => {
    const result = rightsSourceDiagnostics(facts)
    if (refusal === undefined) expect(result.refusal).toBeUndefined()
    else
      expect(result.refusal).toMatchObject({
        code: "plan.rights-source-access",
        severity: "error",
        params: refusal,
      })
    expect(result.warnings.map((w) => [w.code, w.severity, w.params])).toEqual(
      warnings.map((params) => [
        "plan.rights-source-unknown-keys",
        "warning",
        params,
      ])
    )
  })
})

describe("readRightsSourceFacts", () => {
  /**
   * Фейкова ціль: `present` — таблиці, які бачить `to_regclass`, з фактом
   * доступу; `missingColumns` — колонки, яких `pg_attribute` не має. Журнал —
   * кожен запит із параметрами.
   */
  function fakeTarget(o: {
    present: Partial<Record<string, boolean>>
    missingColumns?: string[]
  }) {
    const log: { sql: string; params: readonly unknown[] }[] = []
    const answer = (sql: string, params: readonly unknown[]): unknown[] => {
      if (sql.includes("current_setting(s.name)"))
        return (params[0] as string[]).map(() => ({ value: "on" }))
      if (sql.includes("AS source_owned")) {
        const [schemas, names] = params as [string[], string[]]
        return schemas.flatMap((schema, i) => {
          const owned = o.present[`${schema}.${names[i]}`]
          return owned === undefined
            ? []
            : [
                {
                  table_schema: schema,
                  table_name: names[i],
                  source_owned: owned,
                },
              ]
        })
      }
      if (sql.includes("AS source_column")) {
        const [schemas, names, columns] = params as [
          string[],
          string[],
          string[],
        ]
        return schemas
          .map((schema, i) => ({
            table_schema: schema,
            table_name: names[i],
            source_column: columns[i],
          }))
          .filter(
            (c) =>
              !(o.missingColumns ?? []).includes(
                `${c.table_schema}.${c.table_name}.${c.source_column}`
              )
          )
      }
      if (sql.includes("AS unknown_key"))
        return [{ unknown_key: "stale", total: "1" }]
      return []
    }
    const tx: ApplyTransaction = {
      query: async <R extends Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = []
      ) => {
        log.push({ sql, params })
        return answer(sql, params) as R[]
      },
      extract: () => Promise.reject(new Error("no extract expected")),
    }
    return { tx, log }
  }

  it.each([
    {
      case: "a missing table",
      present: { "public.membership": true, "public.role_grant": true },
      missingColumns: [],
      read: ["grants"],
    },
    {
      case: "an unowned table",
      present: {
        "public.membership": true,
        "public.role_grant": true,
        "public.global_grant": false,
      },
      missingColumns: [],
      read: ["grants"],
    },
    {
      case: "a missing column",
      present: {
        "public.membership": true,
        "public.role_grant": true,
        "public.global_grant": true,
      },
      missingColumns: ["public.role_grant.role_key"],
      read: ["globalGrants"],
    },
    {
      // Р2d1-11: з'єднання `sr` з недоступною таблицею ролей впало б `42501`
      case: "an unowned role table",
      poly: true,
      present: {
        "public.membership": true,
        "public.role_grant": true,
        "public.global_grant": true,
        "public.poly_grants": true,
        "public.source_roles": false,
      },
      missingColumns: [],
      read: ["grants", "globalGrants"],
    },
    {
      case: "a missing role table",
      poly: true,
      present: {
        "public.membership": true,
        "public.role_grant": true,
        "public.global_grant": true,
        "public.poly_grants": true,
      },
      missingColumns: [],
      read: ["grants", "globalGrants"],
    },
  ])(
    "reads data with row security off and skips $case",
    async ({ present, missingColumns, read, ...o }) => {
      const model = "poly" in o && o.poly ? poly : adopted
      // Р2d1-10, Р2d1-11: дані — лише під `row_security = off` (на RLS без
      // обходу — гучна помилка, не тихий нуль); таблиці, якої немає, чи якій
      // відмовлено, і колонки, якої ще немає, не читаються.
      const target = fakeTarget({ present, missingColumns })
      const input = rightsSourceInput(model.contracts)
      const facts = await readRightsSourceFacts(target.tx, input)

      const setConfig = target.log.findIndex(
        (q) =>
          q.sql.includes("set_config") &&
          JSON.stringify(q.params) ===
            JSON.stringify([["row_security"], ["off"]])
      )
      const reads = target.log
        .map((q, i) => ({ ...q, i }))
        .filter((q) => q.sql.includes("AS unknown_key"))
      expect(setConfig).toBeGreaterThanOrEqual(0)
      expect(reads).toHaveLength(read.length)
      for (const q of reads) expect(q.i).toBeGreaterThan(setConfig)
      expect(reads.map((q) => q.sql)).toEqual(
        read.map((name) => unknownKeysQuery(sourceNamed(model, name)).sql)
      )
      expect(facts.unknownKeys.map((u) => u.source)).toEqual(read)
      expect(facts.owners).toEqual(
        Object.entries(present).map(([table, owned]) => ({ table, owned }))
      )
    }
  )

  it("refuses a table in a schema the apply role cannot use instead of missing it", async () => {
    // Р2d1-10: `to_regclass` на схемі без `USAGE` кидає сирий `42501`, тож
    // таблицю шукають за іменем у каталозі, а `USAGE` на схемі — частина
    // доступу: така таблиця — відмова, а не відсутня (фейк відповідає за
    // ціль, тож форма запиту перевіряється тут же).
    const target = fakeTarget({
      present: {
        "public.membership": true,
        "public.role_grant": true,
        "public.global_grant": false,
      },
    })
    const facts = await readRightsSourceFacts(
      target.tx,
      rightsSourceInput(adopted.contracts)
    )
    const catalog = target.log.filter(
      (q) =>
        q.sql.includes("AS source_owned") || q.sql.includes("AS source_column")
    )
    expect(catalog).toHaveLength(2)
    for (const q of catalog) expect(q.sql).not.toContain("to_regclass")
    expect(catalog[0]!.sql).toContain(
      "pg_catalog.has_schema_privilege(CURRENT_USER, n.oid, 'USAGE')"
    )
    expect(rightsSourceDiagnostics(facts).refusal).toMatchObject({
      code: "plan.rights-source-access",
      params: { tables: "public.global_grant" },
    })
  })

  it("passes the known keys of the source as a parameter", async () => {
    const target = fakeTarget({
      present: {
        "public.membership": true,
        "public.role_grant": true,
        "public.global_grant": true,
      },
    })
    const facts = await readRightsSourceFacts(
      target.tx,
      rightsSourceInput(adopted.contracts)
    )
    expect(
      target.log
        .filter((q) => q.sql.includes("AS unknown_key"))
        .map((q) => q.params)
    ).toEqual([[[ADOPTED_LEAD_KEY]], [[ADOPTED_SUPPORT_KEY]]])
    expect(facts.unknownKeys).toEqual([
      { source: "grants", keys: ["stale"], more: 0 },
      { source: "globalGrants", keys: ["stale"], more: 0 },
    ])
  })
})

describe("unknownKeysQuery", () => {
  const LIST = (key: string, from: string, where: string) =>
    `SELECT k.key AS unknown_key, pg_catalog.count(*) OVER () AS total FROM (SELECT DISTINCT ${key}::text AS key FROM ${from} WHERE ${key} IS NOT NULL${where} AND NOT (${key}::text = ANY ($1::text[]))) k ORDER BY k.key COLLATE "C" LIMIT ${RIGHTS_SOURCE_LIMIT}`

  it("the keys query reads the role table through the same join and conditions", () => {
    // Р2d1-11, Р2d1-18: те саме з'єднання й ті самі умови, що в `rights_mine`
    // (DB-кейс `poly-plan-keys`, Задача 5).
    const query = unknownKeysQuery(sourceNamed(poly, "polyGrants"))
    expect(tree(query.sql)).toEqual(
      tree(
        LIST(
          "sr.key",
          "public.poly_grants src JOIN public.source_roles sr ON sr.id = src.role_id AND sr.org_id IS NULL",
          " AND src.scope_type = 'org'"
        )
      )
    )
    const roles = { schema: "public", name: "source_roles" }
    const grants = { schema: "public", name: "poly_grants" }
    expect(query.columns).toEqual([
      { table: grants, column: "role_id" },
      { table: grants, column: "scope_type" },
      { table: roles, column: "id" },
      { table: roles, column: "key" },
      { table: roles, column: "org_id" },
    ])
  })

  it.each([
    { case: "without an active column", active: undefined, where: "" },
    {
      case: "with a mapped active column",
      active: "is_active",
      where: " AND src.is_active IS TRUE",
    },
  ])(
    "a key column source reads the key directly ($case)",
    ({ active, where }) => {
      const source = {
        ...sourceNamed(adopted, "grants"),
        ...(active === undefined ? {} : { active }),
      }
      const query = unknownKeysQuery(source)
      expect(tree(query.sql)).toEqual(
        tree(LIST("src.role_key", "public.role_grant src", where))
      )
      const table = { schema: "public", name: "role_grant" }
      expect(query.columns).toEqual([
        { table, column: "role_key" },
        ...(active === undefined ? [] : [{ table, column: active }]),
      ])
    }
  )
})

describe("rightsSourceInput", () => {
  it("checks the owner of a role table", () => {
    // Р2d1-10, Р2d1-17: таблиця ролей підлягає тій самій перевірці доступу.
    const input = rightsSourceInput(poly.contracts)
    const names = input.tables.map((t) => `${t.schema}.${t.name}`)
    expect([...names].sort()).toEqual(
      [
        "public.global_grant",
        "public.membership",
        "public.poly_grants",
        "public.role_grant",
        "public.source_roles",
      ].sort()
    )
    expect(
      input.assignments.map((a) => [a.source.name, [...a.keys].sort()])
    ).toEqual([
      ["grants", [ADOPTED_LEAD_KEY]],
      ["globalGrants", [ADOPTED_SUPPORT_KEY]],
      ["polyGrants", [ADOPTED_MEMBER_KEY]],
      ["polyContainerGrants", [ADOPTED_LEAD_KEY]],
    ])
  })
})
