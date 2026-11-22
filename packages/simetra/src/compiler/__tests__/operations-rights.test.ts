import { describe, expect, it } from "vitest"
import {
  addElement,
  applyChanges,
  compile,
  createObject,
  deleteElement,
  explainObject,
  renameElement,
  type CompiledModel,
  type ElementTarget,
  type SchemaPathResolver,
} from "simetra/compiler"
import {
  COMMENT_FILE,
  MEMBER_FILE,
  ORG_KIND_ID,
  ORG_SCOPE_KIND,
  PROJECT_CATALOG_FILE,
  TASK_FILE,
  TASK_ID,
  rightsFiles,
} from "./fixtures/rights"
import type { Diagnostic } from "../diagnostics"
import { toPlatformForms } from "../operations/platform-forms"
import { uuid } from "./helpers"

type Json = Record<string, unknown>
type Files = ReadonlyMap<string, string>

const PROJECT = "project.meta.json"
const MEMBERSHIP_FILE = "custom-tables/Membership/Membership.meta.json"
const REGION_DIM_ID = uuid(6060)
const REASSIGN_ID = uuid(7701)
const ESCALATE_ID = uuid(7702)

const ref = (kind: string, name: string) => ({ kind, name })

/** Детерміноване джерело id у формі UUID v4. */
function counter(start = 900_000): () => string {
  let n = start
  return () => uuid(++n)
}

const schemaPath: SchemaPathResolver = (file, schemaFile) =>
  `schemas-of/${file}/${schemaFile}`

const options = () => ({ schemaPath, newId: counter() })

const errors = (result: { diagnostics: { severity: string }[] }) =>
  result.diagnostics.filter((d) => d.severity === "error")

const json = (files: Files, path: string) =>
  JSON.parse(files.get(path)!) as Json

async function modelOf(files: Files): Promise<CompiledModel> {
  const compiled = await compile(files)
  expect(errors(compiled)).toEqual([])
  return compiled.model!
}

/**
 * Проєкт з усіма полями прав, що мають посилання: контейнер, прив'язка
 * (реквізитом і шляхом), власники, вимір доступу з мапінгом і кастомні дії,
 * одна з яких вимагає іншу.
 */
function allRights(): Map<string, string> {
  return rightsFiles({
    [PROJECT]: {
      accessDimensions: [
        {
          id: REGION_DIM_ID,
          name: "region",
          target: ref("Catalog", "Region"),
          values: {
            relation: {
              object: ref("InformationRegister", "MemberRegion"),
              subject: "member",
              value: "region",
            },
          },
        },
      ],
    },
    [PROJECT_CATALOG_FILE]: { rightsContainer: true },
    [TASK_FILE]: {
      ownership: ["assignee"],
      containerBinding: "project",
      access: [{ attribute: "region", dimension: "region" }],
      customActions: [
        {
          id: REASSIGN_ID,
          name: "reassign",
          requires: ["update"],
          effects: { header: ["assignee"] },
        },
        { id: ESCALATE_ID, name: "escalate", requires: ["reassign"] },
      ],
    },
    [COMMENT_FILE]: {
      ownership: [["task", "assignee"]],
      containerBinding: ["task", "project"],
    },
  })
}

/**
 * Вид `org` з прийнятою таблицею членства замість довідника: джерело
 * членства посилається на колонки таблиці за логічними іменами.
 */
function adoptedMembership(): Map<string, string> {
  const column = (
    id: number,
    name: string,
    physicalName: string,
    type: string
  ) => ({
    id: uuid(id),
    name,
    physicalName,
    type,
    notNull: true,
  })
  const files = rightsFiles({
    [PROJECT]: {
      scopeKinds: [
        {
          id: ORG_KIND_ID,
          name: "org",
          physicalName: "org_id",
          root: { object: ref("Catalog", "Organization") },
          setFunction: { schema: "public", name: "org_ids" },
        },
      ],
      membershipSources: [
        {
          id: uuid(6120),
          name: "members",
          scopeKind: "org",
          table: ref("CustomTable", "Membership"),
          columns: { scope: "orgId", user: "userId", active: "isActive" },
        },
      ],
    },
    [TASK_FILE]: {
      attributes: [
        {
          id: uuid(6011),
          name: "assignee",
          physicalName: "assignee_id",
          type: "Ref",
          ref: ref("CustomTable", "Membership"),
        },
      ],
    },
    [MEMBERSHIP_FILE]: {
      id: uuid(6100),
      kind: "CustomTable",
      name: "Membership",
      physicalName: "membership",
      kindLabel: "membership",
      scope: "org",
      columns: [
        column(6101, "id", "id", "UUID"),
        column(6102, "orgId", "org_id", "UUID"),
        column(6103, "userId", "user_id", "UUID"),
        column(6104, "isActive", "is_active", "Boolean"),
      ],
      primaryKey: { columns: ["id"] },
      uniques: [{ columns: ["orgId", "id"] }],
      scopeColumn: "orgId",
      // Носій скоупу — FK на ключ кореня виду (Р8).
      foreignKeys: [
        {
          name: "membership_org_fk",
          columns: ["orgId"],
          references: {
            object: { kind: "Catalog", name: "Organization" },
            key: "ref",
          },
        },
      ],
    },
  })
  files.delete(MEMBER_FILE)
  files.delete("information-registers/MemberRegion/MemberRegion.meta.json")
  return files
}

/** Перейменування, яке мусить вдатися; повертає файли після нього. */
async function renamed(files: Files, target: ElementTarget, newName: string) {
  const result = await renameElement(files, { target, newName })
  expect(errors(result)).toEqual([])
  expect(result.ok).toBe(true)
  return applyChanges(files, result.changes)
}

const TASK: ElementTarget = { kind: "Document", name: "Task" }
const element = (...chain: string[]): ElementTarget => ({
  ...TASK,
  element: chain,
})

describe("designer operations over rights fields", () => {
  it("adds a custom action and an access dimension with ids", async () => {
    const files = allRights()
    const o = options()
    const action = await addElement(
      files,
      {
        target: TASK,
        collection: "customActions",
        element: { name: "archive", requires: ["escalate"] },
      },
      o
    )
    expect(errors(action)).toEqual([])
    expect(action.ok).toBe(true)
    const withAction = applyChanges(files, action.changes)
    const added = (json(withAction, TASK_FILE).customActions as Json[]).find(
      (a) => a.name === "archive"
    )!
    expect(typeof added.id).toBe("string")

    const dimension = await addElement(
      withAction,
      {
        target: { kind: "Project" },
        collection: "accessDimensions",
        element: {
          name: "zone",
          target: ref("Catalog", "Region"),
          values: {
            relation: {
              object: ref("InformationRegister", "MemberRegion"),
              subject: "member",
              value: "region",
            },
          },
        },
      },
      o
    )
    expect(errors(dimension)).toEqual([])
    expect(dimension.ok).toBe(true)
    const after = applyChanges(withAction, dimension.changes)
    const dims = json(after, PROJECT).accessDimensions as Json[]
    expect(typeof dims.find((d) => d.name === "zone")!.id).toBe("string")
    await modelOf(after)
  })

  it("renames an attribute in every rights place", async () => {
    const owner = await renamed(allRights(), element("assignee"), "owner")
    const task = json(owner, TASK_FILE)
    expect(task.ownership).toEqual(["owner"])
    expect((task.customActions as Json[])[0]!.effects).toEqual({
      header: ["owner"],
    })
    expect(json(owner, COMMENT_FILE).ownership).toEqual([["task", "owner"]])

    const project = await renamed(allRights(), element("project"), "workspace")
    expect(json(project, TASK_FILE).containerBinding).toBe("workspace")
    expect(json(project, COMMENT_FILE).containerBinding).toEqual([
      "task",
      "workspace",
    ])

    const column = await renamed(
      adoptedMembership(),
      { kind: "CustomTable", name: "Membership", element: ["userId"] },
      "memberUser"
    )
    const [source] = json(column, PROJECT).membershipSources as Json[]
    expect(source!.columns).toEqual({
      scope: "orgId",
      user: "memberUser",
      active: "isActive",
    })
  })

  it("renames a dimension and a custom action", async () => {
    const dim = await renamed(
      allRights(),
      { kind: "Project", element: ["region"] },
      "area"
    )
    expect(json(dim, TASK_FILE).access).toEqual([
      { attribute: "region", dimension: "area" },
    ])

    const action = await renamed(allRights(), element("reassign"), "handOver")
    const actions = json(action, TASK_FILE).customActions as Json[]
    expect(actions.map((a) => [a.name, a.requires])).toEqual([
      ["handOver", ["update"]],
      ["escalate", ["handOver"]],
    ])
  })

  it("refuses to delete a dimension, a container and a carrier that are referenced", async () => {
    const files = allRights()
    const roles = async (target: ElementTarget) => {
      const result = await deleteElement(files, { target })
      expect(result.ok).toBe(false)
      expect(result.changes).toEqual([])
      expect(new Set(result.diagnostics.map((d) => d.code))).toEqual(
        new Set(["operation.delete-referenced"])
      )
      return result.diagnostics.map((d) => (d.params as { role: string }).role)
    }
    expect(await roles({ kind: "Project", element: ["region"] })).toEqual([
      "access.dimension",
    ])
    expect(await roles({ kind: "Catalog", name: "Project" })).toContain(
      "attribute.ref"
    )
    // Реквізит-контейнер тримає прив'язка задачі, а через шлях — і коментаря.
    expect(await roles(element("project"))).toEqual(
      expect.arrayContaining(["rights.carrier", "rights.carrierPath"])
    )
    expect(await roles(element("assignee"))).toEqual(
      expect.arrayContaining([
        "rights.carrier",
        "rights.carrierPath",
        "customAction.header",
      ])
    )
    expect(await roles(element("reassign"))).toEqual(["customAction.requires"])
  })

  it("creates a container catalog with rights fields", async () => {
    const files = allRights()
    const result = await createObject(
      files,
      {
        kind: "Catalog",
        name: "Board",
        data: {
          scope: "org",
          rightsContainer: true,
          attributes: [
            { name: "project", type: "Ref", ref: ref("Catalog", "Project") },
            { name: "region", type: "Ref", ref: ref("Catalog", "Region") },
          ],
          containerBinding: "project",
          access: [{ attribute: "region", dimension: "region" }],
          customActions: [{ name: "pin", effects: { header: ["region"] } }],
        },
      },
      options()
    )
    expect(errors(result)).toEqual([])
    expect(result.ok).toBe(true)
    const after = applyChanges(files, result.changes)
    const board = json(after, "catalogs/Board/Board.meta.json")
    expect(board.rightsContainer).toBe(true)
    expect(typeof (board.customActions as Json[])[0]!.id).toBe("string")
    const model = await modelOf(after)
    const explained = explainObject(model, { kind: "Catalog", name: "Board" })!
    expect(explained.contracts).toContainEqual(
      expect.objectContaining({ container: true })
    )
  })

  it("addresses a custom action unambiguously", async () => {
    const files = allRights()
    const clash = await addElement(
      files,
      {
        target: TASK,
        collection: "customActions",
        element: { name: "region" },
      },
      options()
    )
    // Невдала компіляція результату: обгортка не пише жодної зміни.
    expect(clash.ok).toBe(false)
    expect(clash.diagnostics.map((d) => d.code)).toContain(
      "identity.name-duplicate"
    )

    const after = await renamed(files, element("reassign"), "handOver")
    const before = json(files, TASK_FILE)
    expect(json(after, TASK_FILE).attributes).toEqual(before.attributes)
    const requires = (await modelOf(after)).references.filter(
      (r) => r.role === "customAction.requires"
    )
    expect(requires.map((r) => r.to.id)).toEqual([REASSIGN_ID])

    const deleted = await deleteElement(files, { target: element("escalate") })
    expect(errors(deleted)).toEqual([])
    const left = json(applyChanges(files, deleted.changes), TASK_FILE)
    expect((left.customActions as Json[]).map((a) => a.name)).toEqual([
      "reassign",
    ])
    expect(left.attributes).toEqual(before.attributes)
    expect(TASK_ID).toBe(before.id)
  })
})

// Перехід у форму платформи (спека декларацій функцій §5.1, Р12): мутація,
// після якої задекларована функція стає формою платформи, у тій самій зміні
// видаляє її декларацію, а ширші призначення форми називає попередженням.
describe("a declared function becomes a platform form", () => {
  const TEAM_SQL = "sql/public/team.sql"
  const TEAM_FUNCTIONS = "sql/public/team.functions.json"
  const REGION_SQL = "sql/public/region.sql"
  const REGION_FUNCTIONS = "sql/public/region.functions.json"
  const TEAM_IDS =
    "CREATE FUNCTION public.team_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET TimeZone = 'UTC' SET DateStyle = 'ISO, MDY' SET IntervalStyle = 'postgres' SET extra_float_digits = '1' AS $$ SELECT NULL::uuid $$;\n"
  const OTHER =
    "CREATE FUNCTION public.team_count() RETURNS int LANGUAGE sql STABLE SET search_path = '' AS $$ SELECT 1 $$;\n"
  const REGION_IDS =
    "CREATE FUNCTION public.region_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' SET TimeZone = 'UTC' SET DateStyle = 'ISO, MDY' SET IntervalStyle = 'postgres' SET extra_float_digits = '1' AS $$ SELECT NULL::uuid $$;\n"

  const declared = (name: string, callers: string[], n: number) => ({
    id: uuid(n),
    function: { name },
    callers,
  })

  function withDeclarations(
    sql: Record<string, string>,
    declarations: Record<string, Json[]>
  ): Map<string, string> {
    const files = rightsFiles()
    for (const [path, text] of Object.entries(sql)) files.set(path, text)
    for (const [path, functions] of Object.entries(declarations)) {
      files.set(path, JSON.stringify({ functions }))
    }
    return files
  }

  const addTeamKind = (files: Files) =>
    addElement(
      files,
      {
        target: { kind: "Project" },
        collection: "scopeKinds",
        element: {
          name: "team",
          root: {
            external: { schema: "public", table: "teams", column: "id" },
          },
          setFunction: { name: "team_ids" },
        },
      },
      options()
    )

  const widens = (result: { diagnostics: readonly Diagnostic[] }) =>
    result.diagnostics.filter(
      (d) => d.code === "sql.declaration-platform-form-widens"
    )

  it("add of a scope kind writes the result and removes the declaration of its set function", async () => {
    const files = withDeclarations(
      { [TEAM_SQL]: TEAM_IDS },
      { [TEAM_FUNCTIONS]: [declared("team_ids", ["user"], 7801)] }
    )
    const input = await compile(files)
    const inputErrors = input.diagnostics.filter((d) => d.severity === "error")
    expect(inputErrors.map((d) => [d.code, d.params?.name])).toEqual([
      ["sql.declaration-check-missing", "team_ids"],
    ])

    const result = await addTeamKind(files)
    expect(errors(result)).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => [c.path, c.content === null])).toEqual([
      ["project.meta.json", false],
      [TEAM_FUNCTIONS, true],
    ])
    expect(widens(result).map((d) => d.params)).toEqual([
      {
        schema: "public",
        name: "team_ids",
        function: "public.team_ids",
        form: "setFunction",
        roles: "service, command",
      },
    ])
    await modelOf(applyChanges(files, result.changes))
  })

  it("keeps the other entries of the declarations file in canonical form", async () => {
    const files = withDeclarations(
      { [TEAM_SQL]: TEAM_IDS + OTHER },
      {
        [TEAM_FUNCTIONS]: [
          declared("team_count", ["user"], 7802),
          declared("team_ids", ["user", "service", "command"], 7803),
        ],
      }
    )
    const result = await addTeamKind(files)
    expect(errors(result)).toEqual([])
    expect(result.ok).toBe(true)
    // Викликачі збігаються з призначеннями функції множини: нічого не ширшає.
    expect(widens(result)).toEqual([])
    const after = applyChanges(files, result.changes)
    expect(json(after, TEAM_FUNCTIONS)).toEqual({
      functions: [declared("team_count", ["user"], 7802)],
    })
    await modelOf(after)
  })

  it("warns with the added roles when the form widens the callers of the declaration", async () => {
    const files = withDeclarations(
      { [TEAM_SQL]: TEAM_IDS },
      { [TEAM_FUNCTIONS]: [declared("team_ids", ["service"], 7804)] }
    )
    expect(errors(await compile(files))).toEqual([])

    const result = await addTeamKind(files)
    expect(errors(result)).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => c.path)).toEqual([
      "project.meta.json",
      TEAM_FUNCTIONS,
    ])
    expect(widens(result).map((d) => [d.severity, d.file, d.params])).toEqual([
      [
        "warning",
        TEAM_FUNCTIONS,
        {
          schema: "public",
          name: "team_ids",
          function: "public.team_ids",
          form: "setFunction",
          roles: "user, command",
        },
      ],
    ])
  })

  it("add of an access dimension with a values function never widens", async () => {
    const files = withDeclarations(
      { [REGION_SQL]: REGION_IDS },
      { [REGION_FUNCTIONS]: [declared("region_ids", ["service"], 7805)] }
    )
    expect(errors(await compile(files))).toEqual([])

    const result = await addElement(
      files,
      {
        target: { kind: "Project" },
        collection: "accessDimensions",
        element: {
          name: "area",
          target: ref("Catalog", "Region"),
          values: { function: { name: "region_ids" } },
        },
      },
      options()
    )
    expect(errors(result)).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => [c.path, c.content === null])).toEqual([
      ["project.meta.json", false],
      [REGION_FUNCTIONS, true],
    ])
    expect(widens(result)).toEqual([])
  })

  it("create of a subscription removes the declaration of its handler without a warning", async () => {
    const HANDLER_SQL = "sql/public/org-touch.sql"
    const HANDLER_FUNCTIONS = "sql/public/org-touch.functions.json"
    const files = withDeclarations(
      {
        [HANDLER_SQL]:
          "CREATE FUNCTION public.org_touch() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN RETURN NEW; END $$;\n",
      },
      { [HANDLER_FUNCTIONS]: [declared("org_touch", ["service"], 7806)] }
    )
    expect(errors(await compile(files))).toEqual([])

    const result = await createObject(
      files,
      {
        kind: "EventSubscription",
        name: "OrgTouch",
        data: {
          sources: [ref("Catalog", "Organization")],
          event: "onWrite",
          handler: { name: "org_touch" },
        },
      },
      options()
    )
    expect(errors(result)).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.changes.map((c) => [c.path, c.content === null])).toEqual([
      ["event-subscriptions/OrgTouch/OrgTouch.meta.json", false],
      [HANDLER_FUNCTIONS, true],
    ])
    // Призначення обробника порожні: перехід не розширює нічого.
    expect(widens(result)).toEqual([])
  })

  // Р7: `"a.b".c` і `a."b.c"` — різні функції, хоча зклеєний рядок у них
  // один (`a.b.c`).
  it("matches a declaration to a form by the (schema, name) pair, not a joined string", () => {
    const files = rightsFiles({
      [PROJECT]: {
        scopeKinds: [
          ORG_SCOPE_KIND,
          {
            id: uuid(7810),
            name: "dotted",
            physicalName: "dotted_id",
            root: {
              external: { schema: "public", table: "teams", column: "id" },
            },
            setFunction: { schema: "a.b", name: "c" },
          },
        ],
      },
    })
    const sql = "sql/a/fns.sql"
    const sidecar = "sql/a/fns.functions.json"
    files.set(sql, "-- функції розбирає компіляція, не перехід\n")
    const other = {
      id: uuid(7811),
      function: { schema: "a", name: "b.c" },
      callers: ["service"],
    }
    const form = {
      id: uuid(7812),
      function: { schema: "a.b", name: "c" },
      callers: ["service"],
    }
    files.set(sidecar, JSON.stringify({ functions: [other, form] }))

    const transition = toPlatformForms(files)
    expect(json(transition.files, sidecar)).toEqual({ functions: [other] })
    expect(transition.diagnostics.map((d) => d.params)).toEqual([
      {
        schema: "a.b",
        name: "c",
        function: "a.b.c",
        form: "setFunction",
        roles: "user, command",
      },
    ])
  })
})
