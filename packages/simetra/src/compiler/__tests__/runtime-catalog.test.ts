import { beforeAll, describe, expect, it } from "vitest"
import {
  buildRuntimeCatalog,
  canonicalSnapshot,
  type CompiledModel,
} from "simetra/compiler"
import {
  runtimeCatalogSchema,
  standardElementId,
  type RuntimeCatalog,
  type RuntimeObject,
} from "simetra/model"
import { modelHash } from "../canonical"
import {
  BULLETIN_FILE,
  GAUGE_LOG_FILE,
  STATUS_FILE,
  adminRoles,
  commandCoreLayer,
  compileRights,
  gaugeLoadLayer,
  gaugeRowRule,
  policyDomain,
  refAttribute,
  rootCreationDomain,
  runtimeValuesLayer,
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
    expect(Object.keys(objectOf("Users").operations ?? {})).toEqual(["update"])
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
      parentName: "parent",
      lineNumber: "line_number",
      lineNumberName: "lineNumber",
    })
    expect(
      section!.attributes.filter((a) =>
        ["id", "parent_id", "line_number"].includes(a.column)
      )
    ).toEqual([])
  })

  // id ТЧ — її ідентичність у формі передачі (рішення В4, В12): береться з
  // походження фізичної таблиці, а не з імені, яке змінюється; стандартна ТЧ
  // (дельта «Ролей») несе синтетичний id елемента.
  it("a tabular section carries its UUID", () => {
    const sections = catalog.objects.flatMap((o) => o.tabularSections)
    const roles = objectOf("OrgRoles")
    expect(roles.tabularSections.map((s) => s.id)).toContain(
      standardElementId(roles.id, { logicalName: "delta" })
    )
    for (const section of sections) {
      const table = model.physical.tables.find(
        (t) =>
          t.schema === section.table.schema && t.name === section.table.name
      )
      expect(table?.origin.tabularSectionId, section.table.name).toBeDefined()
      expect(section.id).toBe(table!.origin.tabularSectionId)
    }
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
    // Колонки CHECK — окремий тест на `Gauge` (Р-A3-21).
    for (const check of table.checks) {
      expect(constraints).toContainEqual(
        expect.objectContaining({ name: check.name, kind: "check" })
      )
    }
    for (const fk of table.foreignKeys) {
      expect(constraints).toContainEqual({
        name: fk.name,
        kind: "foreignKey",
        columns: fk.columns,
        references: fk.references.columns,
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

/**
 * Ціль одноцільового `Ref` і FK власника ТЧ (спека П4-B Рд1, В12): за ними
 * будівник читання робить `include` і корелює ТЧ з власником. FK скоупленої
 * таблиці на ціль того самого виду — складений `(скоуп, колонка)`.
 */
describe("buildRuntimeCatalog: ref and parentConstraint", () => {
  const fkOf = (table: string, columns: string[]) => {
    const found = model.physical.tables
      .find((t) => t.name === table)!
      .foreignKeys.find((f) => f.columns.join() === columns.join())
    expect(found, `${table}(${columns.join()})`).toBeDefined()
    return found!.name
  }
  const idOf = (name: string) => model.objects.find((o) => o.name === name)!.id

  it.each([
    [
      "a composite same-scope FK",
      "Ticket",
      "region",
      "Region",
      ["org_id", "region_id"],
    ],
    [
      "a simple FK to an unscoped target",
      "OrgMember",
      "user",
      "Users",
      ["user_id"],
    ],
    // Ціль поза каталогом (документ) — та сама: `object` — id моделі.
    [
      "a target outside the catalog",
      "TaskComment",
      "task",
      "Task",
      ["org_id", "task_id"],
    ],
  ])(
    "a single-target Ref has its target and FK: %s",
    (_, object, name, target, columns) => {
      const table = objectOf(object).table.name
      expect(attributeOf(object, name).ref).toEqual({
        object: idOf(target),
        constraint: fkOf(table, columns),
      })
    }
  )

  it.each([
    // Колонка скоупу має FK на корінь, але її тип — `UUID`.
    ["the scope column", "Ticket", "org"],
    ["a UUID standard attribute with an FK", "Ticket", "createdBy"],
    ["an enumeration reference", "Bulletin", "status"],
    ["a reference array", "Ticket", "watchers"],
    ["a polymorphic pair", "Ticket", "subject"],
  ])("%s has no ref", (_, object, name) => {
    expect(attributeOf(object, name)).not.toHaveProperty("ref")
  })

  it("a standard Ref attribute and a tabular section attribute have a ref", async () => {
    const { model: roots } = await compileRights(rootCreationDomain())
    const organization = buildRuntimeCatalog(roots!).objects.find(
      (o) => o.name === "Organization"
    )!
    expect(
      organization.attributes.find((a) => a.name === "owner")!.ref
    ).toEqual({
      object: roots!.objects.find((o) => o.name === "Users")!.id,
      constraint: "organization_owner_id_fkey",
    })
    const related = objectOf("Ticket").tabularSections[0]!.attributes.find(
      (a) => a.column === "related_id"
    )
    expect(related!.ref).toEqual({
      object: idOf("Ticket"),
      constraint: fkOf("ticket_checklist", ["org_id", "related_id"]),
    })
  })

  it.each([
    [
      "a composite scoped parent",
      "Ticket",
      "ticket_checklist",
      ["org_id", "parent_id"],
    ],
    ["a simple unscoped parent", "Users", "users_devices", ["parent_id"]],
  ])(
    "a tabular section names its owner FK: %s",
    (_, object, table, columns) => {
      const [section] = objectOf(object).tabularSections
      expect(section!.parentConstraint).toBe(fkOf(table, columns))
      expect(
        section!.constraints.find((c) => c.name === section!.parentConstraint)
      ).toMatchObject({
        kind: "foreignKey",
        columns,
        references: [...columns.slice(0, -1), "id"],
      })
    }
  )

  it("the T0 schema rejects a section whose parentConstraint has no references", () => {
    const broken = {
      ...catalog,
      objects: catalog.objects.map((o) => ({
        ...o,
        tabularSections: o.tabularSections.map((s) => ({
          ...s,
          constraints: s.constraints.map((c) =>
            c.name === s.parentConstraint ? { ...c, references: undefined } : c
          ),
        })),
      })),
    }
    expect(runtimeCatalogSchema.safeParse(broken).success).toBe(false)
  })
})

/**
 * Значення рантайму на справжньому каталозі (`runtimeValuesLayer()`): факти,
 * за якими T3 кодує вхід і декодує рядок ядра, — з метаданих, а не з рукою
 * зібраного об'єкта unit-тестів T3.
 */
describe("buildRuntimeCatalog on runtime values", () => {
  let values: RuntimeCatalog
  beforeAll(async () => {
    const { model: m, diagnostics } = await compileRights(
      policyDomain(runtimeValuesLayer())
    )
    expect(diagnostics).toEqual([])
    values = buildRuntimeCatalog(m!)
  })
  const gauge = () => values.objects.find((o) => o.name === "Gauge")!
  const attribute = (name: string) =>
    gauge().attributes.find((a) => a.name === name)

  it("Numeric(30,10), BigInt, Json, Bytes and a BigInt array", () => {
    expect(attribute("amount")).toMatchObject({
      pgType: "numeric(30,10)",
      castType: "numeric",
      type: "Numeric",
      precision: 30,
      scale: 10,
    })
    expect(attribute("counter")).toMatchObject({
      castType: "bigint",
      type: "BigInt",
    })
    expect(attribute("payload")).toMatchObject({
      castType: "jsonb",
      type: "Json",
    })
    expect(attribute("blob")).toMatchObject({
      castType: "bytea",
      type: "Bytes",
    })
    expect(attribute("marks")).toMatchObject({
      pgType: "bigint[]",
      castType: "bigint[]",
      type: "BigInt",
      array: true,
    })
  })

  // Логічне ім'я значення — на вході й виході T3, мітку знає лише база.
  it("an enumeration reference carries names and labels, cast as text", () => {
    expect(attribute("level")).toMatchObject({
      castType: "text",
      type: "Ref",
      enumValues: [
        { name: "Low", label: "lvl_low" },
        { name: "High", label: "lvl_high" },
      ],
    })
  })

  it("a polymorphic pair lists its targets with their labels", () => {
    expect(attribute("subject")).toMatchObject({
      column: "subject_id",
      castType: "uuid",
      pair: {
        typeColumn: "subject_type",
        targets: [
          { object: { kind: "Catalog", name: "Project" }, label: "project" },
          { object: { kind: "Catalog", name: "Region" }, label: "region" },
        ],
      },
    })
  })

  it("a scoped tabular section names its composite owner FK", () => {
    const [lines] = gauge().tabularSections
    expect(lines!.parentConstraint).toBe("gauge_lines_org_id_parent_id_fkey")
    expect(
      lines!.constraints.find((c) => c.name === lines!.parentConstraint)
    ).toMatchObject({
      columns: ["org_id", "parent_id"],
      references: ["org_id", "id"],
    })
  })

  it("a custom String attribute has maxLength, also in a tabular section", () => {
    const log = values.objects.find((o) => o.name === "GaugeLog")!
    expect(log.attributes.find((a) => a.name === "note")).toMatchObject({
      pgType: "character varying(40)",
      castType: "character varying",
      type: "String",
      maxLength: 40,
    })
    const [lines] = gauge().tabularSections
    expect(lines!.name).toBe("lines")
    expect(lines!.attributes.find((a) => a.name === "note")).toMatchObject({
      castType: "character varying",
      maxLength: 40,
    })
    expect(lines!.attributes.find((a) => a.name === "qty")).toMatchObject({
      castType: "numeric",
      precision: 30,
      scale: 10,
    })
  })

  // Каталог рантайму не знає енам-типів (`castTypeOf` їх не приводить):
  // на `PgEnum` посилається лише колонка `CustomTable`, а каталог містить
  // лише види ядра команд. Тест тримає цей факт: коли довідник зможе
  // посилатися на `PgEnum`, він почервоніє й вимагатиме типу приведення.
  it("a catalog attribute cannot reference a PgEnum, so no quoted cast type comes from a catalog", async () => {
    const { diagnostics } = await compileRights(
      policyDomain(runtimeValuesLayer(), {
        "pg-enums/Mood/Mood.meta.json": {
          id: uuid(7590),
          kind: "PgEnum",
          name: "Mood",
          physicalName: "mood",
          values: ["calm"],
        },
        [GAUGE_LOG_FILE]: {
          attributes: [
            refAttribute(7591, "mood", "mood", {
              kind: "PgEnum",
              name: "Mood",
            }),
          ],
        },
      })
    )
    expect(diagnostics.map((d) => d.code)).toEqual([
      "reference.not-referenceable",
    ])
  })
})

/**
 * Лінивий атрибут (Рд25, В3): у каталозі лише ефективно лінивий реквізит
 * шапки — явний `load: "lazy"` чи `Bytes` без `load`; у ТЧ лінивих немає.
 */
describe("buildRuntimeCatalog: lazy attributes", () => {
  const gaugeOf = async (loads: Record<string, "eager" | "lazy">) => {
    const { model: m, diagnostics } = await compileRights(
      policyDomain(gaugeLoadLayer(loads))
    )
    expect(diagnostics).toEqual([])
    return buildRuntimeCatalog(m!).objects.find((o) => o.name === "Gauge")!
  }
  const loadOf = (object: RuntimeObject, name: string) =>
    object.attributes.find((a) => a.name === name)!.load

  it("Bytes of the header defaults to lazy; load overrides it", async () => {
    const defaults = await gaugeOf({ amount: "lazy" })
    expect(loadOf(defaults, "blob")).toBe("lazy")
    expect(loadOf(defaults, "amount")).toBe("lazy")
    expect(loadOf(defaults, "counter")).toBeUndefined()
    const eager = await gaugeOf({ blob: "eager" })
    expect(eager.attributes.find((a) => a.name === "blob")).not.toHaveProperty(
      "load"
    )
    const scan = defaults.tabularSections[0]!.attributes.find(
      (a) => a.name === "scan"
    )
    expect(scan).toMatchObject({ type: "Bytes" })
    expect(scan).not.toHaveProperty("load")
  })
})

/**
 * Колонка CHECK (Р-A3-21) — побічний результат компілятора за фактично
 * призначеним іменем, а не розбір імені обмеження: Postgres повертає лише ім'я,
 * і мапінг `23514` на реквізит (спека П4 §6.10) бере колонку звідси.
 */
describe("buildRuntimeCatalog: CHECK columns", () => {
  const checksOf = async (files: Map<string, string>) => {
    const { model: m, diagnostics } = await compileRights(files)
    expect(diagnostics).toEqual([])
    return {
      model: m!,
      checks: buildRuntimeCatalog(m!)
        .objects.find((o) => o.name === "Gauge")!
        .constraints.filter((c) => c.kind === "check"),
    }
  }

  it("bounds, an enumeration label and a pair type name their column; a row rule names none", async () => {
    const { checks } = await checksOf(
      withSql(policyDomain(runtimeValuesLayer()), gaugeRowRule())
    )
    expect(checks).toEqual([
      { name: "gauge_level_check", kind: "check", columns: ["level"] },
      { name: "gauge_reading_bounds", kind: "check", columns: ["reading"] },
      { name: "gauge_span", kind: "check", columns: [] },
      {
        name: "gauge_subject_type_check",
        kind: "check",
        columns: ["subject_type"],
      },
    ])
  })

  // Ім'я CHECK довгої таблиці обрізане до 63 байтів: мапа йде за призначеним
  // іменем, а не за перерахованим «таблиця_колонка_мітка».
  it("follows the assigned name of a truncated CHECK", async () => {
    const table = "gauge_log_" + "x".repeat(50)
    const files = policyDomain(runtimeValuesLayer(), {
      [GAUGE_LOG_FILE]: {
        physicalName: table,
        attributes: [
          {
            id: uuid(7517),
            name: "level",
            physicalName: "level",
            type: "Integer",
            positive: true,
          },
        ],
      },
    })
    const { model: m, diagnostics } = await compileRights(files)
    expect(diagnostics).toEqual([])
    const [check] = m!.physical.tables.find((t) => t.name === table)!.checks
    expect(check!.name).not.toBe(`${table}_level_bounds`)
    expect(
      buildRuntimeCatalog(m!)
        .objects.find((o) => o.name === "GaugeLog")!
        .constraints.filter((c) => c.kind === "check")
    ).toEqual([{ name: check!.name, kind: "check", columns: ["level"] }])
  })

  // Мапа — не частина знімка: хеш фікстури той самий, що до появи мапи
  // (обчислений на коміті до неї). Зміна фікстури змінює і цей літерал.
  it("stays outside the canonical snapshot and the hash", async () => {
    const { model: m } = await checksOf(policyDomain(runtimeValuesLayer()))
    expect(m.checkColumns.length).toBeGreaterThan(0)
    expect(canonicalSnapshot(m)).not.toHaveProperty("checkColumns")
    expect(await modelHash({ ...m, checkColumns: [] })).toBe(m.hash)
    expect(m.hash).toBe(
      "79a88a9c55d98e85b67d0755be1372e00a447fe23af7340cd14359f854c24f6a"
    )
  })
})

/**
 * Факти створення тенанта (спека П4 §6.3, §6.13): ядро кореня й довідник
 * членства, з яких T3 генерує id і перевіряє `creatorMember`.
 */
describe("buildRuntimeCatalog: scope root creation", () => {
  let roots: RuntimeCatalog
  const compiledRoots = async () => {
    const { model: m, diagnostics } = await compileRights(rootCreationDomain())
    expect(diagnostics).toEqual([])
    return buildRuntimeCatalog(m!)
  }
  beforeAll(async () => {
    roots = await compiledRoots()
  })
  const object = (name: string) => roots.objects.find((o) => o.name === name)!

  it("a root with a creator names its membership catalog; a root without one has none", () => {
    expect(object("Organization").operations?.create).toEqual({
      function: { schema: "public", name: "organization_create_root" },
      context: "create",
      root: { membership: object("OrgMember").id },
    })
    expect(object("Branch").operations?.create).toEqual({
      function: { schema: "public", name: "branch_create_root" },
      context: "create",
      root: {},
    })
    expect(object("OrgMember").operations?.create).not.toHaveProperty("root")
    expect(object("OrgRoleAssignments").operations?.create).not.toHaveProperty(
      "root"
    )
  })

  it("a membership catalog names its user column", () => {
    expect(object("OrgMember").membership).toEqual({ userColumn: "user_id" })
    expect(object("BranchMember").membership).toEqual({
      userColumn: "user_id",
    })
    expect(object("OrgRoleAssignments")).not.toHaveProperty("membership")
  })

  it("is deterministic and passes the T0 schema", async () => {
    expect(runtimeCatalogSchema.parse(roots)).toEqual(roots)
    expect(JSON.stringify(await compiledRoots())).toBe(JSON.stringify(roots))
  })

  it.each<[string, (catalog: RuntimeCatalog) => RuntimeCatalog]>([
    [
      "a membership outside the catalog",
      (c) => ({
        ...c,
        objects: c.objects.filter((o) => o.name !== "OrgMember"),
      }),
    ],
    [
      "a membership object without its membership facts",
      (c) => ({
        ...c,
        objects: c.objects.map((o) =>
          o.name === "OrgMember" ? { ...o, membership: undefined } : o
        ),
      }),
    ],
  ])("the T0 schema rejects %s", (_, broken) => {
    expect(runtimeCatalogSchema.safeParse(broken(roots)).success).toBe(false)
  })
})
