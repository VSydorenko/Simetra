import { describe, expect, it } from "vitest"
import {
  compile,
  executeGrants,
  platformSchemaGrants,
  type CompiledModel,
  type PromotionRecord,
} from "simetra/compiler"
import { PLATFORM_ROLES, PROVIDER_API_ROLES, quoteIdent } from "simetra/model"
import {
  FINGERPRINT_SECTIONS,
  applyStateOf,
  renderApplyState,
  type EnginePlan,
  type Extracted,
  writeApplyStateStatements,
  type CatalogFingerprint,
  type DriftReport,
  type FingerprintSection,
} from "simetra/schema"
import {
  adoptedSourcesDomain,
  compileRights,
  withoutUsers as withoutUsersLayer,
} from "../../../compiler/__tests__/fixtures/rights"
import {
  catalog,
  metaFiles,
  project,
} from "../../../compiler/__tests__/helpers"

async function model(files: Record<string, unknown>): Promise<CompiledModel> {
  const compiled = await compile(
    metaFiles({ "project.meta.json": project(), ...files })
  )
  expect(compiled.diagnostics).toEqual([])
  return compiled.model!
}

const withoutUsers = () =>
  model({ "catalogs/Party/Party.meta.json": catalog("Party") })

const withUsers = () =>
  model({
    "catalogs/Users/Users.meta.json": catalog("Users", {
      role: "users",
      scope: "none",
    }),
  })

const usage = Object.values(PROVIDER_API_ROLES.supabase).map(
  (role) => `GRANT USAGE ON SCHEMA simetra TO ${quoteIdent(role)};`
)

const snapshotHashGrants = executeGrants(
  "simetra.applied_snapshot_hash()",
  ["command"],
  "supabase"
)

// Читають епоху команди й обидві ролі запиту (гостьова сесія теж); скидання
// не має отримувача
const epochGrants = executeGrants(
  "simetra.row_version_epoch()",
  ["command", "user", "anonymous"],
  "supabase"
)
const resetGrants = executeGrants(
  "simetra.reset_row_version_epoch()",
  [],
  "supabase"
)
const stateGrants = [...snapshotHashGrants, ...epochGrants, ...resetGrants]

describe("renderApplyState", () => {
  it("creates the schema with marker and ledger", async () => {
    const sql = renderApplyState(await withoutUsers())
    expect(sql).toContain("CREATE SCHEMA IF NOT EXISTS simetra;")
    expect(sql).toContain("CREATE TABLE simetra.marker (")
    expect(sql).toContain("CREATE TABLE simetra.ledger (")
  })

  it("secures the schema itself when the platform layer is absent", async () => {
    const sql = renderApplyState(await withoutUsers())
    expect(sql).toContain("REVOKE ALL ON SCHEMA simetra FROM PUBLIC;")
    expect(usage).toHaveLength(3)
    for (const grant of usage) expect(sql).toContain(grant)
  })

  it("leaves schema grants to the platform layer when it is present", async () => {
    const m = await withUsers()
    const lines = renderApplyState(m).split("\n")
    // Рішення Р-A3-16: стан дає лише гранти своєї функції, а схему — шар
    expect(lines.filter((l) => /^(GRANT|REVOKE)\b/.test(l))).toEqual(
      stateGrants
    )
    // Ті самі одиниці вже дає платформний шар — дубля не буде
    const layer = m.sqlUnits.map((u) => u.sql)
    expect(layer).toContain("REVOKE ALL ON SCHEMA simetra FROM PUBLIC;")
    for (const grant of usage) expect(layer).toContain(grant)
  })

  it("secures the schema once when the session user comes from the subject", async () => {
    // Без «Користувачів» шар дає лише `current_user_id()` з `sub` (спека користувачів §7):
    // безпеку схеми — стан застосування, і в бажаному SQL вона рівно одна.
    const result = await compileRights(
      adoptedSourcesDomain(withoutUsersLayer())
    )
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const m = result.model!
    expect(m.sqlUnits.map((u) => u.identity)).toContain(
      "function:simetra.current_user_id()"
    )
    const desired = [
      ...renderApplyState(m).split("\n"),
      ...m.sqlUnits.flatMap((u) => u.sql.split("\n")),
    ]
    for (const grant of [
      ...usage,
      `GRANT USAGE ON SCHEMA simetra TO ${quoteIdent(PLATFORM_ROLES.command)};`,
      "REVOKE ALL ON SCHEMA simetra FROM PUBLIC;",
    ])
      expect(
        desired.filter((line) => line === grant),
        grant
      ).toHaveLength(1)
  })

  it("gives the ledger a nullable promotion column", async () => {
    const sql = renderApplyState(await withoutUsers())
    const ledger = sql.slice(sql.indexOf("CREATE TABLE simetra.ledger ("))
    expect(ledger).toMatch(/^ {2}promotion jsonb,$/m)
  })

  it("gives the ledger a nullable rehearsal hash column", async () => {
    const sql = renderApplyState(await withoutUsers())
    const ledger = sql.slice(sql.indexOf("CREATE TABLE simetra.ledger ("))
    expect(ledger).toMatch(/^ {2}rehearsal_hash text,$/m)
  })

  it("grants nothing on the state tables", async () => {
    // Рішення Р-A3-16: поза гранти схеми — лише EXECUTE функцій стану
    for (const [m, schema] of [
      [await withoutUsers(), platformSchemaGrants("supabase")],
      [await withUsers(), []],
    ] as const) {
      const lines = renderApplyState(m).split("\n")
      expect(lines.filter((l) => /^(GRANT|REVOKE)\b/.test(l))).toEqual([
        ...schema,
        ...stateGrants,
      ])
      expect(lines.join("\n")).not.toMatch(/ON\s+(ALL\s+)?TABLES?\b/i)
    }
  })

  it("reads the applied snapshot hash through a definer function", async () => {
    for (const m of [await withoutUsers(), await withUsers()]) {
      const sql = renderApplyState(m)
      const fn = [
        "CREATE OR REPLACE FUNCTION simetra.applied_snapshot_hash()",
        "RETURNS text",
        "LANGUAGE sql STABLE SECURITY DEFINER",
        "SET search_path = ''",
        "AS $$SELECT snapshot_hash FROM simetra.marker$$;",
      ].join("\n")
      expect(sql).toContain(fn)
      // Тіло SQL-функції Postgres перевіряє при створенні: marker — раніше
      expect(sql.indexOf(fn)).toBeGreaterThan(
        sql.indexOf("CREATE TABLE simetra.marker (")
      )
      expect(sql.indexOf(snapshotHashGrants[0]!)).toBeGreaterThan(
        sql.indexOf(fn)
      )
    }
  })
})

describe("renderApplyState: epoch of row versions", () => {
  const FN = (name: string) => `CREATE OR REPLACE FUNCTION simetra.${name}()`

  it("creates the one-row epoch table", async () => {
    const sql = renderApplyState(await withoutUsers())
    expect(sql).toContain(
      [
        "CREATE TABLE simetra.version_epoch (",
        "  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),",
        "  epoch uuid NOT NULL DEFAULT gen_random_uuid()",
        ");",
      ].join("\n")
    )
  })

  it("reads the epoch through a stable definer function that is NULL on a replica", async () => {
    for (const m of [await withoutUsers(), await withUsers()]) {
      const sql = renderApplyState(m)
      const start = sql.indexOf(FN("row_version_epoch"))
      expect(start).toBeGreaterThan(
        sql.indexOf("CREATE TABLE simetra.version_epoch")
      )
      const fn = sql.slice(start, sql.indexOf("\n\n", start) + 1)
      expect(fn).toContain("RETURNS text")
      expect(fn).toContain("LANGUAGE sql STABLE SECURITY DEFINER")
      expect(fn).toContain("SET search_path = ''")
      expect(fn).toContain("pg_is_in_recovery()")
      expect(fn).toContain("substr(")
      expect(fn).toContain(", 1, 8)")
      expect(fn).toContain("pg_control_system()")
      expect(fn).toContain("pg_postmaster_start_time()")
      expect(fn).toContain("e.epoch::text")
      // Не літерал `::regclass`: послідовність двигун може створити пізніше
      expect(fn).not.toContain("::regclass")
      expect(fn).toContain("to_regclass('simetra.row_version')")
      expect(fn).not.toContain("simetra_runtime")
    }
  })

  it("lets the command role and both request roles read the epoch, nobody run the reset", async () => {
    const lines = renderApplyState(await withoutUsers()).split("\n")
    for (const role of [
      PLATFORM_ROLES.command,
      PROVIDER_API_ROLES.supabase.user,
      PROVIDER_API_ROLES.supabase.anonymous,
    ])
      expect(lines).toContain(
        `GRANT EXECUTE ON FUNCTION simetra.row_version_epoch() TO ${quoteIdent(role)};`
      )
    expect(lines).not.toContain(
      `GRANT EXECUTE ON FUNCTION simetra.row_version_epoch() TO ${quoteIdent(PROVIDER_API_ROLES.supabase.service ?? "service_role")};`
    )
    expect(
      lines.filter((l) =>
        l.startsWith(
          "GRANT EXECUTE ON FUNCTION simetra.reset_row_version_epoch()"
        )
      )
    ).toEqual([])
    expect(lines).toContain(
      "REVOKE EXECUTE ON FUNCTION simetra.reset_row_version_epoch() FROM PUBLIC;"
    )
  })

  it("seeds over the mechanics tables of the model and draws a new epoch", async () => {
    const m = await withoutUsers()
    const sql = renderApplyState(m)
    const start = sql.indexOf(FN("reset_row_version_epoch"))
    const fn = sql.slice(start, sql.indexOf("$$;", start))
    expect(fn).toContain("LANGUAGE plpgsql SECURITY INVOKER")
    expect(fn).toContain("SET search_path = ''")
    // Таблиці беруться з моделі, а не з імен колонок
    expect(fn).toContain("LOCK TABLE public.party IN SHARE MODE;")
    expect(fn).toContain("ALTER SEQUENCE simetra.row_version NO CYCLE;")
    expect(fn).toContain("setval('simetra.row_version', v_max, true)")
    expect(fn).toContain(
      "CASE WHEN is_called THEN last_value + 1 ELSE last_value END"
    )
    expect(fn).toContain(
      "UPDATE simetra.version_epoch SET epoch = gen_random_uuid();"
    )
    expect(fn).toContain("INSERT INTO simetra.version_epoch DEFAULT VALUES;")
    // Ручний виклик пише послідовність, тож коміт синхронний за правилом раннера
    expect(fn).toContain(
      "PERFORM pg_catalog.set_config('synchronous_commit', 'on', true) WHERE pg_catalog.current_setting('synchronous_commit') IN ('off', 'local');"
    )
    // Замки йдуть до повторного сканування й до `setval`; epoха — після засіву
    expect(fn.indexOf("LOCK TABLE")).toBeLessThan(fn.indexOf("ALTER SEQUENCE"))
    expect(fn.indexOf("ALTER SEQUENCE")).toBeLessThan(fn.indexOf("setval("))
    expect(fn.indexOf("setval(")).toBeLessThan(
      fn.indexOf("UPDATE simetra.version_epoch")
    )
  })
})

describe("applyStateOf", () => {
  const FN = "function:simetra.applied_snapshot_hash()"
  const target = (units: string[]): Extracted => ({
    model: {
      tables: [],
      enumTypes: [],
      units: units.map((identity) => ({
        class: "function",
        identity,
        schema: "simetra",
        name: identity,
        sql: "",
      })),
    },
    catalog: { engine: "test" },
    diagnostics: [],
    unpopulated: [],
  })
  const plan = (produces: string[]): EnginePlan => ({
    actions: produces.map((id) => ({
      sql: "",
      verb: "create",
      produces: [id],
      consumes: [],
      destroys: [],
      produced: [],
      destroyed: [],
      consumed: [],
      transactionality: "transactional",
      newSegmentBefore: false,
      lockedTables: [],
      lockClass: "none",
      dataLoss: false,
      rewriteRisk: false,
    })),
    empty: produces.length === 0,
    preamble: [],
    diagnostics: [],
  })

  it("sees the state as present when only the function is left", async () => {
    for (const m of [await withoutUsers(), await withUsers()])
      expect(applyStateOf(target([FN]), plan([]), m).state).toBe("present")
  })

  it("sees the state as absent without the function, tables and schema", async () => {
    const m = await withoutUsers()
    expect(
      applyStateOf(target([]), plan(["schema:simetra", FN]), m).state
    ).toBe("absent")
  })

  it("does not need the schema to be absent when the platform layer owns it", async () => {
    // З шаром схема — його одиниця: стан відсутній, щойно немає таблиць і
    // функції, хоч би схема й існувала
    const m = await withUsers()
    expect(applyStateOf(target([]), plan([FN]), m).state).toBe("absent")
    expect(applyStateOf(target([FN]), plan([]), m).state).toBe("present")
  })

  it("owns the function, its ACL and its grant units, not other platform functions", async () => {
    for (const m of [await withoutUsers(), await withUsers()]) {
      const state = applyStateOf(target([FN]), plan([]), m)
      for (const id of [
        FN,
        `acl:(${FN}).simetra_command`,
        `acl:(${FN}).anon`,
        "grant:grant:function:simetra.applied_snapshot_hash():simetra_command:execute",
        "grant:revoke:function:simetra.applied_snapshot_hash():public:execute",
      ])
        expect(state.owns(id), id).toBe(true)
      expect(state.ownsPath(`units.${FN}`)).toBe(true)
      for (const id of [
        "function:simetra.current_user_id()",
        "acl:(function:simetra.current_user_id()).authenticated",
        "grant:grant:function:simetra.current_user_id():authenticated:execute",
        "function:simetra.applied_snapshot_hash_x()",
      ])
        expect(state.owns(id), id).toBe(false)
    }
  })

  const SEQ = "sequence:simetra.row_version"
  const EPOCH_FN = "function:simetra.row_version_epoch()"
  const RESET_FN = "function:simetra.reset_row_version_epoch()"

  it("owns the version sequence, its revokes and its ACL, not other sequences", async () => {
    for (const m of [await withoutUsers(), await withUsers()]) {
      const state = applyStateOf(target([]), plan([]), m)
      for (const id of [
        SEQ,
        `acl:(${SEQ}).anon`,
        "grant:revoke:sequence:simetra.row_version:public:all",
        "grant:revoke:sequence:simetra.row_version:authenticated:all",
        EPOCH_FN,
        RESET_FN,
        "grant:grant:function:simetra.row_version_epoch():anon:execute",
        "grant:revoke:function:simetra.reset_row_version_epoch():public:execute",
        "table:simetra.version_epoch",
      ])
        expect(state.owns(id), id).toBe(true)
      for (const id of [
        "sequence:simetra.other",
        "sequence:public.row_version",
        "grant:revoke:sequence:simetra.other:public:all",
      ])
        expect(state.owns(id), id).toBe(false)
    }
  })

  it("sees the state as present when only the version sequence is left", async () => {
    // Послідовність без таблиць і функцій — часткове застосування: інакше
    // її відсутність у плані лишилася б непоміченою
    for (const m of [await withoutUsers(), await withUsers()])
      expect(
        applyStateOf(target([SEQ]), plan(["schema:simetra", FN]), m).state
      ).toBe("present")
  })

  it("sees the state as absent when the sequence is missing too", async () => {
    const m = await withoutUsers()
    expect(
      applyStateOf(
        target([]),
        plan(["schema:simetra", FN, EPOCH_FN, RESET_FN, SEQ]),
        m
      ).state
    ).toBe("absent")
  })

  it("sees the state as present when only an epoch function is left", async () => {
    for (const fn of [EPOCH_FN, RESET_FN])
      expect(
        applyStateOf(
          target([fn]),
          plan(["schema:simetra"]),
          await withoutUsers()
        ).state
      ).toBe("present")
  })
})

describe("writeApplyStateStatements", () => {
  const fingerprint = (version: number): CatalogFingerprint => ({
    version,
    sections: Object.fromEntries(
      FINGERPRINT_SECTIONS.map((s) => [s, s])
    ) as Record<FingerprintSection, string>,
  })

  it("refuses fingerprints of different versions: the ledger has one version column", () => {
    expect(() =>
      writeApplyStateStatements({
        planHash: "p",
        fromHash: null,
        toHash: "t",
        snapshot: {},
        scope: { schemas: ["app"], provider: "supabase" },
        catalog: { tables: [], enumTypes: [], units: [] },
        engine: { name: "e", version: "1" },
        targetFingerprint: fingerprint(1),
        resultFingerprint: fingerprint(2),
        allow: [],
        drift: null,
        promotion: null,
        rehearsalHash: null,
        applyId: "00000000-0000-4000-8000-000000000000",
      })
    ).toThrow(/fingerprint versions differ/)
  })

  /** Значення колонки ledger за її назвою в `INSERT`. */
  const ledgerValue = (
    drift: DriftReport | null,
    column: string,
    promotion: { hash: string; record: PromotionRecord } | null = null,
    rehearsalHash: string | null = null
  ): unknown => {
    const [, ledger] = writeApplyStateStatements({
      planHash: "p",
      fromHash: null,
      toHash: "t",
      snapshot: {},
      scope: { schemas: ["app"], provider: "supabase" },
      catalog: { tables: [], enumTypes: [], units: [] },
      engine: { name: "e", version: "1" },
      targetFingerprint: fingerprint(1),
      resultFingerprint: fingerprint(1),
      allow: ["drift"],
      drift,
      promotion,
      rehearsalHash,
      applyId: "00000000-0000-4000-8000-000000000000",
    })
    const columns = /\(([^)]*)\)/
      .exec(ledger!.sql)![1]!
      .split(",")
      .map((c) => c.trim())
    expect(columns).toContain(column)
    return ledger!.params[columns.indexOf(column)]
  }

  it("records the accepted drift in the ledger", () => {
    const drift: DriftReport = {
      reason: "drift",
      sections: ["owner"],
      paths: ["tables.app.t.columns.c"],
    }
    expect(ledgerValue(drift, "drift")).toBe(JSON.stringify(drift))
  })

  it("writes SQL NULL, not JSON null, for a plan without drift", () => {
    expect(ledgerValue(null, "drift")).toBeNull()
  })

  const RECORD: PromotionRecord = {
    format: 1,
    base: "0".repeat(64),
    result: "1".repeat(64),
    objectId: "00000000-0000-4000-8000-000000000001",
    kind: "Catalog",
    tables: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        schema: "app",
        from: "parties",
        to: "party",
      },
    ],
    columns: [],
    typeChanges: [],
    dataSteps: [],
    retired: [],
    relaxed: [],
    tightened: [],
    rowLevelSecurity: [],
    deleteSemantics: [],
    conversions: [],
    movedUnits: [],
    rewrittenUnits: [],
    contractChanges: [],
  }

  it("records the applied promotion with its hash", () => {
    const promotion = { hash: "h".repeat(64), record: RECORD }
    expect(ledgerValue(null, "promotion", promotion)).toBe(
      JSON.stringify(promotion)
    )
  })

  it("writes SQL NULL for a plan without promotion", () => {
    expect(ledgerValue(null, "promotion")).toBeNull()
    expect(ledgerValue(null, "rehearsal_hash")).toBeNull()
  })

  it("records the hash of the rehearsal report", () => {
    const promotion = { hash: "h".repeat(64), record: RECORD }
    expect(ledgerValue(null, "rehearsal_hash", promotion, "r".repeat(64))).toBe(
      "r".repeat(64)
    )
  })
})
