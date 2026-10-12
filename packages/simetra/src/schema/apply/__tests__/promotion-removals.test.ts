import { beforeAll, describe, expect, it } from "vitest"
import {
  loadSqlParser,
  type PromotionObject,
  type PromotionRecord,
  type SqlParser,
} from "simetra/compiler"
import type {
  CatalogColumn,
  CatalogModel,
  CatalogTable,
  CatalogUnit,
} from "simetra/model"
import {
  accessChanges,
  adoptedReplacements,
  checkPermissions,
  classifyRemovals,
  classifySteps,
  promotionPermissionItems,
  requiredPermissions,
  stepConversions,
  tableKey,
  unclassifiedRemovals,
  unrealizedRenames,
  type EngineAction,
  type PlanStep,
  type RenameIntent,
} from "simetra/schema"

/**
 * Класи видалень промоції, нереалізоване оголошення й виняток «заміна»
 * (рішення 2, 3 і 7 плану П3-2a): копія після наміру проти бажаної тіні.
 */

const OBJECT_ID = "00000000-0000-4000-8000-000000000001"
const ATTRIBUTE_ID = "00000000-0000-4000-8000-000000000101"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

function record(over: Partial<PromotionRecord>): PromotionRecord {
  return {
    format: 1,
    base: "0".repeat(64),
    result: "1".repeat(64),
    objectId: OBJECT_ID,
    kind: "Catalog",
    labelDropped: false,
    tables: [{ id: OBJECT_ID, schema: "app", from: "items", to: "items" }],
    columns: [],
    typeChanges: [],
    dataSteps: [],
    retired: [],
    relaxed: [],
    tightened: [],
    rowLevelSecurity: [],
    deleteSemantics: [],
    conversions: [],
    movedUnits: [],
    rewrittenUnits: [],
    contractChanges: [],
    ...over,
  }
}

const col = (
  name: string,
  over: Partial<CatalogColumn> = {}
): CatalogColumn => ({
  name,
  type: "text",
  notNull: false,
  ...over,
})

function table(
  name: string,
  over: Partial<CatalogTable> = {},
  schema = "app"
): CatalogTable {
  return {
    schema,
    name,
    rowLevelSecurity: "enabled",
    columns: [col("id", { type: "uuid", notNull: true })],
    primaryKey: { name: `${name}_pkey`, columns: ["id"] },
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
    ...over,
  }
}

const model = (
  tables: CatalogTable[],
  units: CatalogUnit[] = []
): CatalogModel => ({ tables, enumTypes: [], units })

function unit(
  cls: CatalogUnit["class"],
  identity: string,
  name: string,
  sql: string
): CatalogUnit {
  return { class: cls, identity, schema: "app", name, sql }
}

function intent(
  over: {
    tables?: [string, string][]
    temp?: [string, string, string][]
  } = {}
): RenameIntent {
  return {
    steps: [],
    columns: [],
    tablesNewToOld: new Map(
      (over.tables ?? []).map(([to, from]) => [
        tableKey("app", to),
        tableKey("app", from),
      ])
    ),
    tempNames: new Map(
      (over.temp ?? []).map(([t, temp, original]) => [
        JSON.stringify(["app", t, temp]),
        original,
      ])
    ),
  }
}

const conversion = (
  cls: PromotionRecord["conversions"][number]["class"],
  ...objects: PromotionObject[]
): PromotionRecord["conversions"][number] => ({
  subject: `subject-${cls}`,
  class: cls,
  objects,
})

const ITEMS = [{ schema: "app", name: "items" }]
const CATALOG_ITEMS = [{ schema: "app", name: "catalog_items" }]

const constraint = (name: string, t = "items"): PromotionObject => ({
  kind: "constraint",
  schema: "app",
  table: t,
  name,
})

function step(id: string, sql: string, over: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    origin: "engine",
    sql,
    verb: "alter",
    class: "catalogOnly",
    lockClass: "accessExclusive",
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: [],
    produces: [],
    consumes: [],
    destroys: [],
    destroyed: [],
    consumed: [],
    dataLoss: false,
    rewriteRisk: false,
    guards: [],
    ...over,
  }
}

function action(sql: string, over: Partial<EngineAction> = {}): EngineAction {
  return {
    sql,
    verb: "alter",
    produces: [],
    consumes: [],
    destroys: [],
    destroyed: [],
    consumed: [],
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: [],
    lockClass: "accessExclusive",
    dataLoss: false,
    rewriteRisk: false,
    ...over,
  }
}

const classify = (
  rec: PromotionRecord,
  clone: CatalogModel,
  desired: CatalogModel,
  i: RenameIntent = intent()
) => classifyRemovals({ record: rec, intent: i, clone, desired, parse })

describe("classifyRemovals", () => {
  it("covers a removed unique constraint by its conversion class", () => {
    const unique = {
      name: "items_code_key",
      columns: ["code"],
      nullsNotDistinct: false,
    }
    const removals = classify(
      record({ conversions: [conversion("rowRule", constraint(unique.name))] }),
      model([table("items", { columns: [col("code")], uniques: [unique] })]),
      model([table("items", { columns: [col("code")] })])
    )
    expect(removals).toEqual([
      {
        path: "tables.app.items.uniques.items_code_key",
        kind: "missing",
        covered: "rowRule",
        tables: ITEMS,
      },
    ])
    expect(unclassifiedRemovals(removals)).toEqual([])
  })

  it("covers a constraint left under a temporary name by its original name", () => {
    const check = { name: "simetra_tmp_1", expression: "CHECK (true)" }
    const removals = classify(
      record({ conversions: [conversion("rowRule", constraint("items_k"))] }),
      model([table("items", { checks: [check] })]),
      model([table("items")]),
      intent({ temp: [["items", "simetra_tmp_1", "items_k"]] })
    )
    expect(removals).toEqual([
      {
        path: "tables.app.items.checks.items_k",
        kind: "missing",
        covered: "rowRule",
        tables: ITEMS,
      },
    ])
  })

  it("covers a removed policy unit by its unit key after the table rename", () => {
    const policy = unit(
      "policy",
      "policy:app.catalog_items.items_read",
      "items_read",
      "CREATE POLICY items_read ON app.catalog_items FOR SELECT USING (true)"
    )
    const removals = classify(
      record({
        tables: [
          { id: OBJECT_ID, schema: "app", from: "items", to: "catalog_items" },
        ],
        conversions: [
          conversion("platform", {
            kind: "unit",
            class: "policy",
            schema: "app",
            table: "items",
            name: "items_read",
          }),
        ],
      }),
      model([table("catalog_items")], [policy]),
      model([table("catalog_items")]),
      intent({ tables: [["catalog_items", "items"]] })
    )
    expect(removals).toEqual([
      {
        path: "units.policy:app.catalog_items.items_read",
        kind: "missing",
        covered: "platform",
        tables: CATALOG_ITEMS,
      },
    ])
  })

  it("covers a dropped retired column through its temporary name", () => {
    // Бажана таблиця має свій `code`, тож намір відвів вилучений `code` на
    // тимчасове ім'я: на копії він уже `simetra_retired_1`
    const removals = classify(
      record({
        retired: [
          {
            sourceId: ATTRIBUTE_ID,
            schema: "app",
            table: "items",
            column: "code",
          },
        ],
      }),
      model([table("items", { columns: [col("simetra_retired_1")] })]),
      model([table("items", { columns: [col("code")] })]),
      intent({ temp: [["items", "simetra_retired_1", "code"]] })
    )
    expect(removals).toEqual([
      {
        path: "tables.app.items.columns.code",
        kind: "missing",
        covered: "retired",
        tables: ITEMS,
      },
    ])
  })

  it("covers a foreign key dropped with a retired column and one replaced by own delete semantics", () => {
    const fk = (name: string, column: string) => ({
      name,
      columns: [column],
      references: { schema: "app", table: "groups", columns: ["id"] },
      onDelete: "noAction" as const,
      onUpdate: "noAction" as const,
      deferrable: "no" as const,
    })
    const removals = classify(
      record({
        retired: [
          {
            sourceId: ATTRIBUTE_ID,
            schema: "app",
            table: "items",
            column: "old_group",
          },
        ],
        deleteSemantics: [
          {
            direction: "own",
            schema: "app",
            table: "items",
            columns: ["group_id"],
            target: "app.groups",
            from: "noAction",
            to: "cascade",
          },
        ],
      }),
      model([
        table("items", {
          columns: [col("old_group"), col("group_id")],
          foreignKeys: [
            fk("items_group_id_fkey", "group_id"),
            fk("items_old_group_fkey", "old_group"),
          ],
        }),
      ]),
      model([
        table("items", {
          columns: [col("group_id")],
          foreignKeys: [
            { ...fk("items_group_id_fkey", "group_id"), onDelete: "cascade" },
          ],
        }),
      ])
    )
    expect(removals).toEqual([
      {
        path: "tables.app.items.columns.old_group",
        kind: "missing",
        covered: "retired",
        tables: ITEMS,
      },
      {
        path: "tables.app.items.foreignKeys.items_group_id_fkey",
        kind: "changed",
        covered: "deleteSemantics",
        tables: ITEMS,
      },
      {
        path: "tables.app.items.foreignKeys.items_old_group_fkey",
        kind: "missing",
        covered: "retired",
        tables: ITEMS,
      },
    ])
  })

  it("covers a lost default of an attribute column by its class and of a standard column by the mapping", () => {
    const removals = classify(
      record({
        columns: [
          {
            id: ATTRIBUTE_ID,
            sourceId: ATTRIBUTE_ID,
            schema: "app",
            table: "items",
            from: "code",
            to: "code",
          },
          {
            id: `${OBJECT_ID}#Description`,
            sourceId: "00000000-0000-4000-8000-000000000102",
            schema: "app",
            table: "items",
            from: "title",
            to: "description",
          },
        ],
        conversions: [
          conversion("property", {
            kind: "default",
            schema: "app",
            table: "items",
            column: "code",
          }),
        ],
      }),
      model([
        table("items", {
          columns: [
            col("code", { default: "'x'::text" }),
            col("description", { default: "''::text" }),
          ],
        }),
      ]),
      model([table("items", { columns: [col("code"), col("description")] })])
    )
    expect(removals).toEqual([
      {
        path: "tables.app.items.columns.code.default",
        kind: "changed",
        covered: "property",
        tables: ITEMS,
      },
      {
        // Шлях — у старих іменах: `description` був `title`
        path: "tables.app.items.columns.title.default",
        kind: "changed",
        covered: "mapping",
        tables: ITEMS,
      },
    ])
  })

  it("needs a class for a lost default of the scope column", () => {
    // Носій скоупу: id запису — UUID виду скоупу, не синтетичний id
    // стандартного реквізиту, тож мапінг значення не покриває (R21)
    const scopeColumn = {
      id: "00000000-0000-4000-8000-000000000301",
      sourceId: "00000000-0000-4000-8000-000000000302",
      schema: "app",
      table: "items",
      from: "org_ref",
      to: "org_id",
    }
    const clone = model([
      table("items", {
        columns: [
          col("org_id", { type: "uuid", default: "gen_random_uuid()" }),
        ],
      }),
    ])
    const desired = model([
      table("items", { columns: [col("org_id", { type: "uuid" })] }),
    ])
    const without = classify(record({ columns: [scopeColumn] }), clone, desired)
    expect(unclassifiedRemovals(without)[0]?.params).toEqual({
      paths: "tables.app.items.columns.org_ref.default",
    })
    const removed = classify(
      record({
        columns: [scopeColumn],
        conversions: [
          conversion("removed", {
            kind: "default",
            schema: "app",
            table: "items",
            column: "org_ref",
          }),
        ],
      }),
      clone,
      desired
    )
    expect(removed).toEqual([
      {
        path: "tables.app.items.columns.org_ref.default",
        kind: "changed",
        covered: "removed",
        tables: ITEMS,
      },
    ])
    expect(unclassifiedRemovals(removed)).toEqual([])
  })

  it("covers a removed column comment by its class", () => {
    const removals = classify(
      record({
        conversions: [
          conversion("metadata", {
            kind: "comment",
            schema: "app",
            table: "items",
            column: "code",
          }),
        ],
      }),
      model([table("items", { columns: [col("code", { comment: "Code" })] })]),
      model([table("items", { columns: [col("code")] })])
    )
    expect(removals).toEqual([
      {
        path: "tables.app.items.columns.code.comment",
        kind: "changed",
        covered: "metadata",
        tables: ITEMS,
      },
    ])
  })

  it("does not let one grant's class cover another grant on the same table", () => {
    // Грант на колонку несе її ім'я в ключі: на копії `code` уже перейменовано
    // з `old_code`, а запис називає старе ім'я
    const columnGrant = unit(
      "grant",
      "grant:app.catalog_items:authenticated:update",
      "catalog_items",
      "GRANT UPDATE (code) ON TABLE app.catalog_items TO authenticated"
    )
    const readGrant = unit(
      "grant",
      "grant:app.catalog_items:anon:select",
      "catalog_items",
      "GRANT SELECT ON TABLE app.catalog_items TO anon"
    )
    const removals = classify(
      record({
        tables: [
          { id: OBJECT_ID, schema: "app", from: "items", to: "catalog_items" },
        ],
        columns: [
          {
            id: ATTRIBUTE_ID,
            sourceId: ATTRIBUTE_ID,
            schema: "app",
            table: "catalog_items",
            from: "old_code",
            to: "code",
          },
        ],
        conversions: [
          conversion("removed", {
            kind: "unit",
            class: "grant",
            schema: "app",
            table: "items",
            name: "grant:authenticated:update(old_code)",
          }),
        ],
      }),
      model(
        [table("catalog_items", { columns: [col("code")] })],
        [columnGrant, readGrant]
      ),
      model([table("catalog_items", { columns: [col("code")] })]),
      intent({ tables: [["catalog_items", "items"]] })
    )
    expect(removals).toEqual([
      {
        path: "units.grant:app.catalog_items:anon:select",
        kind: "missing",
        covered: null,
        tables: CATALOG_ITEMS,
      },
      {
        path: "units.grant:app.catalog_items:authenticated:update",
        kind: "missing",
        covered: "removed",
        tables: CATALOG_ITEMS,
      },
    ])
    expect(unclassifiedRemovals(removals)).toEqual([
      expect.objectContaining({
        code: "plan.removal-unclassified",
        severity: "error",
        params: { paths: "units.grant:app.catalog_items:anon:select" },
      }),
    ])
  })

  it("compares tables structurally despite dots in names", () => {
    // Таблиця одиниці a."b.c" і стороння "a.b".c: рядковий ключ `a.b.c` їх
    // злив би, і клас обмеження сторонньої покрив би обмеження одиниці
    const check = { name: "k", expression: "CHECK (true)" }
    const unitTable = table("b.c", { checks: [check] }, "a")
    const foreign = table("c", { checks: [check] }, "a.b")
    const removals = classifyRemovals({
      record: record({
        tables: [{ id: OBJECT_ID, schema: "a", from: "b.c", to: "b.c" }],
        conversions: [
          conversion("rowRule", {
            kind: "constraint",
            schema: "a.b",
            table: "c",
            name: "k",
          }),
        ],
      }),
      intent: intent(),
      clone: model([unitTable, foreign]),
      desired: model([
        { ...unitTable, checks: [] },
        { ...foreign, checks: [] },
      ]),
      parse,
    })
    expect(removals).toEqual([
      {
        path: "tables.a.b.c.checks.k",
        kind: "missing",
        covered: null,
        tables: [{ schema: "a", name: "b.c" }],
      },
    ])
  })

  it("tells a lost default, a lost comment and an RLS change apart", () => {
    const removals = classify(
      record({
        rowLevelSecurity: [
          { schema: "app", table: "items", from: "off", to: "enabled" },
        ],
        conversions: [
          conversion("property", {
            kind: "default",
            schema: "app",
            table: "items",
            column: "code",
          }),
        ],
      }),
      model([
        table("items", {
          rowLevelSecurity: "off",
          columns: [col("code", { default: "'x'::text", comment: "Code" })],
        }),
      ]),
      model([table("items", { columns: [col("code")] })])
    )
    expect(removals).toEqual([
      {
        path: "tables.app.items.rowLevelSecurity",
        kind: "changed",
        covered: "rowLevelSecurity",
        tables: ITEMS,
      },
      {
        path: "tables.app.items.columns.code.default",
        kind: "changed",
        covered: "property",
        tables: ITEMS,
      },
      {
        path: "tables.app.items.columns.code.comment",
        kind: "changed",
        covered: null,
        tables: ITEMS,
      },
    ])
  })

  it("refuses a removal that no class covers", () => {
    const index = {
      name: "items_name_idx",
      unique: false,
      method: "btree",
      keys: [{ column: "name" }],
      include: [],
      nullsNotDistinct: false,
    }
    const removals = classify(
      record({}),
      model([table("items", { columns: [col("name")], indexes: [index] })]),
      model([table("items", { columns: [col("name")] })])
    )
    expect(unclassifiedRemovals(removals)).toEqual([
      expect.objectContaining({
        code: "plan.removal-unclassified",
        params: { paths: "tables.app.items.indexes.items_name_idx" },
      }),
    ])
  })

  it("refuses a changed primary key and an identity change", () => {
    const removals = classify(
      record({}),
      model([
        table("items", {
          columns: [
            col("id", {
              type: "bigint",
              notNull: true,
              identity: { generation: "byDefault", sequence: "items_id_seq" },
            }),
          ],
          primaryKey: { name: "items_key", columns: ["id"] },
        }),
      ]),
      model([
        table("items", {
          columns: [col("id", { type: "bigint", notNull: true })],
        }),
      ])
    )
    expect(unclassifiedRemovals(removals)[0]?.params).toEqual({
      paths:
        "tables.app.items.primaryKey, tables.app.items.columns.id.identity",
    })
  })

  it("keeps a same-name redefinition of an adopted index a relaxation", () => {
    // Частковий унікальний індекс став повним під тим самим ім'ям: двигун
    // знімає й створює його знову, але для прийнятого індексу це не заміна
    const full = {
      name: "items_code_idx",
      unique: true,
      method: "btree",
      keys: [{ column: "code" }],
      include: [],
      nullsNotDistinct: false,
    }
    const partial = { ...full, where: "(code IS NOT NULL)" }
    const clone = model([
      table("items", { columns: [col("code")], indexes: [partial] }),
    ])
    const desired = model([
      table("items", { columns: [col("code")], indexes: [full] }),
    ])
    const actions = [
      action("DROP INDEX app.items_code_idx", {
        verb: "drop",
        destroys: ["index:app.items_code_idx"],
        destroyed: [{ kind: "index", schema: "app", name: "items_code_idx" }],
      }),
      action("CREATE UNIQUE INDEX items_code_idx ON app.items (code)", {
        verb: "create",
        produces: ["index:app.items_code_idx"],
      }),
    ]
    const noReplacement = adoptedReplacements(
      actions,
      clone,
      new Set([tableKey("app", "items")]),
      1
    )
    expect([...noReplacement]).toEqual(["s2"])
    expect(
      classifySteps(actions, clone, parse, 1, { noReplacement }).map(
        (s) => s.class
      )
    ).toEqual(["relaxation", "validationScan"])
    // Без промоції той самий план — заміна
    expect(classifySteps(actions, clone, parse, 1)[0]?.class).toBe(
      "catalogOnly"
    )
    // І потребує класу з запису
    expect(
      classify(
        record({
          conversions: [
            conversion("rowRule", {
              kind: "index",
              schema: "app",
              table: "items",
              name: "items_code_idx",
            }),
          ],
        }),
        clone,
        desired
      )
    ).toEqual([
      {
        path: "tables.app.items.indexes.items_code_idx",
        kind: "changed",
        covered: "rowRule",
        tables: ITEMS,
      },
    ])
  })

  it.each([
    [
      "constraint",
      "ALTER TABLE app.items DROP CONSTRAINT items_k",
      "ALTER TABLE app.items ADD CONSTRAINT items_k CHECK (id IS NOT NULL) NOT VALID",
      "constraint:app.items.items_k",
      "items_k",
    ],
    [
      "policy",
      "DROP POLICY items_read ON app.items",
      "CREATE POLICY items_read ON app.items FOR SELECT USING (false)",
      "policy:app.items.items_read",
      "items_read",
    ],
    [
      "trigger",
      "DROP TRIGGER items_audit ON app.items",
      "CREATE TRIGGER items_audit AFTER UPDATE ON app.items FOR EACH ROW EXECUTE FUNCTION app.audit()",
      "trigger:app.items.items_audit",
      "items_audit",
    ],
    [
      "rule",
      "DROP RULE items_rule ON app.items",
      "CREATE RULE items_rule AS ON DELETE TO app.items DO INSTEAD NOTHING",
      "rule:app.items.items_rule",
      "items_rule",
    ],
  ])(
    "keeps a same-name redefinition of an adopted %s a relaxation",
    (kind, drop, create, id, name) => {
      const actions = [
        action(drop, {
          verb: "drop",
          destroys: [id],
          destroyed: [{ kind, schema: "app", table: "items", name }],
        }),
        action(create, { verb: "create", produces: [id] }),
      ]
      const clone = model([
        table("items", {
          checks: [{ name: "items_k", expression: "CHECK (true)" }],
        }),
      ])
      const noReplacement = adoptedReplacements(
        actions,
        clone,
        new Set([tableKey("app", "items")]),
        0
      )
      expect([...noReplacement]).toEqual(["s1"])
      expect(
        classifySteps(actions, clone, parse, 0, { noReplacement })[0]?.class
      ).toBe("relaxation")
      // Без промоції — заміна
      expect(classifySteps(actions, clone, parse, 0)[0]?.class).toBe(
        "catalogOnly"
      )
    }
  )

  it("does not count a constraint the clone does not hold as adopted", () => {
    const actions = [
      action("ALTER TABLE app.items DROP CONSTRAINT gone", {
        destroyed: [
          { kind: "constraint", schema: "app", table: "items", name: "gone" },
        ],
      }),
    ]
    expect(
      adoptedReplacements(
        actions,
        model([table("items")]),
        new Set([tableKey("app", "items")]),
        0
      ).size
    ).toBe(0)
  })

  it("does not count objects of other tables as adopted", () => {
    const actions = [
      action("DROP INDEX app.other_idx", {
        verb: "drop",
        destroyed: [{ kind: "index", schema: "app", name: "other_idx" }],
      }),
      action("ALTER TABLE app.other DROP CONSTRAINT other_k", {
        destroyed: [
          {
            kind: "constraint",
            schema: "app",
            table: "other",
            name: "other_k",
          },
        ],
      }),
    ]
    const clone = model([
      table("items"),
      table("other", {
        checks: [{ name: "other_k", expression: "CHECK (true)" }],
        indexes: [
          {
            name: "other_idx",
            unique: true,
            method: "btree",
            keys: [{ column: "id" }],
            include: [],
            nullsNotDistinct: false,
          },
        ],
      }),
    ])
    expect(
      adoptedReplacements(
        actions,
        clone,
        new Set([tableKey("app", "items")]),
        0
      ).size
    ).toBe(0)
  })
})

describe("unrealizedRenames", () => {
  const renamed = record({
    tables: [
      { id: OBJECT_ID, schema: "app", from: "items", to: "catalog_items" },
    ],
    columns: [
      {
        id: ATTRIBUTE_ID,
        sourceId: ATTRIBUTE_ID,
        schema: "app",
        table: "catalog_items",
        from: "old_code",
        to: "code",
      },
    ],
  })
  const renames = intent({ tables: [["catalog_items", "items"]] })

  it("refuses an engine drop of a renamed column", () => {
    const steps = [
      step("s3", "ALTER TABLE app.catalog_items DROP COLUMN code", {
        destroys: ["column:app.catalog_items.code"],
        destroyed: [
          {
            kind: "column",
            schema: "app",
            table: "catalog_items",
            name: "code",
          },
        ],
      }),
    ]
    expect(unrealizedRenames(steps, renames, renamed)).toEqual([
      expect.objectContaining({
        code: "plan.rename-not-realized",
        severity: "error",
        params: { objects: "app.catalog_items.code" },
      }),
    ])
  })

  it("refuses an engine drop of a renamed table", () => {
    const steps = [
      step("s3", "DROP TABLE app.catalog_items", {
        verb: "drop",
        destroys: ["table:app.catalog_items"],
        destroyed: [{ kind: "table", schema: "app", name: "catalog_items" }],
      }),
    ]
    expect(unrealizedRenames(steps, renames, renamed)[0]?.params).toEqual({
      objects: "app.catalog_items",
    })
  })

  it("refuses data loss on a renamed column", () => {
    const lossy = step(
      "s3",
      "ALTER TABLE app.catalog_items ALTER COLUMN code TYPE integer",
      {
        consumed: [
          {
            kind: "column",
            schema: "app",
            table: "catalog_items",
            name: "code",
          },
        ],
        dataLoss: true,
      }
    )
    expect(unrealizedRenames([lossy], renames, renamed)[0]?.params).toEqual({
      objects: "app.catalog_items.code",
    })
    // Рядкова форма двигуна в T2 не розбирається: лише структурне `consumed`
    expect(
      unrealizedRenames(
        [
          {
            ...lossy,
            consumes: ["column:app.catalog_items.code"],
            consumed: [],
          },
        ],
        renames,
        renamed
      )
    ).toEqual([])
    // Без `dataLoss` той самий крок — звичайна зміна, не нереалізоване
    // оголошення
    expect(
      unrealizedRenames([{ ...lossy, dataLoss: false }], renames, renamed)
    ).toEqual([])
  })

  it("accepts the drop of a retired column and steps of the intent", () => {
    const steps = [
      step("s1", "ALTER TABLE app.items RENAME TO catalog_items", {
        origin: "intent",
        dataLoss: false,
      }),
      step(
        "s4",
        "ALTER TABLE app.catalog_items DROP COLUMN simetra_retired_1",
        {
          destroyed: [
            {
              kind: "column",
              schema: "app",
              table: "catalog_items",
              name: "simetra_retired_1",
            },
          ],
          // Адаптер називає вжитим саму таблицю: втрату даних несе знята
          // вилучена колонка, а не перейменована таблиця
          consumed: [{ kind: "table", schema: "app", name: "catalog_items" }],
          dataLoss: true,
        }
      ),
    ]
    expect(unrealizedRenames(steps, renames, renamed)).toEqual([])
  })

  it("refuses data loss on a renamed table that no dropped column explains", () => {
    const lossy = step("s4", "TRUNCATE app.catalog_items", {
      consumed: [{ kind: "table", schema: "app", name: "catalog_items" }],
      dataLoss: true,
    })
    expect(unrealizedRenames([lossy], renames, renamed)[0]?.params).toEqual({
      objects: "app.catalog_items",
    })
  })
})

describe("stepConversions", () => {
  it("shows the class of the object a step removes, in old names", () => {
    const rec = record({
      tables: [
        { id: OBJECT_ID, schema: "app", from: "items", to: "catalog_items" },
      ],
      columns: [
        {
          id: ATTRIBUTE_ID,
          sourceId: ATTRIBUTE_ID,
          schema: "app",
          table: "catalog_items",
          from: "old_code",
          to: "code",
        },
      ],
      conversions: [
        conversion("rowRule", constraint("items_code_key")),
        conversion("platform", {
          kind: "unit",
          class: "grant",
          schema: "app",
          table: "items",
          name: "grant:authenticated:update(old_code)",
        }),
        conversion("property", {
          kind: "default",
          schema: "app",
          table: "items",
          column: "old_code",
        }),
      ],
    })
    const steps = [
      step(
        "s2",
        "ALTER TABLE app.catalog_items DROP CONSTRAINT simetra_tmp_1",
        {
          destroyed: [
            {
              kind: "constraint",
              schema: "app",
              table: "catalog_items",
              name: "simetra_tmp_1",
            },
          ],
        }
      ),
      step(
        "s3",
        "REVOKE UPDATE (code) ON TABLE app.catalog_items FROM authenticated"
      ),
      step(
        "s4",
        "ALTER TABLE app.catalog_items ALTER COLUMN code DROP DEFAULT"
      ),
      step("s5", "ALTER TABLE app.catalog_items ADD COLUMN extra text"),
    ]
    const shown = stepConversions(
      steps,
      rec,
      intent({
        tables: [["catalog_items", "items"]],
        temp: [["catalog_items", "simetra_tmp_1", "items_code_key"]],
      }),
      parse
    )
    expect([...shown]).toEqual([
      ["s2", "rowRule"],
      ["s3", "platform"],
      ["s4", "property"],
    ])
  })

  it("never reaches a step whose object has no class: the plan refuses first", () => {
    const index = {
      name: "items_name_idx",
      unique: false,
      method: "btree",
      keys: [{ column: "name" }],
      include: [],
      nullsNotDistinct: false,
    }
    const rec = record({})
    const removals = classify(
      rec,
      model([table("items", { columns: [col("name")], indexes: [index] })]),
      model([table("items", { columns: [col("name")] })])
    )
    // Відмова — раніше за показ класу; сам показ для такого кроку порожній
    expect(unclassifiedRemovals(removals)).toHaveLength(1)
    const drop = step("s1", "DROP INDEX app.items_name_idx", {
      destroyed: [{ kind: "index", schema: "app", name: "items_name_idx" }],
    })
    expect(stepConversions([drop], rec, intent(), parse).size).toBe(0)
  })
})

describe("access and permission items", () => {
  const access = (
    rec: PromotionRecord,
    clone: CatalogModel,
    desired: CatalogModel,
    dependents: Map<string, string[]> = new Map(),
    i: RenameIntent = intent()
  ) =>
    accessChanges({ record: rec, intent: i, clone, desired, dependents, parse })

  it("lists an access change for RLS off → enabled and a dropped read policy", () => {
    const read = unit(
      "policy",
      "policy:app.catalog_items.items_read",
      "items_read",
      "CREATE POLICY items_read ON app.catalog_items FOR SELECT USING (true)"
    )
    // Політика іншої таблиці лишається: зміна доступу — лише таблиці одиниці
    const other = unit(
      "policy",
      "policy:app.debts.debts_read",
      "debts_read",
      "CREATE POLICY debts_read ON app.debts FOR SELECT USING (true)"
    )
    const changes = access(
      record({
        tables: [
          { id: OBJECT_ID, schema: "app", from: "items", to: "catalog_items" },
        ],
        rowLevelSecurity: [
          { schema: "app", table: "items", from: "off", to: "enabled" },
        ],
      }),
      model(
        [table("catalog_items", { rowLevelSecurity: "off" }), table("debts")],
        [read, other]
      ),
      model([table("catalog_items"), table("debts")], [other]),
      // Залежні прочитано з цілі, де таблиця ще має старе ім'я
      new Map([
        [
          tableKey("app", "items"),
          ["policy app.debts.debts_read", "view app.items_view"],
        ],
      ]),
      intent({ tables: [["catalog_items", "items"]] })
    )
    expect(changes).toEqual([
      {
        table: { schema: "app", name: "catalog_items" },
        rowLevelSecurity: { from: "off", to: "enabled" },
        policies: ["missing policy:app.catalog_items.items_read"],
        grants: [],
        dependents: ["policy app.debts.debts_read", "view app.items_view"],
      },
    ])
    expect(promotionPermissionItems(changes, [], [])).toEqual([
      {
        token: "access:app.catalog_items",
        summary: [
          "rowLevelSecurity off → enabled",
          "missing policy:app.catalog_items.items_read",
          "dependent policy app.debts.debts_read",
          "dependent view app.items_view",
        ],
      },
    ])
  })

  it("lists an access change for a changed grant", () => {
    const grant = (role: string, sql: string) =>
      unit("grant", `grant:app.items:${role}:select`, "items", sql)
    const changes = access(
      record({}),
      model(
        [table("items")],
        [grant("anon", "GRANT SELECT ON TABLE app.items TO anon")]
      ),
      model(
        [table("items")],
        [
          grant("anon", "GRANT SELECT (id) ON TABLE app.items TO anon"),
          grant(
            "authenticated",
            "GRANT SELECT ON TABLE app.items TO authenticated"
          ),
        ]
      )
    )
    expect(changes).toEqual([
      {
        table: { schema: "app", name: "items" },
        policies: [],
        grants: [
          "changed grant:app.items:anon:select",
          "extra grant:app.items:authenticated:select",
        ],
        dependents: [],
      },
    ])
    expect(
      promotionPermissionItems(changes, [], []).map((i) => i.token)
    ).toEqual(["access:app.items"])
    // Той самий доступ — жодної зміни й жодного пункту
    const same = model(
      [table("items")],
      [grant("anon", "GRANT SELECT ON TABLE app.items TO anon")]
    )
    expect(access(record({}), same, same)).toEqual([])
  })

  it("emits delete tokens for own and incoming delete semantics", () => {
    const items = promotionPermissionItems(
      [],
      [
        {
          direction: "incoming",
          schema: "app",
          table: "orders.v2",
          constraint: "orders_item_fkey",
          columns: ["item_id"],
          target: "items",
          from: "cascade",
          to: "cascade",
        },
        {
          direction: "own",
          schema: "app",
          table: "items",
          constraint: "items_group_fkey",
          columns: ["group_id"],
          target: "groups",
          from: "none",
          to: "restrict",
        },
      ],
      []
    )
    // Порядок — за кодовими одиницями токена: `"` іде перед літерами
    expect(items).toEqual([
      {
        // Ім'я з крапкою кваліфіковано `quoteIdent`: токен однозначний
        token: 'delete:app."orders.v2".orders_item_fkey',
        summary: ["incoming (item_id) → items: on delete cascade → cascade"],
      },
      {
        token: "delete:app.items.items_group_fkey",
        summary: ["own (group_id) → groups: on delete none → restrict"],
      },
    ])
  })

  it("requires remove: for objects classed removed", () => {
    const index = {
      name: "items_name_idx",
      unique: false,
      method: "btree",
      keys: [{ column: "name" }],
      include: [],
      nullsNotDistinct: false,
    }
    const clone = model([
      table("items", { columns: [col("name")], indexes: [index] }),
    ])
    const desired = model([table("items", { columns: [col("name")] })])
    const removals = classify(
      record({
        conversions: [
          conversion("removed", {
            kind: "index",
            schema: "app",
            table: "items",
            name: "items_name_idx",
          }),
        ],
      }),
      clone,
      desired
    )
    expect(unclassifiedRemovals(removals)).toEqual([])
    // Неунікальний індекс знімається кроком `catalogOnly`: дозволу просить
    // лише пункт `remove:`
    const steps = classifySteps(
      [
        action("DROP INDEX app.items_name_idx", {
          verb: "drop",
          destroys: ["index:app.items_name_idx"],
          destroyed: [{ kind: "index", schema: "app", name: "items_name_idx" }],
        }),
      ],
      clone,
      parse
    )
    expect(steps.map((s) => s.class)).toEqual(["catalogOnly"])
    const permissionItems = promotionPermissionItems([], [], removals)
    expect(permissionItems).toEqual([
      {
        token: "remove:app.items",
        summary: ["tables.app.items.indexes.items_name_idx"],
      },
    ])
    const subject = { steps, drift: null, promotion: { permissionItems } }
    expect(checkPermissions(subject, [])).toEqual([
      expect.objectContaining({
        code: "apply.permission-required",
        params: { items: "remove:app.items" },
      }),
    ])
    expect(checkPermissions(subject, ["remove:app.items"])).toEqual([])
  })

  it("requires remove: for a lost scope column default classed removed", () => {
    // DEFAULT носія скоупу має лише клас «видалено» (R21); крок DROP DEFAULT
    // — `catalogOnly`, тож дозвіл дає тільки `remove:` нового імені таблиці
    const clone = model([
      table("catalog_items", {
        columns: [
          col("org_id", { type: "uuid", default: "gen_random_uuid()" }),
        ],
      }),
    ])
    const removals = classify(
      record({
        tables: [
          { id: OBJECT_ID, schema: "app", from: "items", to: "catalog_items" },
        ],
        columns: [
          {
            id: "00000000-0000-4000-8000-000000000301",
            sourceId: "00000000-0000-4000-8000-000000000302",
            schema: "app",
            table: "catalog_items",
            from: "org_ref",
            to: "org_id",
          },
        ],
        conversions: [
          conversion("removed", {
            kind: "default",
            schema: "app",
            table: "items",
            column: "org_ref",
          }),
        ],
      }),
      clone,
      model([
        table("catalog_items", { columns: [col("org_id", { type: "uuid" })] }),
      ]),
      intent({ tables: [["catalog_items", "items"]] })
    )
    const steps = classifySteps(
      [
        action(
          "ALTER TABLE app.catalog_items ALTER COLUMN org_id DROP DEFAULT"
        ),
      ],
      clone,
      parse
    )
    expect(steps.map((s) => s.class)).toEqual(["catalogOnly"])
    expect(promotionPermissionItems([], [], removals)).toEqual([
      {
        token: "remove:app.catalog_items",
        summary: ["tables.app.items.columns.org_ref.default"],
      },
    ])
  })

  it("lets a removed key of a multi-target unit require remove: for its table only", () => {
    // Грант на основну таблицю й таблицю ТЧ: ключ основної має клас
    // metadata, ключ ТЧ — removed. Зняття гранту на ТЧ без `remove:`
    // пройшло б, тож одиниця покрита класом removed лише для таблиці ТЧ
    const grant = unit(
      "grant",
      "grant:app.items,app.items_lines:anon:select",
      "items",
      "GRANT SELECT ON TABLE app.items, app.items_lines TO anon"
    )
    const key = (t: string): PromotionObject => ({
      kind: "unit",
      class: "grant",
      schema: "app",
      table: t,
      name: "grant:anon:select",
    })
    const tables = [table("items"), table("items_lines")]
    const removals = classify(
      record({
        tables: [
          { id: OBJECT_ID, schema: "app", from: "items", to: "items" },
          {
            id: "00000000-0000-4000-8000-000000000002",
            schema: "app",
            from: "items_lines",
            to: "items_lines",
          },
        ],
        conversions: [
          conversion("metadata", key("items")),
          conversion("removed", key("items_lines")),
        ],
      }),
      model(tables, [grant]),
      model(tables)
    )
    expect(removals).toEqual([
      {
        path: "units.grant:app.items,app.items_lines:anon:select",
        kind: "missing",
        covered: "removed",
        tables: [{ schema: "app", name: "items_lines" }],
      },
    ])
    const permissionItems = promotionPermissionItems([], [], removals)
    expect(permissionItems.map((i) => i.token)).toEqual([
      "remove:app.items_lines",
    ])
    const subject = { steps: [], drift: null, promotion: { permissionItems } }
    expect(requiredPermissions(subject)).toEqual(["remove:app.items_lines"])
    expect(checkPermissions(subject, [])).toEqual([
      expect.objectContaining({
        code: "apply.permission-required",
        params: { items: "remove:app.items_lines" },
      }),
    ])
    expect(checkPermissions(subject, ["remove:app.items_lines"])).toEqual([])
  })

  it("gives no remove: for removals covered by other classes", () => {
    const removals = classify(
      record({
        conversions: [conversion("rowRule", constraint("items_k"))],
      }),
      model([
        table("items", {
          checks: [{ name: "items_k", expression: "CHECK (true)" }],
        }),
      ]),
      model([table("items")])
    )
    expect(removals.map((r) => r.covered)).toEqual(["rowRule"])
    expect(promotionPermissionItems([], [], removals)).toEqual([])
  })
})
