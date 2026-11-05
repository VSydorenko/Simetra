import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import { KIND_REGISTRY, PLATFORM_SCHEMA } from "simetra/model"
import { SNAPSHOT_TABLES, type SnapshotFact } from "../rights/actor-snapshot"
import { RIGHTS_FUNCTIONS } from "../rights/functions"
import { snapshotSources } from "../rights/snapshot-sources"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import { unitRelations } from "../sql/dependencies"
import { relationReads } from "../sql/reads"
import { generatedUnit, type SqlUnit, type VerbatimUnit } from "../sql/units"
import {
  BENCH_ZONE_TABLE,
  SNAPSHOT_ORG_GUEST_TABLE,
  SNAPSHOT_USER_BADGE_TABLE,
  SNAPSHOT_USER_REGION_TABLE,
  adoptedSourcesDomain,
  compileRights,
  snapshotSourcesDomain,
} from "./fixtures/rights"
import { acceptDebt, expectClean } from "./helpers"

let parse: SqlParser
let plpgsql: PlpgsqlParser
let model: CompiledModel
beforeAll(async () => {
  ;[parse, plpgsql] = await Promise.all([loadSqlParser(), loadPlpgsqlParser()])
  const result = await compileRights(snapshotSourcesDomain())
  expectClean(result, { allow: ["rights.adopted-source-writes"] })
  model = result.model!
})

const verbatimOf = (units: readonly SqlUnit[]): VerbatimUnit[] =>
  units
    .filter((u) => u.generator === undefined)
    .map((u) => ({ ...u, file: u.file!, line: u.line! }))

/** Вхід аналізу з моделі: дослівні одиниці й згенеровані, крім запобіжників. */
function inputOf(compiled: CompiledModel) {
  return {
    contracts: {
      ...compiled.contracts,
      scopeSetFunctions: compiled.scopeKinds
        .filter((k) =>
          compiled.project.scopeKinds.some(
            (d) => d.id === k.id && typeof d.setFunction !== "string"
          )
        )
        .map((k) => ({ scopeKindId: k.id, fn: k.setFunction })),
    },
    physical: compiled.physical,
    objects: compiled.objects,
    generated: compiled.sqlUnits.filter(
      (u) => u.generator !== undefined && u.generator !== "rightsGuards"
    ),
    verbatim: verbatimOf(compiled.sqlUnits),
    attributeCase: compiled.project.naming.attributeCase,
    parse,
    plpgsql,
  }
}

const named = (entry: { table: { schema: string; name: string } }) =>
  `${entry.table.schema}.${entry.table.name}`

describe("actor snapshot sources", () => {
  // Рукописна мапа фікстури: кожна форма джерела з `snapshotSourcesDomain`.
  it("maps the sources of the fixture to their facts", () => {
    const found = snapshotSources(inputOf(model))
    expect(
      Object.fromEntries(found.sources.map((s) => [named(s), s.facts]))
    ).toEqual({
      [`public.${SNAPSHOT_ORG_GUEST_TABLE}`]: ["scopeSets"],
      "public.org_role_assignments": ["rights"],
      "public.org_roles": ["rights"],
      "public.org_roles_delta": ["rights"],
      "public.project": ["rights"],
      "public.team_member": ["rights", "scopes", "values"],
      "public.team_role_assignments": ["rights"],
      "public.team_roles": ["rights"],
      "public.team_roles_delta": ["rights"],
      [`public.${SNAPSHOT_USER_REGION_TABLE}`]: ["values"],
      "public.users": ["rights", "scopes", "values", "scopeSets"],
      [`public.${BENCH_ZONE_TABLE}`]: ["values"],
    })
    expect(
      Object.fromEntries(found.exempt.map((e) => [named(e), e.reason]))
    ).toEqual({
      "public.global_grant": "assignmentSource",
      "public.membership": "membershipSource",
      "public.role_grant": "assignmentSource",
      "public.source_roles": "sourceRoleTable",
      [`public.${SNAPSHOT_USER_BADGE_TABLE}`]: "declared",
      "simetra.identities": "identities",
      // Дослівна функція виміру кличе публічну функцію членства, а та зі
      // знімком читає мої скоупи транзакції (Р3-6: таблиці знімка — виняток).
      "simetra.rights_tx_header": "snapshot",
      "simetra.rights_tx_scopes": "snapshot",
    })
    expect(found.unknown).toEqual([])
  })

  // Живі варіанти самі знімка не читають; таблиця знімка досяжна лише через
  // публічну функцію, яку кличе дослівна функція проєкту, — і тоді вона
  // виняток, а не джерело.
  it("reads no snapshot table from live variants", () => {
    const snapshot = new Set(
      Object.values(SNAPSHOT_TABLES).map((t) => `${t.schema}.${t.name}`)
    )
    const input = inputOf(model)
    const found = snapshotSources(input)
    expect(found.sources.filter((e) => snapshot.has(named(e)))).toEqual([])
    for (const e of found.exempt.filter((x) => snapshot.has(named(x))))
      expect(e.reason, named(e)).toBe("snapshot")
    for (const fn of [
      RIGHTS_FUNCTIONS.mineLive,
      RIGHTS_FUNCTIONS.myScopesLive,
      RIGHTS_FUNCTIONS.myMembersLive,
      RIGHTS_FUNCTIONS.dimensionValuesLive,
      RIGHTS_FUNCTIONS.scopeSetLive,
    ]) {
      const unit = input.generated.find(
        (u) => u.schema === fn.schema && u.name === fn.name
      )!
      const direct = unitRelations(unit, parse).map(
        (r) => `${r.schema}.${r.name}`
      )
      expect(
        direct.filter((r) => snapshot.has(r)),
        fn.name
      ).toEqual([])
    }
  })

  it("maps the direct reads of every live variant", () => {
    const input = inputOf(model)
    const found = snapshotSources(input)
    const heads: Record<SnapshotFact, string> = {
      rights: RIGHTS_FUNCTIONS.mineLive.name,
      scopes: RIGHTS_FUNCTIONS.myScopesLive.name,
      values: RIGHTS_FUNCTIONS.dimensionValuesLive.name,
      scopeSets: RIGHTS_FUNCTIONS.scopeSetLive.name,
    }
    const kinds = new Map(model.objects.map((o) => [o.id, o.kind]))
    const units = [...input.generated, ...input.verbatim].map((u) => ({
      ...u,
      file: u.file ?? "",
      line: u.line ?? 0,
    }))
    let checked = 0
    for (const [fact, name] of Object.entries(heads) as [
      SnapshotFact,
      string,
    ][]) {
      const head = units.find(
        (u) => u.schema === PLATFORM_SCHEMA && u.name === name
      )!
      for (const ref of relationReads(head, units, parse, plpgsql)) {
        const table = model.physical.tables.find(
          (t) => t.schema === ref.schema && t.name === ref.name
        )
        if (
          table === undefined ||
          table.schema === PLATFORM_SCHEMA ||
          KIND_REGISTRY[kinds.get(table.origin.objectId)!].declared
        )
          continue
        const source = found.sources.find((s) => named(s) === named({ table }))
        expect(source?.facts, `${fact} ${table.name}`).toContain(fact)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it("reports an unknown relation", async () => {
    // Напряму: судження голів раніше відхилило б таку дослівну функцію, і
    // конвеєр до генерації не дійшов би.
    const input = inputOf(model)
    const fake = (sql: string): SqlUnit => ({
      ...generatedUnit(sql, PLATFORM_SCHEMA, parse),
      module: "fake",
      generator: "rights",
    })
    const replaced = new Set([
      RIGHTS_FUNCTIONS.mineLive.name,
      RIGHTS_FUNCTIONS.myScopesLive.name,
      RIGHTS_FUNCTIONS.dimensionValuesLive.name,
      RIGHTS_FUNCTIONS.scopeSetLive.name,
    ])
    const shell = "LANGUAGE sql STABLE SET search_path = ''"
    const found = snapshotSources({
      ...input,
      contracts: { ...input.contracts, rightsCatalogs: [] },
      generated: [
        ...input.generated.filter((u) => !replaced.has(u.name)),
        fake(
          `CREATE FUNCTION simetra.rights_mine_live() RETURNS SETOF uuid ${shell} AS $$ SELECT NULL::uuid WHERE false $$`
        ),
        // Мої скоупи читають і входи `rights_mine` (Р3-15), тож невідоме
        // відношення в них — невідоме для обох фактів.
        fake(
          `CREATE FUNCTION simetra.rights_my_scopes_live() RETURNS SETOF uuid ${shell} AS $$ SELECT j.row_id FROM simetra.rights_journal j $$`
        ),
        fake(
          `CREATE FUNCTION simetra.rights_dimension_values_live(p_dimension uuid) RETURNS SETOF uuid ${shell} AS $$ SELECT NULL::uuid WHERE false $$`
        ),
        fake(
          `CREATE FUNCTION simetra.rights_scope_set_live(p_scope_kind uuid) RETURNS SETOF uuid ${shell} AS $$ SELECT NULL::uuid WHERE false $$`
        ),
      ],
    })
    expect(found.unknown).toEqual(
      (["rights", "scopes"] as const).map((fact) => ({
        relation: "simetra.rights_journal",
        fact,
        via: "function:simetra.rights_my_scopes_live()",
      }))
    )

    // Через конвеєр: матеріалізоване подання моделі над таблицею виду.
    const files = snapshotSourcesDomain()
    files.set(
      "sql/public/zone-keepers.sql",
      `CREATE MATERIALIZED VIEW public.zone_keepers AS SELECT z.id, z.keeper_id FROM public.${BENCH_ZONE_TABLE} z;`
    )
    files.set(
      "sql/public/zone-ids.sql",
      "CREATE FUNCTION public.zone_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT k.id FROM public.zone_keepers k WHERE k.keeper_id = (SELECT simetra.current_user_id()) $$;"
    )
    const result = await compileRights(await acceptDebt(files))
    expect(
      result.diagnostics
        .filter((d) => d.code === "rights.snapshot-source-unknown")
        .map((d) => d.params)
    ).toEqual([
      {
        relation: "public.zone_keepers",
        fact: "values",
        via: "function:public.zone_ids()",
      },
    ])
  })

  it("sees through a model view", async () => {
    const files = snapshotSourcesDomain()
    files.set(
      "sql/public/zone-view.sql",
      `CREATE VIEW public.zone_view AS SELECT z.id, z.keeper_id FROM public.${BENCH_ZONE_TABLE} z;`
    )
    files.set(
      "sql/public/zone-ids.sql",
      "CREATE FUNCTION public.zone_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT v.id FROM public.zone_view v WHERE v.keeper_id = (SELECT simetra.current_user_id()) $$;"
    )
    const result = await compileRights(await acceptDebt(files))
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const found = snapshotSources(inputOf(result.model!))
    expect(
      found.sources.find((s) => s.table.name === BENCH_ZONE_TABLE)?.facts
    ).toEqual(["values"])
    expect(found.unknown).toEqual([])
  })
})

/**
 * Р3-13: SQL застосунку не відкриває ролі команд чи `PUBLIC` запису в
 * таблицю-виняток знімка. База — прийняті джерела без жодного гранту;
 * виняток — прийняте членство `public.membership`.
 */
describe("snapshot exempt writers", () => {
  const WRITER_FILE = "sql/public/writer.sql"
  const writers = async (sql: string) => {
    const files = adoptedSourcesDomain()
    files.set(WRITER_FILE, sql)
    const result = await compileRights(await acceptDebt(files))
    // Інша помилка зупинила б компіляцію раніше за правило — порожній
    // перелік тоді нічого не доводив би.
    expect(
      result.diagnostics.filter(
        (d) =>
          d.severity === "error" && d.code !== "rights.snapshot-exempt-writer"
      )
    ).toEqual([])
    return result.diagnostics
      .filter((d) => d.code === "rights.snapshot-exempt-writer")
      .map((d) => ({
        form: d.params?.form,
        table: d.params?.table,
        object: d.params?.object,
      }))
  }
  const DEFINER = "SECURITY DEFINER SET search_path = ''"
  const writer = (name: string, body: string) =>
    `CREATE FUNCTION public.${name}() RETURNS void LANGUAGE sql VOLATILE ${DEFINER} AS $$ ${body} $$;`
  const UPDATE = "UPDATE public.membership SET is_active = true WHERE false"
  const REVOKE = "REVOKE EXECUTE ON FUNCTION public.touch() FROM PUBLIC;"

  it("accepts an adopted source without grants", async () => {
    const result = await compileRights(adoptedSourcesDomain())
    expectClean(result, { allow: ["rights.adopted-source-writes"] })
  })

  it("accepts a write policy on an exempt table without a grant", async () => {
    expect(
      await writers(
        "CREATE POLICY membership_write ON public.membership FOR UPDATE TO simetra_command USING (true);"
      )
    ).toEqual([])
  })

  it("refuses a definer trigger function writing an exempt table", async () => {
    const fn = `CREATE FUNCTION public.touch() RETURNS trigger LANGUAGE plpgsql VOLATILE ${DEFINER} AS $$ BEGIN ${UPDATE}; RETURN NULL; END $$;`
    const trigger =
      "CREATE TRIGGER touch AFTER INSERT ON public.membership FOR EACH STATEMENT EXECUTE FUNCTION public.touch();"
    expect(await writers(`${fn}\n${REVOKE}\n${trigger}`)).toEqual([
      { form: "trigger", table: "public.membership", object: "public.touch" },
    ])
    // Не причеплена тригерна функція запису не відкриває.
    expect(await writers(`${fn}\n${REVOKE}`)).toEqual([])
  })

  it("refuses a definer function writing an exempt table through a data-modifying CTE", async () => {
    expect(
      await writers(
        writer(
          "touch",
          "WITH t AS (UPDATE public.membership SET is_active = true WHERE false RETURNING 1) SELECT FROM t"
        )
      )
    ).toEqual([
      { form: "definer", table: "public.membership", object: "public.touch" },
    ])
  })

  it.each([
    [
      "global",
      "ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
    ],
    [
      "in schema",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;",
    ],
  ])(
    "refuses a definer writer whose execute is revoked only in default privileges (%s)",
    async (_, defaults) => {
      expect(await writers(`${defaults}\n${writer("touch", UPDATE)}`)).toEqual([
        { form: "definer", table: "public.membership", object: "public.touch" },
      ])
      expect(await writers(`${writer("touch", UPDATE)}\n${REVOKE}`)).toEqual([])
    }
  )

  it("refuses a definer function writing an exempt table and executable by the command role", async () => {
    expect(
      await writers(
        `${writer("touch", UPDATE)}\n${REVOKE}\nGRANT EXECUTE ON FUNCTION public.touch() TO simetra_command;`
      )
    ).toEqual([
      { form: "definer", table: "public.membership", object: "public.touch" },
    ])
    expect(await writers(`${writer("touch", UPDATE)}\n${REVOKE}`)).toEqual([])
  })

  it.each([
    ["a table grant", "GRANT INSERT ON public.membership TO simetra_command;"],
    [
      "a column grant",
      "GRANT UPDATE (is_active) ON public.membership TO PUBLIC;",
    ],
    ["TRUNCATE", "GRANT TRUNCATE ON public.membership TO simetra_command;"],
    [
      "default privileges of the schema",
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO simetra_command;",
    ],
  ])(
    "refuses a grant of DML on an exempt table to public or the command role (%s)",
    async (_, sql) => {
      const found = await writers(sql)
      expect(found.map((f) => [f.form, f.table])).toContainEqual([
        "grant",
        "public.membership",
      ])
    }
  )

  it("refuses no SELECT grant on an exempt table", async () => {
    expect(
      await writers("GRANT SELECT ON public.membership TO simetra_command;")
    ).toEqual([])
  })

  it("refuses a writable view over an exempt table", async () => {
    const view =
      "CREATE VIEW public.membership_view AS SELECT m.id, m.is_active FROM public.membership m;"
    expect(
      await writers(
        `${view}\nGRANT UPDATE ON public.membership_view TO simetra_command;`
      )
    ).toEqual([
      {
        form: "view",
        table: "public.membership",
        object: "public.membership_view",
      },
    ])
    expect(
      await writers(
        `${view.replace("AS SELECT", "WITH (security_invoker = true) AS SELECT")}\nGRANT UPDATE ON public.membership_view TO simetra_command;`
      )
    ).toEqual([])
  })
})
