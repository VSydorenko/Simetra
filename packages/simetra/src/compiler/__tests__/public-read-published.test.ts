import { describe, expect, it, vi } from "vitest"
import {
  KIND_REGISTRY,
  isObjectTable,
  type PhysicalSnapshot,
  type PhysicalTable,
} from "simetra/model"
import type { CompiledModel } from "simetra/compiler"
import { accessContracts } from "../access-units"
import {
  carrierBackfillStatements,
  carrierLinks,
} from "../rights/carrier-units"
import type { ParsedObject } from "../stages/files"
import { checkPublishedPublicRead } from "../rights/checks"
import type { RightsCheckContext } from "../rights/checks"
import {
  MEMBER_FILE,
  ORG_ASSIGNMENTS_FILE,
  ORG_ROLES_FILE,
  PROJECT_FILE,
  REGION_FILE,
  TASK_FILE,
  USERS_FILE,
  compileRights,
  withRoles,
  type Layer,
} from "./fixtures/rights"
import { snakeCaseTwin } from "./fixtures/snake-case"
import { metaFiles, project, uuid } from "./helpers"

const CONDITIONAL = { role: "anon", published: true }
const LINES_TABLE = "region_lines"
const LINES = {
  id: uuid(7803),
  name: "lines",
  physicalName: LINES_TABLE,
  attributes: [],
}

const conditionalRegion = (extra: Record<string, unknown> = {}): Layer => ({
  [REGION_FILE]: { publicRead: CONDITIONAL, ...extra },
})

async function compiledRegion(extra: Record<string, unknown> = {}) {
  const result = await compileRights(withRoles(conditionalRegion(extra)))
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

describe("conditional publicRead in the compiled model (Р-D1-8)", () => {
  it("adds the published column and keeps the string form without it", async () => {
    const model = await compiledRegion()
    const region = model.physical.tables.find((t) => t.name === "region")!
    const published = region.columns.find((c) => c.name === "published")
    expect(published).toMatchObject({
      type: "boolean",
      notNull: true,
      default: "false",
    })
    const plain = await compileRights(
      withRoles({ [REGION_FILE]: { publicRead: "anon" } })
    )
    const plainRegion = plain.model!.physical.tables.find(
      (t) => t.name === "region"
    )!
    expect(plainRegion.columns.map((c) => c.name)).not.toContain("published")
  })

  it("puts published into the transitions, the publish actions and the header of the access contract", async () => {
    const model = await compiledRegion()
    const rights = model.contracts.rights.find(
      (c) => c.table.name === "region"
    )!
    expect(rights.transitions).toContainEqual({
      column: "published",
      default: "false",
    })
    const publish = rights.actions.find((a) => a.name === "publish")!
    expect(publish).toMatchObject({
      requires: ["read"],
      transition: { column: "published", from: false, to: true },
    })
    // «all» не розгортається в колонку переходу: її змінює лише дія.
    for (const name of ["create", "update"]) {
      expect(
        rights.actions.find((a) => a.name === name)!.effects.header
      ).not.toContain("published")
    }
    const access = model.contracts.access.find(
      (a) => a.table.name === "region"
    )!
    expect(access.published).toEqual({
      column: "published",
      mark: "deletion_mark",
    })
    // Колонковий грант: вставка не задає публікації, змінює її лише дія.
    expect(access.command!.insert).not.toContain("published")
    expect(access.command!.update).toContain("published")
  })

  it("leaves the access contract of the string form without published", async () => {
    const result = await compileRights(
      withRoles({ [REGION_FILE]: { publicRead: "anon" } })
    )
    const access = result.model!.contracts.access.find(
      (a) => a.table.name === "region"
    )!
    expect(access.published).toBeUndefined()
  })

  it("refuses a custom action named publish or unpublish as a taken word", async () => {
    const result = await compileRights(
      withRoles(
        conditionalRegion({
          customActions: [
            { id: uuid(7801), name: "publish" },
            { id: uuid(7802), name: "unpublish" },
          ],
        })
      )
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "rights.custom-action-reserved")
        .map((d) => [d.file, d.pointer])
    ).toEqual([
      [REGION_FILE, "/customActions/0/name"],
      [REGION_FILE, "/customActions/1/name"],
    ])
  })

  it("refuses to build a contract for a table of a conditional object without publication columns", async () => {
    // Копії V у ТЧ кладе стадія 3 (Р-D1-9); знімок без них — дефект
    // компілятора, і будівник контрактів кидає, а не відкриває таблицю. З
    // файлів такий знімок недосяжний, тож копії прибираємо з готового.
    const model = await compiledRegion({ tabularSections: [LINES] })
    const withLines = (
      columns: (table: PhysicalTable) => PhysicalTable["columns"]
    ): PhysicalSnapshot => ({
      ...model.physical,
      tables: model.physical.tables.map((t) =>
        t.name === LINES_TABLE ? { ...t, columns: columns(t) } : t
      ),
    })
    const withoutCopies = withLines((t) =>
      t.columns.filter((c) => c.origin.copyOf === undefined)
    )
    // Колонка з іменем копії, що копією не є, — не V: будівник впізнає копію
    // за походженням, а не за іменем.
    const namedLikeCopies = withLines((t) =>
      t.columns.map((c) =>
        c.origin.copyOf === undefined
          ? c
          : { ...c, origin: { ...c.origin, copyOf: undefined } }
      )
    )
    const region = model.objects.find((o) => o.name === "Region")!
    const objects: ParsedObject[] = [
      {
        file: REGION_FILE,
        kind: "Catalog",
        name: "Region",
        id: region.id,
        data: { publicRead: CONDITIONAL },
      },
    ]
    const build = (snapshot: PhysicalSnapshot) =>
      accessContracts(
        objects,
        {
          ...snapshot,
          tables: snapshot.tables.filter(
            (t) => isObjectTable(t) && t.origin.objectId === region.id
          ),
        },
        [],
        new Map(),
        [],
        undefined,
        "camelCase",
        new Set()
      )
    // Той самий виклик на повному знімку будує контракт: кидає саме брак копій.
    expect(
      build(model.physical).find((a) => a.table.name === LINES_TABLE)!.published
    ).toEqual({ column: "published", mark: "deletion_mark" })
    for (const snapshot of [withoutCopies, namedLikeCopies]) {
      expect(() => build(snapshot)).toThrow(
        /internal: conditional public read of region_lines/
      )
    }
  })
})

describe("rules of the conditional publicRead (Р-D1-13)", () => {
  const diagnosticsOf = async (files: Map<string, string>) =>
    (await compileRights(files)).diagnostics
      .filter((d) => d.code.startsWith("rights.public-read"))
      .map((d) => [d.file, d.code, d.pointer])

  it.each([
    {
      case: "a kind without command writes",
      files: () =>
        withRoles({
          [TASK_FILE]: { publicRead: CONDITIONAL },
        }),
      expected: [
        [TASK_FILE, "rights.public-read-published-kind", "/publicRead"],
      ],
    },
    {
      case: "a project without the rights functions",
      files: () => {
        return metaFiles({
          [PROJECT_FILE]: project(),
          [REGION_FILE]: {
            id: uuid(6040),
            kind: "Catalog",
            name: "Region",
            physicalName: "region",
            kindLabel: "region",
            publicRead: CONDITIONAL,
          },
        })
      },
      expected: [
        [REGION_FILE, "rights.public-read-published-rights", "/publicRead"],
      ],
    },
    {
      case: "an object form on the users catalog",
      files: () => withRoles({ [USERS_FILE]: { publicRead: CONDITIONAL } }),
      expected: [[USERS_FILE, "rights.public-read-forbidden", "/publicRead"]],
    },
    {
      case: "an object form on the membership catalog",
      files: () => withRoles({ [MEMBER_FILE]: { publicRead: CONDITIONAL } }),
      expected: [[MEMBER_FILE, "rights.public-read-forbidden", "/publicRead"]],
    },
    {
      case: "an object form on the roles catalog",
      files: () => withRoles({ [ORG_ROLES_FILE]: { publicRead: CONDITIONAL } }),
      expected: [
        [ORG_ROLES_FILE, "rights.public-read-forbidden", "/publicRead"],
      ],
    },
    {
      case: "an object form on the role assignments catalog",
      files: () =>
        withRoles({ [ORG_ASSIGNMENTS_FILE]: { publicRead: CONDITIONAL } }),
      expected: [
        [ORG_ASSIGNMENTS_FILE, "rights.public-read-forbidden", "/publicRead"],
      ],
    },
    {
      case: "a valid conditional object",
      files: () => withRoles(conditionalRegion()),
      expected: [],
    },
  ])("$case", async ({ files, expected }) => {
    expect(await diagnosticsOf(files())).toEqual(expected)
  })
})

describe("rights.public-read-published-read (Р-D1-13)", () => {
  it("fires for an object whose kind has no read action in its rights contract", () => {
    // Через файли недосяжне: кожен вид з `publicRead` має `read`. Тому дію
    // прибирає шпигун над реєстром, а контекст — мінімальний виклик перевірки.
    const object = (data: Record<string, unknown>, file: string) => ({
      file,
      kind: "Catalog",
      name: String(data.name),
      data,
    })
    const ctx = {
      objects: [
        object({ name: "Users", role: "users" }, "users.json"),
        object({ name: "Role", kind: "Role" }, "role.json"),
        object({ name: "Page", publicRead: CONDITIONAL }, "page.json"),
      ].map((o, i) => (i === 1 ? { ...o, kind: "Role" } : o)),
      project: {
        database: { provider: "supabase" },
        membershipSources: [],
      },
    } as unknown as RightsCheckContext
    const spy = vi.spyOn(KIND_REGISTRY.Catalog, "actions").mockReturnValue([])
    try {
      expect(
        checkPublishedPublicRead(ctx).map((d) => [d.file, d.code, d.pointer])
      ).toEqual([
        ["page.json", "rights.public-read-published-read", "/publicRead"],
      ])
    } finally {
      spy.mockRestore()
    }
  })
})

describe("copies of the publication condition in tabular sections (Р-D1-9)", () => {
  const REGION = { schema: "public", name: "region" }
  const copiesOf = (table: PhysicalTable) =>
    table.columns
      .filter((c) => c.origin.copyOf !== undefined)
      .map((c) => ({
        name: c.name,
        type: c.type,
        notNull: c.notNull,
        copyOf: c.origin.copyOf,
      }))
  const EXPECTED_COPIES = ["published", "deletion_mark"].map((column) => ({
    name: column,
    type: "boolean",
    notNull: false,
    copyOf: { table: REGION, column, through: "parent_id" },
  }))
  const tableOf = (model: CompiledModel, name: string) =>
    model.physical.tables.find((t) => t.name === name)!

  it("copies published and deletion_mark of the header into each tabular section", async () => {
    const model = await compiledRegion({ tabularSections: [LINES] })
    expect(copiesOf(tableOf(model, LINES_TABLE))).toEqual(EXPECTED_COPIES)
    // Шапка копій не має: V — її власні колонки.
    expect(copiesOf(tableOf(model, "region"))).toEqual([])
    const plain = await compileRights(
      withRoles({
        [REGION_FILE]: { publicRead: "anon", tabularSections: [LINES] },
      })
    )
    expect(copiesOf(tableOf(plain.model!, LINES_TABLE))).toEqual([])
  })

  it("gives the same copies in a snake_case project", async () => {
    // Ім'я носія пише платформа, тож посилання стадії 2 мусить резолвитися в
    // стилі проєкту: `deletion_mark`, а не `deletionMark`.
    const result = await compileRights(
      snakeCaseTwin(withRoles(conditionalRegion({ tabularSections: [LINES] })))
    )
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(copiesOf(tableOf(result.model!, LINES_TABLE))).toEqual(
      EXPECTED_COPIES
    )
  })

  it("points the access contract of the section at its copies", async () => {
    const model = await compiledRegion({ tabularSections: [LINES] })
    const lines = model.contracts.access.find(
      (a) => a.table.name === LINES_TABLE
    )!
    expect(lines.published).toEqual({
      column: "published",
      mark: "deletion_mark",
    })
    // Копії пише лише платформа: колонковий грант ролі команд їх не дає.
    for (const column of ["published", "deletion_mark"]) {
      expect(lines.command!.insert).not.toContain(column)
      expect(lines.command!.update).not.toContain(column)
    }
  })

  it("derives, propagates and backfills both copies by the carrier mechanism", async () => {
    const model = await compiledRegion({ tabularSections: [LINES] })
    const link = carrierLinks(model.physical).find(
      (l) => l.table.name === LINES_TABLE
    )!
    expect(link.copies).toEqual([
      { name: "published", column: "published" },
      { name: "deletion_mark", column: "deletion_mark" },
    ])
    const carrierUnits = model.sqlUnits
      .filter((u) => u.generator === "carriers")
      .map((u) => u.identity)
    expect(carrierUnits).toEqual(
      expect.arrayContaining([
        `trigger:public.${LINES_TABLE}.${LINES_TABLE}_simetra_carriers`,
        `function:public.${LINES_TABLE}_simetra_carriers()`,
      ])
    )
    const backfill = carrierBackfillStatements(model.physical, [
      {
        table: { schema: "public", name: LINES_TABLE },
        columns: ["published", "deletion_mark"],
      },
    ])
    expect(backfill.map((s) => [s.table.name, s.source.name])).toEqual([
      [LINES_TABLE, "region"],
    ])
    expect(backfill[0]!.sql).toMatch(
      /SET \(published, deletion_mark\) = \(SELECT s\.published, s\.deletion_mark FROM public\.region AS s/
    )
  })

  it.each([
    {
      field: "ownership",
      value: { ownership: ["published"] },
      at: "/ownership/0",
    },
    {
      field: "ownership",
      value: { ownership: ["deletionMark"] },
      at: "/ownership/0",
    },
    {
      field: "containerBinding",
      value: { containerBinding: "published" },
      at: "/containerBinding",
    },
  ])(
    "keeps rights.carrier-not-ref for $field on a publication column ($at)",
    async ({ value, at }) => {
      const result = await compileRights(
        withRoles(conditionalRegion({ tabularSections: [LINES], ...value }))
      )
      expect(
        result.diagnostics
          .filter((d) => d.code.startsWith("rights.carrier"))
          .map((d) => [d.code, d.file, d.pointer])
      ).toEqual([["rights.carrier-not-ref", REGION_FILE, at]])
    }
  )

  it.each([
    { name: "published", pointer: "/publicRead/published" },
    { name: "deletion_mark", pointer: "/publicRead/deletionMark" },
  ])(
    "refuses a section attribute that takes the copy name $name",
    async ({ name, pointer }) => {
      const result = await compileRights(
        withRoles(
          conditionalRegion({
            tabularSections: [
              {
                ...LINES,
                attributes: [
                  {
                    id: uuid(7804),
                    name: name === "published" ? "published" : "deletionMark",
                    physicalName: name,
                    type: "Boolean",
                  },
                ],
              },
            ],
          })
        )
      )
      expect(
        result.diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => [d.code, d.file, d.pointer, d.params])
      ).toEqual([
        [
          "rights.carrier-column-taken",
          REGION_FILE,
          pointer,
          { table: LINES_TABLE, column: name },
        ],
      ])
    }
  )
})
