import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME,
} from "simetra/model"
import {
  ORG_KIND_ID,
  compileRights,
  policyDomain,
  signalTopicDomain,
  singleTenantRights,
  writeRoles,
} from "./fixtures/rights"
import { hasFixedBody } from "../sql/units"
import { catalog, metaFiles, project } from "./helpers"

/**
 * Генератор `rights_client_snapshot()` (спека П4-B §9.1): текст і гранти, які
 * дає компілятор. Що функція повертає під claims — DB-тест
 * `rights-client-snapshot`.
 */

const NAME = RIGHTS_CLIENT_SNAPSHOT_FUNCTION_NAME
const SIGNATURE = `simetra.${NAME}()`
const snapshotUnits = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.identity.includes(`simetra.${NAME}(`))
const fn = (model: CompiledModel) =>
  snapshotUnits(model).find((u) => u.class === "function")!

let model: CompiledModel
let verbatim: CompiledModel

beforeAll(async () => {
  const plain = await compileRights(policyDomain(writeRoles()))
  expect(plain.diagnostics).toEqual([])
  model = plain.model!
  const custom = await compileRights(signalTopicDomain())
  expect(custom.diagnostics).toEqual([])
  verbatim = custom.model!
})

describe("rights_client_snapshot", () => {
  it("is STABLE SECURITY INVOKER with an empty search_path and returns jsonb", () => {
    expect(fn(model).sql.split("\nAS ")[0]).toBe(
      `CREATE OR REPLACE FUNCTION ${SIGNATURE}\nRETURNS jsonb\nLANGUAGE plpgsql STABLE SECURITY INVOKER\nSET search_path = ''`
    )
  })

  // Генероване ≠ дослівне: тіло кличе платформні функції (`rights_mine`,
  // `current_user_id`), що для SQL застосунку — `sql.platform-function-call`.
  it("is platform SQL with a fixed body, not judged by the application SQL rules", () => {
    for (const unit of snapshotUnits(model)) {
      expect(unit.generator).toBe("rightsClientSnapshot")
      expect(hasFixedBody(unit)).toBe(true)
    }
    expect(fn(model).sql).toContain("simetra.rights_mine()")
  })

  it("grants EXECUTE only to the user and command roles and revokes the rest", () => {
    const roles = PROVIDER_API_ROLES.supabase
    expect(
      snapshotUnits(model)
        .filter((u) => u.class === "grant")
        .map((u) => u.sql)
        .sort()
    ).toEqual(
      [
        `REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM PUBLIC;`,
        `REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM ${roles.anonymous};`,
        `REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM ${roles.service};`,
        `GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO ${roles.user};`,
        `GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO ${PLATFORM_ROLES.command};`,
      ].sort()
    )
  })

  it("returns the empty value without a user and reads only the facts of the current user", () => {
    const { sql } = fn(model)
    expect(sql).toContain("v_user := (SELECT simetra.current_user_id());")
    expect(sql).toContain(
      "IF v_user IS NULL THEN\n    RETURN jsonb_build_object('userId', NULL, 'scopeSets', '[]'::jsonb, 'rights', '[]'::jsonb);"
    )
    expect(sql).toContain("FROM simetra.rights_mine() m")
    // Чужі факти — лише через `_of`-варіанти з параметром користувача.
    expect(sql).not.toMatch(/rights_\w+_of\(/)
  })

  it("orders every array by the full tuple", () => {
    const { sql } = fn(model)
    expect(sql).toContain(
      "ORDER BY m.level, m.level_id, m.scope, m.container, m.object, m.action, m.extent, m.dimension_id)"
    )
    expect(sql).toContain("ORDER BY s.scope_kind, s.scope)")
  })

  it("takes the scope set of a kind by the same expression as the read policy, once per kind", () => {
    const set = "public.org_member_member_scopes()"
    const policies = model.sqlUnits.filter(
      (u) => u.class === "policy" && u.sql.includes("task_scope_read")
    )
    expect(policies[0]!.sql).toContain(`ARRAY(SELECT ${set})`)
    const { sql } = fn(model)
    expect(sql).toContain(
      `'${ORG_KIND_ID}'::text AS scope_kind, ${set} AS scope`
    )
    expect(sql.split(set)).toHaveLength(2)
  })

  it("uses rights_scope_set for a kind with a verbatim set function, as the read policy does", () => {
    const call = `simetra.rights_scope_set('${ORG_KIND_ID}'::uuid)`
    const policy = verbatim.sqlUnits.find(
      (u) => u.class === "policy" && u.sql.includes("task_scope_read")
    )!
    expect(policy.sql).toContain(`ARRAY(SELECT ${call})`)
    expect(fn(verbatim).sql).toContain(`${call} AS scope`)
  })

  it("requires every function its body calls", () => {
    expect(fn(model).requires).toEqual(
      expect.arrayContaining([
        { type: "unit", identity: "function:simetra.current_user_id()" },
        { type: "unit", identity: "function:simetra.rights_mine()" },
        {
          type: "unit",
          identity: "function:public.org_member_member_scopes()",
        },
      ])
    )
    expect(fn(verbatim).requires).toEqual(
      expect.arrayContaining([
        {
          type: "unit",
          identity: expect.stringMatching(
            /^function:simetra\.rights_scope_set\(/
          ),
        },
      ])
    )
  })

  it("is created after every function it requires", () => {
    const order = model.creationOrder.map((n) =>
      n.type === "unit" ? n.identity : ""
    )
    const self = order.indexOf(fn(model).identity)
    expect(self).toBeGreaterThan(-1)
    for (const node of fn(model).requires ?? []) {
      if (node.type === "unit") {
        expect(order.indexOf(node.identity)).toBeLessThan(self)
      }
    }
  })

  it("exists in a single-tenant project without rights catalogs, with an empty scope list", async () => {
    const result = await compileRights(singleTenantRights())
    expect(result.diagnostics).toEqual([])
    expect(fn(result.model!).sql).toContain("'scopeSets', '[]'::jsonb,")
  })

  it("generates nothing without rights functions", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Item/Item.meta.json": catalog("Item"),
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(snapshotUnits(result.model!)).toEqual([])
  })
})
