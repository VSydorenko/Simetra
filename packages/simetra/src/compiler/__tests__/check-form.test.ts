import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { SqlFunctionDeclaration } from "simetra/model"
import { diagnostic, isRepairError } from "../diagnostics"
import { uuid } from "./helpers"
import {
  refAttribute,
  ROLE_FILE,
  USERS_FILE,
  STATUS_FILE,
  without,
  withRoles,
  type Layer,
} from "./fixtures/rights"

const SQL = "sql/public/fns.sql"
const FUNCTIONS = "sql/public/fns.functions.json"

const fn = (args: string, shell = "SECURITY DEFINER") =>
  `CREATE FUNCTION public.f(${args}) RETURNS int LANGUAGE sql STABLE ${shell} SET search_path = '' AS $$ SELECT 1 $$;\n`

type Check = NonNullable<SqlFunctionDeclaration["check"]>

const KIND_LABELS: Record<string, string> = {
  Task: "task",
  Users: "users",
  Announcement: "announcement",
  Box: "box",
}

/**
 * Definer-функція з доказовим запобіжником першим оператором. Суддя
 * `checkDeclaredGuards` судить кожну декларацію з `check` (спека §5.2, Р4),
 * зокрема лише з викликачем `service`, тож випадки, що перевіряють саме форму
 * `check`, несуть тіло, яке застосовує її: інакше їх рахувало б не те правило.
 * `action` — рядок дії контракту (UUID для кастомної).
 */
const proved = (check: Check, args: string, action = check.action) => {
  const target = check.scope ?? check.row
  const guard =
    check.scope === undefined ? "rights_require" : "rights_require_scope"
  return `CREATE FUNCTION public.f(${args}) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$BEGIN PERFORM simetra.${guard}('${action}', '${KIND_LABELS[check.object.name]}', ${target ?? "NULL"}); END$$;\n`
}

function files(
  check: Check,
  sql: string,
  ...layers: Layer[]
): Map<string, string> {
  const all = withRoles(...layers)
  // Перелік не має контракту прав: об'єкт існує, але прав на нього немає.
  all.set(
    STATUS_FILE,
    JSON.stringify({
      id: uuid(7902),
      kind: "Enumeration",
      name: "Status",
      physicalName: "status",
      values: [{ id: uuid(7903), name: "Draft", physicalName: "draft" }],
    })
  )
  all.set(SQL, sql)
  all.set(
    FUNCTIONS,
    JSON.stringify({
      functions: [
        {
          id: uuid(7900),
          function: { name: "f" },
          // Роль без сесії судить `check-missing`, а `user` без доказу — стадія 4:
          // суддя Р1 стоїть після неї, тож `service` доводить його ізольовано.
          callers: ["service"],
          check,
        },
      ],
    })
  )
  return all
}

async function judged(
  check: Check,
  sql: string,
  repair?: true,
  ...layers: Layer[]
) {
  const result = await compile(
    files(check, sql, ...layers),
    repair ? { repair } : {}
  )
  return {
    result,
    forms: result.diagnostics
      .filter((d) => d.code === "sql.declaration-check-form")
      .map((d) => [d.file, d.pointer, d.params]),
  }
}

const at = (reason: string) => [
  FUNCTIONS,
  "/functions/0",
  { schema: "public", name: "f", function: "public.f", reason },
]

const TASK: Check["object"] = { kind: "Document", name: "Task" }
const ANNOUNCEMENT: Check["object"] = { kind: "Document", name: "Announcement" }
const USERS: Check["object"] = { kind: "Catalog", name: "Users" }
const ORGANIZATION: Check["object"] = { kind: "Catalog", name: "Organization" }

// Інваріант І6: кожна причина `check-form` має червоний тест. Мутація — прибрати
// відповідну гілку `checkFormReason`; тест червоніє, бо діагностики немає.
describe("sql.declaration-check-form", () => {
  it.each<{ name: string; check: Check; sql: string; reason: string }>([
    {
      name: "invoker: a check on a SECURITY INVOKER function",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("p_row uuid", ""),
      reason: "invoker",
    },
    {
      name: "noRights: the object is absent",
      check: { action: "read", object: { kind: "Catalog", name: "Nope" } },
      sql: fn(""),
      reason: "noRights",
    },
    {
      name: "noRights: the object has no rights contract",
      check: {
        action: "read",
        object: { kind: "Enumeration", name: "Status" },
      },
      sql: fn(""),
      reason: "noRights",
    },
    {
      name: "unknownAction: no such action on the object",
      check: { action: "nope", object: TASK, row: "p_row" },
      sql: fn("p_row uuid"),
      reason: "unknownAction",
    },
    {
      name: "twoTargets: row and scope together",
      check: { action: "read", object: TASK, row: "p_row", scope: "p_scope" },
      sql: fn("p_row uuid, p_scope uuid"),
      reason: "twoTargets",
    },
    {
      name: "targetParameter: no such parameter",
      check: { action: "read", object: TASK, row: "p_other" },
      sql: fn("p_row uuid"),
      reason: "targetParameter",
    },
    {
      name: "targetParameter: not uuid",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("p_row text"),
      reason: "targetParameter",
    },
    {
      name: "targetParameter: a uuid array",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("p_row uuid[]"),
      reason: "targetParameter",
    },
    {
      name: "targetParameter: an OUT parameter",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("OUT p_row uuid"),
      reason: "targetParameter",
    },
    {
      name: "targetParameter: an INOUT parameter",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("INOUT p_row uuid"),
      reason: "targetParameter",
    },
    {
      name: "targetParameter: a schema-qualified type that is not pg_catalog",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("p_row public.uuid"),
      reason: "targetParameter",
    },
    {
      name: "targetParameter: a SETOF uuid parameter",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("p_row SETOF uuid"),
      reason: "targetParameter",
    },
    {
      // Читання Users обмежує межа видимості (ключ рядка — id користувача).
      name: "targetRequired: read of Users without a target",
      check: { action: "read", object: USERS },
      sql: fn(""),
      reason: "targetRequired",
    },
    {
      name: "scopeUnscoped: scope on an unscoped object",
      check: { action: "read", object: ANNOUNCEMENT, scope: "p_scope" },
      sql: fn("p_scope uuid"),
      reason: "scopeUnscoped",
    },
    {
      name: "createOnRow: create with row",
      check: { action: "create", object: TASK, row: "p_row" },
      sql: fn("p_row uuid"),
      reason: "createOnRow",
    },
    {
      name: "createOnRoot: create of a scope kind root with scope",
      check: { action: "create", object: ORGANIZATION, scope: "p_scope" },
      sql: fn("p_scope uuid"),
      reason: "createOnRoot",
    },
    {
      name: "createOnRoot: create of a scope kind root without a target",
      check: { action: "create", object: ORGANIZATION },
      sql: fn(""),
      reason: "createOnRoot",
    },
    {
      name: "targetRequired: a scoped object without a target",
      check: { action: "read", object: TASK },
      sql: fn(""),
      reason: "targetRequired",
    },
    {
      name: "targetRequired: create of a scoped object without a target",
      check: { action: "create", object: TASK },
      sql: fn(""),
      reason: "targetRequired",
    },
    {
      name: "targetForbidden: a row on an object without carriers",
      check: { action: "read", object: ANNOUNCEMENT, row: "p_row" },
      sql: fn("p_row uuid"),
      reason: "targetForbidden",
    },
  ])("$name", async ({ check, sql, reason }) => {
    const { result, forms } = await judged(check, sql)
    expect(forms).toEqual([at(reason)])
    expect(result.ok).toBe(false)
    expect(result.model).toBeUndefined()
  })

  it.each<{ name: string; check: Check; args: string }>([
    {
      name: "read of a scoped row",
      check: { action: "read", object: TASK, row: "p_row" },
      args: "p_row uuid",
    },
    {
      name: "an unnamed IN mode and a pg_catalog.uuid type",
      check: { action: "read", object: TASK, row: "p_row" },
      args: "IN p_row pg_catalog.uuid",
    },
    {
      name: "read of a Users row (the visible-users boundary reads the key)",
      check: { action: "read", object: USERS, row: "p_row" },
      args: "p_row uuid",
    },
    {
      name: "create in a scope of a scoped object",
      check: { action: "create", object: TASK, scope: "p_scope" },
      args: "p_scope uuid",
    },
    {
      name: "a read of a scope",
      check: { action: "read", object: TASK, scope: "p_scope" },
      args: "p_scope uuid",
    },
    {
      name: "an object without carriers, no target",
      check: { action: "read", object: ANNOUNCEMENT },
      args: "",
    },
    {
      name: "create without a target on an object without carriers",
      check: { action: "create", object: ANNOUNCEMENT },
      args: "",
    },
  ])("accepts $name", async ({ check, args }) => {
    const { result, forms } = await judged(check, proved(check, args))
    expect(forms).toEqual([])
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  })

  // Регістр не має ключа з однієї колонки `uuid`: ціль `row` його не адресує,
  // лишається `scope`. Мутація: прибрати гілку `rowKey` судді — діагностики
  // немає, а генератор запобіжника падає внутрішньою помилкою.
  describe("rowKey: a row target on a register", () => {
    const ref = (kind: string, name: string) => ({ kind, name })
    const registers: Layer = {
      "information-registers/Recorded/Recorded.meta.json": {
        id: uuid(7920),
        kind: "InformationRegister",
        name: "Recorded",
        physicalName: "recorded",
        kindLabel: "recorded",
        scope: "org",
        writeMode: "RecorderSubordinate",
        recorderTypes: [ref("Document", "Task")],
        dimensions: [
          refAttribute(7921, "region", "region_id", ref("Catalog", "Region")),
        ],
      },
      "accumulation-registers/Hours/Hours.meta.json": {
        id: uuid(7930),
        kind: "AccumulationRegister",
        name: "Hours",
        physicalName: "hours_reg",
        kindLabel: "hours_reg",
        scope: "org",
        registerType: "Balance",
        dimensions: [
          refAttribute(7931, "region", "region_id", ref("Catalog", "Region")),
        ],
        resources: [
          {
            id: uuid(7932),
            name: "hours",
            physicalName: "hours",
            type: "Numeric",
            precision: 10,
            scale: 2,
          },
        ],
      },
    }
    it.each([
      [
        "an independent information register",
        "MemberRegion",
        "InformationRegister",
      ],
      [
        "a recorder-subordinate information register",
        "Recorded",
        "InformationRegister",
      ],
      ["an accumulation register", "Hours", "AccumulationRegister"],
    ])("%s: row is refused, scope is accepted", async (_name, name, kind) => {
      const object = { kind, name } as Check["object"]
      const row = await judged(
        { action: "read", object, row: "p_row" },
        fn("p_row uuid"),
        undefined,
        registers
      )
      expect(row.forms).toEqual([at("rowKey")])
      const scope = await judged(
        { action: "read", object, scope: "p_scope" },
        fn("p_scope uuid"),
        undefined,
        registers
      )
      expect(scope.forms).toEqual([])
    })
  })

  // Р2: `check-form` не клас ремонту — режим `repair` модель не повертає.
  it("is not in the repair class: repair mode returns no model", async () => {
    const { result, forms } = await judged(
      { action: "nope", object: TASK, row: "p_row" },
      fn("p_row uuid"),
      true
    )
    expect(forms).toEqual([at("unknownAction")])
    expect(result.model).toBeUndefined()
  })

  // Дія над наявним рядком Users — будь-яка, крім `create` — бере межу
  // видимості «Користувачів»: ціль-рядок обов'язкова (ADR архітекторки, межа
  // `SELECT` діє на наявні рядки `UPDATE` і `DELETE`).
  describe("Users actions over an existing row", () => {
    const custom: Layer = {
      [USERS_FILE]: { customActions: [{ id: uuid(7904), name: "ban" }] },
    }
    it.each(["read", "update", "delete", "ban"])(
      "%s requires a row target and accepts one",
      async (action) => {
        const none = await judged(
          { action, object: USERS },
          fn(""),
          undefined,
          custom
        )
        expect(none.forms).toEqual([at("targetRequired")])
        const rowCheck = { action, object: USERS, row: "p_row" } as const
        const row = await judged(
          rowCheck,
          proved(
            rowCheck,
            "p_row uuid",
            action === "ban" ? uuid(7904) : action
          ),
          undefined,
          custom
        )
        expect(row.forms).toEqual([])
        expect(
          row.result.diagnostics.filter((d) => d.severity === "error")
        ).toEqual([])
      }
    )
  })

  // Контейнер власного рядка не читає: `rightsPredicates` бере лише прив'язку.
  describe("an unscoped container without other carriers", () => {
    const box: Layer = {
      "catalogs/Box/Box.meta.json": {
        id: uuid(7910),
        kind: "Catalog",
        name: "Box",
        physicalName: "box",
        kindLabel: "box",
        scope: "none",
        rightsContainer: true,
      },
    }
    const BOX: Check["object"] = { kind: "Catalog", name: "Box" }
    it.each(["create", "read"])(
      "%s without a target is accepted",
      async (action) => {
        const check = { action, object: BOX }
        const { forms, result } = await judged(
          check,
          proved(check, ""),
          undefined,
          box
        )
        expect(forms).toEqual([])
        expect(
          result.diagnostics.filter((d) => d.severity === "error")
        ).toEqual([])
      }
    )
    it("read with a row is targetForbidden", async () => {
      const { forms } = await judged(
        { action: "read", object: BOX, row: "p_row" },
        fn("p_row uuid"),
        undefined,
        box
      )
      expect(forms).toEqual([at("targetForbidden")])
    })
  })

  // Без жодної ролі функцій прав немає, а з ними й межі видимості
  // «Користувачів» (`hasVisibleUsers`): читання Users рядка не читає.
  it("Users read has no row target without any role", async () => {
    const noRoles: Layer = without(
      ...["OrgAdmin", "OrgMember", "ProjectLead", "Support", "Everyone"].map(
        ROLE_FILE
      )
    )
    const row = { action: "read", object: USERS, row: "p_row" } as const
    const withRow = await judged(row, fn("p_row uuid"), undefined, noRoles)
    expect(withRow.forms).toEqual([at("targetForbidden")])
    const noneCheck = { action: "read", object: USERS } as const
    const none = await judged(
      noneCheck,
      proved(noneCheck, ""),
      undefined,
      noRoles
    )
    expect(none.forms).toEqual([])
    expect(
      none.result.diagnostics.filter((d) => d.severity === "error")
    ).toEqual([])
  })

  // Ранній вихід суддi не губить попереджень, зібраних до нього.
  it("keeps the earlier warnings next to the check-form error", async () => {
    const unread: Layer = {
      ...without(ROLE_FILE("OrgAdmin")),
      [ROLE_FILE("OrgMember")]: { include: [], grants: [] },
    }
    const { result, forms } = await judged(
      { action: "read", object: TASK },
      fn(""),
      undefined,
      unread
    )
    expect(forms).toEqual([at("targetRequired")])
    expect(result.diagnostics.map((d) => d.code)).toContain(
      "rights.scope-kind-unread"
    )
  })

  it("is an error that the repair class does not pass", () => {
    expect(
      isRepairError(
        diagnostic("sql.declaration-check-form", FUNCTIONS, "/functions/0")
      )
    ).toBe(false)
  })

  it("a custom action resolves by its name", async () => {
    const approve = { action: "approve", object: ANNOUNCEMENT }
    const all = files(approve, proved(approve, "", uuid(7901)))
    const path = "documents/Announcement/Announcement.meta.json"
    const object = JSON.parse(all.get(path)!)
    all.set(
      path,
      JSON.stringify({
        ...object,
        customActions: [{ id: uuid(7901), name: "approve" }],
      })
    )
    const result = await compile(all)
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  })
})
