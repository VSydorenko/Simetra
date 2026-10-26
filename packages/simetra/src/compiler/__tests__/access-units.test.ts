import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import { makeObjectName, type Dml } from "simetra/model"
import {
  accessPolicyNames,
  buildAccessUnits,
  tableGrants,
  type AccessPolicyContracts,
} from "../access-units"
import { sha256Hex } from "../canonical"
import { mainTableOf, type AccessContract } from "../contracts"
import { RIGHTS_FUNCTIONS } from "../rights/functions"
import {
  COMMAND_ACTION,
  renderCondition,
  rightsPredicates,
  type RightsPredicate,
} from "../rights/predicates"
import { sha256HexSync } from "../sha256"
import { loadSqlParser } from "../sql/parse"
import type { SqlUnit } from "../sql/units"
import {
  ATTACHMENTS_TABLE,
  BULLETIN_FILE,
  BULLETIN_TABLE,
  CHECKLIST_TABLE,
  COMMENT_TABLE,
  GLOBAL_ASSIGNMENTS_FILE,
  GLOBAL_GRANT_FILE,
  GLOBAL_ROLES_FILE,
  GRANT_FILE,
  HOURS_TABLES,
  ORG_KIND_ID,
  PROJECT_FILE,
  RATE_TABLE,
  REGION_DIMENSION_ID,
  REGION_NOTES_TABLE,
  SET_FILE,
  TASK_FILE,
  USERS_FILE,
  adoptedMembership,
  globalConstant,
  globalGrantTable,
  globalGrantsSource,
  grant,
  grantTable,
  grantsSource,
  membersSource,
  objects,
  policyDomain,
  rightsFiles,
  singleTenantRights,
  without,
  withRoles,
  writableRegister,
  writeRoles,
} from "./fixtures/rights"
import { readReferenceDomain } from "./fixtures/reference-domain"
import {
  expectClean,
  STOCK_FILE,
  SALE_FILE,
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  organization,
  project,
  salesDocument,
  scopedProject,
} from "./helpers"

async function compiled(entries: Record<string, unknown>) {
  const result = await compile(metaFiles(entries))
  expectClean(result, { allow: ["rights.scope-kind-unread"] })
  return result.model!
}

function scoped(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "project.meta.json": scopedProject(),
    "catalogs/Organization/Organization.meta.json": organization(),
    ...extra,
  }
}

/** ТЧ `lines`; фізичне ім'я таблиці рядків ТЧ задає файл, тож воно явне. */
function lines(physicalName: string) {
  return {
    id: "00000000-0000-4000-8000-000000000a01",
    name: "lines",
    physicalName,
    attributes: [attribute("note", { type: "String", length: 20 })],
  }
}

function accessOf(model: CompiledModel, table: string) {
  return model.contracts.access.filter((a) => a.table.name === table)
}

describe("accessContracts", () => {
  it("scoped catalog and its tabular section carry the scope column", async () => {
    const model = await compiled(
      scoped({
        "catalogs/Counterparty/Counterparty.meta.json": catalog(
          "Counterparty",
          { scope: "org", tabularSections: [lines("counterparty_lines")] }
        ),
      })
    )
    const id = model.objects.find((o) => o.name === "Counterparty")!.id
    const records = model.contracts.access.filter((a) => a.objectId === id)
    expect(records.map((r) => r.table.name)).toEqual([
      "counterparty",
      "counterparty_lines",
    ])
    const org = model.scopeKinds.find((k) => k.name === "org")!
    expect(org.setFunction).toEqual(model.scopeKinds[0]!.setFunction)
    for (const record of records) {
      expect(record.scope).toEqual({
        scopeKindId: org.id,
        carrier: "org_id",
        setFunction: model.scopeKinds[0]!.setFunction,
      })
      expect(record.publicRead).toEqual([])
    }
  })

  it("scope root keys its own rows by id and its section rows by parent_id", async () => {
    const model = await compiled({
      "project.meta.json": scopedProject(),
      "catalogs/Organization/Organization.meta.json": organization({
        tabularSections: [lines("organization_lines")],
      }),
    })
    expect(accessOf(model, "organization")[0]!.scope?.carrier).toBe("id")
    expect(accessOf(model, "organization_lines")[0]!.scope?.carrier).toBe(
      "parent_id"
    )
  })

  it("scoped accumulation register derived tables carry their own scope column", async () => {
    const scope = { scope: "org" }
    const entries = salesDocument()
    Object.assign(entries[SALE_FILE] as object, scope)
    Object.assign(entries[STOCK_FILE] as object, scope)
    entries["catalogs/Item/Item.meta.json"] = catalog("Item", scope)
    const model = await compiled(scoped(entries))
    const stockId = model.objects.find((o) => o.name === "Stock")!.id
    const parts = model.physical.tables
      .filter((t) => t.origin.objectId === stockId)
      .map((t) => t.origin.part ?? "main")
      .sort()
    expect(parts).toEqual(["main", "totals", "turnoversMonth"])
    const records = model.contracts.access.filter((a) => a.objectId === stockId)
    expect(records).toHaveLength(3)
    for (const record of records) expect(record.scope?.carrier).toBe("org_id")
  })

  it("unscoped catalog without publicRead has no scope and no public read", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      "catalogs/Region/Region.meta.json": catalog("Region"),
    })
    const objectId = model.objects.find((o) => o.name === "Region")!.id
    expect(model.contracts.access).toEqual([
      {
        objectId,
        table: { schema: "public", name: "region" },
        publicRead: [],
        root: false,
        users: false,
        rights: { objectId },
      },
    ])
  })

  it("anon public read opens both request roles, authenticated only the user", async () => {
    const model = await compiled(
      scoped({
        "catalogs/Region/Region.meta.json": catalog("Region", {
          scope: "none",
          publicRead: "anon",
        }),
        "catalogs/Counterparty/Counterparty.meta.json": catalog(
          "Counterparty",
          { scope: "org", publicRead: "authenticated" }
        ),
      })
    )
    expect(accessOf(model, "region")[0]!.publicRead).toEqual([
      "anonymous",
      "user",
    ])
    expect(accessOf(model, "counterparty")[0]!.publicRead).toEqual(["user"])
  })

  it("adopted tables and kinds without RLS have no access record", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      "catalogs/Contract/Contract.meta.json": catalog("Contract", {
        attributes: [attribute("number", { type: "String", length: 20 })],
      }),
      "custom-tables/Legacy/Legacy.meta.json": customTable("Legacy", {
        rowLevelSecurity: "enabled",
      }),
      "event-subscriptions/Stamp/Stamp.meta.json": {
        id: "00000000-0000-4000-8000-000000000a02",
        kind: "EventSubscription",
        name: "Stamp",
        physicalName: "stamp",
        sources: [{ kind: "Catalog", name: "Contract" }],
        event: "beforeWrite",
        handler: { schema: "public", name: "stamp" },
      },
      "sql/public/stamp.sql":
        "CREATE FUNCTION public.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN RETURN NEW; END $$;",
    })
    const legacy = model.physical.tables.find((t) => t.name === "legacy")!
    expect(legacy.rowLevelSecurity).toBe("enabled")
    expect(model.contracts.access.map((a) => a.table.name)).toEqual([
      "contract",
    ])
  })

  it("records are ordered by schema, then table name", async () => {
    const model = await compiled(
      scoped({
        "catalogs/Zeta/Zeta.meta.json": catalog("Zeta", { scope: "org" }),
        "catalogs/Alpha/Alpha.meta.json": catalog("Alpha", {
          scope: "org",
          schema: "app",
        }),
        "documents/Invoice/Invoice.meta.json": document("Invoice", {
          scope: "org",
        }),
      })
    )
    const tables = model.contracts.access.map(
      (a) => `${a.table.schema}.${a.table.name}`
    )
    expect(tables).toEqual(
      [...tables].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    )
    expect(tables[0]).toBe("app.alpha")
  })
})

const ITEM = { schema: "public", name: "item" }

function contract(overrides: Partial<AccessContract> = {}): AccessContract {
  return {
    objectId: "00000000-0000-4000-8000-000000000b01",
    table: ITEM,
    publicRead: [],
    root: false,
    users: false,
    ...overrides,
  }
}

const ORG_SCOPE = {
  scopeKindId: "00000000-0000-4000-8000-000000000b02",
  carrier: "org_id",
  setFunction: { schema: "public", name: "org_member_scopes" },
}

/** Без ролей і «Користувачів»: генератор будує лише гранти й межі. */
const NO_RIGHTS: AccessPolicyContracts = {
  rights: [],
  accessDimensions: [],
  roles: [],
  membership: [],
  membershipSources: [],
}

async function units(access: AccessContract[]) {
  return buildAccessUnits(
    access,
    NO_RIGHTS,
    { tables: [], enumTypes: [] },
    "supabase",
    "app",
    await loadSqlParser()
  )
}

const policySql = (units: readonly SqlUnit[]) =>
  units.filter((u) => u.class === "policy").map((u) => u.sql)

/** Політики таблиці скомпільованої моделі: ім'я → SQL. */
function policiesOf(model: CompiledModel, table: string): Map<string, string> {
  return new Map(
    model.sqlUnits
      .filter(
        (u) =>
          u.generator === "access" &&
          u.class === "policy" &&
          (u.tree as { CreatePolicyStmt: { table: { relname: string } } })
            .CreatePolicyStmt.table.relname === table
      )
      .map((u) => [u.name, u.sql])
  )
}

const ORG_BOUNDARY = "org_id = ANY (ARRAY(SELECT public.org_member_scopes()))"
const BOUNDED = "TO authenticated, simetra_command"

describe("buildAccessUnits", () => {
  it("user readers: revoke from PUBLIC and every API role, select to authenticated", () => {
    expect(tableGrants(ITEM, ["user"], "supabase").sort()).toEqual(
      [
        "REVOKE ALL ON TABLE public.item FROM PUBLIC;",
        "REVOKE ALL ON TABLE public.item FROM anon;",
        "REVOKE ALL ON TABLE public.item FROM service_role;",
        "REVOKE ALL ON TABLE public.item FROM authenticated;",
        "GRANT SELECT ON TABLE public.item TO authenticated;",
      ].sort()
    )
  })

  it("anonymous readers keep the revoke from anon before the grant", () => {
    // ADP схеми `public` дають `anon` усе, зокрема TRUNCATE: грант SELECT
    // сам по собі решти не відкликав би.
    const grants = tableGrants(ITEM, ["user", "anonymous"], "supabase")
    expect(grants).toContain("REVOKE ALL ON TABLE public.item FROM anon;")
    expect(grants).toContain("GRANT SELECT ON TABLE public.item TO anon;")
    expect(grants).toContain(
      "GRANT SELECT ON TABLE public.item TO authenticated;"
    )
    expect(grants.filter((g) => g.startsWith("GRANT"))).toHaveLength(2)
  })

  it("scoped table gets restrictive scope policies for every command", async () => {
    // Р2a2-1: межа тенанта — `RESTRICTIVE`, тож жодна `PERMISSIVE`-політика
    // прав її не розширює; `anon` її не отримує.
    expect(policySql(await units([contract({ scope: ORG_SCOPE })]))).toEqual([
      `CREATE POLICY item_scope_delete ON public.item AS RESTRICTIVE FOR DELETE ${BOUNDED} USING (${ORG_BOUNDARY});`,
      `CREATE POLICY item_scope_insert ON public.item AS RESTRICTIVE FOR INSERT ${BOUNDED} WITH CHECK (${ORG_BOUNDARY});`,
      `CREATE POLICY item_scope_read ON public.item AS RESTRICTIVE FOR SELECT ${BOUNDED} USING (${ORG_BOUNDARY});`,
      `CREATE POLICY item_scope_update ON public.item AS RESTRICTIVE FOR UPDATE ${BOUNDED} USING (${ORG_BOUNDARY}) WITH CHECK (${ORG_BOUNDARY});`,
    ])
  })

  it("the scope root has no scope insert policy", async () => {
    // Скоуп нового кореня — його власний `id`: межу нового тенанта дасть
    // право створення кореня (П4), а не множина моїх скоупів (Р2a2-1).
    const model = await compiled({
      "project.meta.json": scopedProject(),
      "catalogs/Organization/Organization.meta.json": organization({
        tabularSections: [lines("organization_lines")],
      }),
    })
    expect([...policiesOf(model, "organization").keys()].sort()).toEqual([
      "organization_scope_delete",
      "organization_scope_read",
      "organization_scope_update",
    ])
    expect([...policiesOf(model, "organization_lines").keys()].sort()).toEqual([
      "organization_lines_scope_delete",
      "organization_lines_scope_insert",
      "organization_lines_scope_read",
      "organization_lines_scope_update",
    ])
  })

  it("public read for anonymous and user opens all rows to both roles", async () => {
    const result = await units([
      contract({ publicRead: ["anonymous", "user"] }),
    ])
    expect(policySql(result)).toEqual([
      "CREATE POLICY item_public_read ON public.item AS PERMISSIVE FOR SELECT TO anon, authenticated, simetra_command USING (true);",
    ])
    expect(result.map((u) => u.sql)).toContain(
      "GRANT SELECT ON TABLE public.item TO anon;"
    )
  })

  it("unscoped table without public read has grants only", async () => {
    const result = await units([contract()])
    expect(result.filter((u) => u.class === "policy")).toEqual([])
    expect(result.every((u) => u.class === "grant")).toBe(true)
    expect(result.map((u) => u.sql).sort()).toEqual(
      tableGrants(ITEM, ["user"], "supabase").sort()
    )
  })

  it("units are generated, owned by the object and never grant on a schema", async () => {
    const result = await units([
      contract({ scope: ORG_SCOPE, publicRead: ["anonymous", "user"] }),
    ])
    for (const unit of result) {
      expect(unit.generator).toBe("access")
      expect(unit.ownerObjectId).toBe(contract().objectId)
      expect(unit.module).toBe("app")
      expect(unit.file).toBeUndefined()
      const grant = (unit.tree as { GrantStmt?: { objtype?: string } })
        .GrantStmt
      expect(grant?.objtype ?? "OBJECT_TABLE").toBe("OBJECT_TABLE")
    }
  })

  it("quotes names that need it", async () => {
    const table = { schema: "App", name: "select" }
    const result = await units([
      contract({
        table,
        scope: { ...ORG_SCOPE, carrier: "Org" },
      }),
    ])
    expect(result.map((u) => u.sql)).toContain(
      'GRANT SELECT ON TABLE "App"."select" TO authenticated;'
    )
    const read = result.find((u) => u.name === "select_scope_read")!.sql
    expect(read).toContain('ON "App"."select" AS RESTRICTIVE')
    expect(read).toContain('USING ("Org" = ANY')
  })

  it("policy names stay within 63 bytes and never collide", async () => {
    // Р2a2-2: довгі контейнер, вимір і колонка носія разом — мітка понад 40
    // байтів стає префіксом із хешем, тож імена однієї таблиці не збігаються
    // навіть тоді, коли від імені таблиці нічого не лишилось.
    const table = { schema: "public", name: "t".repeat(60) }
    const names = accessPolicyNames(table)
    const container = "c".repeat(60)
    const column = "k".repeat(63)
    const dimension = "d".repeat(63)
    const labels = [
      "any",
      "own",
      `own_${column}`,
      `own_${"k".repeat(62)}x`,
      dimension,
      `in_${container}_any`,
      `in_${container}_own`,
      `in_${container}_own_${column}`,
      `in_${container}_own_${"k".repeat(62)}x`,
      `in_${container}_${dimension}`,
    ]
    const dmls: Dml[] = ["insert", "update", "delete"]
    const all = [
      names.scopeRead,
      names.scopeInsert,
      names.scopeUpdate,
      names.scopeDelete,
      names.publicRead,
      names.commandInsert,
      names.commandUpdate,
      names.commandDelete,
      ...labels.map((label) => names.rights(label)),
      // Р2b1-11: мітка запису — `<dml>_<родина>_<мітка>` з тією самою межею.
      ...dmls.flatMap((dml) =>
        (["root", "rest"] as const).flatMap((family) =>
          labels.map((label) => names.write(dml, family, label))
        )
      ),
    ]
    for (const name of all) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(63)
    }
    expect(new Set(all).size).toBe(all.length)
    // Довга мітка — її перші 31 байт, `_` і 8 hex-знаків sha256 повної мітки.
    const long = `read_in_${container}_any`
    const hashed = `${long.slice(0, 31)}_${(await sha256Hex(long)).slice(0, 8)}`
    expect(hashed).toHaveLength(40)
    expect(names.rights(`in_${container}_any`)).toBe(
      `${"t".repeat(22)}_${hashed}`
    )
    const longWrite = `update_root_in_${container}_own`
    expect(names.write("update", "root", `in_${container}_own`)).toBe(
      `${"t".repeat(22)}_${longWrite.slice(0, 31)}_${(await sha256Hex(longWrite)).slice(0, 8)}`
    )
    expect(names.write("insert", "rest", "any")).toBe(
      makeObjectName(table.name, undefined, "insert_rest_any")
    )
    expect(names.commandUpdate).toBe(
      makeObjectName(table.name, undefined, "command_update")
    )
    // Коротка мітка лишається як є.
    expect(names.rights("in_project_any")).toBe(
      makeObjectName(table.name, undefined, "read_in_project_any")
    )
    const result = await units([
      contract({ table, scope: ORG_SCOPE, publicRead: ["user"] }),
    ])
    expect(
      result
        .filter((u) => u.class === "policy")
        .map((u) => u.name)
        .sort()
    ).toEqual(
      [
        names.publicRead,
        names.scopeInsert,
        names.scopeUpdate,
        names.scopeDelete,
      ].sort()
    )
  })

  it("the synchronous sha256 matches Web Crypto", async () => {
    for (const text of [
      "",
      "abc",
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(200),
      "read_in_контейнер_own",
    ]) {
      expect(sha256HexSync(text)).toBe(await sha256Hex(text))
    }
  })
})

describe("rights read and users visibility policies", () => {
  let domain: CompiledModel
  beforeAll(async () => {
    const result = await compile(policyDomain())
    expectClean(result)
    domain = result.model!
  })

  it("scoped tables of the policy domain keep their restrictive boundary", () => {
    for (const table of [
      "task",
      CHECKLIST_TABLE,
      COMMENT_TABLE,
      ATTACHMENTS_TABLE,
      ...Object.values(HOURS_TABLES),
    ]) {
      const policies = policiesOf(domain, table)
      expect(policies.get(`${table}_scope_read`)).toContain(
        "AS RESTRICTIVE FOR SELECT"
      )
      expect(policies.has(`${table}_scope_insert`)).toBe(true)
      expect(policies.has(`${table}_read`)).toBe(false)
    }
  })

  it("users are bounded by the visible users set in a project with membership", async () => {
    const visible = "ANY (ARRAY(SELECT simetra.rights_visible_users()))"
    expect(policiesOf(domain, "users").get("users_scope_read")).toBe(
      `CREATE POLICY users_scope_read ON public.users AS RESTRICTIVE FOR SELECT ${BOUNDED} USING (id = ${visible});`
    )
    expect(
      policiesOf(domain, "users_devices").get("users_devices_scope_read")
    ).toBe(
      `CREATE POLICY users_devices_scope_read ON public.users_devices AS RESTRICTIVE FOR SELECT ${BOUNDED} USING (parent_id = ${visible});`
    )
    // Без членства (однотенантний проєкт) і без ролей — ні межі, ні функції.
    for (const files of [singleTenantRights(), rightsFiles()]) {
      const result = await compile(files)
      expectClean(result, { allow: ["rights.scope-kind-unread"] })
      const model = result.model!
      expect(policiesOf(model, "users").has("users_scope_read")).toBe(false)
      expect(
        model.sqlUnits.some(
          (u) => u.name === RIGHTS_FUNCTIONS.visibleUsers.name
        )
      ).toBe(false)
    }
  })

  it("rights read policies come from the predicate builder", () => {
    // Кожна політика прав — рівно предикат будівника умов 2a1 (Р2a2-2):
    // власних форм умов тут немає.
    const expected = new Map<string, string>()
    for (const access of domain.contracts.access) {
      if (access.rights === undefined || access.publicRead.length > 0) continue
      const contract = domain.contracts.rights.find(
        (c) => c.objectId === access.rights!.objectId
      )!
      const table = domain.physical.tables.find(
        (t) => t.schema === access.table.schema && t.name === access.table.name
      )!
      for (const predicate of rightsPredicates(
        contract,
        "read",
        table,
        mainTableOf(domain.physical, contract.objectId)!
      )) {
        const using = predicate.conditions.map(renderCondition).join(" AND ")
        expected.set(
          `${table.name}:${using}`,
          `ON ${table.schema}.${table.name} AS PERMISSIVE FOR SELECT ${BOUNDED} USING (${using});`
        )
      }
    }
    const actual = domain.sqlUnits.filter(
      (u) =>
        u.generator === "access" &&
        u.class === "policy" &&
        /_read_/.test(u.name)
    )
    expect(actual).toHaveLength(expected.size)
    for (const unit of actual) {
      const table = (
        unit.tree as { CreatePolicyStmt: { table: { relname: string } } }
      ).CreatePolicyStmt.table.relname
      const using = unit.sql.slice(unit.sql.indexOf("USING (") + 7, -2)
      expect(unit.sql).toBe(
        `CREATE POLICY ${unit.name} ${expected.get(`${table}:${using}`)!}`
      )
    }
    // Предмет тесту — читання: політики запису перевіряють тести запису.
    expect(
      [...policiesOf(domain, "task").keys()]
        .filter((name) => /_(read|scope)_/.test(name))
        .sort()
    ).toEqual([
      "task_read_any",
      "task_read_in_project_any",
      "task_read_in_project_own",
      "task_read_in_project_region",
      "task_read_own",
      "task_read_region",
      "task_scope_delete",
      "task_scope_insert",
      "task_scope_read",
      "task_scope_update",
    ])
  })

  it("several ownership carriers are told apart by the carrier column", async () => {
    // Р2a2-2: без суфікса колонки носія обидві власні політики мали б одне
    // ім'я — дубль ідентичності без діагностики.
    const result = await compile(
      policyDomain({ [TASK_FILE]: { ownership: ["assignee", "createdBy"] } })
    )
    expectClean(result)
    const model = result.model!
    expect(
      [...policiesOf(model, "task").keys()]
        .filter((name) => name.includes("_read_"))
        .sort()
    ).toEqual([
      "task_read_any",
      "task_read_in_project_any",
      "task_read_in_project_own_assignee_id",
      "task_read_in_project_own_created_by_id",
      "task_read_in_project_region",
      "task_read_own_assignee_id",
      "task_read_own_created_by_id",
      "task_read_region",
    ])
    const identities = model.sqlUnits.map((u) => u.identity)
    expect(new Set(identities).size).toBe(identities.length)
  })

  const members = `ANY (ARRAY(SELECT simetra.rights_my_members('${ORG_KIND_ID}'::uuid)))`
  const own = (label: string) =>
    `org_id = ANY (ARRAY(SELECT simetra.rights_own('read', '${label}')))`
  const anyOf = (label: string) =>
    `org_id = ANY (ARRAY(SELECT simetra.rights_any('read', '${label}')))`
  const region = `'${REGION_DIMENSION_ID}'::uuid`

  it.each<[string, string, string]>([
    // ТЧ — копії носіїв власника й власна колонка скоупу (Р2a2-4).
    [
      `${CHECKLIST_TABLE}_read_own`,
      CHECKLIST_TABLE,
      `assignee_id = ${members} AND ${own("task")}`,
    ],
    [
      `${CHECKLIST_TABLE}_read_region`,
      CHECKLIST_TABLE,
      `region_id = ANY (ARRAY(SELECT simetra.rights_dimension_values(${region}))) AND org_id = ANY (ARRAY(SELECT simetra.rights_dim('read', 'task', ${region})))`,
    ],
    [
      `${CHECKLIST_TABLE}_read_in_project_any`,
      CHECKLIST_TABLE,
      "project_id = ANY (ARRAY(SELECT simetra.rights_container('read', 'task', 'any', NULL)))",
    ],
    // Носій шляху — його копія в основній таблиці й у ТЧ (Р2a2-6).
    [
      `${COMMENT_TABLE}_read_own`,
      COMMENT_TABLE,
      `task_id_assignee_id = ${members} AND ${own("task_comment")}`,
    ],
    [
      `${ATTACHMENTS_TABLE}_read_own`,
      ATTACHMENTS_TABLE,
      `task_id_assignee_id = ${members} AND ${own("task_comment")}`,
    ],
    // Носій-ключ копії не має: рядок ТЧ «Користувачів» — за `parent_id`.
    [
      "users_devices_read_own",
      "users_devices",
      "parent_id = (SELECT simetra.current_user_id()) AND (SELECT simetra.has_right('read', 'users', 'own', NULL))",
    ],
    // Похідна таблиця регістра — власна колонка скоупу й колонка виміру.
    [
      `${HOURS_TABLES.totals}_read_any`,
      HOURS_TABLES.totals,
      anyOf(HOURS_TABLES.movements),
    ],
    [
      `${HOURS_TABLES.totals}_read_region`,
      HOURS_TABLES.totals,
      `region_id = ANY (ARRAY(SELECT simetra.rights_dimension_values(${region}))) AND org_id = ANY (ARRAY(SELECT simetra.rights_dim('read', '${HOURS_TABLES.movements}', ${region})))`,
    ],
  ])("%s", (name, table, using) => {
    expect(policiesOf(domain, table).get(name)).toBe(
      `CREATE POLICY ${name} ON public.${table} AS PERMISSIVE FOR SELECT ${BOUNDED} USING (${using});`
    )
  })

  it("a register has neither own nor container read policies", () => {
    for (const table of Object.values(HOURS_TABLES)) {
      expect(
        [...policiesOf(domain, table).keys()]
          .filter((name) => name.includes("_read_"))
          .sort()
      ).toEqual([`${table}_read_any`, `${table}_read_region`])
    }
  })

  it("public read keeps write scope policies and has no rights read", async () => {
    // Р2a2-3: `publicRead` свідомо відкриває всі рядки на читання, а межа
    // запису від форми прав не залежить.
    const result = await compile(
      policyDomain({ [TASK_FILE]: { publicRead: "authenticated" } })
    )
    expectClean(result)
    for (const table of ["task", CHECKLIST_TABLE]) {
      // Предмет тесту — читання й межі: політики запису перевіряють тести запису.
      expect(
        [...policiesOf(result.model!, table).keys()]
          .filter((name) => /_(read|scope)_|_public_read$/.test(name))
          .sort()
      ).toEqual([
        `${table}_public_read`,
        `${table}_scope_delete`,
        `${table}_scope_insert`,
        `${table}_scope_update`,
      ])
    }
  })

  it("no rights read policies without roles", async () => {
    const result = await compile(rightsFiles())
    expectClean(result, { allow: ["rights.scope-kind-unread"] })
    const names = result
      .model!.sqlUnits.filter(
        (u) => u.generator === "access" && u.class === "policy"
      )
      .map((u) => u.name)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      expect(name).toMatch(/_scope_(read|insert|update|delete)$/)
    }
  })

  it("rights read policies follow the rights functions without users", async () => {
    // Р2a2-24, Р2d1-7: ролі й прийняте джерело членства без «Користувачів» —
    // поточного користувача дає `sub` (Р2d1-6), тож функції прав є, а з ними
    // й політики, що їх кличуть; межа тенанта лишається. Без функцій прав
    // політик немає — це тримає таблиця предикатів (rights-functions).
    // Довідники прав `org` лишаються: рівень скоупу з ролями джерелом не
    // покрито (Р2d1-5).
    const result = await compile(
      withRoles(
        adoptedMembership(),
        {
          [PROJECT_FILE]: {
            membershipSources: [membersSource()],
            assignmentSources: [
              grantsSource(),
              globalGrantsSource({
                table: { kind: "CustomTable", name: "GlobalGrant" },
              }),
            ],
          },
          [GRANT_FILE]: grantTable(),
          [GLOBAL_GRANT_FILE]: globalGrantTable(),
          [TASK_FILE]: { trackAuthor: false },
          [SET_FILE("TaskReaders")]: {
            grants: [grant(objects(["Document", "Task"]), ["read"], "any")],
          },
        },
        without(USERS_FILE, GLOBAL_ROLES_FILE, GLOBAL_ASSIGNMENTS_FILE)
      )
    )
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const model = result.model!
    expect(model.contracts.roles).not.toEqual([])
    const names = model.sqlUnits
      .filter((u) => u.generator === "access" && u.class === "policy")
      .map((u) => u.name)
    expect(names).toContain("task_scope_read")
    expect(names).toContain("task_read_any")
  })

  it("policy identities of the policy domain are unique", () => {
    const identities = domain.sqlUnits
      .filter((u) => u.class === "policy")
      .map((u) => u.identity)
    expect(new Set(identities).size).toBe(identities.length)
  })
})

describe("rights write policies", () => {
  let domain: CompiledModel
  beforeAll(async () => {
    const result = await compile(policyDomain(writeRoles(), writableRegister()))
    expectClean(result)
    domain = result.model!
  })

  const DMLS: Dml[] = ["insert", "update", "delete"]
  const COMMAND = "TO simetra_command"
  const context = "(SELECT simetra.command_action()) IS NOT NULL"
  const rootOf = (label: string) => `(SELECT simetra.command_root('${label}'))`
  const WRITE = /_(insert|update|delete)_(root|rest)_/

  /** Мітка політики за обсягом предиката: домен має один носій кожної форми. */
  function labelOf(predicate: RightsPredicate): string {
    const inner = (extent: RightsPredicate["extent"]): string => {
      if (extent === "any" || extent === "own") return extent
      if ("dimensionId" in extent) return "region"
      return `in_project_${inner(extent.inner)}`
    }
    return inner(predicate.extent)
  }

  function clauses(dml: Dml, condition: string): string {
    if (dml === "insert") return `WITH CHECK (${condition})`
    if (dml === "delete") return `USING (${condition})`
    return `USING (${condition}) WITH CHECK (${condition})`
  }

  /**
   * Очікувані політики запису таблиці (Р2b1-4): кореневий рядок — предикати
   * дії контексту з умовою родини, решта — предикати природної дії за DML.
   * Кожна умова — з будівника умов 2a1.
   */
  function expectedWrites(
    model: CompiledModel,
    tableName: string,
    root: { key: string; label: string } | undefined,
    rest: Partial<Record<Dml, string>>
  ): Map<string, string> {
    const table = model.physical.tables.find((t) => t.name === tableName)!
    const contract = model.contracts.rights.find(
      (c) => c.objectId === table.origin.objectId
    )!
    const main = mainTableOf(model.physical, contract.objectId)!
    const expected = new Map<string, string>()
    const add = (
      dml: Dml,
      family: "root" | "rest",
      action: string | typeof COMMAND_ACTION,
      prefix: string[]
    ) => {
      for (const predicate of rightsPredicates(contract, action, table, main)) {
        const name = `${tableName}_${dml}_${family}_${labelOf(predicate)}`
        const condition = [
          ...prefix,
          ...predicate.conditions.map(renderCondition),
        ].join(" AND ")
        expected.set(
          name,
          `CREATE POLICY ${name} ON ${table.schema}.${tableName} AS PERMISSIVE FOR ${dml.toUpperCase()} ${COMMAND} ${clauses(dml, condition)};`
        )
      }
    }
    for (const dml of DMLS) {
      if (root !== undefined) {
        add(dml, "root", COMMAND_ACTION, [
          `${root.key} = ${rootOf(root.label)}`,
        ])
      }
      const action = rest[dml]
      if (action !== undefined) {
        add(
          dml,
          "rest",
          action,
          root === undefined
            ? []
            : [`${root.key} IS DISTINCT FROM ${rootOf(root.label)}`]
        )
      }
    }
    return expected
  }

  const writesOf = (model: CompiledModel, table: string) =>
    new Map([...policiesOf(model, table)].filter(([name]) => WRITE.test(name)))

  /**
   * Повний набір імен політик таблиці зі скоупом: межа скоупу, читання за
   * предикатами `read`, охорона контексту й очікувані політики запису. Без
   * нього зайва політика з іменем поза шаблоном запису (скажімо, ще одна
   * `PERMISSIVE … WITH CHECK (true)`) пройшла б непоміченою.
   */
  function allPolicies(
    model: CompiledModel,
    tableName: string,
    writes: ReadonlyMap<string, string>
  ): string[] {
    const table = model.physical.tables.find((t) => t.name === tableName)!
    const contract = model.contracts.rights.find(
      (c) => c.objectId === table.origin.objectId
    )!
    const main = mainTableOf(model.physical, contract.objectId)!
    const names = accessPolicyNames(table)
    return [
      names.scopeRead,
      names.scopeInsert,
      names.scopeUpdate,
      names.scopeDelete,
      ...rightsPredicates(contract, "read", table, main).map((p) =>
        names.rights(labelOf(p))
      ),
      names.commandInsert,
      names.commandUpdate,
      names.commandDelete,
      ...writes.keys(),
    ].sort()
  }
  const policyNames = (model: CompiledModel, table: string) =>
    [...policiesOf(model, table).keys()].sort()

  it("guards every write command with the context", () => {
    // Р2b1-3: порожній чи відсутній контекст — відмова й там, де кореневої
    // родини немає (регістр).
    for (const table of ["task", CHECKLIST_TABLE, REGION_NOTES_TABLE]) {
      const policies = policiesOf(domain, table)
      expect(policies.get(`${table}_command_insert`)).toBe(
        `CREATE POLICY ${table}_command_insert ON public.${table} AS RESTRICTIVE FOR INSERT ${COMMAND} WITH CHECK (${context});`
      )
      expect(policies.get(`${table}_command_update`)).toBe(
        `CREATE POLICY ${table}_command_update ON public.${table} AS RESTRICTIVE FOR UPDATE ${COMMAND} USING (${context}) WITH CHECK (${context});`
      )
      expect(policies.get(`${table}_command_delete`)).toBe(
        `CREATE POLICY ${table}_command_delete ON public.${table} AS RESTRICTIVE FOR DELETE ${COMMAND} USING (${context});`
      )
    }
  })

  it("binds the root row to the command action and the rest to the natural one", () => {
    const expected = expectedWrites(
      domain,
      "task",
      { key: "id", label: "task" },
      { insert: "create", update: "update", delete: "delete" }
    )
    // Шість обсягів домену на кожну з шести пар (DML, родина).
    expect(expected.size).toBe(36)
    expect(writesOf(domain, "task")).toEqual(expected)
    expect(policyNames(domain, "task")).toEqual(
      allPolicies(domain, "task", expected)
    )
  })

  it("rights assignments write only the command root family", () => {
    const expected = expectedWrites(
      domain,
      "org_role_assignments",
      { key: "id", label: "org_role_assignments" },
      {}
    )
    expect([...expected.keys()].sort()).toEqual([
      "org_role_assignments_delete_root_any",
      "org_role_assignments_insert_root_any",
      "org_role_assignments_update_root_any",
    ])
    expect(writesOf(domain, "org_role_assignments")).toEqual(expected)
    expect(policyNames(domain, "org_role_assignments")).toEqual(
      allPolicies(domain, "org_role_assignments", expected)
    )
  })

  it("a tabular section binds to its owner", () => {
    // Р2b1-4, Р2b1-7: ключ родини — колонка власника з міткою власника;
    // природна дія ТЧ на будь-який DML — `update` власника.
    const expected = expectedWrites(
      domain,
      CHECKLIST_TABLE,
      { key: "parent_id", label: "task" },
      { insert: "update", update: "update", delete: "update" }
    )
    expect(writesOf(domain, CHECKLIST_TABLE)).toEqual(expected)
    expect(policyNames(domain, CHECKLIST_TABLE)).toEqual(
      allPolicies(domain, CHECKLIST_TABLE, expected)
    )
  })

  it("a register writes by its natural action without a root family", () => {
    const expected = expectedWrites(domain, REGION_NOTES_TABLE, undefined, {
      insert: "write",
      update: "write",
      delete: "write",
    })
    expect(expected.size).toBeGreaterThan(0)
    expect(writesOf(domain, REGION_NOTES_TABLE)).toEqual(expected)
    expect(policyNames(domain, REGION_NOTES_TABLE)).toEqual(
      allPolicies(domain, REGION_NOTES_TABLE, expected)
    )
    // Похідні таблиці регістра й регістр лише з `read` політик запису не мають.
    for (const table of Object.values(HOURS_TABLES)) {
      expect(
        [...policiesOf(domain, table).keys()].filter(
          (name) => WRITE.test(name) || name.includes("_command_")
        )
      ).toEqual([])
    }
  })

  it("public read opens rows to the command role too", async () => {
    // Р2b1-17: роль команд діє від імені користувача, якому рядки й так
    // відкриті; без цього запис з `WHERE` чи `RETURNING` не бачив би рядків.
    const policies = policiesOf(domain, BULLETIN_TABLE)
    expect(policies.get(`${BULLETIN_TABLE}_public_read`)).toBe(
      `CREATE POLICY ${BULLETIN_TABLE}_public_read ON public.${BULLETIN_TABLE} AS PERMISSIVE FOR SELECT TO authenticated, simetra_command USING (true);`
    )
    for (const dml of DMLS) {
      expect(policies.has(`${BULLETIN_TABLE}_scope_${dml}`)).toBe(true)
      expect(policies.has(`${BULLETIN_TABLE}_command_${dml}`)).toBe(true)
    }
    expect(policies.has(`${BULLETIN_TABLE}_scope_read`)).toBe(false)
    expect(
      [...policies.keys()].filter((name) => name.includes("_read_"))
    ).toEqual([])
    expect(writesOf(domain, BULLETIN_TABLE)).toEqual(
      expectedWrites(
        domain,
        BULLETIN_TABLE,
        { key: "id", label: BULLETIN_TABLE },
        { insert: "create", update: "update", delete: "delete" }
      )
    )
    const anon = await compile(
      policyDomain(writeRoles(), { [BULLETIN_FILE]: { publicRead: "anon" } })
    )
    expectClean(anon)
    expect(
      policiesOf(anon.model!, BULLETIN_TABLE).get(
        `${BULLETIN_TABLE}_public_read`
      )
    ).toContain("TO anon, authenticated, simetra_command USING (true)")
    // Читання від імені користувача від функцій прав не залежить.
    expect(
      policySql(await units([contract({ publicRead: ["user"] })]))
    ).toEqual([
      "CREATE POLICY item_public_read ON public.item AS PERMISSIVE FOR SELECT TO authenticated, simetra_command USING (true);",
    ])
  })

  it("a constant has no root family", async () => {
    // Р2b1-4: ключ константи — `singleton` чи колонка скоупу, а не `ref`,
    // тож умови родини немає (`boolean = uuid` зламав би розгортання);
    // Р2b1-7: природна `update` константи покриває вставку й оновлення.
    const reference = await compile(readReferenceDomain())
    expectClean(reference)
    const currency = policiesOf(reference.model!, "default_currency")
    expect([...currency.values()].join(" ")).not.toContain("command_root")
    expect(writesOf(reference.model!, "default_currency")).toEqual(
      expectedWrites(reference.model!, "default_currency", undefined, {
        insert: "update",
        update: "update",
      })
    )
    const result = await compile(policyDomain(globalConstant()))
    expectClean(result)
    const model = result.model!
    const writes = writesOf(model, RATE_TABLE)
    expect([...writes.keys()].sort()).toEqual([
      `${RATE_TABLE}_insert_rest_any`,
      `${RATE_TABLE}_update_rest_any`,
    ])
    expect(writes).toEqual(
      expectedWrites(model, RATE_TABLE, undefined, {
        insert: "update",
        update: "update",
      })
    )
  })

  it("no write policies without rights functions or write actions", async () => {
    const result = await compile(rightsFiles())
    expectClean(result, { allow: ["rights.scope-kind-unread"] })
    const names = result
      .model!.sqlUnits.filter(
        (u) => u.generator === "access" && u.class === "policy"
      )
      .map((u) => u.name)
    expect(names.length).toBeGreaterThan(0)
    expect(
      names.filter((name) => WRITE.test(name) || name.includes("_command_"))
    ).toEqual([])
    // Системні довідники прав відкривають адміністративний запис лише на корені.
    for (const contract of domain.contracts.rights) {
      if (contract.system === undefined) continue
      const writes = [...policiesOf(domain, contract.table.name).keys()].filter(
        (name) => WRITE.test(name)
      )
      expect(writes.length).toBeGreaterThan(0)
      expect(writes.every((name) => name.includes("_root_"))).toBe(true)
      expect(writes.some((name) => name.includes("_rest_"))).toBe(false)
    }
  })

  it("policy identities stay unique with write policies", () => {
    const identities = domain.sqlUnits
      .filter((u) => u.class === "policy")
      .map((u) => u.identity)
    expect(new Set(identities).size).toBe(identities.length)
  })
})
