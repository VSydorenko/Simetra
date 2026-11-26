import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  RIGHTS_REQUIRE_ERROR,
  type SqlFunctionDeclaration,
} from "simetra/model"
import type { AccessContract } from "../contracts"
import { buildRequireUnits } from "../rights/require-units"
import type { DeclaredFunction } from "../sql/declarations"
import { loadSqlParser } from "../sql/parse"
import { loadPlpgsqlParser } from "../sql/plpgsql"
import { hasFixedBody } from "../sql/units"
import { uuid } from "./helpers"
import {
  ORG_KIND_ID,
  REGION_DIMENSION_ID,
  ROLE_FILE,
  TASK_FILE,
  commandCoreLayer,
  policyDomain,
  writeRoles,
  USERS_FILE,
  without,
  withRoles,
  type Layer,
} from "./fixtures/rights"

/**
 * Генератор функцій запобіжника `simetra.rights_require` і
 * `simetra.rights_require_scope` (спека декларацій функцій §5.2): текст і
 * гранти, які дає компілятор. Як функції поводяться на базі — DB-тест.
 */

type Check = NonNullable<SqlFunctionDeclaration["check"]>

const SQL = "sql/public/fns.sql"
const FUNCTIONS = "sql/public/fns.functions.json"

interface Spec {
  check: Check
  /** Викликачі декларації; за замовчуванням `service`. */
  callers?: SqlFunctionDeclaration["callers"]
}

/**
 * Definer-функція. Запобіжник виклику судить кожну декларацію з `check`
 * (спека §5.2, Р4), зокрема лише з викликачем `service`, тож тіло завжди з
 * доказовим запобіжником першим оператором.
 */
function definer({ check }: Spec, index: number, withCheck: boolean): string {
  const target = check.scope ?? check.row
  const args = target === undefined ? "" : `${target} uuid`
  // Без `check` декларація запобіжника не оголошує, а виклик його без
  // декларації платформа не пускає, тож тіло службове.
  if (!withCheck) {
    return `CREATE FUNCTION public.f${index}(${args}) RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;\n`
  }
  const guard =
    check.scope === undefined ? "rights_require" : "rights_require_scope"
  return `CREATE FUNCTION public.f${index}(${args}) RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$BEGIN PERFORM simetra.${guard}('${ACTION_IDS[check.action] ?? check.action}', '${LABELS[check.object.name]}', ${target ?? "NULL"}); END$$;\n`
}

const LABELS: Record<string, string> = {
  Task: "task",
  Announcement: "announcement",
  Ticket: "ticket",
  Users: "users",
}
// Кастомна дія в запобіжнику — UUID, у декларації — ім'я.
const ACTION_IDS: Record<string, string> = { ban: uuid(7904) }

function declare(all: Map<string, string>, specs: Spec[], withCheck: boolean) {
  all.set(SQL, specs.map((spec, i) => definer(spec, i, withCheck)).join(""))
  all.set(
    FUNCTIONS,
    JSON.stringify({
      functions: specs.map(({ check, callers }, index) => ({
        id: uuid(7800 + index),
        function: { name: `f${index}` },
        callers: callers ?? ["service"],
        ...(withCheck ? { check } : {}),
      })),
    })
  )
  return all
}

async function unitsOver(all: Map<string, string>, specs: Spec[]) {
  const result = await compile(declare(all, specs, true))
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!.sqlUnits.filter((u) => u.generator === "rightsRequire")
}

const units = (specs: Spec[], ...layers: Layer[]) =>
  unitsOver(withRoles(...layers), specs)

/**
 * Одиниці запобіжника над контрактами доступу, зміненими `patch`: `published`
 * будівник контрактів ще не заповнює (Р-D1-2), тож контракт — вручну, а
 * генератор той самий. Декларації — зі стану `explain` компіляції.
 */
async function unitsPatched(
  specs: Spec[],
  patch: (access: AccessContract) => AccessContract,
  ...layers: Layer[]
) {
  const result = await compile(declare(withRoles(...layers), specs, true))
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  const model = result.model!
  const declared = result.declaredFunctions!.flatMap(
    (state): DeclaredFunction[] => {
      if (state.check === undefined) return []
      const unit = model.sqlUnits.find(
        (u) =>
          u.class === "function" &&
          u.schema === state.schema &&
          u.name === state.name
      )!
      return [
        {
          declaration: {
            function: { schema: state.schema, name: state.name },
            callers: [...state.callers],
            check: state.check,
          },
          file: FUNCTIONS,
          pointer: "",
          unit: { ...unit, file: unit.file!, line: unit.line! },
          key: { schema: state.schema, name: state.name },
        },
      ]
    }
  )
  const rebuild = async (access: (a: AccessContract) => AccessContract) =>
    buildRequireUnits({
      declared,
      objects: model.objects,
      contracts: {
        ...model.contracts,
        access: model.contracts.access.map(access),
      },
      physical: model.physical,
      provider: model.project.database.provider,
      module: model.project.name,
      units: model.sqlUnits.filter((u) => u.generator !== "rightsRequire"),
      parse: await loadSqlParser(),
      plpgsql: await loadPlpgsqlParser(),
    })
  // Перебудова без зміни дає рівно одиниці компіляції: оснастка вірна.
  expect((await rebuild((a) => a)).map((u) => u.sql)).toEqual(
    model.sqlUnits
      .filter((u) => u.generator === "rightsRequire")
      .map((u) => u.sql)
  )
  return rebuild(patch)
}

/** Основна таблиця `Task` з умовою публікації (`AccessContract.published`). */
const publishedTask = (a: AccessContract): AccessContract =>
  a.table.name === "task"
    ? { ...a, published: { column: "published", mark: "deletion_mark" } }
    : a

const functionOf = (all: { class: string; sql: string }[], name: string) =>
  all.find((u) => u.class === "function" && u.sql.includes(`simetra.${name}(`))
    ?.sql

/** Гілки функції: пара `мітка/дія` → умова. */
function branches(sql: string | undefined): Map<string, string> {
  return new Map(
    [
      ...(sql ?? "").matchAll(
        /IF p_object = '([^']*)' AND p_action = '([^']*)' AND \((.*)\) THEN/g
      ),
    ].map(([, label, action, condition]) => [`${label}/${action}`, condition!])
  )
}

const TASK = { kind: "Document", name: "Task" } as const
const ANNOUNCEMENT = { kind: "Document", name: "Announcement" } as const
const TICKET = { kind: "Catalog", name: "Ticket" } as const
const USERS = { kind: "Catalog", name: "Users" } as const
const task = (action: string, target: "row" | "scope" = "row"): Spec => ({
  check: {
    action,
    object: TASK,
    ...(target === "row" ? { row: "p_row" } : { scope: "p_scope" }),
  },
})

const TENANT_ROW =
  "r.org_id = ANY (ARRAY(SELECT public.org_member_member_scopes()))"
const TENANT_SCOPE =
  "p_scope = ANY (ARRAY(SELECT public.org_member_member_scopes()))"
const USERS_ROW = "r.id = ANY (ARRAY(SELECT simetra.rights_visible_users()))"
const BAN_ID = uuid(7904)
const BAN: Layer = {
  [USERS_FILE]: { customActions: [{ id: BAN_ID, name: "ban" }] },
}

describe("rights_require / rights_require_scope generator", () => {
  // І9: без `check` у жодній декларації функцій запобіжника немає.
  it("generates nothing when no declaration has a check", async () => {
    const result = await compile(declare(withRoles(), [task("read")], false))
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(
      result.model!.sqlUnits.filter((u) => u.generator === "rightsRequire")
    ).toEqual([])
  })

  // Мутація: гілка для кожної пари об'єкта (а не декларації) — `delete`
  // з'явилась би.
  it("has a branch for each declared pair only and no scope function without a scope target", async () => {
    const all = await units([task("read"), task("update")])
    expect(
      [...branches(functionOf(all, "rights_require")).keys()].sort()
    ).toEqual(["task/read", "task/update"])
    expect(functionOf(all, "rights_require_scope")).toBeUndefined()
  })

  it("has one branch per pair, however many declarations name it", async () => {
    const all = await units([task("read"), task("read")])
    // Рахуємо за текстом: `Map` гілок злив би дубль сам.
    expect(
      functionOf(all, "rights_require")!.split("IF p_object = 'task'").length -
        1
    ).toBe(1)
  })

  it("puts a scope target into rights_require_scope and leaves rights_require out", async () => {
    const all = await units([task("create", "scope")])
    expect(functionOf(all, "rights_require")).toBeUndefined()
    expect([
      ...branches(functionOf(all, "rights_require_scope")).keys(),
    ]).toEqual(["task/create"])
  })

  // І4 (бік SQL): лише `REVOKE`, жодного `GRANT`.
  it("revokes EXECUTE from PUBLIC and every API role and grants nothing", async () => {
    const all = await units([task("read"), task("create", "scope")])
    const grants = all.filter((u) => u.class === "grant").map((u) => u.sql)
    expect(grants.some((sql) => sql.startsWith("GRANT"))).toBe(false)
    for (const name of ["rights_require", "rights_require_scope"]) {
      expect(
        grants.filter((sql) => sql.includes(`simetra.${name}(`)).sort()
      ).toEqual(
        ["PUBLIC", "anon", "authenticated", "service_role"]
          .map(
            (role) =>
              `REVOKE EXECUTE ON FUNCTION simetra.${name}(text, text, uuid) FROM ${role};`
          )
          .sort()
      )
    }
  })

  // `FIXED_BODY = false` зробив би функцію дослівною одиницею застосунку.
  it("is a fixed-body platform function, SECURITY INVOKER with an empty search_path", async () => {
    const all = await units([task("read")])
    for (const unit of all) expect(hasFixedBody(unit)).toBe(true)
    const sql = functionOf(all, "rights_require")!
    expect(sql.split("\nAS ")[0]).toBe(
      "CREATE OR REPLACE FUNCTION simetra.rights_require(p_action text, p_object text, p_row uuid)\nRETURNS void\nLANGUAGE plpgsql SECURITY INVOKER\nSET search_path = ''"
    )
  })

  // Невідома пара, відсутнє право, рядок і `NULL` — та сама відмова: вона
  // стоїть після гілок, а не в кожній.
  it("refuses with the one error after the branches", async () => {
    expect(RIGHTS_REQUIRE_ERROR).toEqual({
      errcode: "42501",
      message: "rights.forbidden",
      noRight: "no-right",
    })
    const sql = functionOf(await units([task("read")]), "rights_require")!
    expect(sql).toMatch(
      /END IF;\n {2}RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'rights.forbidden', DETAIL = 'no-right';\nEND\n/
    )
  })

  it("requires the rights function, the tenant set function and the table of the row", async () => {
    const fn = (await units([task("read")])).find(
      (u) => u.class === "function"
    )!
    const identities = (fn.requires ?? []).map((node) =>
      node.type === "unit" ? node.identity : `${node.schema}.${node.name}`
    )
    expect(identities).toEqual(
      expect.arrayContaining([
        expect.stringContaining("simetra.rights_any("),
        expect.stringContaining("public.org_member_member_scopes("),
        "public.task",
      ])
    )
  })

  // Без ролей функцій прав немає: гілка кликала б неіснуючу `rights_any`
  // (`42883` замість `42501`). Мутація: будувати гілки й без функцій прав.
  it("has no branches and no rights function edge in a project without roles", async () => {
    const noRoles = without(
      ...["OrgAdmin", "OrgMember", "ProjectLead", "Support", "Everyone"].map(
        ROLE_FILE
      )
    )
    const all = await units([task("read"), task("create", "scope")], noRoles)
    for (const name of ["rights_require", "rights_require_scope"]) {
      const sql = functionOf(all, name)!
      expect(sql).not.toContain("rights_any")
      expect(sql).not.toContain("IF p_object")
      expect(sql).toMatch(
        /BEGIN\n {2}RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'rights.forbidden', DETAIL = 'no-right';\nEND\n/
      )
    }
    const required = all.flatMap((u) =>
      u.class === "function" ? (u.requires ?? []) : []
    )
    expect(
      required.filter(
        (n) => n.type === "unit" && n.identity.includes("simetra.rights_")
      )
    ).toEqual([])
  })

  describe("the condition of a branch", () => {
    // Мутація: прибрати межу тенанта з `rowBranch` — `TENANT_ROW` зникає.
    it("row target: the key, the tenant boundary and the OR of the action predicates", async () => {
      const all = await units([task("read")])
      expect(branches(functionOf(all, "rights_require")).get("task/read")).toBe(
        `EXISTS (SELECT 1 FROM public.task r WHERE r.id = p_row AND ${TENANT_ROW} AND ((r.org_id = ANY (ARRAY(SELECT simetra.rights_any('read', 'task'))))))`
      )
    })

    // Мутація: брати в гілці `scope` усі гранти `rowFreeGrants` (з `own`).
    it("scope target: the tenant set and the any-extent set of the action", async () => {
      const all = await units([task("create", "scope")])
      expect(
        branches(functionOf(all, "rights_require_scope")).get("task/create")
      ).toBe(
        `${TENANT_SCOPE} AND p_scope = ANY (ARRAY(SELECT simetra.rights_any('create', 'task')))`
      )
    })

    // Мутація: взяти в OR лише перший предикат (`.slice(0, 1)` у
    // `rightsCheck`) — зникають предикати власності, виміру й контейнера.
    it("row target: the OR of every predicate of the action (any, own, dimension, container)", async () => {
      const all = await unitsOver(
        policyDomain(writeRoles(), commandCoreLayer()),
        [{ check: { action: "update", object: TICKET, row: "p_row" } }]
      )
      const sql = functionOf(all, "rights_require")!
      expect(branches(sql).get("ticket/update")).toBe(
        "EXISTS (SELECT 1 FROM public.ticket r WHERE r.id = p_row AND r.org_id = ANY (ARRAY(SELECT public.org_member_member_scopes())) AND (" +
          [
            "(r.org_id = ANY (ARRAY(SELECT simetra.rights_any('update', 'ticket'))))",
            `(r.assignee_id = ANY (ARRAY(SELECT simetra.rights_my_members('${ORG_KIND_ID}'::uuid))) AND r.org_id = ANY (ARRAY(SELECT simetra.rights_own('update', 'ticket'))))`,
            `(r.region_id = ANY (ARRAY(SELECT simetra.rights_dimension_values('${REGION_DIMENSION_ID}'::uuid))) AND r.org_id = ANY (ARRAY(SELECT simetra.rights_dim('update', 'ticket', '${REGION_DIMENSION_ID}'::uuid))))`,
            "(r.project_id = ANY (ARRAY(SELECT simetra.rights_container('update', 'ticket', 'any', NULL))))",
            `(r.assignee_id = ANY (ARRAY(SELECT simetra.rights_my_members('${ORG_KIND_ID}'::uuid))) AND r.project_id = ANY (ARRAY(SELECT simetra.rights_container('update', 'ticket', 'own', NULL))))`,
            `(r.region_id = ANY (ARRAY(SELECT simetra.rights_dimension_values('${REGION_DIMENSION_ID}'::uuid))) AND r.project_id = ANY (ARRAY(SELECT simetra.rights_container('update', 'ticket', 'dimension', '${REGION_DIMENSION_ID}'::uuid))))`,
          ].join(" OR ") +
          "))"
      )
    })

    it("no target: the boolean right of an object without carriers", async () => {
      const all = await units([
        { check: { action: "read", object: ANNOUNCEMENT } },
      ])
      expect(
        branches(functionOf(all, "rights_require")).get("announcement/read")
      ).toBe(
        "((SELECT simetra.has_right('read', 'announcement', 'any', NULL)))"
      )
    })

    // Мутація: не брати `readBoundaries` для `update` — межа «Користувачів»
    // зникає з гілки (рішення архітекторки: політики `SELECT` діють на
    // наявний рядок `UPDATE` і `DELETE`).
    it.each(["read", "update", "delete", BAN_ID])(
      "Users %s: the visible-users boundary is part of the branch",
      async (action) => {
        const all = await units(
          [
            {
              check: {
                action: action === BAN_ID ? "ban" : action,
                object: USERS,
                row: "p_row",
              },
            },
          ],
          BAN
        )
        const condition = branches(functionOf(all, "rights_require")).get(
          `users/${action}`
        )
        expect(condition).toContain(`AND ${USERS_ROW} AND `)
      }
    )

    it("a row of an object that is not Users has no users boundary", async () => {
      const all = await units([task("update")])
      expect(
        branches(functionOf(all, "rights_require")).get("task/update")
      ).not.toContain("rights_visible_users")
    })

    // Пара лише з викликачами user/command: обидві ролі входять до ролей
    // політики `publicRead`, тож гілка — RLS (умова політики), без предикатів.
    // Мутація: брати цю гілку й для пари з `service`.
    it("publicRead read of a user-only pair is the RLS condition, with a service caller it is the predicates", async () => {
      const publicRead = { [TASK_FILE]: { publicRead: "authenticated" } }
      const userOnly = await units(
        [
          { ...task("read"), callers: ["user", "command"] },
          { ...task("update"), callers: ["user"] },
        ],
        publicRead
      )
      // Лише читання: `update` лишається за предикатами (мутація: усі дії).
      expect(
        branches(functionOf(userOnly, "rights_require")).get("task/update")
      ).toContain("rights_any('update', 'task')")
      expect(
        branches(functionOf(userOnly, "rights_require")).get("task/read")
      ).toBe(
        "EXISTS (SELECT 1 FROM public.task r WHERE r.id = p_row AND ((SELECT simetra.current_user_id()) IS NOT NULL))"
      )
      // Один `service` у парі: предикати для всієї пари, і user-декларації.
      const mixed = await units(
        [
          { ...task("read"), callers: ["user"] },
          { ...task("read"), callers: ["service"] },
        ],
        publicRead
      )
      expect(
        branches(functionOf(mixed, "rights_require")).get("task/read")
      ).toBe(
        "EXISTS (SELECT 1 FROM public.task r WHERE r.id = p_row AND ((r.org_id = ANY (ARRAY(SELECT simetra.rights_any('read', 'task'))))))"
      )
    })

    // Р-D1-5: умовний `publicRead` — RLS пари user/command: опублікований
    // рядок (умова `<t>_public_read`) OR межа тенанта з правом `read`; пара з
    // `service` — лише права з межею, як об'єкт без `publicRead`.
    it("conditional publicRead read of a user-only pair is the published row or the tenant boundary with the rights", async () => {
      const plain = await units([task("read")])
      const rightsBranch = branches(functionOf(plain, "rights_require")).get(
        "task/read"
      )!
      const head = `EXISTS (SELECT 1 FROM public.task r WHERE r.id = p_row AND ${TENANT_ROW} AND (`
      expect(rightsBranch.startsWith(head)).toBe(true)
      const rights = rightsBranch.slice(head.length, -"))".length)
      const publicRead = { [TASK_FILE]: { publicRead: "authenticated" } }
      const userOnly = await unitsPatched(
        [
          { ...task("read"), callers: ["user", "command"] },
          { ...task("update"), callers: ["user"] },
        ],
        publishedTask,
        publicRead
      )
      expect(
        branches(functionOf(userOnly, "rights_require")).get("task/read")
      ).toBe(
        `EXISTS (SELECT 1 FROM public.task r WHERE r.id = p_row AND ((r.published AND NOT r.deletion_mark AND (SELECT simetra.current_user_id()) IS NOT NULL) OR (${TENANT_ROW} AND (${rights}))))`
      )
      // Дія, крім читання, — за предикатами з межею, як досі.
      expect(
        branches(functionOf(userOnly, "rights_require")).get("task/update")
      ).toContain(`AND ${TENANT_ROW} AND (`)
      const service = await unitsPatched(
        [task("read")],
        publishedTask,
        publicRead
      )
      expect(
        branches(functionOf(service, "rights_require")).get("task/read")
      ).toBe(rightsBranch)
    })

    // Межі тенанта читання `publicRead` не має (політики `scope_read` нема), а
    // `scope_update` діє завжди: гілка розрізняє.
    it("publicRead drops the tenant boundary of read but not of update", async () => {
      const all = await units([task("read"), task("update")], {
        [TASK_FILE]: { publicRead: "authenticated" },
      })
      const row = branches(functionOf(all, "rights_require"))
      expect(row.get("task/read")).not.toContain(TENANT_ROW)
      expect(row.get("task/update")).toContain(TENANT_ROW)
    })
  })
})
