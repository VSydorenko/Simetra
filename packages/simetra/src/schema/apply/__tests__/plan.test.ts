import { describe, expect, it } from "vitest"
import {
  canonicalSnapshot,
  compile,
  type CompiledModel,
  type PromotionRecord,
} from "simetra/compiler"
import { PLATFORM_ROLES, type CatalogModel } from "simetra/model"
import {
  APPLY_STATE_FORMAT,
  FINGERPRINT_SECTIONS,
  buildPlan,
  desiredForApply,
  type ApplyDatabase,
  type ApplyTransaction,
  type EngineAction,
  type EngineCatalog,
  type PromotionInput,
  type SchemaEngine,
} from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
} from "../../../compiler/__tests__/helpers"
import {
  ATTACHMENTS_TABLE,
  CHECKLIST_TABLE,
  TAG_ID,
  adoptedSourcesDomain,
  adminRoles,
  GLOBAL_ADMIN_ID,
  compileRights,
  policyDomain,
  promotableTag,
  promotedRights,
  ROLE_FILE,
  rightsFiles,
  tagMapping,
} from "../../../compiler/__tests__/fixtures/rights"
import { applyDiagnostic } from "../diagnostic"

/**
 * Конвеєр плану на фейковому порті — лише те, що не потребує справжньої
 * бази; решта — у `build-plan.db.test.ts` designer.
 */
describe("buildPlan", () => {
  // Без функції носіїв на цілі (база до цього запобіжника) «до» невідоме:
  // план не вигадує втрати, а йде далі — запобіжник на COMMIT стане першим
  // носієм цього знання після застосування
  it.each([
    { assigned: true, removeCatalogs: false, holdersFn: true, refusal: true },
    { assigned: false, removeCatalogs: false, holdersFn: true, refusal: false },
    { assigned: true, removeCatalogs: true, holdersFn: true, refusal: true },
    { assigned: false, removeCatalogs: true, holdersFn: true, refusal: false },
    { assigned: true, removeCatalogs: false, holdersFn: false, refusal: false },
  ])(
    "handles removal of fullAccess (assigned: $assigned, catalogs removed: $removeCatalogs, holders function: $holdersFn)",
    async ({ assigned, removeCatalogs, holdersFn, refusal }) => {
      const old = (await compile(policyDomain(adminRoles()))).model!
      const compiledDesired = await compile(
        removeCatalogs
          ? rightsFiles()
          : policyDomain(adminRoles(), {
              [ROLE_FILE("GlobalAdmin")]: { fullAccess: false },
            })
      )
      expect(
        compiledDesired.diagnostics.filter((d) => d.severity === "error")
      ).toEqual([])
      const desired = compiledDesired.model!
      const target = await fakeTarget(old, {
        notCopies: [],
        rights: {
          holdersFn,
          previousRoles: [
            { role_id: GLOBAL_ADMIN_ID, storage: "global", storage_id: null },
          ],
          rows: assigned
            ? {
                "public.global_role_assignments": [
                  {
                    id: "a1",
                    scope: null,
                    archetype: GLOBAL_ADMIN_ID,
                    custom_role: null,
                    deleted: false,
                  },
                ],
              }
            : {},
          holders: assigned
            ? {
                "public.global_role_assignments": [
                  {
                    scope: "00000000-0000-0000-0000-000000000000",
                    actor: "user-1",
                    archetype: GLOBAL_ADMIN_ID,
                  },
                ],
              }
            : {},
        },
      })
      const outcome = await buildPlan(
        shadowFailing(),
        { reader: target.reader, scratch: emptyScratch },
        desired,
        { target: { url: "postgres://target" } },
        []
      )
      expect(
        outcome.diagnostics.some(
          (d) => d.code === "plan.rights-full-access-lost"
        )
      ).toBe(refusal)
      if (refusal) expect(outcome.status).toBe("refused")
      else
        expect(
          outcome.diagnostics.some((d) => d.code === SHADOW_FAILED.code)
        ).toBe(true)
    }
  )

  it("refuses a server older than Postgres 17 before reading its facts", async () => {
    // Платформна спека §1: Postgres 17 — мінімум; без цієї відмови читання
    // фактів упало б сирим `42703` на `datlocale`
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Party/Party.meta.json": catalog("Party"),
      })
    )
    expect(compiled.diagnostics).toEqual([])
    const statements: string[] = []
    const tx: ApplyTransaction = {
      query: async <R extends Record<string, unknown>>(sql: string) => {
        statements.push(sql)
        return (sql.includes("server_version_num")
          ? [{ num: 160004, version: "16.4" }]
          : []) as unknown as R[]
      },
      extract: () => Promise.reject(new Error("no extract expected")),
    }
    const reader: ApplyDatabase = {
      transaction: (_db, _end, fn) => fn(tx),
    }
    const scratch: ApplyDatabase = {
      transaction: () => Promise.reject(new Error("no copy expected")),
    }
    // Двигун не потрібен: відмова — до будь-якого витягу
    const engine = new Proxy({} as SchemaEngine, {
      get: (_, name) => {
        throw new Error(`no engine call expected: ${String(name)}`)
      },
    })
    const outcome = await buildPlan(
      engine,
      { reader, scratch },
      compiled.model!,
      { target: { url: "postgres://fake" } },
      []
    )
    expect(outcome).toMatchObject({
      status: "refused",
      diagnostics: [
        { code: "apply.server-unsupported", params: { version: "16.4" } },
      ],
    })
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain("server_version_num")
  })

  it.each([
    { server: "target", promotions: false },
    { server: "shadow", promotions: false },
    { server: "target", promotions: true },
  ])(
    "refuses a plan when the command role is missing on the $server server (promotion: $promotions)",
    async ({ server, promotions }) => {
      const compiled = await compile(
        metaFiles({
          "project.meta.json": project(),
          "catalogs/Party/Party.meta.json": catalog("Party"),
        })
      )
      const urls = {
        target: "postgres://target",
        shadow: "postgres://shadow",
      }
      // Свіжа ціль Postgres 17; роль команд є лише на іншому сервері
      const reader: ApplyDatabase = {
        transaction: (db, _end, fn) =>
          fn({
            query: async <R extends Record<string, unknown>>(sql: string) =>
              (sql.includes("server_version_num")
                ? [{ num: 170004, version: "17.4", major: 17 }]
                : sql.includes("pg_auth_members") &&
                    db.url !== urls[server as "target" | "shadow"]
                  ? [
                      {
                        name: PLATFORM_ROLES.command,
                        attributes: {},
                        memberOf: [],
                        members: [],
                      },
                    ]
                  : []) as unknown as R[],
            extract: () => Promise.reject(new Error("no extract expected")),
          }),
      }
      const scratch: ApplyDatabase = {
        transaction: () => Promise.reject(new Error("no copy expected")),
      }
      // Будь-який виклик двигуна — і `withDesiredShadow` — кидає: відмова
      // мусить прийти до тіні й до гілки промоції
      const engine = new Proxy({} as SchemaEngine, {
        get: (_, name) => {
          throw new Error(`no engine call expected: ${String(name)}`)
        },
      })
      // Запис промоції відмова не читає: вона — до розгалуження
      const records: PromotionInput[] = promotions
        ? [{ record: {} as PromotionRecord, file: "plans/x.promotion.json" }]
        : []
      const outcome = await buildPlan(
        engine,
        { reader, scratch },
        compiled.model!,
        { target: { url: urls.target }, shadowBase: { url: urls.shadow } },
        records
      )
      expect(outcome).toMatchObject({
        status: "refused",
        diagnostics: [
          {
            code: "plan.platform-role-missing",
            params: { role: PLATFORM_ROLES.command, server },
          },
        ],
      })
    }
  )

  it.each([
    { case: "plan", promotion: false },
    { case: "plan with a promotion", promotion: true },
  ])(
    "carrier copy steps reach the footprint without a read of the target ($case)",
    async ({ promotion }) => {
      // Р2b2-7: у marker цілі колонки копій ТЧ `checklist` і `attachments` не
      // були копіями, а в кожній таблиці є рядок — план дає кроки даних
      // копій, а не відмову, і ціль на рядки не читає. Слід плану питає
      // право `LOCK` на таблиці кроків: `checklist` і її джерело є, а
      // `attachments`, яку план створює, кроку не має. Фейк зупиняє план на
      // цьому читанні; самі кроки доводить `carrier-backfill.test.ts`
      const { before, desired, records } = promotion
        ? await promotedTag()
        : await samePolicyDomain()
      const target = await fakeTarget(before, {
        notCopies: [CHECKLIST_TABLE, ATTACHMENTS_TABLE],
      })
      await expect(
        buildPlan(
          fakeEngine([createTable(ATTACHMENTS_TABLE)]),
          { reader: target.reader, scratch: emptyScratch },
          desired,
          { target: { url: "postgres://target" } },
          records
        )
      ).rejects.toBeInstanceOf(ReachedLockRights)
      const names = target.lockTables.map((t) => t.name)
      expect(names).toContain(CHECKLIST_TABLE)
      expect(names).toContain("task")
      expect(names).not.toContain(ATTACHMENTS_TABLE)
    }
  )

  it.each([
    { case: "plan", promotion: false },
    { case: "plan with a promotion", promotion: true },
  ])(
    "refuses a plan when the apply role cannot bypass RLS of a source table ($case)",
    async ({ promotion }) => {
      // Р2d1-10, Р2d1-13: відмова — до витягу й тіні, до розгалуження
      // промоції; двигун не кличеться зовсім
      const { before, desired, records } = promotion
        ? await promotedTag(adoptedSourcesDomain)
        : await samePolicyDomain(adoptedSourcesDomain)
      const target = await fakeTarget(before, {
        notCopies: [],
        sources: { owned: false },
      })
      const engine = new Proxy({} as SchemaEngine, {
        get: (_, name) => {
          throw new Error(`no engine call expected: ${String(name)}`)
        },
      })
      const outcome = await buildPlan(
        engine,
        { reader: target.reader, scratch: emptyScratch },
        desired,
        { target: { url: "postgres://target" } },
        records
      )
      expect(outcome.status).toBe("refused")
      expect(outcome.diagnostics.map((d) => [d.code, d.severity])).toEqual([
        ["plan.rights-source-access", "error"],
      ])
    }
  )

  it.each([
    { case: "plan", promotion: false },
    { case: "plan with a promotion", promotion: true },
  ])(
    "warns about unknown role keys in a source ($case)",
    async ({ promotion }) => {
      // Р2d1-11: попередження, а не відмова — план іде далі, до бажаної тіні
      // (тут вона падає, і відмова несе зібрані до неї діагностики)
      const { before, desired, records } = promotion
        ? await promotedTag(adoptedSourcesDomain)
        : await samePolicyDomain(adoptedSourcesDomain)
      const target = await fakeTarget(before, {
        notCopies: [],
        sources: { owned: true, unknownKey: "stale" },
      })
      const outcome = await buildPlan(
        shadowFailing(),
        { reader: target.reader, scratch: emptyScratch },
        desired,
        { target: { url: "postgres://target" } },
        records
      )
      const codes = outcome.diagnostics.map((d) => d.code)
      expect(codes).toContain(SHADOW_FAILED.code)
      expect(
        outcome.diagnostics
          .filter((d) => d.code === "plan.rights-source-unknown-keys")
          .map((d) => [d.severity, d.params])
      ).toEqual([
        ["warning", { source: "grants", keys: "stale", more: 0 }],
        ["warning", { source: "globalGrants", keys: "stale", more: 0 }],
      ])
    }
  )
})

/** Маркер падіння бажаної тіні фейкового двигуна. */
const SHADOW_FAILED = applyDiagnostic("engine.clone-failed", "error", {
  detail: "fake shadow",
})

/** Двигун, чия бажана тінь падає: план дійшов до неї. */
function shadowFailing(): SchemaEngine {
  const engine = fakeEngine([])
  return new Proxy(engine, {
    get: (target, name) =>
      name === "withDesiredShadow"
        ? () =>
            Promise.resolve({
              status: "shadow-failed",
              diagnostics: [SHADOW_FAILED],
            })
        : target[name as keyof SchemaEngine],
  })
}

type Domain = typeof policyDomain

async function samePolicyDomain(domain: Domain = policyDomain) {
  const model = (await compileRights(domain())).model!
  return { before: model, desired: model, records: [] }
}

/** Домен (типово політик) з прийнятою `Tag` до промоції, після неї й запис. */
async function promotedTag(domain: Domain = policyDomain) {
  const { before, desired, record } = await promotedRights(
    promotableTag(),
    tagMapping(),
    domain
  )
  const records: PromotionInput[] = [
    { record, file: `plans/${TAG_ID}.promotion.json` },
  ]
  return { before, desired, records }
}

/** Копія цілі гілки промоції: усе читає порожнім, кроки наміру приймає. */
const emptyScratch: ApplyDatabase = {
  transaction: (_db, _end, fn) =>
    fn({
      query: async <R extends Record<string, unknown>>() => [] as R[],
      extract: () => Promise.reject(new Error("no extract expected")),
    }),
}

/** Фейкова ціль дійшла до читання права `LOCK` на таблиці сліду плану. */
class ReachedLockRights extends Error {}

const EMPTY_CATALOG: CatalogModel = { tables: [], enumTypes: [], units: [] }

/**
 * Фейкова ціль Postgres 17 з marker `model`: колонки копій таблиць
 * `notCopies` у знімку marker — звичайні колонки. Відбиток і модель
 * каталогу збігаються з marker, тож гейт дрейфу пропускає. Глобальних ADP
 * немає, тож збір середовища копії не бере. `lockTables` — таблиці сліду, на
 * які план питає право `LOCK`; це читання кидає `ReachedLockRights`.
 */
async function fakeTarget(
  model: CompiledModel,
  o: {
    notCopies: readonly string[]
    /**
     * Таблиці прийнятих джерел прав: доступ ролі застосування й ключ ролі,
     * якого не оголошує жодна роль, у кожному джерелі призначень.
     */
    sources?: { owned: boolean; unknownKey?: string }
    rights?: {
      /** Чи є на цілі `simetra.rights_full_access_roles()`. */
      holdersFn: boolean
      previousRoles: {
        role_id: string
        storage: string
        storage_id: string | null
      }[]
      rows: Record<string, Record<string, unknown>[]>
      holders: Record<string, Record<string, unknown>[]>
    }
  }
) {
  const snapshot = JSON.parse(JSON.stringify(canonicalSnapshot(model))) as {
    physical: {
      tables: {
        name: string
        columns: { origin: Record<string, unknown> }[]
      }[]
    }
  }
  for (const table of snapshot.physical.tables)
    if (o.notCopies.includes(table.name))
      for (const column of table.columns) delete column.origin.copyOf
  const fingerprint = Object.fromEntries(
    FINGERPRINT_SECTIONS.map((section) => [section, "h"])
  )
  const marker = {
    format: APPLY_STATE_FORMAT,
    snapshot_hash: model.hash,
    snapshot,
    scope: (await desiredForApply(model)).scope,
    catalog: EMPTY_CATALOG,
    engine_name: ENGINE.name,
    engine_version: ENGINE.version,
    fingerprint,
    fingerprint_version: 1,
    platform_version: "0",
    plan_hash: "p",
  }
  const lockTables: Named[] = []
  const answer = (sql: string, params: readonly unknown[] = []): unknown[] => {
    if (sql.includes("pg_database"))
      return [{ major: 17, encoding: "UTF8", collate: "C", ctype: "C" }]
    if (sql.includes("server_version_num"))
      return [{ num: 170004, version: "17.4" }]
    if (sql.includes("AS marker, to_regclass"))
      return [{ marker: true, ledger: true }]
    if (sql.includes("to_jsonb(m)")) return [{ row: JSON.stringify(marker) }]
    if (sql.includes("pg_auth_members"))
      return (params[0] as string[]).map((name) => ({
        name,
        attributes: {},
        memberOf: [],
        members: [],
      }))
    if (sql.includes("AS session")) return [{ session: "app" }]
    if (sql.includes("surface_rel")) return [fingerprint]
    if (sql.includes("current_setting(s.name)"))
      return (params[0] as string[]).map(() => ({ value: "on" }))
    if (sql.includes("AS source_owned")) {
      const [schemas, names] = params as [string[], string[]]
      return schemas.map((schema, i) => ({
        table_schema: schema,
        table_name: names[i],
        source_owned: o.sources?.owned ?? true,
      }))
    }
    if (sql.includes("AS source_column")) {
      const [schemas, names, columns] = params as [string[], string[], string[]]
      return schemas.map((schema, i) => ({
        table_schema: schema,
        table_name: names[i],
        source_column: columns[i],
      }))
    }
    if (sql.includes("AS unknown_key"))
      return o.sources?.unknownKey === undefined
        ? []
        : [{ unknown_key: o.sources.unknownKey, total: "1" }]
    if (sql.includes("AS present") && sql.includes("rights_full_access_roles"))
      return [{ present: o.rights?.holdersFn === true }]
    if (sql.includes("FROM simetra.rights_full_access_roles()"))
      return o.rights?.previousRoles ?? []
    if (sql.includes(" AS actor,") && sql.includes(" AS archetype")) {
      const table = /FROM ([a-z_]+\.[a-z_]+)/.exec(sql)?.[1]
      return table === undefined ? [] : (o.rights?.holders[table] ?? [])
    }
    const rightTable = /FROM ([a-z_]+\.[a-z_]+)/.exec(sql)?.[1]
    if (rightTable !== undefined && o.rights?.rows[rightTable] !== undefined)
      return o.rights.rows[rightTable]!
    // Факти `plpgsql_check`: розширення немає — план іде далі з
    // діагностикою, а не падає
    if (sql.includes('AS "checkSchemaTaken"')) return [{ installed: false }]
    // Право `LOCK` на таблиці сліду читається вже після збору середовища:
    // кроки копій до нього дійшли, далі план фейкам не потрібен
    if (sql.includes("AS lockable")) {
      lockTables.push(...(JSON.parse(params[0] as string) as Named[]))
      throw new ReachedLockRights()
    }
    return []
  }
  const tx: ApplyTransaction = {
    query: async <R extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[]
    ) => answer(sql, params) as R[],
    extract: () => Promise.reject(new Error("no extract expected")),
  }
  const reader: ApplyDatabase = { transaction: (_db, _end, fn) => fn(tx) }
  return { reader, lockTables }
}

type Named = { schema: string; name: string }

const ENGINE = { name: "fake", version: "1" }

/** Двигун, чия бажана тінь дає план з `actions`; інших викликів не чекає. */
function fakeEngine(actions: EngineAction[]): SchemaEngine {
  const extracted = {
    model: EMPTY_CATALOG,
    catalog: {} as EngineCatalog,
    diagnostics: [],
    unpopulated: [],
  }
  const engine: Partial<SchemaEngine> = {
    identity: ENGINE,
    extract: () => Promise.resolve(extracted),
    plan: () => ({ actions, empty: false, preamble: [], diagnostics: [] }),
    withTargetClone: async (_o, _target, _scope, fn) => ({
      status: "loaded",
      value: await fn({ url: "postgres://clone" }),
      diagnostics: [],
    }),
    withDesiredShadow: async (_o, _sql, _scope, fn) => ({
      status: "loaded",
      value: await fn(
        { url: "postgres://shadow" },
        { actions, empty: false, preamble: [], diagnostics: [] }
      ),
      diagnostics: [],
    }),
  }
  return new Proxy(engine as SchemaEngine, {
    get: (target, name) => {
      if (name in target) return target[name as keyof SchemaEngine]
      throw new Error(`no engine call expected: ${String(name)}`)
    },
  })
}

/** Дія двигуна, що створює таблицю `name` у `public`. */
function createTable(name: string): EngineAction {
  return {
    sql: `CREATE TABLE public.${name} (id uuid)`,
    verb: "create",
    produces: [`table:public.${name}`],
    consumes: [],
    destroys: [],
    produced: [{ kind: "table", schema: "public", name }],
    destroyed: [],
    consumed: [],
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: [],
    lockClass: "none",
    dataLoss: false,
    rewriteRisk: false,
  }
}
