import { describe, expect, it } from "vitest"
import { PLATFORM_ROLES } from "simetra/model"
import {
  applyChanges,
  canonicalSnapshot,
  compile,
  fixFiles,
  type CompiledModel,
} from "simetra/compiler"
import { buildPlan, desiredForApply, executePlan } from "simetra/schema"
import { createApplyDatabase } from "../schema-engine"
import { acceptDebt } from "../../../simetra/src/compiler/__tests__/helpers"
import { withRoles } from "../../../simetra/src/compiler/__tests__/fixtures/rights"
import { testProvider } from "../../../simetra/test/support"
import {
  engine,
  errors,
  inTarget,
  schemaPath,
  useRoundTrip,
} from "../schema-engine/__tests__/round-trip.support"
import { query } from "./support/db"

/**
 * Крок (д) `fix` над живою базою (спека декларацій функцій §5.6, Р7; план Д4,
 * інваріант Б6): глобальний ADP (без `IN SCHEMA`) після вирізання з теки
 * лишається в базі як середовище, тож вирізання безпечне лише тоді, коли
 * виведений `REVOKE` знімає все, що він дає, — отримувачі `PUBLIC` і ролі API.
 * Роль команд він не знімає: такий ADP `fix` лишає людині, і план без вирізу
 * не будується.
 */

const reader = createApplyDatabase({ readOnly: true })
const writer = createApplyDatabase({ readOnly: false })

const ADP_FILE = "sql/public/adp.sql"
const RPC_FILE = "sql/public/rpc.sql"
const RPC_FUNCTIONS = "sql/public/rpc.functions.json"
const RPC = "public.rpc(uuid)"

const RPC_SQL =
  "CREATE FUNCTION public.rpc(p_id uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$ BEGIN PERFORM simetra.rights_require('read', 'task', p_id); END $$;\n"

const options = () => {
  let n = 0
  return {
    schemaPath,
    newId: () => `7b000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  }
}

/** Тека прав профілю прогону без `rpc` (стан бази до застосування плану). */
function baseFolder(): Map<string, string> {
  const files = withRoles()
  files.set(
    "project.meta.json",
    JSON.stringify({
      ...JSON.parse(files.get("project.meta.json")!),
      database: { provider: testProvider() },
    })
  )
  return files
}

/** Та сама тека з задекларованим `rpc` і глобальним ADP, що дає `EXECUTE` `to`. */
async function withAdp(to: string): Promise<Map<string, string>> {
  const files = baseFolder()
  files.set(RPC_FILE, RPC_SQL)
  files.set(
    RPC_FUNCTIONS,
    JSON.stringify({
      functions: [
        {
          id: "7a000000-0000-4000-8000-000000000001",
          function: { name: "rpc" },
          callers: [],
          check: {
            action: "read",
            object: { kind: "Document", name: "Task" },
            row: "p_id",
          },
        },
      ],
    })
  )
  files.set(
    ADP_FILE,
    `ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO ${to};\n`
  )
  return acceptDebt(files)
}

/** План моделі над ціллю й його застосування з усіма запрошеними дозволами. */
async function applyModel(url: string, model: CompiledModel): Promise<void> {
  const target = { url }
  const outcome = await buildPlan(
    engine,
    { reader, scratch: createApplyDatabase({ readOnly: false }) },
    model,
    { target },
    []
  )
  expect({
    status: outcome.status,
    errors: errors(outcome.diagnostics),
  }).toEqual({ status: "planned", errors: [] })
  if (outcome.status !== "planned") throw new Error("plan refused")
  const artifact = outcome.artifact
  const applied = await executePlan(writer, target, artifact, {
    mode: "apply",
    planHash: artifact.planHash,
    allow: artifact.requiredPermissions,
    snapshot: canonicalSnapshot(model),
  })
  expect({
    status: applied.status,
    errors: errors(applied.diagnostics),
  }).toEqual({ status: "committed", errors: [] })
}

/** Одержувачі `EXECUTE` функції (без власника): `PUBLIC` чи ім'я ролі. */
async function executeAcl(url: string, signature: string): Promise<string[]> {
  const rows = await query<{ grantee: string }>(
    url,
    `select case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee
       from pg_proc p,
            aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = $1::regprocedure
        and a.privilege_type = 'EXECUTE'
        and a.grantee <> p.proowner`,
    [signature]
  )
  return rows.map((r) => r.grantee.replaceAll('"', "")).sort()
}

describe("fix cuts a global ADP only when the derived REVOKE removes its grants", () => {
  useRoundTrip()

  it("a global ADP TO PUBLIC is cut; the plan applied over the database that keeps it leaves the new function with its derived ACL only", async () => {
    const files = await withAdp("PUBLIC")
    const fixed = applyChanges(
      files,
      (await fixFiles(files, options())).changes
    )
    expect(fixed.has(ADP_FILE)).toBe(false)
    const compiled = await compile(fixed)
    expect(errors(compiled.diagnostics)).toEqual([])
    const model = compiled.model!

    // База має стан без `rpc` і глобальний ADP як середовище: його вирізали з
    // теки, але з бази це не прибирає нічого.
    const base = await compile(baseFolder())
    const desired = await desiredForApply(base.model!)
    await inTarget(desired.sql, desired.scope, async (target) => {
      await query(
        target.url,
        "ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC"
      )
      // Середовище живе: функція без плану отримала б `EXECUTE` для `PUBLIC`.
      await query(
        target.url,
        "CREATE FUNCTION public.probe() RETURNS int LANGUAGE sql AS 'SELECT 1'"
      )
      expect(await executeAcl(target.url, "public.probe()")).toContain("PUBLIC")
      await query(target.url, "DROP FUNCTION public.probe()")
      await applyModel(target.url, model)
      // Лише виведений ACL: `PUBLIC`, який дав би ADP, знято.
      expect(await executeAcl(target.url, RPC)).toEqual([])
    })
  })

  it("a global ADP that also names the command role is left to the author and the plan is not buildable", async () => {
    const to = `PUBLIC, ${PLATFORM_ROLES.command}`
    const files = await withAdp(to)
    const result = await fixFiles(files, options())
    const fixed = applyChanges(files, result.changes)
    expect(fixed.get(ADP_FILE)).toBe(files.get(ADP_FILE))
    expect(
      result.diagnostics.filter(
        (d) => d.code === "sql.default-privileges-execute"
      )
    ).toHaveLength(1)
    // Без вирізу немає моделі, а отже й плану.
    expect((await compile(fixed)).model).toBeUndefined()
  })
})
