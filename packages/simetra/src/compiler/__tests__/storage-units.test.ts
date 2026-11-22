import { describe, expect, it } from "vitest"
import { compile, type CompiledModel, type Diagnostic } from "simetra/compiler"
import { tenantBoundary } from "../access-units"
import { callersOfRole } from "../sql/execute-grants"
import { PLATFORM_STATE_TABLES, STORAGE_TABLES, ZERO_UUID } from "simetra/model"
import { uuid } from "./helpers"
import {
  ROLE_FILE,
  catalog,
  commandCoreLayer,
  grant,
  objects,
  policyDomain,
  role,
  singleTenantRights,
  adminRoles,
  writeRoles,
  type Layer,
} from "./fixtures/rights"
import { acceptDebt, expectClean } from "./helpers"

const SCOPED_ID = uuid(7101)
const FREE_ID = uuid(7102)
const storage = { maxBytes: 2048, mediaTypes: ["image/png", "text/plain"] }

/** Довідник зі `storage` у скоупі `org` і роль з `create` на нього. */
function scopedLayer(): Layer {
  return {
    "catalogs/Scan/Scan.meta.json": catalog(SCOPED_ID, "Scan", "scan", {
      storage,
    }),
    [ROLE_FILE("ScanWriter")]: role(
      uuid(7103),
      "ScanWriter",
      { scopeKind: "org" },
      {
        grants: [
          grant(objects(["Catalog", "Scan"]), ["read", "create"], "any"),
        ],
      }
    ),
  }
}

let scoped: CompiledModel
let free: CompiledModel
async function compiled(files: Map<string, string>) {
  const result = await compile(files)
  expectClean(result)
  return result.model!
}
async function setup() {
  scoped ??= await compiled(
    policyDomain(writeRoles(), adminRoles(), commandCoreLayer(), scopedLayer())
  )
  free ??= await compiled(
    singleTenantRights({
      "catalogs/Scan/Scan.meta.json": catalog(FREE_ID, "Scan", "scan", {
        scope: "none",
        storage,
      }),
      [ROLE_FILE("ScanWriter")]: role(uuid(7104), "ScanWriter", "global", {
        grants: [
          grant(objects(["Catalog", "Scan"]), ["read", "create"], "any"),
        ],
      }),
    })
  )
}

const storageUnits = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "storage")
const unitOf = (model: CompiledModel, identity: string) =>
  model.sqlUnits.find((u) => u.identity === identity)

describe("storage generator", () => {
  it("a project without storage has no storage tables and no storage units; the instance table is apply state", async () => {
    const result = await compile(policyDomain(writeRoles()))
    expectClean(result)
    const model = result.model!
    expect(
      model.physical.tables.filter((t) => t.name.startsWith("storage_"))
    ).toEqual([])
    expect(storageUnits(model)).toEqual([])
    expect(PLATFORM_STATE_TABLES).toContain(STORAGE_TABLES.instance.name)
  })

  it("lays the tables with RLS and no policy, and the file functions with their grants", async () => {
    await setup()
    const tables = scoped.physical.tables.filter(
      (t) => (t.origin as { part?: string }).part === "storage"
    )
    expect(tables.map((t) => t.name)).toEqual([
      "storage_pending",
      "storage_quota",
      "storage_usage",
    ])
    expect(tables.every((t) => t.rowLevelSecurity === "enabled")).toBe(true)
    const sql = storageUnits(scoped).map((u) => u.sql)
    for (const fn of [
      "file_attach(uuid, uuid, bigint, text)",
      "storage_rows_exist(uuid, uuid[])",
      "storage_row_page(uuid, uuid)",
      "storage_pending_left()",
      "storage_pending_sweep()",
      "storage_instance_id()",
    ]) {
      expect(sql).toContain(
        `GRANT EXECUTE ON FUNCTION simetra.${fn} TO simetra_files;`
      )
    }
    // `storage_headroom` — лише роль запиту, не `simetra_files`
    const headroom = sql.filter((s) => s.includes("storage_headroom"))
    expect(headroom.some((s) => s.startsWith("GRANT EXECUTE"))).toBe(true)
    expect(headroom.some((s) => s.includes("simetra_files"))).toBe(false)
    expect(sql).toContain("GRANT USAGE ON SCHEMA simetra TO simetra_files;")
    // Усі функції — definer з порожнім шляхом пошуку
    const functions = storageUnits(scoped).filter((u) => u.class === "function")
    expect(functions.length).toBeGreaterThan(6)
    for (const u of functions) {
      expect(u.sql).toContain("SECURITY DEFINER")
      expect(u.sql).toContain("SET search_path = ''")
    }
  })

  it("the binding function builds the fingerprint from the uuid, the cluster, the database and the timeline", async () => {
    await setup()
    const sql = unitOf(scoped, "function:simetra.storage_instance_id()")!.sql
    expect(sql).toContain("RETURNS text")
    expect(sql).toContain("pg_catalog.pg_control_system()")
    expect(sql).toContain("s.system_identifier")
    expect(sql).toContain("d.oid::text FROM pg_catalog.pg_database")
    expect(sql).toContain("pg_catalog.current_database()")
    expect(sql).toContain("pg_catalog.pg_control_checkpoint()")
    expect(sql).toContain("c.timeline_id")
  })

  it("the sweep removes only the records of transactions older than the snapshot xmin, for simetra_files alone", async () => {
    await setup()
    const sql = unitOf(scoped, "function:simetra.storage_pending_sweep()")!.sql
    expect(sql).toContain(
      "p.xact < pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot())"
    )
    const all = storageUnits(scoped).map((u) => u.sql)
    expect(all).toContain(
      "GRANT EXECUTE ON FUNCTION simetra.storage_pending_sweep() TO simetra_files;"
    )
  })

  it("puts the three triggers of the file on the table of the kind", async () => {
    await setup()
    const triggers = storageUnits(scoped)
      .filter((u) => u.class === "trigger")
      .map((u) => u.sql)
    expect(triggers).toHaveLength(3)
    expect(triggers.some((t) => /BEFORE INSERT ON \S+\.scan /.test(t))).toBe(
      true
    )
    expect(
      triggers.some((t) =>
        t.includes("BEFORE UPDATE OF file_size, file_content_type")
      )
    ).toBe(true)
    expect(triggers.some((t) => t.includes("AFTER INSERT OR DELETE"))).toBe(
      true
    )
  })

  it("builds headroom from the policy builders: scope boundary and row-free grants for a scoped object", async () => {
    await setup()
    const body = unitOf(
      scoped,
      "function:simetra.storage_headroom(uuid,uuid)"
    )!.sql
    expect(body).toContain(SCOPED_ID)
    // Межа скоупу користувача — рівно будівник межі тенанта над `p_scope`, а не
    // лише схожий текст: гранти теж містять `p_scope = ANY (…)`
    const scope = scoped.contracts.access.find(
      (a) => a.scope !== undefined
    )!.scope!
    const boundary = tenantBoundary({ ...scope, carrier: "p_scope" })
    // Форма умови: межа AND гранти AND запас, а не будь-які три шматки:
    // `OR` замість `AND` не мав би пройти
    const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    expect(body).toMatch(
      new RegExp(
        `RETURN COALESCE\\(${escaped} AND \\([^\\n]+\\) AND NOT EXISTS \\(SELECT 1 FROM [^\\n]*storage_quota[^\\n]*\\), false\\);`
      )
    )
    expect(body).toContain("simetra.rights_")
    expect(body).toContain("storage_quota")
    expect(body).not.toContain(ZERO_UUID)
  })

  it("an unscoped object keeps its usage under the zero uuids and judges the right by has_right", async () => {
    await setup()
    const body = unitOf(
      free,
      "function:simetra.storage_headroom(uuid,uuid)"
    )!.sql
    expect(body).toContain(FREE_ID)
    expect(body).toContain("has_right")
    expect(body).not.toContain("p_scope = ANY")
    const usage = storageUnits(free).find(
      (u) => u.class === "function" && u.sql.includes("storage_usage")
    )!
    expect(usage.sql).toContain(ZERO_UUID)
  })

  it("file_attach checks the object, the size and the type before it writes the record", async () => {
    await setup()
    const body = storageUnits(scoped).find(
      (u) => u.class === "function" && u.name === "file_attach"
    )!.sql
    expect(body).toContain("p_size > v_max")
    expect(body).toContain("NOT (p_type = ANY (v_types))")
    expect(body).toContain("ARRAY['image/png', 'text/plain']")
    expect(body).toContain("v_max := 2048")
    expect(body).toContain("ON CONFLICT DO NOTHING")
    expect(body).toContain("DETAIL = 'attach-invalid'")
  })
})

describe("application SQL leaves the storage alone (invariant 7)", () => {
  const EXTRA = "sql/public/extra.sql"
  const plpgsql = (body: string, options = "") =>
    `CREATE FUNCTION public.f() RETURNS void LANGUAGE plpgsql ${options} AS $$ BEGIN ${body}; END $$`
  const codes = (diagnostics: readonly Diagnostic[]) =>
    diagnostics.map((d) => d.code)
  const compiledWith = async (sql: string) => {
    const files = policyDomain(writeRoles(), scopedLayer())
    files.set(EXTRA, sql)
    return compile(await acceptDebt(files))
  }

  it.each([
    ["file_attach", "PERFORM simetra.file_attach(NULL, NULL, NULL, NULL)"],
    ["storage_headroom", "PERFORM simetra.storage_headroom(NULL, NULL)"],
    ["storage_rows_exist", "PERFORM simetra.storage_rows_exist(NULL, NULL)"],
    ["storage_row_page", "PERFORM simetra.storage_row_page(NULL, NULL)"],
    ["storage_pending_left", "PERFORM simetra.storage_pending_left()"],
    ["storage_pending_sweep", "PERFORM simetra.storage_pending_sweep()"],
    ["storage_instance_id", "PERFORM simetra.storage_instance_id()"],
  ])("a call of %s is sql.platform-function-call", async (_, body) => {
    const result = await compiledWith(plpgsql(body))
    expect(codes(result.diagnostics)).toEqual(["sql.platform-function-call"])
  })

  it("a definer function that reaches the storage by its own call is refused", async () => {
    const result = await compiledWith(
      plpgsql(
        "PERFORM simetra.file_attach(NULL, NULL, NULL, NULL)",
        "SECURITY DEFINER SET search_path = ''"
      )
    )
    expect(codes(result.diagnostics)).toContain("sql.platform-function-call")
  })

  it.each([
    ["INSERT INTO simetra.storage_usage VALUES (NULL, NULL, 1)"],
    ["DELETE FROM simetra.storage_quota"],
    ["UPDATE simetra.storage_pending SET size = 0"],
    ["INSERT INTO simetra.storage_instance DEFAULT VALUES"],
  ])("%s is a Rule 1 write", async (body) => {
    const result = await compiledWith(plpgsql(body))
    expect(codes(result.diagnostics)).toEqual(["sql.kind-table-verbatim"])
  })

  it.each([
    ["SET ROLE simetra_files"],
    ["PERFORM set_config('role', 'simetra_files', true)"],
  ])("%s is sql.command-context-write", async (body) => {
    const result = await compiledWith(plpgsql(body, "VOLATILE"))
    expect(codes(result.diagnostics)).toEqual(["sql.command-context-write"])
  })

  it("simetra_files is no grant purpose: nobody calls it, a verbatim grant on a storage function is refused", async () => {
    for (const provider of ["supabase", "postgres"] as const)
      expect(callersOfRole("simetra_files", provider)).toBeUndefined()
    for (const role of ["simetra_files", "simetra_command"]) {
      const result = await compiledWith(
        `GRANT EXECUTE ON FUNCTION simetra.file_attach(uuid, uuid, bigint, text) TO ${role};`
      )
      expect(codes(result.diagnostics)).toContain("schema.reserved")
    }
  })

  it.each([
    ["SET search_path = public"],
    ["PERFORM set_config('search_path', 'simetra', true)"],
  ])("%s in a definer function is refused", async (body) => {
    const result = await compiledWith(
      plpgsql(body, "SECURITY DEFINER SET search_path = ''")
    )
    expect(codes(result.diagnostics)).toContain("sql.command-context-write")
  })

  it("the option SET search_path = '' of the shell passes", async () => {
    const result = await compiledWith(
      "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;"
    )
    expect(codes(result.diagnostics)).not.toContain("sql.command-context-write")
  })
})
