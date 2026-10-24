import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import { makeObjectName } from "simetra/model"
import {
  accessPolicyNames,
  buildAccessUnits,
  tableGrants,
  type AccessPolicyContracts,
} from "../access-units"
import { sha256Hex } from "../canonical"
import { mainTableOf, type AccessContract } from "../contracts"
import { RIGHTS_FUNCTIONS } from "../rights/functions"
import { renderCondition, rightsPredicates } from "../rights/predicates"
import { sha256HexSync } from "../sha256"
import { loadSqlParser } from "../sql/parse"
import type { SqlUnit } from "../sql/units"
import {
  ATTACHMENTS_TABLE,
  CHECKLIST_TABLE,
  COMMENT_TABLE,
  GLOBAL_ASSIGNMENTS_FILE,
  GLOBAL_ROLES_FILE,
  GRANT_FILE,
  HOURS_TABLES,
  ORG_ASSIGNMENTS_FILE,
  ORG_KIND_ID,
  ORG_ROLES_FILE,
  PROJECT_FILE,
  REGION_DIMENSION_ID,
  SET_FILE,
  TASK_FILE,
  USERS_FILE,
  adoptedMembership,
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
} from "./fixtures/rights"
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
        "CREATE FUNCTION public.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$;",
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
      "CREATE POLICY item_public_read ON public.item AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true);",
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
    const all = [
      names.scopeRead,
      names.scopeInsert,
      names.scopeUpdate,
      names.scopeDelete,
      names.publicRead,
      ...labels.map((label) => names.rights(label)),
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
    expect([...policiesOf(domain, "task").keys()].sort()).toEqual([
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
      expect([...policiesOf(result.model!, table).keys()].sort()).toEqual([
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

  it("no rights read policies where there are no rights functions", async () => {
    // Р2a2-24: ролі й прийняте джерело членства без «Користувачів» — функцій
    // прав немає (Р2a1-30), тож немає й політик, що їх кличуть; межа тенанта
    // лишається (fail-closed).
    const result = await compile(
      withRoles(
        adoptedMembership(),
        {
          [PROJECT_FILE]: {
            membershipSources: [membersSource()],
            assignmentSources: [grantsSource(), globalGrantsSource()],
          },
          [GRANT_FILE]: grantTable(),
          [TASK_FILE]: { trackAuthor: false },
          [SET_FILE("TaskReaders")]: {
            grants: [grant(objects(["Document", "Task"]), ["read"], "any")],
          },
        },
        without(
          USERS_FILE,
          ORG_ROLES_FILE,
          ORG_ASSIGNMENTS_FILE,
          GLOBAL_ROLES_FILE,
          GLOBAL_ASSIGNMENTS_FILE
        )
      )
    )
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const model = result.model!
    expect(model.contracts.roles).not.toEqual([])
    const names = model.sqlUnits
      .filter((u) => u.generator === "access" && u.class === "policy")
      .map((u) => u.name)
    expect(names).toContain("task_scope_read")
    expect(names.filter((name) => name.includes("_read_"))).toEqual([])
  })

  it("policy identities of the policy domain are unique", () => {
    const identities = domain.sqlUnits
      .filter((u) => u.class === "policy")
      .map((u) => u.identity)
    expect(new Set(identities).size).toBe(identities.length)
  })
})
