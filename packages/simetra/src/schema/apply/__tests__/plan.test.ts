import { describe, expect, it } from "vitest"
import {
  applyChanges,
  canonicalSnapshot,
  compile,
  promoteObject,
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
  uuid,
} from "../../../compiler/__tests__/helpers"
import {
  ATTACHMENTS_TABLE,
  CHECKLIST_TABLE,
  TAG_ID,
  TASK_NOTE_ADOPTED_TABLE,
  TASK_NOTE_ID,
  compileRights,
  policyDomain,
  promotableTag,
  promotableTaskNote,
  tagMapping,
  taskNoteMapping,
} from "../../../compiler/__tests__/fixtures/rights"

/**
 * Конвеєр плану на фейковому порті — лише те, що не потребує справжньої
 * бази; решта — у `build-plan.db.test.ts` designer.
 */
describe("buildPlan", () => {
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
    "refuses a new carrier copy on a table with rows, judged against the marker snapshot ($case)",
    async ({ promotion }) => {
      // Р2a2-11: у marker цілі колонки копій ТЧ `checklist` і `attachments` не
      // були копіями (видалені реквізити з даними); таблицю `attachments`
      // план створює наново, тож рядків вона не має. З промоцією план іде
      // гілкою промоції: `Tag` з прийнятої таблиці стає довідником
      const { before, desired, records } = promotion
        ? await promotedTag()
        : await samePolicyDomain()
      const target = await fakeTarget(before, {
        notCopies: [CHECKLIST_TABLE, ATTACHMENTS_TABLE],
      })
      const outcome = await buildPlan(
        fakeEngine([createTable(ATTACHMENTS_TABLE)]),
        {
          reader: target.reader,
          scratch: promotion ? emptyScratch : noScratch,
        },
        desired,
        { target: { url: "postgres://target" } },
        records
      )
      expect(outcome).toMatchObject({
        status: "refused",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({
            code: "plan.carrier-backfill-missing",
            params: {
              table: `public.${CHECKLIST_TABLE}`,
              columns: "assignee_id, project_id, region_id",
            },
          }),
        ]),
      })
      expect(
        outcome.diagnostics.filter(
          (d) => d.code === "plan.carrier-backfill-missing"
        )
      ).toHaveLength(1)
      // Читається лише таблиця з копіями, яких marker не знав і план не створює
      expect(target.existsQueried).toEqual([`public.${CHECKLIST_TABLE}`])
    }
  )

  it("reads and refuses a table renamed by the promotion under its old name", async () => {
    // Р2a2-11: копія носія лягає на таблицю, яку промоція перейменовує;
    // перевірка рядків іде до перейменувань, тож лише старе ім'я існує в цілі
    const { before, desired, records } = await promoted(
      promotableTaskNote(),
      taskNoteMapping(),
      TASK_NOTE_ID
    )
    expect(
      desired.physical.tables.some((t) => t.name === TASK_NOTE_ADOPTED_TABLE)
    ).toBe(false)
    const target = await fakeTarget(before, { notCopies: [] })
    const outcome = await buildPlan(
      fakeEngine([]),
      { reader: target.reader, scratch: emptyScratch },
      desired,
      { target: { url: "postgres://target" } },
      records
    )
    expect(
      outcome.diagnostics.filter(
        (d) => d.code === "plan.carrier-backfill-missing"
      )
    ).toEqual([
      expect.objectContaining({
        params: {
          table: `public.${TASK_NOTE_ADOPTED_TABLE}`,
          columns: "task_id_assignee_id",
        },
      }),
    ])
    expect(target.existsQueried).toEqual([`public.${TASK_NOTE_ADOPTED_TABLE}`])
  })
})

async function samePolicyDomain() {
  const model = (await compileRights(policyDomain())).model!
  return { before: model, desired: model, records: [] }
}

/** Домен політик з прийнятою `Tag` до промоції, після неї й запис. */
function promotedTag() {
  return promoted(promotableTag(), tagMapping(), TAG_ID)
}

/** Домен політик з прийнятою таблицею `layer` до промоції, після неї й запис. */
async function promoted(
  layer: Parameters<typeof policyDomain>[0],
  mapping: Parameters<typeof promoteObject>[1],
  id: string
) {
  const files = policyDomain(layer)
  const before = (await compileRights(files)).model!
  let n = 950_000
  const result = await promoteObject(files, mapping, {
    schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
    newId: () => uuid(++n),
  })
  expect(result.diagnostics).toEqual([])
  const desired = (await compileRights(applyChanges(files, result.changes)))
    .model!
  const records: PromotionInput[] = [
    { record: result.record!, file: `plans/${id}.promotion.json` },
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

/** Ціль, якої план не пише: прогін-доказ і копії тут не потрібні. */
const noScratch: ApplyDatabase = {
  transaction: () => Promise.reject(new Error("no copy expected")),
}

const EMPTY_CATALOG: CatalogModel = { tables: [], enumTypes: [], units: [] }

/**
 * Фейкова ціль Postgres 17 з marker `model`: колонки копій таблиць
 * `notCopies` у знімку marker — звичайні колонки. Відбиток і модель
 * каталогу збігаються з marker, тож гейт дрейфу пропускає; у кожній таблиці
 * є рядок. `existsQueried` — таблиці, які план перевірив на рядки.
 */
async function fakeTarget(
  model: CompiledModel,
  o: { notCopies: readonly string[] }
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
  const existsQueried: string[] = []
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
    const exists = /^SELECT EXISTS \(SELECT 1 FROM (\S+)\)/.exec(sql)
    if (exists !== null) {
      existsQueried.push(exists[1]!)
      return [{ found: true }]
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
  return { reader, existsQueried }
}

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
