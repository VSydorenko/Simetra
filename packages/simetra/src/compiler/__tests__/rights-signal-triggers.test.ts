import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import { PROVIDER_API_ROLES, ZERO_UUID } from "simetra/model"
import { buildClientCatalog } from "../client-catalog"
import { buildRuntimeCatalog } from "../runtime-catalog"
import { buildRightsSignalUnits } from "../rights/signal-triggers"
import { snapshotSources } from "../rights/snapshot-sources"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import type { SqlUnit, VerbatimUnit } from "../sql/units"
import {
  ADOPTED_LEAD_KEY,
  BENCH_ZONE_TABLE,
  EVERYONE_ID,
  ORG_KIND_ID,
  POLY_GRANT_FILE,
  ROLE_FILE,
  SNAPSHOT_ORG_GUEST_TABLE,
  SNAPSHOT_USER_BADGE_TABLE,
  SOURCE_ROLE_FILE,
  TEAM_KIND_ID,
  adminRoles,
  adoptedSourcesDomain,
  commandCoreLayer,
  compileRights,
  policyDomain,
  polyContainerGrantsSource,
  polyGrantTable,
  rightsFiles,
  role,
  snapshotSourcesDomain,
  sourceRoleTable,
  writeRoles,
} from "./fixtures/rights"
import { bodyShape, loadShapeParsers, tree } from "./fixtures/sql-shape"
import { acceptDebt, catalog, expectClean, metaFiles, project } from "./helpers"

/**
 * Генератор тригерів сигналу прав (спека П4-B §8.2, Р9): на кожну модельну
 * таблицю фактів з аналізу джерел знімка — операторний AFTER-тригер, що кличе
 * `signal_rights` чи `signal_user_rights`. Що Postgres з ними робить —
 * DB-тест `rights-signals`; тут — множина таблиць, канали й форма одиниць.
 */

let parse: SqlParser
let plpgsql: PlpgsqlParser
let policy: CompiledModel
let sources: CompiledModel
let noCatalogs: CompiledModel
beforeAll(async () => {
  ;[parse, plpgsql] = await Promise.all([loadSqlParser(), loadPlpgsqlParser()])
  await loadShapeParsers()
  const compiled = async (
    files: Map<string, string>,
    allow: Parameters<typeof expectClean>[1] = {}
  ) => {
    const result = await compileRights(files)
    expectClean(result, allow)
    return result.model!
  }
  policy = await compiled(policyDomain(writeRoles()))
  sources = await compiled(snapshotSourcesDomain(), {
    allow: ["rights.adopted-source-writes"],
  })
  // Функції прав без жодного довідника прав: членство й «Користувачі» —
  // таблиці фактів і без знімка актора (Р9).
  noCatalogs = await compiled(
    rightsFiles({
      [ROLE_FILE("Everyone")]: role(EVERYONE_ID, "Everyone", "everyUser"),
    }),
    { allow: ["rights.scope-kind-unread"] }
  )
})

const signalUnits = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "rightsSignal")

const named = (t: { schema: string; name: string }) => `${t.schema}.${t.name}`

/** Таблиця тригера з дерева `CreateTrigStmt`: генератор кваліфікує її схемою. */
function triggerTable(unit: SqlUnit): string {
  const relation = (
    unit.tree as {
      CreateTrigStmt: { relation: { schemaname: string; relname: string } }
    }
  ).CreateTrigStmt.relation
  return `${relation.schemaname}.${relation.relname}`
}

const triggeredTables = (model: CompiledModel) =>
  [
    ...new Set(
      signalUnits(model)
        .filter((u) => u.class === "trigger")
        .map(triggerTable)
    ),
  ].sort()

/** Вхід аналізу джерел з моделі — як у конвеєрі, без запобіжників і сигналів. */
function sourcesOf(model: CompiledModel) {
  const verbatim: VerbatimUnit[] = model.sqlUnits
    .filter((u) => u.generator === undefined)
    .map((u) => ({ ...u, file: u.file!, line: u.line! }))
  return snapshotSources({
    contracts: {
      ...model.contracts,
      scopeSetFunctions: model.scopeKinds
        .filter((k) =>
          model.project.scopeKinds.some(
            (d) => d.id === k.id && typeof d.setFunction !== "string"
          )
        )
        .map((k) => ({ scopeKindId: k.id, fn: k.setFunction })),
    },
    physical: model.physical,
    objects: model.objects,
    generated: model.sqlUnits.filter(
      (u) =>
        u.generator !== undefined &&
        u.generator !== "rightsGuards" &&
        u.generator !== "rightsSignal"
    ),
    verbatim,
    attributeCase: model.project.naming.attributeCase,
    parse,
    plpgsql,
  })
}

const generatorOf = (model: CompiledModel) =>
  buildRightsSignalUnits({
    contracts: model.contracts,
    physical: model.physical,
    objects: model.objects,
    sources: sourcesOf(model),
    attributeCase: model.project.naming.attributeCase,
    provider: model.project.database.provider,
    module: model.project.name,
    parse,
  })

describe("rights signal triggers: the set of tables", () => {
  // Тест повноти (Р9): кожне джерело фактів аналізу — тригер або названий
  // виняток генератора, і нічого понад це. Винятки — рукописна мапа.
  it.each([
    ["the policy domain", () => policy, {}],
    [
      "the snapshot sources domain",
      () => sources,
      {
        [`public.${BENCH_ZONE_TABLE}`]: "verbatimFunction",
        [`public.${SNAPSHOT_ORG_GUEST_TABLE}`]: "verbatimFunction",
      },
    ],
    ["a project without rights catalogs", () => noCatalogs, {}],
  ] as const)(
    "%s: every facts table has a trigger or a named exemption",
    (_, model, exempt) => {
      const analysis = sourcesOf(model())
      const generated = generatorOf(model())
      const triggered = triggeredTables(model())
      expect(triggered.length).toBeGreaterThan(0)
      expect(
        Object.fromEntries(
          generated.exempt.map((e) => [named(e.table), e.reason])
        )
      ).toEqual(exempt)
      expect([...triggered, ...Object.keys(exempt)].sort()).toEqual(
        analysis.sources.map((s) => named(s.table)).sort()
      )
      expect(generated.unknown).toEqual([])
      // Конвеєр кладе рівно одиниці генератора.
      expect(signalUnits(model()).map((u) => u.identity)).toEqual(
        generated.units.map((u) => u.identity)
      )
    }
  )

  it("puts triggers on membership and Users of a project without rights catalogs", () => {
    expect(noCatalogs.contracts.rightsCatalogs).toEqual([])
    expect(triggeredTables(noCatalogs)).toEqual([
      "public.org_member",
      "public.users",
    ])
  })

  // `fresh: true` обіцяє клієнту сигнал прав зв'язку (Р1): кожна така
  // таблиця зв'язку — у множині тригерів.
  it("triggers every relation table the catalog calls fresh", async () => {
    // Записи каталогу рантайму — лише об'єкти з ядром команд.
    const result = await compileRights(
      policyDomain(writeRoles(), adminRoles(), commandCoreLayer())
    )
    expectClean(result)
    const model = result.model!
    const relations = new Map(
      model.contracts.accessDimensions.flatMap((d) =>
        "relation" in d.values
          ? [[d.dimensionId, named(d.values.relation.table)] as const]
          : []
      )
    )
    const fresh = buildRuntimeCatalog(model)
      .objects.flatMap((o) => o.rights?.access ?? [])
      .filter((a) => a.fresh)
      .map((a) => relations.get(a.dimensionId)!)
    expect(fresh.length).toBeGreaterThan(0)
    for (const table of fresh) expect(triggeredTables(model)).toContain(table)
  })

  // Спека прав §4.7: на прийняту таблицю платформа тригерів не ставить.
  it("puts no trigger on adopted sources and adopted relations", () => {
    const adopted = [
      "public.membership",
      "public.role_grant",
      "public.global_grant",
      "public.source_roles",
      `public.${SNAPSHOT_USER_BADGE_TABLE}`,
    ]
    const tables = new Set(
      sources.sqlUnits
        .filter((u) => u.class === "trigger" && u.file === undefined)
        .map(triggerTable)
    )
    for (const table of adopted) expect(tables, table).not.toContain(table)
  })

  // Т3: факт, який генерований код читає з таблиці невідомої форми, — помилка.
  it("reports a facts table of an unknown shape instead of skipping it", () => {
    const analysis = sourcesOf(sources)
    const zone = analysis.sources.find(
      (s) => s.table.name === BENCH_ZONE_TABLE
    )!
    const result = buildRightsSignalUnits({
      contracts: sources.contracts,
      physical: sources.physical,
      objects: sources.objects,
      sources: { sources: [{ ...zone, verbatimOnly: false }] },
      attributeCase: sources.project.naming.attributeCase,
      provider: sources.project.database.provider,
      module: sources.project.name,
      parse,
    })
    expect(result.units).toEqual([])
    expect(result.exempt).toEqual([])
    expect(result.unknown).toEqual([
      {
        table: { schema: "public", name: BENCH_ZONE_TABLE },
        facts: ["values"],
      },
    ])
  })

  it("generates nothing without rights functions", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Item/Item.meta.json": catalog("Item"),
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(
      result.model!.sqlUnits.filter((u) => u.generator === "rightsSignal")
    ).toEqual([])
  })
})

describe("rights signal triggers: units", () => {
  const fn = (model: CompiledModel, table: string) =>
    signalUnits(model).find(
      (u) =>
        u.class === "function" && u.name === `${table}_simetra_rights_signal`
    )!

  it("each function is SECURITY DEFINER with row_security off and an empty search_path, with EXECUTE for nobody", () => {
    const roles = PROVIDER_API_ROLES.supabase
    for (const table of triggeredTables(policy)) {
      const name = table.split(".")[1]!
      const unit = fn(policy, name)
      expect(unit.sql.split("\nAS ")[0], name).toBe(
        `CREATE OR REPLACE FUNCTION public.${name}_simetra_rights_signal()\nRETURNS trigger\nLANGUAGE plpgsql SECURITY DEFINER\nSET search_path = ''\nSET row_security = off`
      )
      const signature = `public.${name}_simetra_rights_signal()`
      expect(
        signalUnits(policy)
          .filter((u) => u.class === "grant" && u.sql.includes(signature))
          .map((u) => u.sql)
          .sort()
      ).toEqual(
        [
          `REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC;`,
          `REVOKE EXECUTE ON FUNCTION ${signature} FROM ${roles.anonymous};`,
          `REVOKE EXECUTE ON FUNCTION ${signature} FROM ${roles.user};`,
          `REVOKE EXECUTE ON FUNCTION ${signature} FROM ${roles.service};`,
        ].sort()
      )
    }
  })

  it("triggers are statement-level AFTER triggers with transition tables", () => {
    const transition = {
      INSERT: "REFERENCING NEW TABLE AS new_rows",
      UPDATE: "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows",
      DELETE: "REFERENCING OLD TABLE AS old_rows",
    }
    const triggers = signalUnits(policy).filter((u) => u.class === "trigger")
    expect(triggers.length).toBeGreaterThan(0)
    for (const unit of triggers) {
      const table = triggerTable(unit)
      const op = unit.name
        .split("_")
        .at(-1)!
        .toUpperCase() as keyof typeof transition
      expect(unit.sql).toBe(
        `CREATE TRIGGER ${unit.name} AFTER ${op} ON ${table} ${transition[op]} FOR EACH STATEMENT EXECUTE FUNCTION ${table}_simetra_rights_signal();`
      )
    }
  })

  it("requires the rights senders and the tables it reads", () => {
    const requires = fn(policy, "org_role_assignments").requires
    expect(requires).toEqual([
      { type: "unit", identity: "function:simetra.signal_rights(uuid,uuid)" },
      { type: "unit", identity: "function:simetra.signal_user_rights(uuid)" },
      { type: "table", schema: "public", name: "org_member" },
    ])
    const identities = new Set(policy.sqlUnits.map((u) => u.identity))
    for (const node of requires!)
      if (node.type === "unit") expect(identities).toContain(node.identity)
  })
})

describe("rights signal triggers: channels", () => {
  const ORG = `'${ORG_KIND_ID}'::uuid`
  const ZERO = `'${ZERO_UUID}'::uuid`
  const users = (...selects: string[]) =>
    `SELECT simetra.signal_user_rights(s.user_id) FROM (SELECT DISTINCT r.user_id FROM (${selects.join(" UNION ALL ")}) r WHERE r.user_id IS NOT NULL) s`
  const scopes = (...selects: string[]) =>
    `SELECT simetra.signal_rights(s.scope_kind, s.scope) FROM (SELECT DISTINCT r.scope_kind, r.scope FROM (${selects.join(" UNION ALL ")}) r WHERE r.scope IS NOT NULL) s`
  const from = { o: "old_rows o", n: "new_rows n" } as const
  /** Рядки події: вставка — нові, видалення — старі, оновлення — обидва. */
  const ROWS = {
    INSERT: ["n"],
    UPDATE: ["o", "n"],
    DELETE: ["o"],
  } as const
  type Op = keyof typeof ROWS
  const each = (op: Op, select: (a: "o" | "n") => string) =>
    ROWS[op].map(select)

  /** Гілки тіла: умови `TG_OP` і запити `PERFORM` кожної, по порядку. */
  function branches(model: CompiledModel, table: string) {
    const unit = signalUnits(model).find(
      (u) =>
        u.class === "function" && u.name === `${table}_simetra_rights_signal`
    )!
    const shape = bodyShape(unit.sql)
    const conditions = shape
      .filter((s) => s.type === "if")
      .flatMap((s) => s.expressions.map((e) => e.tree))
    // Гілки `ELSIF` дерево не розділяє: запити — по порядку гілок.
    const performs = shape
      .filter((s) => s.type === "perform")
      .map((s) => s.expressions[0]!.tree)
    return { conditions, performs }
  }

  /** Очікуване тіло: на подію — запити `PERFORM`. */
  function expectBranches(
    model: CompiledModel,
    table: string,
    expected: Partial<Record<Op, string[]>>
  ) {
    const ops = (["INSERT", "UPDATE", "DELETE"] as const).filter(
      (op) => expected[op] !== undefined
    )
    const actual = branches(model, table)
    expect(actual.conditions, table).toEqual(
      ops.map((op) => tree(`SELECT TG_OP = '${op}'`))
    )
    expect(actual.performs, table).toEqual(
      ops.flatMap((op) => expected[op]!.map((sql) => tree(sql)))
    )
  }
  const allOps = (body: (op: Op) => string[]) => ({
    INSERT: body("INSERT"),
    UPDATE: body("UPDATE"),
    DELETE: body("DELETE"),
  })

  it("a scope-level role and its delta signal the rights channel of their scope", () => {
    for (const table of ["org_roles", "org_roles_delta"])
      expectBranches(
        policy,
        table,
        allOps((op) => [
          scopes(
            ...each(
              op,
              (a) =>
                `SELECT ${ORG} AS scope_kind, ${a}.org_id AS scope FROM ${from[a]}`
            )
          ),
        ])
      )
  })

  it("a global role and its delta signal the global channel", () => {
    for (const table of ["global_roles", "global_roles_delta"])
      expectBranches(
        policy,
        table,
        allOps((op) => [
          scopes(
            ...each(
              op,
              (a) =>
                `SELECT ${ZERO} AS scope_kind, ${ZERO} AS scope FROM ${from[a]}`
            )
          ),
        ])
      )
  })

  // Призначення — у канал користувача, не скоупу: учасник нового скоупу на
  // канал скоупу ще не підписаний (§8.2).
  it("a scope-level assignment signals the user of its member, a global one its subject", () => {
    expectBranches(
      policy,
      "org_role_assignments",
      allOps((op) => [
        users(
          ...each(
            op,
            (a) =>
              `SELECT m.user_id AS user_id FROM ${from[a]} JOIN public.org_member m ON m.id = ${a}.subject`
          )
        ),
      ])
    )
    expectBranches(
      policy,
      "global_role_assignments",
      allOps((op) => [
        users(
          ...each(op, (a) => `SELECT ${a}.subject AS user_id FROM ${from[a]}`)
        ),
      ])
    )
  })

  it("membership signals the user of the row, a relation the user of its subject", () => {
    expectBranches(
      policy,
      "org_member",
      allOps((op) => [
        users(
          ...each(op, (a) => `SELECT ${a}.user_id AS user_id FROM ${from[a]}`)
        ),
      ])
    )
    expectBranches(
      policy,
      "member_region",
      allOps((op) => [
        users(
          ...each(
            op,
            (a) =>
              `SELECT m.user_id AS user_id FROM ${from[a]} JOIN public.org_member m ON m.id = ${a}.member_id`
          )
        ),
      ])
    )
  })

  it("Users signal the row itself only on a change of invalid or user_kind", () => {
    expectBranches(policy, "users", {
      UPDATE: [
        users(
          "SELECT n.id AS user_id FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE o.invalid IS DISTINCT FROM n.invalid OR o.user_kind IS DISTINCT FROM n.user_kind"
        ),
      ],
    })
  })

  // Т1: поява, зникнення чи зміна носія скоупу контейнера — суб'єктам
  // призначень рівня контейнера на ньому, одним оператором.
  it("a rights container signals the subjects of container-level assignments on changed containers", () => {
    const changed: Record<Op, string> = {
      INSERT: "SELECT n.id AS container FROM new_rows n",
      UPDATE:
        "SELECT n.id AS container FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE o.org_id IS DISTINCT FROM n.org_id",
      DELETE: "SELECT o.id AS container FROM old_rows o",
    }
    expectBranches(
      policy,
      "project",
      allOps((op) => [
        users(
          `SELECT a.subject AS user_id FROM (${changed[op]}) c JOIN public.global_role_assignments a ON a.container = c.container`,
          `SELECT m.user_id AS user_id FROM (${changed[op]}) c JOIN public.org_role_assignments a ON a.container = c.container JOIN public.org_member m ON m.id = a.subject`
        ),
      ])
    )
  })

  // Членів виду дає довідник членства моделі чи прийняте джерело: прийняту
  // таблицю тригер лише читає (§4.7).
  it("an assignment finds the user of its member in the membership of its kind, model or adopted", () => {
    // Вид `team` має довідник членства моделі; `org` — прийняте джерело.
    expect(sources.contracts.membership.map((m) => m.scopeKindId)).toEqual([
      TEAM_KIND_ID,
    ])
    expectBranches(
      sources,
      "team_role_assignments",
      allOps((op) => [
        users(
          ...each(
            op,
            (a) =>
              `SELECT m.user_id AS user_id FROM ${from[a]} JOIN public.team_member m ON m.id = ${a}.subject`
          )
        ),
      ])
    )
    expectBranches(
      sources,
      "org_role_assignments",
      allOps((op) => [
        users(
          ...each(
            op,
            (a) =>
              `SELECT m.user_id AS user_id FROM ${from[a]} JOIN public.membership m ON m.id = ${a}.subject`
          )
        ),
      ])
    )
  })
})

describe("adoptedFacts in the runtime and client catalogs", () => {
  it("is absent without adopted sources", () => {
    expect(buildRuntimeCatalog(policy).adoptedFacts).toBeUndefined()
  })

  it("names the scope kinds of adopted membership and any adopted assignments", async () => {
    const result = await compileRights(adoptedSourcesDomain())
    expectClean(result, { allow: ["rights.adopted-source-writes"] })
    const runtime = buildRuntimeCatalog(result.model!)
    expect(runtime.adoptedFacts).toEqual({
      membershipKinds: [ORG_KIND_ID],
      assignments: true,
    })
    expect(buildClientCatalog(runtime).adoptedFacts).toEqual(
      runtime.adoptedFacts
    )
  })

  // Призначення будь-якого рівня — зокрема контейнера (Р9).
  it("counts an adopted assignment source of the container level alone", async () => {
    const files = policyDomain(writeRoles(), {
      "project.meta.json": {
        assignmentSources: [polyContainerGrantsSource({ where: [] })],
      },
      [POLY_GRANT_FILE]: polyGrantTable(),
      [SOURCE_ROLE_FILE]: sourceRoleTable(),
      [ROLE_FILE("ProjectLead")]: {
        sourceKeys: [{ source: "polyContainerGrants", key: ADOPTED_LEAD_KEY }],
      },
    })
    const result = await compileRights(await acceptDebt(files))
    expectClean(result, { allow: ["rights.adopted-source-writes"] })
    const model = result.model!
    expect(
      model.contracts.assignmentSources.map((s) => s.assignedOn.level)
    ).toEqual(["container"])
    expect(buildRuntimeCatalog(model).adoptedFacts).toEqual({
      membershipKinds: [],
      assignments: true,
    })
  })
})
