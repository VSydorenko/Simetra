import { beforeAll, describe, expect, it } from "vitest"
import {
  buildRuntimeCatalog,
  canonicalSnapshot,
  type CompiledModel,
} from "simetra/compiler"
import {
  runtimeCatalogSchema,
  type RuntimeCatalog,
  type RuntimeObject,
} from "simetra/model"
import { modelHash } from "../canonical"
import {
  BULLETIN_FILE,
  STATUS_FILE,
  adminRoles,
  commandCoreLayer,
  compileRights,
  policyDomain,
  refAttribute,
  statusEnumeration,
  ticketNoticeHandler,
  withSql,
  writeRoles,
  type Layer,
} from "./fixtures/rights"
import { uuid } from "./helpers"

/**
 * Значення, яких немає в довідниках фікстури A2: `Numeric` з точністю й
 * посилання на перерахування, де логічне ім'я значення ≠ мітка бази. Таблиця
 * з кінця алфавіту: порядок за таблицями (порядок контрактів ядра) тоді
 * відрізняється від порядку `model.objects`.
 */
const bulletinValues = (): Layer => ({
  [STATUS_FILE]: statusEnumeration(),
  [BULLETIN_FILE]: {
    physicalName: "zz_bulletin",
    attributes: [
      {
        id: uuid(7301),
        name: "weight",
        physicalName: "weight",
        type: "Numeric",
        precision: 12,
        scale: 3,
      },
      refAttribute(7302, "status", "status", {
        kind: "Enumeration",
        name: "Status",
      }),
    ],
  },
})

const files = () =>
  withSql(
    policyDomain(
      writeRoles(),
      adminRoles(),
      commandCoreLayer(),
      ticketNoticeHandler().layer,
      bulletinValues()
    ),
    ticketNoticeHandler()
  )

async function compiled(): Promise<CompiledModel> {
  const { model, diagnostics } = await compileRights(files())
  expect(diagnostics).toEqual([])
  return model!
}

let model: CompiledModel
let catalog: RuntimeCatalog
beforeAll(async () => {
  model = await compiled()
  catalog = buildRuntimeCatalog(model)
})

const objectOf = (name: string): RuntimeObject => {
  const found = catalog.objects.find((o) => o.name === name)
  expect(found, name).toBeDefined()
  return found!
}
const attributeOf = (object: string, name: string) => {
  const found = objectOf(object).attributes.find((a) => a.name === name)
  expect(found, `${object}.${name}`).toBeDefined()
  return found!
}

describe("CompiledModel.catalogCommands", () => {
  it("is the set the core SQL is generated from", () => {
    const saves = model.sqlUnits
      .filter((u) => u.generator === "catalogCommand" && u.class === "function")
      .map((u) => u.identity)
      .filter((identity) => identity.includes("_save("))
      .sort()
    expect(
      model.catalogCommands
        .map(
          (c) =>
            `function:${c.functions.save.schema}.${c.functions.save.name}(jsonb,int8)`
        )
        .sort()
    ).toEqual(saves)
    expect(saves.length).toBeGreaterThan(0)
  })

  // Похідне поле не входить у знімок: інакше хеш залежав би від форми
  // контракту, якої застосування не бачить.
  it("stays outside the canonical snapshot and the hash", async () => {
    expect(canonicalSnapshot(model)).not.toHaveProperty("catalogCommands")
    expect(await modelHash({ ...model, catalogCommands: [] })).toBe(model.hash)
  })
})

describe("buildRuntimeCatalog", () => {
  it("passes the T0 schema and carries the model hash", () => {
    expect(runtimeCatalogSchema.parse(catalog)).toEqual(catalog)
    expect(catalog.snapshotHash).toBe(model.hash)
    expect(catalog.provider).toBe(model.project.database.provider)
  })

  it("is deterministic across compilations", async () => {
    expect(JSON.stringify(buildRuntimeCatalog(await compiled()))).toBe(
      JSON.stringify(catalog)
    )
  })

  it("lists exactly the catalogs with a command core, in model order", () => {
    const ids = new Set(model.catalogCommands.map((c) => c.objectId))
    expect(catalog.objects.map((o) => o.id)).toEqual(
      model.objects.filter((o) => ids.has(o.id)).map((o) => o.id)
    )
  })

  it("operations come from the contract functions and actions", () => {
    expect(objectOf("OrgRoleAssignments").operations).toEqual({
      create: {
        function: { schema: "public", name: "org_role_assignments_save" },
        context: "administerRights",
      },
      update: {
        function: { schema: "public", name: "org_role_assignments_save" },
        context: "administerRights",
      },
      markDeletion: {
        function: {
          schema: "public",
          name: "org_role_assignments_mark_deletion",
        },
        context: "administerRights",
      },
      delete: {
        function: { schema: "public", name: "org_role_assignments_delete" },
        context: "administerRights",
      },
    })
    // «Користувачів» команда не створює й не позначає (спека П4 §6.6).
    expect(Object.keys(objectOf("Users").operations)).toEqual(["update"])
  })

  it("keeps the key and the version out of attributes, under logical names", () => {
    const ticket = objectOf("Ticket")
    expect(ticket).toMatchObject({
      key: "id",
      keyName: "ref",
      versionColumn: "version",
      versionName: "version",
      scopeColumn: "org_id",
    })
    const columns = ticket.attributes.map((a) => a.column)
    expect(columns).not.toContain("id")
    expect(columns).not.toContain("version")
    const [section] = ticket.tabularSections
    expect(section).toMatchObject({
      name: "checklist",
      key: "id",
      keyName: "ref",
      parent: "parent_id",
      lineNumber: "line_number",
    })
    expect(
      section!.attributes.filter((a) =>
        ["id", "parent_id", "line_number"].includes(a.column)
      )
    ).toEqual([])
  })

  it("insert and update flags follow the command grant keys", () => {
    // Скоуп пишеться лише на створенні; колонка поза грантом не пишеться ніколи.
    expect(attributeOf("Ticket", "org")).toMatchObject({
      column: "org_id",
      insert: true,
      update: false,
      required: true,
    })
    // Обов'язковість — лише серед того, що команда вставляє: скоуп рядка ТЧ
    // `NOT NULL` без DEFAULT, але його ставить ядро, а не вхід.
    expect(
      objectOf("Ticket").tabularSections[0]!.attributes.find(
        (a) => a.name === "org"
      )
    ).toMatchObject({ insert: false, update: false, required: false })
    expect(attributeOf("Users", "userKind")).toMatchObject({
      insert: false,
      update: false,
      required: false,
    })
    expect(attributeOf("Ticket", "deletionMark")).toMatchObject({
      insert: false,
      update: false,
    })
  })

  it("value facts: length, precision, cast type, enumeration labels, pair", () => {
    expect(attributeOf("Ticket", "code")).toMatchObject({
      pgType: "character varying(9)",
      castType: "character varying",
      type: "String",
      maxLength: 9,
    })
    expect(attributeOf("Bulletin", "weight")).toMatchObject({
      castType: "numeric",
      type: "Numeric",
      precision: 12,
      scale: 3,
    })
    expect(attributeOf("Bulletin", "status")).toMatchObject({
      castType: "text",
      type: "Ref",
      enumValues: [{ name: "Open", label: "open" }],
    })
    expect(attributeOf("Ticket", "watchers")).toMatchObject({
      castType: "uuid[]",
      array: true,
    })
    expect(attributeOf("Ticket", "subject")).toMatchObject({
      column: "subject_id",
      type: "Ref",
      pair: {
        typeColumn: "subject_type",
        targets: [
          { object: { kind: "Catalog", name: "Project" }, label: "project" },
          { object: { kind: "Catalog", name: "Region" }, label: "region" },
        ],
      },
    })
  })

  it("constraints: primary key, uniques, unique indexes, checks, foreign keys", () => {
    const table = model.physical.tables.find((t) => t.name === "ticket")!
    const constraints = objectOf("Ticket").constraints
    expect(constraints).toContainEqual({
      name: table.primaryKey!.name,
      kind: "primaryKey",
      columns: ["id"],
    })
    for (const unique of table.uniques) {
      expect(constraints).toContainEqual({
        name: unique.name,
        kind: "unique",
        columns: unique.columns,
      })
    }
    const index = table.indexes.find((i) => i.unique)!
    expect(constraints).toContainEqual({
      name: index.name,
      kind: "unique",
      columns: index.keys.map((k) => ("column" in k ? k.column : "")),
    })
    for (const check of table.checks) {
      expect(constraints).toContainEqual({
        name: check.name,
        kind: "check",
        columns: [],
      })
    }
    for (const fk of table.foreignKeys) {
      expect(constraints).toContainEqual({
        name: fk.name,
        kind: "foreignKey",
        columns: fk.columns,
      })
    }
    expect(constraints).toHaveLength(
      1 +
        table.uniques.length +
        table.indexes.filter((i) => i.unique).length +
        table.checks.length +
        table.foreignKeys.length
    )
  })
})
