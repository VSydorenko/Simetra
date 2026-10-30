import { beforeAll, describe, expect, it } from "vitest"
import {
  applyChanges,
  carrierFunctionNames,
  carrierTriggerNames,
  compile,
  type CompiledModel,
  loadSqlParser,
  mechanicsTriggerName,
  promoteObject,
  rightsGuardNames,
  type PromotionObject,
  type PromotionRecord,
  type SqlParser,
  unitSubjectKeys,
} from "simetra/compiler"
import { catalogFromSnapshot } from "simetra/model"
import type {
  CatalogColumn,
  CatalogModel,
  CatalogTable,
  CatalogUnit,
  PhysicalColumn,
  PhysicalTable,
} from "simetra/model"
import {
  accessChanges,
  adoptedReplacements,
  checkPermissions,
  classifyRemovals,
  classifySteps,
  platformReplacements,
  propertyReproductions,
  promotionPermissionItems,
  requiredPermissions,
  stepConversions,
  tableKey,
  unclassifiedRemovals,
  unrealizedRenames,
  updateOfNarrowings,
  valueElementColumns,
  type EngineAction,
  type EquivalenceObject,
  type PlanStep,
  type RenameIntent,
} from "simetra/schema"
import { uuid } from "../../../compiler/__tests__/helpers"
import {
  policyDomain,
  promotableTag,
  tagMapping,
  writeRoles,
} from "../../../compiler/__tests__/fixtures/rights"
import { enumerations } from "../../__tests__/fixtures/e1-fixtures"

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
    produced: [],
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
    produced: [],
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

  it("leaves out a column the intent adds for a data step", () => {
    // Колонку цілі кроку даних додав сам намір без NOT NULL і DEFAULT:
    // їх ставить двигун, і це не перевизначення прийнятої колонки
    const fill = {
      names: "beforeRenames" as const,
      schema: "app",
      table: "items",
      key: "id",
      column: "deletion_mark",
      expression: "coalesce(inactive, false)",
      kind: "conversion" as const,
    }
    const clone = model([
      table("items", {
        columns: [
          col("id", { type: "uuid", notNull: true }),
          col("deletion_mark", { type: "boolean" }),
        ],
      }),
    ])
    const desired = model([
      table("items", {
        columns: [
          col("id", { type: "uuid", notNull: true }),
          col("deletion_mark", {
            type: "boolean",
            notNull: true,
            default: "false",
          }),
        ],
      }),
    ])
    expect(classify(record({ dataSteps: [fill] }), clone, desired)).toEqual([])
    // Без кроку даних та сама колонка — прийнята, і її зміна без класу
    expect(
      unclassifiedRemovals(classify(record({}), clone, desired))
    ).not.toEqual([])
  })

  it("still classifies an adopted column outside the intent's added columns", () => {
    // Вердикт В8: пропуск — лише для колонок, які додав намір; перевизначення
    // прийнятої колонки поруч лишається видаленням без класу
    const fill = {
      names: "beforeRenames" as const,
      schema: "app",
      table: "items",
      key: "id",
      column: "deletion_mark",
      expression: "coalesce(inactive, false)",
      kind: "conversion" as const,
    }
    const columns = (notNull: boolean) => [
      col("id", { type: "uuid", notNull: true }),
      col("code", { notNull }),
      col("deletion_mark", { type: "boolean", notNull }),
    ]
    const removals = classify(
      record({ dataSteps: [fill] }),
      model([table("items", { columns: columns(false) })]),
      model([table("items", { columns: columns(true) })])
    )
    expect(removals.map((r) => [r.path, r.covered])).toEqual([
      ["tables.app.items.columns.code.notNull", null],
    ])
    expect(unclassifiedRemovals(removals)).not.toEqual([])
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
            event: "delete",
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

  // R24: дослівно перенесений коментар таблиці покриває лише клас `metadata`
  // на саме цей об'єкт, а не мапінг
  it("covers a table comment only by a class on that comment", () => {
    const clone = model([table("items", { comment: "Items" })])
    const desired = model([table("items")])
    const comment = { kind: "comment" as const, schema: "app", table: "items" }
    expect(
      classify(
        record({ conversions: [conversion("metadata", comment)] }),
        clone,
        desired
      )
    ).toEqual([
      {
        path: "tables.app.items.comment",
        kind: "changed",
        covered: "metadata",
        tables: ITEMS,
      },
    ])
    const uncovered = classify(record({}), clone, desired)
    expect(uncovered.map((r) => r.covered)).toEqual([null])
    expect(unclassifiedRemovals(uncovered)[0]?.params).toEqual({
      paths: "tables.app.items.comment",
    })
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

  it("does not see an environment step", () => {
    // Рішення 5 плану П3-2b-0: крок середовища — лише права об'єкта, який
    // створює сам план; втратою перейменування він не буває
    const environment = step("s5", "DROP TABLE app.catalog_items", {
      origin: "environment",
      destroyed: [{ kind: "table", schema: "app", name: "catalog_items" }],
      consumed: [{ kind: "table", schema: "app", name: "catalog_items" }],
      dataLoss: true,
    })
    expect(unrealizedRenames([environment], renames, renamed)).toEqual([])
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

  it("does not show a class next to an environment step", () => {
    const rec = record({
      conversions: [
        conversion("platform", {
          kind: "unit",
          class: "grant",
          schema: "app",
          table: "items",
          name: "grant:authenticated:update(old_code)",
        }),
      ],
    })
    const revoke = step(
      "s3",
      "REVOKE UPDATE (old_code) ON TABLE app.items FROM authenticated"
    )
    // Той самий оператор кроком двигуна клас має, кроком середовища — ні
    expect([...stepConversions([revoke], rec, intent(), parse)]).toEqual([
      ["s3", "platform"],
    ])
    expect(
      stepConversions(
        [{ ...revoke, origin: "environment" }],
        rec,
        intent(),
        parse
      ).size
    ).toBe(0)
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
    i: RenameIntent = intent(),
    serviceAccess: Map<string, string[]> = new Map()
  ) =>
    accessChanges({
      record: rec,
      intent: i,
      clone,
      desired,
      dependents,
      serviceAccess,
      provider: "supabase",
      parse,
    })

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
    expect(promotionPermissionItems(changes, [], [], [])).toEqual([
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
      promotionPermissionItems(changes, [], [], []).map((i) => i.token)
    ).toEqual(["access:app.items"])
    // Той самий доступ — жодної зміни й жодного пункту
    const same = model(
      [table("items")],
      [grant("anon", "GRANT SELECT ON TABLE app.items TO anon")]
    )
    expect(access(record({}), same, same)).toEqual([])
  })

  it("marks a generated policy that opens roles no adopted policy of its command had", () => {
    const policy = (name: string, sql: string) =>
      unit("policy", `policy:app.items.${name}`, name, sql)
    const changes = access(
      record({}),
      model(
        [table("items")],
        [
          policy(
            "items_select",
            "CREATE POLICY items_select ON app.items FOR SELECT TO authenticated USING (true)"
          ),
          // Інша команда ролі не покриває: `anon` тут пише, а не читає
          policy(
            "items_insert",
            "CREATE POLICY items_insert ON app.items FOR INSERT TO anon WITH CHECK (true)"
          ),
        ]
      ),
      model(
        [table("items")],
        [
          policy(
            "items_read",
            "CREATE POLICY items_read ON app.items AS PERMISSIVE FOR SELECT TO authenticated USING (true)"
          ),
          policy(
            "items_public_read",
            "CREATE POLICY items_public_read ON app.items AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true)"
          ),
        ]
      )
    )
    expect(changes.map((c) => c.policies)).toEqual([
      [
        "missing policy:app.items.items_insert",
        "extra policy:app.items.items_public_read adds roles anon",
        "extra policy:app.items.items_read",
        "missing policy:app.items.items_select",
      ],
    ])
  })

  describe("write rights policies of the command role", () => {
    // Компіляція «до» й промоція — у `beforeAll`: разом з компіляцією «після»
    // це три повні компіляції домену політик, які в одному `it` під
    // паралельним `pnpm test` упирались у таймаут.
    const files = policyDomain(writeRoles(), promotableTag())
    let before: CompiledModel
    let result: Awaited<ReturnType<typeof promoteObject>>
    beforeAll(async () => {
      before = (await compile(files)).model!
      let n = 950_000
      result = await promoteObject(files, tagMapping(), {
        schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
        newId: () => uuid(++n),
      })
    })

    it("are listed under access", async () => {
      // Р2b1-12: політики запису ролі команд, яких прийнята таблиця не мала, —
      // `extra … adds roles simetra_command` у пункті `access:<таблиця>`; код
      // `addedRoles` не змінено, тест фіксує поведінку над справжнім виходом
      expect(result.diagnostics).toEqual([])
      const after = (await compile(applyChanges(files, result.changes))).model!
      const catalogOf = (m: CompiledModel): CatalogModel => ({
        tables: catalogFromSnapshot(m.physical).tables,
        enumTypes: [],
        units: m.sqlUnits.map((u) => ({
          class: u.class,
          identity: u.identity,
          schema: u.schema,
          name: u.name,
          sql: u.sql,
        })),
      })
      const changes = access(
        result.record!,
        catalogOf(before),
        catalogOf(after)
      )
      expect(changes.map((c) => `${c.table.schema}.${c.table.name}`)).toEqual([
        "public.tag",
      ])
      expect(changes[0]!.policies).toContain(
        "extra policy:public.tag.tag_update_root_any adds roles simetra_command"
      )
    })
  })

  it("counts an adopted policy for public as the user role", () => {
    const policy = (name: string, sql: string) =>
      unit("policy", `policy:app.items.${name}`, name, sql)
    const changes = access(
      record({}),
      model(
        [table("items")],
        [
          policy(
            "items_all",
            "CREATE POLICY items_all ON app.items FOR SELECT USING (true)"
          ),
        ]
      ),
      model(
        [table("items")],
        [
          policy(
            "items_public_read",
            "CREATE POLICY items_public_read ON app.items AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true)"
          ),
        ]
      )
    )
    expect(changes.map((c) => c.policies)).toEqual([
      [
        "missing policy:app.items.items_all",
        "extra policy:app.items.items_public_read adds roles anon",
      ],
    ])
  })

  it("marks a changed policy of the same identity that opens a role", () => {
    const policy = (sql: string) =>
      unit(
        "policy",
        "policy:app.items.items_public_read",
        "items_public_read",
        sql
      )
    const changes = access(
      record({}),
      model(
        [table("items")],
        [
          policy(
            "CREATE POLICY items_public_read ON app.items FOR SELECT TO authenticated USING (true)"
          ),
        ]
      ),
      model(
        [table("items")],
        [
          policy(
            "CREATE POLICY items_public_read ON app.items AS PERMISSIVE FOR SELECT TO anon, authenticated USING (true)"
          ),
        ]
      )
    )
    expect(changes.map((c) => c.policies)).toEqual([
      ["changed policy:app.items.items_public_read adds roles anon"],
    ])
  })

  it("does not count an adopted restrictive policy as access a role had", () => {
    const policy = (name: string, sql: string) =>
      unit("policy", `policy:app.items.${name}`, name, sql)
    const changes = access(
      record({}),
      model(
        [table("items")],
        [
          // Обмежувальна політика лише звужує доступ: `anon` читання не мав
          policy(
            "items_guard",
            "CREATE POLICY items_guard ON app.items AS RESTRICTIVE FOR SELECT TO anon USING (true)"
          ),
        ]
      ),
      model(
        [table("items")],
        [
          policy(
            "items_public_read",
            "CREATE POLICY items_public_read ON app.items AS PERMISSIVE FOR SELECT TO anon USING (true)"
          ),
        ]
      )
    )
    expect(changes.map((c) => c.policies)).toEqual([
      [
        "missing policy:app.items.items_guard",
        "extra policy:app.items.items_public_read adds roles anon",
      ],
    ])
  })

  it("a restrictive generated policy opens no roles", () => {
    // Межа тенанта лише звужує доступ (Р2a2-12): прийнятої політики `INSERT`
    // немає, але нова `RESTRICTIVE` ролі `authenticated` нічого не відкриває
    const changes = access(
      record({}),
      model([table("items")]),
      model(
        [table("items")],
        [
          unit(
            "policy",
            "policy:app.items.items_scope_insert",
            "items_scope_insert",
            "CREATE POLICY items_scope_insert ON app.items AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (org_id = ANY (ARRAY(SELECT app.my_orgs())))"
          ),
        ]
      )
    )
    expect(changes.map((c) => c.policies)).toEqual([
      ["extra policy:app.items.items_scope_insert"],
    ])
  })

  it("lists a table that only loses the service role access, read under the old name", () => {
    const same = model([table("catalog_items")])
    const changes = access(
      record({
        tables: [
          { id: OBJECT_ID, schema: "app", from: "items", to: "catalog_items" },
        ],
      }),
      same,
      same,
      new Map(),
      intent({ tables: [["catalog_items", "items"]] }),
      new Map([[tableKey("app", "items"), ["SELECT", "REFERENCES"]]])
    )
    expect(changes).toEqual([
      {
        table: { schema: "app", name: "catalog_items" },
        policies: [],
        grants: [],
        serviceRole: {
          role: "service_role",
          privileges: ["SELECT", "REFERENCES"],
        },
        dependents: [],
      },
    ])
    expect(promotionPermissionItems(changes, [], [], [])).toEqual([
      {
        token: "access:app.catalog_items",
        summary: [
          "service role service_role loses SELECT, REFERENCES: server code on the service key loses access; the server reaches kind data through platform commands (P4)",
        ],
      },
    ])
  })

  it("emits delete and update tokens for own and incoming semantics", () => {
    const incoming = {
      direction: "incoming" as const,
      schema: "app",
      table: "orders.v2",
      constraint: "orders_item_fkey",
      columns: ["item_id"],
      target: "items",
      from: "cascade",
      to: "restrict",
    }
    const permissionItems = promotionPermissionItems(
      [],
      [
        { ...incoming, event: "update" },
        { ...incoming, event: "delete" },
        {
          direction: "own",
          event: "delete",
          schema: "app",
          table: "items",
          constraint: "items_group_fkey",
          columns: ["group_id"],
          target: "groups",
          from: "none",
          to: "restrict",
        },
      ],
      [],
      []
    )
    // Порядок — група (`delete:` перед `update:`), далі кодові одиниці
    // токена: `"` іде перед літерами
    expect(permissionItems).toEqual([
      {
        // Ім'я з крапкою кваліфіковано `quoteIdent`: токен однозначний
        token: 'delete:app."orders.v2".orders_item_fkey',
        summary: [
          "incoming (item_id) → items: on delete cascade → restrict: deleting a row of the promoted object that has child rows is refused",
        ],
      },
      {
        token: "delete:app.items.items_group_fkey",
        summary: ["own (group_id) → groups: on delete none → restrict"],
      },
      {
        token: 'update:app."orders.v2".orders_item_fkey',
        summary: [
          "incoming (item_id) → items: on update cascade → restrict: changing the referenced key of a row of the promoted object that has child rows is refused",
        ],
      },
    ])
    // Дозвіл на `delete:` того самого FK не покриває зміну `ON UPDATE`
    const subject = { steps: [], drift: null, promotion: { permissionItems } }
    const deletes = [
      'delete:app."orders.v2".orders_item_fkey',
      "delete:app.items.items_group_fkey",
    ]
    expect(checkPermissions(subject, deletes)).toEqual([
      expect.objectContaining({
        code: "apply.permission-required",
        params: { items: 'update:app."orders.v2".orders_item_fkey' },
      }),
    ])
    expect(
      checkPermissions(subject, [
        ...deletes,
        'update:app."orders.v2".orders_item_fkey',
      ])
    ).toEqual([])
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
    const permissionItems = promotionPermissionItems([], [], removals, [])
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
    expect(promotionPermissionItems([], [], removals, [])).toEqual([
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
    const permissionItems = promotionPermissionItems([], [], removals, [])
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
    expect(promotionPermissionItems([], [], removals, [])).toEqual([])
  })
})

describe("platformReplacements", () => {
  // Таблиця одиниці перейменовується: копія після наміру й тінь бачать нове
  // ім'я, а запис — старе (рішення 7 плану П3-2b-0, R9)
  const RENAMED = {
    tables: [{ id: OBJECT_ID, schema: "app", from: "items", to: "item" }],
  }

  const eq = (
    kind: EquivalenceObject["kind"],
    name: string,
    parts: unknown[],
    t = "item"
  ): EquivalenceObject => ({
    kind,
    schema: "app",
    table: t,
    name,
    key: JSON.stringify(parts),
    valid: true,
  })
  const index = (name: string, keys: string[], t = "item") =>
    eq("index", name, ["btree", false, false, keys.length, keys], t)
  const fk = (name: string, def: string) => eq("constraint", name, ["f", def])
  const check = (name: string, def: string) =>
    eq("constraint", name, ["c", def])
  const indexObject = (name: string): PromotionObject => ({
    kind: "index",
    schema: "app",
    table: "items",
    name,
  })

  function gate(
    over: Partial<PromotionRecord>,
    clone: EquivalenceObject[],
    shadow: EquivalenceObject[],
    o: {
      units?: CatalogUnit[]
      cloneUnits?: CatalogUnit[]
      labels?: { schema: string; table: string; column: string }[]
    } = {}
  ) {
    return platformReplacements({
      record: record({ ...RENAMED, ...over }),
      cloneEquivalence: clone,
      shadowEquivalence: shadow,
      desired: model([table("item")], o.units ?? []),
      clone: model([table("item")], o.cloneUnits ?? []),
      valueElementColumns: o.labels ?? [],
      provider: "supabase",
      // Бажані таблиці без копій носіїв: умов змісту немає
      physical: { tables: [] },
      attributeCase: "snake_case",
      parse,
    })
  }

  const refusedObjects = (out: ReturnType<typeof gate>) =>
    out.map((d) => [d.code, d.severity, d.params?.objects])

  describe("equivalent element (§9.2: indexes on FK, register keys, the rest)", () => {
    it("refuses an adopted index the shadow does not reproduce", () => {
      const out = gate(
        {
          conversions: [conversion("platform", indexObject("items_code_idx"))],
        },
        [index("items_code_idx", ["code"])],
        [index("item_title_idx", ["title"])]
      )
      expect(refusedObjects(out)).toEqual([
        [
          "plan.platform-replacement-missing",
          "error",
          "subject-platform (index app.items.items_code_idx)",
        ],
      ])
    })

    it("passes when the shadow has an equivalent index on the same table", () => {
      const out = gate(
        {
          conversions: [conversion("platform", indexObject("items_code_idx"))],
        },
        [index("items_code_idx", ["code"])],
        [index("item_code_idx", ["code"])]
      )
      expect(out).toEqual([])
    })

    it("refuses an equivalent index that sits on another table", () => {
      const out = gate(
        {
          conversions: [conversion("platform", indexObject("items_code_idx"))],
        },
        [index("items_code_idx", ["code"])],
        [index("other_code_idx", ["code"], "other")]
      )
      expect(out.map((d) => d.code)).toEqual([
        "plan.platform-replacement-missing",
      ])
    })

    it("refuses a register key until registers exist", () => {
      // Ключ запису регістра чи зв'язку M:N: еквівалентного ключа вид поки не
      // дає, тож це відома відмова, а не тихе зникнення
      const key = eq("constraint", "items_a_b_key", ["u", "UNIQUE (a, b)"])
      const out = gate(
        { conversions: [conversion("platform", constraint("items_a_b_key"))] },
        [key],
        []
      )
      expect(out.map((d) => d.code)).toEqual([
        "plan.platform-replacement-missing",
      ])
    })

    it("does not check the same object with the class removed", () => {
      const out = gate(
        { conversions: [conversion("removed", indexObject("items_code_idx"))] },
        [index("items_code_idx", ["code"])],
        []
      )
      expect(out).toEqual([])
    })

    it("names every object without a replacement in one diagnostic", () => {
      const out = gate(
        {
          conversions: [
            conversion(
              "platform",
              indexObject("items_code_idx"),
              indexObject("items_title_idx")
            ),
          ],
        },
        [
          index("items_code_idx", ["code"]),
          index("items_title_idx", ["title"]),
        ],
        [index("item_code_idx", ["code"])]
      )
      expect(refusedObjects(out)).toEqual([
        [
          "plan.platform-replacement-missing",
          "error",
          "subject-platform (index app.items.items_title_idx)",
        ],
      ])
    })

    it("skips an object the copy of the target does not have", () => {
      // Копія доказу — копія цілі: чого немає на копії, немає й на цілі, тож
      // знімати нічого
      const out = gate(
        {
          conversions: [conversion("platform", indexObject("items_code_idx"))],
        },
        [],
        []
      )
      expect(out).toEqual([])
    })
  })

  describe("foreign key (§9.2: FK reference, RESTRICT → NO ACTION)", () => {
    const TARGET = "REFERENCES app.groups(id)"
    const adopted = (def: string) =>
      gate(
        {
          conversions: [conversion("platform", constraint("items_group_fkey"))],
        },
        [
          fk(
            "items_group_fkey",
            `FOREIGN KEY (group_id) ${TARGET} ON DELETE RESTRICT`
          ),
        ],
        [fk("item_group_id_fkey", def)]
      )

    it.each([
      ["RESTRICT → NO ACTION", `FOREIGN KEY (group_id) ${TARGET}`],
      [
        "the same action",
        `FOREIGN KEY (group_id) ${TARGET} ON DELETE RESTRICT`,
      ],
      [
        "RESTRICT → NO ACTION on update too",
        `FOREIGN KEY (group_id) ${TARGET} ON UPDATE RESTRICT ON DELETE NO ACTION`,
      ],
    ])("passes %s without a permission", (_, def) => {
      expect(adopted(def)).toEqual([])
    })

    it("passes NO ACTION → RESTRICT", () => {
      const out = gate(
        {
          conversions: [conversion("platform", constraint("items_group_fkey"))],
        },
        [fk("items_group_fkey", `FOREIGN KEY (group_id) ${TARGET}`)],
        [
          fk(
            "item_group_id_fkey",
            `FOREIGN KEY (group_id) ${TARGET} ON DELETE RESTRICT`
          ),
        ]
      )
      expect(out).toEqual([])
    })

    it.each([
      [
        "CASCADE → NO ACTION",
        `FOREIGN KEY (group_id) ${TARGET} ON DELETE CASCADE`,
        `FOREIGN KEY (group_id) ${TARGET}`,
      ],
      [
        "NO ACTION → CASCADE",
        `FOREIGN KEY (group_id) ${TARGET}`,
        `FOREIGN KEY (group_id) ${TARGET} ON DELETE CASCADE`,
      ],
      [
        "SET NULL → RESTRICT",
        `FOREIGN KEY (group_id) ${TARGET} ON DELETE SET NULL`,
        `FOREIGN KEY (group_id) ${TARGET} ON DELETE RESTRICT`,
      ],
      [
        "a changed deferrability",
        `FOREIGN KEY (group_id) ${TARGET} DEFERRABLE INITIALLY DEFERRED`,
        `FOREIGN KEY (group_id) ${TARGET}`,
      ],
      [
        "INITIALLY DEFERRED → IMMEDIATE",
        `FOREIGN KEY (group_id) ${TARGET} DEFERRABLE INITIALLY DEFERRED`,
        `FOREIGN KEY (group_id) ${TARGET} DEFERRABLE`,
      ],
      [
        "a changed MATCH",
        `FOREIGN KEY (group_id) ${TARGET} MATCH FULL`,
        `FOREIGN KEY (group_id) ${TARGET}`,
      ],
      [
        "another target table",
        `FOREIGN KEY (group_id) ${TARGET}`,
        "FOREIGN KEY (group_id) REFERENCES app.teams(id)",
      ],
      [
        "another column",
        `FOREIGN KEY (group_id) ${TARGET}`,
        `FOREIGN KEY (team_id) ${TARGET}`,
      ],
    ])("refuses %s under the class platform", (_, was, now) => {
      const out = gate(
        {
          conversions: [conversion("platform", constraint("items_group_fkey"))],
        },
        [fk("items_group_fkey", was)],
        [fk("item_group_id_fkey", now)]
      )
      expect(out.map((d) => d.code)).toEqual([
        "plan.platform-replacement-missing",
      ])
    })

    it("refuses a foreign key of the shadow on another table", () => {
      const def = `FOREIGN KEY (group_id) ${TARGET}`
      const out = gate(
        {
          conversions: [conversion("platform", constraint("items_group_fkey"))],
        },
        [fk("items_group_fkey", def)],
        [{ ...fk("other_group_id_fkey", def), table: "other" }]
      )
      expect(out.map((d) => d.code)).toEqual([
        "plan.platform-replacement-missing",
      ])
    })
  })

  describe("value list in CHECK (§9.2: → Ref to an enumeration)", () => {
    const STATUS = [{ schema: "app", table: "item", column: "status" }]
    const adopted = (
      def: string,
      labels = STATUS,
      shadow: EquivalenceObject[] = []
    ) =>
      gate(
        {
          conversions: [
            conversion("platform", constraint("items_status_check")),
          ],
        },
        [check("items_status_check", def)],
        shadow,
        { labels }
      )

    it.each([
      "CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))",
      "CHECK (((status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))",
      "CHECK (status IN ('a', 'b'))",
    ])("passes %s when the mapped column is a Ref to an enumeration", (def) => {
      expect(adopted(def)).toEqual([])
    })

    it("refuses the value list when the mapped column is no such Ref", () => {
      const out = adopted(
        "CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))",
        [{ schema: "app", table: "item", column: "kind" }]
      )
      expect(out.map((d) => d.code)).toEqual([
        "plan.platform-replacement-missing",
      ])
    })

    it("does not accept a value-list CHECK of the shadow as the replacement", () => {
      // Сама форма `CHECK` у тіні не доводить перерахування: її міг дописати
      // будь-хто (R9)
      const def = "CHECK ((status = ANY (ARRAY['a'::text, 'b'::text])))"
      const out = adopted(def, [], [check("item_status_check", def)])
      expect(out.map((d) => d.code)).toEqual([
        "plan.platform-replacement-missing",
      ])
    })

    it.each([
      ["a comparison", "CHECK ((status <> ''::text))"],
      [
        "a list over an expression",
        "CHECK ((lower(status) = ANY (ARRAY['a'::text])))",
      ],
      [
        "a list of non-literals",
        "CHECK ((status = ANY (ARRAY[kind, 'b'::text])))",
      ],
      [
        "a negated list",
        "CHECK ((status <> ALL (ARRAY['a'::text, 'b'::text])))",
      ],
      // Знімається лише приведення varchar → text, яке дописує Postgres
      [
        "a list over a cast to another type",
        "CHECK (((status)::integer = ANY (ARRAY[1, 2])))",
      ],
    ])("checks %s by the equivalence key", (_, def) => {
      expect(adopted(def).map((d) => d.code)).toEqual([
        "plan.platform-replacement-missing",
      ])
      expect(adopted(def, STATUS, [check("item_status_check", def)])).toEqual(
        []
      )
    })
  })

  describe("units (§9.2: mechanics triggers, RLS, grants, document commands)", () => {
    const policy: PromotionObject = {
      kind: "unit",
      class: "policy",
      schema: "app",
      table: "items",
      name: "items_read",
    }

    // Прийнята політика на копії після наміру — уже на перейменованій таблиці
    const adoptedPolicy = unit(
      "policy",
      "policy:app.item.items_read",
      "items_read",
      "CREATE POLICY items_read ON app.item FOR SELECT TO authenticated USING (x)"
    )

    it("refuses a policy when the shadow has no policy on the table", () => {
      const out = gate(
        { conversions: [conversion("platform", policy)] },
        [],
        [],
        {
          cloneUnits: [adoptedPolicy],
          units: [
            unit(
              "trigger",
              "trigger:app.item.t",
              "t",
              "CREATE TRIGGER t BEFORE UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.f()"
            ),
            unit(
              "policy",
              "policy:app.other.p",
              "p",
              "CREATE POLICY p ON app.other FOR SELECT USING (true)"
            ),
          ],
        }
      )
      expect(refusedObjects(out)).toEqual([
        [
          "plan.platform-replacement-missing",
          "error",
          "subject-platform (policy app.items.items_read)",
        ],
      ])
    })

    it("passes a policy when the shadow has a policy on the renamed table", () => {
      const out = gate(
        { conversions: [conversion("platform", policy)] },
        [],
        [],
        {
          cloneUnits: [adoptedPolicy],
          units: [
            unit(
              "policy",
              "policy:app.item.p",
              "p",
              "CREATE POLICY p ON app.item FOR SELECT USING (true)"
            ),
          ],
        }
      )
      expect(out).toEqual([])
    })

    it("needs a function of the same name for a unit without a table", () => {
      const fn: PromotionObject = {
        kind: "unit",
        class: "function",
        schema: "app",
        table: "",
        name: "post_item",
      }
      const sql = (name: string) =>
        `CREATE FUNCTION app.${name}() RETURNS void LANGUAGE sql AS $$ SELECT $$`
      const other = unit(
        "function",
        "function:app.other()",
        "other",
        sql("other")
      )
      const same = unit(
        "function",
        "function:app.post_item()",
        "post_item",
        sql("post_item")
      )
      const refused = gate(
        { conversions: [conversion("platform", fn)] },
        [],
        [],
        {
          units: [other],
        }
      )
      expect(refused.map((d) => d.code)).toEqual([
        "plan.platform-replacement-missing",
      ])
      expect(
        gate({ conversions: [conversion("platform", fn)] }, [], [], {
          units: [same],
        })
      ).toEqual([])
    })
  })

  describe("units by class (§8 механізм-заміна)", () => {
    // Бажаний стан — згенеровані одиниці доступу (генератор `access`):
    // скоуплена таблиця з межею тенанта й правом читання `any`
    const GENERATED = [
      unit(
        "grant",
        "grant:app.item:revoke:public:all",
        "app.item",
        "REVOKE ALL ON TABLE app.item FROM PUBLIC"
      ),
      ...["anon", "authenticated", "service_role"].map((role) =>
        unit(
          "grant",
          `grant:app.item:revoke:${role}:all`,
          "app.item",
          `REVOKE ALL ON TABLE app.item FROM ${role}`
        )
      ),
      unit(
        "grant",
        "grant:app.item:grant:authenticated:select",
        "app.item",
        "GRANT SELECT ON TABLE app.item TO authenticated"
      ),
      unit(
        "policy",
        "policy:app.item.item_scope_read",
        "item_scope_read",
        "CREATE POLICY item_scope_read ON app.item AS RESTRICTIVE FOR SELECT TO authenticated, simetra_command USING (org_id = ANY (ARRAY(SELECT app.my_orgs())))"
      ),
      unit(
        "policy",
        "policy:app.item.item_read_any",
        "item_read_any",
        "CREATE POLICY item_read_any ON app.item AS PERMISSIVE FOR SELECT TO authenticated, simetra_command USING ((SELECT simetra.has_right('item', 'read', 'any')))"
      ),
    ]

    /**
     * Прийнята одиниця з тим самим текстом на копії й ключем у записі; ім'я
     * політики й тригера в текстах тестів — `p` і `a`.
     */
    function adopted(cls: "grant" | "policy" | "trigger", sql: string) {
      const name = cls === "policy" ? "p" : cls === "trigger" ? "a" : "app.item"
      const onClone = unit(cls, `${cls}:adopted`, name, sql)
      const [key] = unitSubjectKeys(onClone, parse, "app")
      // Запис — у старому імені таблиці; копія після наміру — вже в новому
      return {
        onClone,
        object: { kind: "unit", ...key!, table: "items" } as PromotionObject,
      }
    }

    function verdict(
      cls: "grant" | "policy" | "trigger",
      sql: string,
      units: CatalogUnit[] = GENERATED
    ): string[] {
      const a = adopted(cls, sql)
      return gate({ conversions: [conversion("platform", a.object)] }, [], [], {
        units,
        cloneUnits: [a.onClone],
      }).map((d) => d.code)
    }
    const MISSING = ["plan.platform-replacement-missing"]

    describe("grant", () => {
      it("is replaced by the generated SELECT to the user role", () => {
        expect(
          verdict("grant", "GRANT SELECT ON TABLE app.item TO authenticated")
        ).toEqual([])
      })

      it("is not replaced when it grants more than SELECT", () => {
        expect(
          verdict("grant", "GRANT ALL ON TABLE app.item TO authenticated")
        ).toEqual(MISSING)
      })

      it("is replaced when it revokes what the generated REVOKE ALL revokes", () => {
        expect(
          verdict("grant", "REVOKE ALL ON TABLE app.item FROM anon")
        ).toEqual([])
      })

      it("is not replaced for the service role, which gets no grant", () => {
        expect(
          verdict("grant", "GRANT SELECT ON TABLE app.item TO service_role")
        ).toEqual(MISSING)
      })

      it("is not replaced when it keeps the grant option", () => {
        expect(
          verdict(
            "grant",
            "GRANT SELECT ON TABLE app.item TO authenticated WITH GRANT OPTION"
          )
        ).toEqual(MISSING)
      })

      it("is replaced by a table SELECT when it grants SELECT on columns", () => {
        expect(
          verdict(
            "grant",
            "GRANT SELECT (id) ON TABLE app.item TO authenticated"
          )
        ).toEqual([])
      })

      it("covers PUBLIC only with PUBLIC", () => {
        expect(
          verdict("grant", "GRANT SELECT ON TABLE app.item TO PUBLIC")
        ).toEqual(MISSING)
        expect(
          verdict("grant", "REVOKE ALL ON TABLE app.item FROM PUBLIC")
        ).toEqual([])
      })

      it("checks every role of a grant to several roles", () => {
        expect(
          verdict(
            "grant",
            "GRANT SELECT ON TABLE app.item TO authenticated, anon"
          )
        ).toEqual(MISSING)
      })

      it("refuses a grant without a target object", () => {
        // Порожній перелік пар не доводить заміни: такий грант — відмова
        const key: PromotionObject = {
          kind: "unit",
          class: "grant",
          schema: "app",
          table: "",
          name: "grant:authenticated:usage",
        }
        expect(
          gate({ conversions: [conversion("platform", key)] }, [], [], {
            units: GENERATED,
          }).map((d) => d.code)
        ).toEqual(MISSING)
      })

      it("does not check a pair the copy does not show", () => {
        // Витяг пише грант відносно типових прав: пару, рівну ADP цілі, копія
        // не показує; її втрату показують write-path, політика чи RLS плану
        const a = adopted(
          "grant",
          "GRANT ALL ON TABLE app.item TO authenticated"
        )
        expect(
          gate({ conversions: [conversion("platform", a.object)] }, [], [], {
            units: GENERATED,
          })
        ).toEqual([])
      })
    })

    describe("policy", () => {
      it("is replaced by the generated read policy of the same command and role", () => {
        expect(
          verdict(
            "policy",
            "CREATE POLICY p ON app.item FOR SELECT TO authenticated USING (x)"
          )
        ).toEqual([])
      })

      it("maps public to the user role", () => {
        expect(
          verdict(
            "policy",
            "CREATE POLICY p ON app.item FOR SELECT TO public USING (x)"
          )
        ).toEqual([])
        expect(
          verdict("policy", "CREATE POLICY p ON app.item FOR SELECT USING (x)")
        ).toEqual([])
      })

      it("refuses FOR ALL TO public: the generated policy covers only SELECT", () => {
        expect(
          verdict(
            "policy",
            "CREATE POLICY p ON app.item FOR ALL TO public USING (x)"
          )
        ).toEqual(MISSING)
      })

      it("refuses a restrictive policy", () => {
        expect(
          verdict(
            "policy",
            "CREATE POLICY p ON app.item AS RESTRICTIVE FOR SELECT TO authenticated USING (x)"
          )
        ).toEqual(MISSING)
      })

      it("refuses a role the generated policy does not have", () => {
        expect(
          verdict(
            "policy",
            "CREATE POLICY p ON app.item FOR SELECT TO anon USING (x)"
          )
        ).toEqual(MISSING)
      })

      it("is replaced only by a permissive rights policy, not by the restrictive scope policy", () => {
        // Межа тенанта читання не відкриває (Р2a2-12): без політики прав
        // прийняте читання зникло б мовчки
        const scopeOnly = GENERATED.filter(
          (u) => u.class === "grant" || u.name === "item_scope_read"
        )
        expect(
          verdict(
            "policy",
            "CREATE POLICY p ON app.item FOR SELECT TO authenticated USING (x)",
            scopeOnly
          )
        ).toEqual(MISSING)
      })

      it("refuses SELECT on a table without a generated policy", () => {
        // Нескоуплена таблиця без `publicRead`: лише гранти, політик немає
        const grantsOnly = GENERATED.filter((u) => u.class === "grant")
        expect(
          verdict(
            "policy",
            "CREATE POLICY p ON app.item FOR SELECT TO authenticated USING (true)",
            grantsOnly
          )
        ).toEqual(MISSING)
      })
    })

    describe("trigger (§8 механізм-заміна)", () => {
      const trigger = (name: string, sql: string) =>
        unit("trigger", `trigger:app.item.${name}`, name, sql)
      // Таблиця виду завжди має механіку: кожна перевірка підписки йде поруч
      // із нею, щоб тригер механіки не «замінив» чужий
      const MECHANICS = trigger(
        "item_simetra_touch",
        "CREATE TRIGGER item_simetra_touch BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION simetra.touch()"
      )
      const subscription = (handler: string) => [
        MECHANICS,
        trigger(
          "s",
          `CREATE TRIGGER s BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION ${handler}()`
        ),
      ]
      // `whenChanged: [price]` у формі `pg_get_triggerdef`: оновлення з умовою
      // й окремий тригер вставки
      const WHEN_CHANGED = [
        MECHANICS,
        trigger(
          "s",
          "CREATE TRIGGER s BEFORE UPDATE ON app.item FOR EACH ROW WHEN ((old.price IS DISTINCT FROM new.price)) EXECUTE FUNCTION app.h()"
        ),
        trigger(
          "s_insert",
          "CREATE TRIGGER s_insert BEFORE INSERT ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"
        ),
      ]
      // Перейменування колонки не переписує аргументу тригера: це рядок
      const EDITED_AT: Partial<PromotionRecord> = {
        columns: [
          {
            id: ATTRIBUTE_ID,
            sourceId: ATTRIBUTE_ID,
            schema: "app",
            table: "item",
            from: "edited_at",
            to: "updated_at",
          },
        ],
      }
      const moddatetime = (column: string, timing = "BEFORE UPDATE") =>
        `CREATE TRIGGER a ${timing} ON app.item FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(${column})`

      function triggerGate(
        sql: string,
        units: CatalogUnit[],
        over: Partial<PromotionRecord> = {},
        tables: PhysicalTable[] = []
      ) {
        const a = adopted("trigger", sql)
        const input = {
          record: record({
            ...RENAMED,
            conversions: [conversion("platform", a.object)],
            ...over,
          }),
          clone: model([table("item")], [a.onClone]),
          desired: model([table("item")], units),
          physical: { tables },
          attributeCase: "snake_case" as const,
          parse,
        }
        return {
          codes: platformReplacements({
            ...input,
            cloneEquivalence: [],
            shadowEquivalence: [],
            valueElementColumns: [],
            provider: "supabase",
          }).map((d) => d.code),
          narrowed: updateOfNarrowings(input).map((d) => [
            d.code,
            d.severity,
            d.params,
          ]),
        }
      }
      const codesOf = (
        sql: string,
        units: CatalogUnit[],
        over?: Partial<PromotionRecord>,
        tables?: PhysicalTable[]
      ) => triggerGate(sql, units, over, tables).codes

      it("an effects trigger is never a replacement of an adopted trigger", () => {
        // Р2b1-12: тригер ефектів дії платформний, тож прийнятий тригер на всі
        // події з функцією того самого імені ним не замінюється (fail-closed)
        const EFFECTS_NAME =
          "CREATE TRIGGER item_simetra_effects AFTER INSERT OR UPDATE OR DELETE ON app.item FOR EACH ROW EXECUTE FUNCTION app.item_simetra_effects()"
        expect(
          codesOf(
            "CREATE TRIGGER a AFTER INSERT OR UPDATE OR DELETE ON app.item FOR EACH ROW EXECUTE FUNCTION app.item_simetra_effects()",
            [MECHANICS, trigger("item_simetra_effects", EFFECTS_NAME)]
          )
        ).toEqual(MISSING)
      })

      it.each(["item_simetra_hierarchy", "item_simetra_hierarchy_update"])(
        "hierarchy trigger %s is never a replacement of an adopted trigger",
        (name) => {
          // Р-A2-1: тригер ієрархії платформний, тож прийнятий тригер з тим
          // самим викликом ним не замінюється (fail-closed)
          const call =
            "AFTER UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.item_simetra_hierarchy()"
          expect(
            codesOf(`CREATE TRIGGER a ${call}`, [
              MECHANICS,
              trigger(name, `CREATE TRIGGER ${name} ${call}`),
            ])
          ).toEqual(MISSING)
        }
      )

      // Кожна пара сторожа прав — окремий рядок: пропущена в переліку
      // платформних пара дала б прийнятому тригеру з тим самим викликом
      // «заміну» і мовчки зняла б його на промоції
      it.each(rightsGuardNames({ schema: "app", name: "item" }))(
        "rights guard $trigger is not a replacement of an adopted trigger",
        ({ trigger: name, function: fn }) => {
          const call = `${fn.schema}.${fn.name}()`
          expect(
            codesOf(
              `CREATE TRIGGER a BEFORE INSERT ON app.item FOR EACH ROW EXECUTE FUNCTION ${call}`,
              [
                MECHANICS,
                trigger(
                  name,
                  `CREATE TRIGGER ${name} BEFORE INSERT ON app.item FOR EACH ROW EXECUTE FUNCTION ${call}`
                ),
              ]
            )
          ).toEqual(MISSING)
        }
      )

      it("the deferred rights check on the platform queue is not a replacement of an adopted trigger", () => {
        // Перевірка на COMMIT висить на черзі платформи, а не на таблиці виду:
        // прийнятий тригер, що кличе ту саму функцію, нею не замінюється
        const call = "simetra.rights_tx_check()"
        expect(
          codesOf(
            `CREATE TRIGGER a AFTER INSERT ON app.item FOR EACH ROW EXECUTE FUNCTION ${call}`,
            [
              MECHANICS,
              {
                class: "trigger",
                identity:
                  "trigger:simetra.rights_tx_pending.rights_tx_pending_check",
                schema: "simetra",
                name: "rights_tx_pending_check",
                sql: `CREATE CONSTRAINT TRIGGER rights_tx_pending_check AFTER INSERT ON simetra.rights_tx_pending DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${call}`,
              },
            ]
          )
        ).toEqual(MISSING)
      })

      describe("on a table with carrier copies (Р2a2-20)", () => {
        const physicalColumn = (
          name: string,
          type: string,
          origin: PhysicalColumn["origin"] = {}
        ): PhysicalColumn => ({ name, type, notNull: false, origin })
        // Бажана таблиця з копією носія власника: механіка й підписка без
        // `whenChanged` на ній — з умовою змісту (Р2a2-19)
        const COPIES: PhysicalTable = {
          schema: "app",
          name: "item",
          origin: { objectId: OBJECT_ID },
          rowLevelSecurity: "enabled",
          columns: [
            physicalColumn("id", "uuid"),
            physicalColumn("parent_id", "uuid"),
            physicalColumn("note", "character varying(200)"),
            physicalColumn("assignee_id", "uuid", {
              copyOf: {
                table: { schema: "app", name: "task" },
                column: "assignee_id",
                through: "parent_id",
              },
            }),
            physicalColumn("updated_at", "timestamp with time zone", {
              standard: "updated_at",
            }),
            physicalColumn("version", "integer", { standard: "version" }),
          ],
          uniques: [],
          checks: [],
          foreignKeys: [],
          indexes: [],
        }
        // Умова змісту у формі `pg_get_triggerdef`: `old.`/`new.` малими, без
        // лапок, `::text` над `varchar`, `OR` одним списком
        const CONTENT =
          "((old.id IS DISTINCT FROM new.id) OR (old.parent_id IS DISTINCT FROM new.parent_id) OR ((old.note)::text IS DISTINCT FROM (new.note)::text) OR (NOT (old.assignee_id IS DISTINCT FROM new.assignee_id)))"
        // Інша умова тієї самої форми — без колонки змісту `note`
        const OTHER =
          "((old.id IS DISTINCT FROM new.id) OR (old.parent_id IS DISTINCT FROM new.parent_id) OR (NOT (old.assignee_id IS DISTINCT FROM new.assignee_id)))"
        const TOUCH_INSERT = trigger(
          "item_simetra_touch",
          "CREATE TRIGGER item_simetra_touch BEFORE INSERT ON app.item FOR EACH ROW EXECUTE FUNCTION simetra.touch()"
        )
        const touchUpdate = (when: string) =>
          trigger(
            "item_simetra_touch_update",
            `CREATE TRIGGER item_simetra_touch_update BEFORE UPDATE ON app.item FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION simetra.touch()`
          )
        const SPLIT = [TOUCH_INSERT, touchUpdate(CONTENT)]
        const pair = (when: string) => [
          ...SPLIT,
          trigger(
            "s",
            `CREATE TRIGGER s BEFORE UPDATE ON app.item FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION app.h()`
          ),
          trigger(
            "s_insert",
            "CREATE TRIGGER s_insert BEFORE INSERT ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"
          ),
        ]
        const HANDLER =
          "CREATE TRIGGER a BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"

        it("moddatetime is replaced only by the split mechanics with an UPDATE trigger", () => {
          expect(
            codesOf(moddatetime("updated_at"), SPLIT, {}, [COPIES])
          ).toEqual([])
          // Механіка лише на вставку чи нерозділена механіка на таблиці з
          // копіями оновлення з умовою змісту не тримає
          expect(
            codesOf(moddatetime("updated_at"), [TOUCH_INSERT], {}, [COPIES])
          ).toEqual(MISSING)
          expect(
            codesOf(moddatetime("updated_at"), [MECHANICS], {}, [COPIES])
          ).toEqual(MISSING)
        })

        it("a subscription pair replaces the adopted trigger", () => {
          expect(triggerGate(HANDLER, pair(CONTENT), {}, [COPIES])).toEqual({
            codes: [],
            narrowed: [],
          })
          // Умову змісту дає лише бажана таблиця з копіями: без неї та сама
          // умова — довільний `WHEN`
          expect(codesOf(HANDLER, pair(CONTENT))).toEqual(MISSING)
        })

        it.each([
          [
            "mechanics",
            moddatetime("updated_at"),
            [TOUCH_INSERT, touchUpdate(OTHER)],
          ],
          ["subscription", HANDLER, pair(OTHER)],
        ])(
          "a user trigger with another OR NOT condition is not platform (%s)",
          (_, sql, units) => {
            expect(codesOf(sql, units, {}, [COPIES])).toEqual(MISSING)
          }
        )

        describe("with author columns (Р-A1-10)", () => {
          // Колонки авторства — поза змістом: тригери механіки й авторства
          // стежать за ними (`watched`), підписки — ні
          const AUTHORED: PhysicalTable = {
            ...COPIES,
            columns: [
              ...COPIES.columns,
              physicalColumn("created_by_id", "uuid", {
                standard: "created_by",
              }),
              physicalColumn("updated_by_id", "uuid", {
                standard: "updated_by",
              }),
            ],
          }
          const WATCHED =
            "((old.id IS DISTINCT FROM new.id) OR (old.parent_id IS DISTINCT FROM new.parent_id) OR ((old.note)::text IS DISTINCT FROM (new.note)::text) OR ((old.created_by_id IS DISTINCT FROM new.created_by_id) OR (old.updated_by_id IS DISTINCT FROM new.updated_by_id)) OR (NOT (old.assignee_id IS DISTINCT FROM new.assignee_id)))"
          const authorTrigger = (name: string, events: string, fn: string) =>
            trigger(
              name,
              `CREATE TRIGGER ${name} BEFORE ${events} ON app.item FOR EACH ROW EXECUTE FUNCTION ${fn}()`
            )
          const AUTHOR = authorTrigger(
            "item_simetra_author",
            "INSERT",
            "simetra.author"
          )
          const AUTHOR_UPDATE = trigger(
            "item_simetra_author_update",
            `CREATE TRIGGER item_simetra_author_update BEFORE UPDATE ON app.item FOR EACH ROW WHEN (${WATCHED}) EXECUTE FUNCTION simetra.author()`
          )
          const AUTHORED_SPLIT = [
            TOUCH_INSERT,
            touchUpdate(WATCHED),
            AUTHOR,
            AUTHOR_UPDATE,
          ]

          it("the subscription pair keeps the condition without authors, the mechanics watches them", () => {
            expect(
              triggerGate(
                HANDLER,
                [
                  ...AUTHORED_SPLIT,
                  ...pair(CONTENT).filter((u) => u.name.startsWith("s")),
                ],
                {},
                [AUTHORED]
              )
            ).toEqual({ codes: [], narrowed: [] })
            expect(
              codesOf(moddatetime("updated_at"), AUTHORED_SPLIT, {}, [AUTHORED])
            ).toEqual([])
            // Механіка оновлення без `watched` на таблиці з авторством —
            // не платформна умова
            expect(
              codesOf(
                moddatetime("updated_at"),
                [TOUCH_INSERT, touchUpdate(CONTENT)],
                {},
                [AUTHORED]
              )
            ).toEqual(MISSING)
          })

          it.each([
            ["the insert trigger", "INSERT"],
            ["the update trigger", "UPDATE"],
          ])(
            "%s of authorship does not stand in for an adopted trigger of the same function",
            (_, events) => {
              expect(
                codesOf(
                  `CREATE TRIGGER a BEFORE ${events} ON app.item FOR EACH ROW EXECUTE FUNCTION simetra.author()`,
                  AUTHORED_SPLIT,
                  {},
                  [AUTHORED]
                )
              ).toEqual(MISSING)
            }
          )

          it("a trigger under the author name with another function is not platform", () => {
            expect(
              codesOf(
                "CREATE TRIGGER a BEFORE INSERT ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
                [
                  TOUCH_INSERT,
                  touchUpdate(WATCHED),
                  authorTrigger("item_simetra_author", "INSERT", "app.h"),
                ],
                {},
                [AUTHORED]
              )
            ).toEqual([])
          })
        })

        it("a carrier trigger does not stand in for an adopted trigger of the same function", () => {
          expect(
            codesOf(
              "CREATE TRIGGER a BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.item_simetra_carriers()",
              [
                ...SPLIT,
                trigger(
                  "item_simetra_carriers",
                  "CREATE TRIGGER item_simetra_carriers BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.item_simetra_carriers()"
                ),
              ],
              {},
              [COPIES]
            )
          ).toEqual(MISSING)
        })
      })

      it("is replaced by the row mechanics for moddatetime on updated_at", () => {
        expect(codesOf(moddatetime("updated_at"), [MECHANICS])).toEqual([])
      })

      describe("on a 50-byte table (Р-A1-7)", () => {
        // Довше за межу 41: тригери платформи — під іменами спільного
        // префікса з хешем, і промоція мусить впізнати їх як платформні
        const LONG = `item_${"x".repeat(45)}`
        const longTrigger = (name: string, sql: string) =>
          unit("trigger", `trigger:app.${LONG}.${name}`, name, sql)
        const TOUCH = longTrigger(
          mechanicsTriggerName(LONG),
          `CREATE TRIGGER ${mechanicsTriggerName(LONG)} BEFORE INSERT OR UPDATE ON app.${LONG} FOR EACH ROW EXECUTE FUNCTION simetra.touch()`
        )
        const derive = carrierTriggerNames({ schema: "app", name: LONG }).derive
        const deriveFn = carrierFunctionNames({ schema: "app", name: LONG })
          .derive.name
        const CARRIERS = longTrigger(
          derive,
          `CREATE TRIGGER ${derive} BEFORE INSERT OR UPDATE ON app.${LONG} FOR EACH ROW EXECUTE FUNCTION app.${deriveFn}()`
        )

        function longCodes(sql: string, units: CatalogUnit[]): string[] {
          const onClone = unit("trigger", "trigger:adopted", "a", sql)
          const [key] = unitSubjectKeys(onClone, parse, "app")
          return platformReplacements({
            record: record({
              tables: [{ id: OBJECT_ID, schema: "app", from: LONG, to: LONG }],
              conversions: [
                conversion("platform", { kind: "unit", ...key!, table: LONG }),
              ],
            }),
            clone: model([table(LONG)], [onClone]),
            desired: model([table(LONG)], units),
            physical: { tables: [] },
            attributeCase: "snake_case",
            cloneEquivalence: [],
            shadowEquivalence: [],
            valueElementColumns: [],
            provider: "supabase",
            parse,
          }).map((d) => d.code)
        }

        it("moddatetime is replaced by the row mechanics", () => {
          expect(
            longCodes(
              `CREATE TRIGGER a BEFORE UPDATE ON app.${LONG} FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime(updated_at)`,
              [TOUCH]
            )
          ).toEqual([])
        })

        it("a carrier trigger does not stand in for an adopted trigger of the same function", () => {
          expect(
            longCodes(
              `CREATE TRIGGER a BEFORE INSERT OR UPDATE ON app.${LONG} FOR EACH ROW EXECUTE FUNCTION app.${deriveFn}()`,
              [TOUCH, CARRIERS]
            )
          ).toEqual(MISSING)
        })
      })

      it("maps the moddatetime argument through the record's columns", () => {
        expect(
          codesOf(moddatetime("edited_at"), [MECHANICS], EDITED_AT)
        ).toEqual([])
        expect(codesOf(moddatetime("edited_at"), [MECHANICS])).toEqual(MISSING)
      })

      it("refuses moddatetime fired after the update", () => {
        expect(
          codesOf(moddatetime("updated_at", "AFTER UPDATE"), [MECHANICS])
        ).toEqual(MISSING)
      })

      it("refuses moddatetime without the row mechanics in the desired state", () => {
        expect(codesOf(moddatetime("updated_at"), [])).toEqual(MISSING)
      })

      it("refuses moddatetime narrowed by UPDATE OF or WHEN", () => {
        // Звужений `moddatetime` — свідоме рішення автора, якого механіка не
        // тримає; такий тригер знімають з дозволом
        expect(
          codesOf(moddatetime("updated_at", "BEFORE UPDATE OF name"), [
            MECHANICS,
          ])
        ).toEqual(MISSING)
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE UPDATE ON app.item FOR EACH ROW WHEN ((old.name IS DISTINCT FROM new.name)) EXECUTE FUNCTION extensions.moddatetime(updated_at)",
            [MECHANICS]
          )
        ).toEqual(MISSING)
      })

      it("refuses another function on a table that has only the mechanics", () => {
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.stamp()",
            [MECHANICS]
          )
        ).toEqual(MISSING)
      })

      it("is replaced by a subscription with the same handler, timing and events", () => {
        const sql =
          "CREATE TRIGGER a BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"
        expect(triggerGate(sql, subscription("app.h"))).toEqual({
          codes: [],
          narrowed: [],
        })
        expect(codesOf(sql, subscription("app.g"))).toEqual(MISSING)
      })

      it("covers INSERT OR UPDATE OF with whenChanged and warns of the narrowing", () => {
        expect(
          triggerGate(
            "CREATE TRIGGER a BEFORE INSERT OR UPDATE OF price ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
            WHEN_CHANGED
          )
        ).toEqual({
          codes: [],
          narrowed: [
            [
              "plan.update-of-narrowed",
              "warning",
              { trigger: "a", table: "app.items", columns: "price" },
            ],
          ],
        })
      })

      it("refuses UPDATE OF without INSERT: the subscription fires on insert too", () => {
        expect(
          triggerGate(
            "CREATE TRIGGER a BEFORE UPDATE OF price ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
            WHEN_CHANGED
          )
        ).toEqual({ codes: MISSING, narrowed: [] })
      })

      it("refuses UPDATE OF other columns than whenChanged", () => {
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE INSERT OR UPDATE OF price, qty ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
            WHEN_CHANGED
          )
        ).toEqual(MISSING)
      })

      it("refuses an arbitrary WHEN", () => {
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW WHEN ((new.price > 0)) EXECUTE FUNCTION app.h()",
            subscription("app.h")
          )
        ).toEqual(MISSING)
      })

      it("refuses other events or timing than the subscription's", () => {
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
            subscription("app.h")
          )
        ).toEqual(MISSING)
        expect(
          codesOf(
            "CREATE TRIGGER a AFTER INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
            subscription("app.h")
          )
        ).toEqual(MISSING)
      })

      it("does not pair an UPDATE trigger with an arbitrary WHEN and its _insert", () => {
        // Два боргові тригери: `x` з довільною умовою й `x_insert` — не пара
        // `whenChanged`, тож `INSERT OR UPDATE OF` вони не покривають
        const debt = [
          MECHANICS,
          trigger(
            "x",
            "CREATE TRIGGER x BEFORE UPDATE ON app.item FOR EACH ROW WHEN ((new.price > 0)) EXECUTE FUNCTION app.h()"
          ),
          trigger(
            "x_insert",
            "CREATE TRIGGER x_insert BEFORE INSERT ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"
          ),
        ]
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW WHEN ((new.price > 0)) EXECUTE FUNCTION app.h()",
            debt
          )
        ).toEqual(MISSING)
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE INSERT OR UPDATE OF price ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
            debt
          )
        ).toEqual(MISSING)
      })

      it("refuses FOR EACH STATEMENT", () => {
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE INSERT OR UPDATE ON app.item FOR EACH STATEMENT EXECUTE FUNCTION app.h()",
            subscription("app.h")
          )
        ).toEqual(MISSING)
      })

      it("refuses trigger arguments the handler would read", () => {
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h('x')",
            subscription("app.h")
          )
        ).toEqual(MISSING)
      })

      it("names the narrowed columns by their old names when the promotion renames them", () => {
        // Копія після наміру друкує `UPDATE OF` уже в новому імені колонки
        // (Postgres тримає номер атрибута), а попередження — у старих іменах
        const COST: Partial<PromotionRecord> = {
          columns: [
            {
              id: ATTRIBUTE_ID,
              sourceId: ATTRIBUTE_ID,
              schema: "app",
              table: "item",
              from: "price",
              to: "cost",
            },
          ],
        }
        const units = [
          MECHANICS,
          trigger(
            "s",
            "CREATE TRIGGER s BEFORE UPDATE ON app.item FOR EACH ROW WHEN ((old.cost IS DISTINCT FROM new.cost)) EXECUTE FUNCTION app.h()"
          ),
          trigger(
            "s_insert",
            "CREATE TRIGGER s_insert BEFORE INSERT ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"
          ),
        ]
        expect(
          triggerGate(
            "CREATE TRIGGER a BEFORE INSERT OR UPDATE OF cost ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
            units,
            COST
          )
        ).toEqual({
          codes: [],
          narrowed: [
            [
              "plan.update-of-narrowed",
              "warning",
              { trigger: "a", table: "app.items", columns: "price" },
            ],
          ],
        })
      })

      describe("whenChanged in the pg_get_triggerdef form of a varchar column", () => {
        // Тінь друкує умову над `varchar` з `::text` з обох боків
        const shadow = (when: string) => [
          MECHANICS,
          trigger(
            "s",
            `CREATE TRIGGER s BEFORE UPDATE ON app.item FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION app.h()`
          ),
          trigger(
            "s_insert",
            "CREATE TRIGGER s_insert BEFORE INSERT ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"
          ),
        ]
        const updateOf = (columns: string, when: string) =>
          triggerGate(
            `CREATE TRIGGER a BEFORE INSERT OR UPDATE OF ${columns} ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()`,
            shadow(when)
          )
        const narrowed = (columns: string) => ({
          codes: [],
          narrowed: [
            [
              "plan.update-of-narrowed",
              "warning",
              { trigger: "a", table: "app.items", columns },
            ],
          ],
        })

        it("covers UPDATE OF one column", () => {
          expect(
            updateOf(
              "name",
              "((old.name)::text IS DISTINCT FROM (new.name)::text)"
            )
          ).toEqual(narrowed("name"))
        })

        it("covers UPDATE OF several columns joined by OR", () => {
          expect(
            updateOf(
              "name, code",
              "(((old.name)::text IS DISTINCT FROM (new.name)::text) OR ((old.code)::text IS DISTINCT FROM (new.code)::text))"
            )
          ).toEqual(narrowed("name, code"))
        })

        it("does not take a one-sided cast or a cast to another type for whenChanged", () => {
          // Приведення лише з одного боку чи до іншого типу — вираз над
          // колонкою, не умова `whenChanged`
          for (const when of [
            "((old.name)::text IS DISTINCT FROM new.name)",
            "((old.name)::integer IS DISTINCT FROM (new.name)::integer)",
          ])
            expect(updateOf("name", when).codes, when).toEqual(MISSING)
        })
      })

      // Кожен випадок нижче тримає один запобіжник `triggerReplacement`: без
      // нього прийнятий тригер зійшов би за підписку, і промоція мовчки
      // змінила б поведінку
      it("refuses an adopted constraint trigger even with the subscription's handler", () => {
        expect(
          codesOf(
            "CREATE CONSTRAINT TRIGGER a AFTER INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
            [
              MECHANICS,
              trigger(
                "s",
                "CREATE TRIGGER s AFTER INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"
              ),
            ]
          )
        ).toEqual(MISSING)
      })

      it("refuses an adopted trigger with a transition table", () => {
        // Postgres дає перехідну таблицю лише `AFTER`-тригеру однієї події,
        // тож форма підписки поруч — `onDelete`
        expect(
          codesOf(
            "CREATE TRIGGER a AFTER DELETE ON app.item REFERENCING OLD TABLE AS o FOR EACH ROW EXECUTE FUNCTION app.h()",
            [
              MECHANICS,
              trigger(
                "s",
                "CREATE TRIGGER s AFTER DELETE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"
              ),
            ]
          )
        ).toEqual(MISSING)
      })

      it("refuses INSERT OR UPDATE OF with its own WHEN under whenChanged", () => {
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE INSERT OR UPDATE OF price ON app.item FOR EACH ROW WHEN ((new.price > 0)) EXECUTE FUNCTION app.h()",
            WHEN_CHANGED
          )
        ).toEqual(MISSING)
      })

      it("does not take a debt constraint trigger of the desired state for a subscription", () => {
        expect(
          codesOf(
            "CREATE TRIGGER a AFTER INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
            [
              MECHANICS,
              trigger(
                "s",
                "CREATE CONSTRAINT TRIGGER s AFTER INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"
              ),
            ]
          )
        ).toEqual(MISSING)
      })

      it("does not take a debt UPDATE OF trigger of the desired state for a subscription", () => {
        expect(
          codesOf(
            "CREATE TRIGGER a BEFORE INSERT OR UPDATE ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()",
            [
              MECHANICS,
              trigger(
                "s",
                "CREATE TRIGGER s BEFORE INSERT OR UPDATE OF price ON app.item FOR EACH ROW EXECUTE FUNCTION app.h()"
              ),
            ]
          )
        ).toEqual(MISSING)
      })
    })
  })

  describe("covered index (§8 механізм-заміна, decision 11)", () => {
    /** Ключ еквівалентності індексу в порядку `INDEX_PARTS`. */
    const fullIndex = (
      name: string,
      columns: string[],
      over: {
        unique?: boolean
        where?: string
        nullsNotDistinct?: boolean
        keys?: number
        options?: number[]
        collations?: (string | null)[]
        storage?: string[]
        classes?: boolean[]
      } = {}
    ) => {
      // Покласні частини мають довжину ключа, не всіх колонок: INCLUDE-колонки
      // їх не несуть
      const keys = columns.slice(0, over.keys ?? columns.length)
      return eq("index", name, [
        "btree",
        over.unique ?? false,
        over.nullsNotDistinct ?? false,
        keys.length,
        columns,
        over.options ?? keys.map(() => 0),
        keys.map(() => "pg_catalog.uuid_ops"),
        keys.map(() => null),
        over.collations ?? keys.map(() => null),
        over.where ?? null,
        over.storage ?? null,
        over.classes ?? keys.map(() => true),
      ])
    }
    const scopeKey = eq("constraint", "item_org_id_id_key", [
      "u",
      "UNIQUE (org_id, id)",
    ])
    const covered = (adopted: EquivalenceObject, shadow = [scopeKey]) =>
      gate(
        {
          conversions: [conversion("platform", indexObject(adopted.name))],
        },
        [adopted],
        shadow
      ).map((d) => d.code)
    const MISSING = ["plan.platform-replacement-missing"]

    it("covers a plain index by a key that starts with its columns", () => {
      expect(covered(fullIndex("items_org_idx", ["org_id"]))).toEqual([])
    })

    it("does not cover a partial index", () => {
      expect(
        covered(fullIndex("items_org_idx", ["org_id"], { where: "(x)" }))
      ).toEqual(MISSING)
    })

    it("does not cover an index with a non-default operator class", () => {
      expect(
        covered(fullIndex("items_org_idx", ["org_id"], { classes: [false] }))
      ).toEqual(MISSING)
    })

    it("does not cover an index with DESC", () => {
      expect(
        covered(fullIndex("items_org_idx", ["org_id"], { options: [3] }))
      ).toEqual(MISSING)
    })

    it("does not cover an index whose columns are not a prefix", () => {
      expect(covered(fullIndex("items_id_org_idx", ["id", "org_id"]))).toEqual(
        MISSING
      )
    })

    it("does not cover an expression index", () => {
      expect(covered(fullIndex("items_lower_idx", ["lower(org_id)"]))).toEqual(
        MISSING
      )
    })

    it("does not cover a unique index by a wider key", () => {
      expect(
        covered(fullIndex("items_org_key", ["org_id"], { unique: true }))
      ).toEqual(MISSING)
    })

    it("covers a unique index by a key with the same columns", () => {
      expect(
        covered(
          fullIndex("items_org_id_key", ["org_id", "id"], { unique: true })
        )
      ).toEqual([])
    })

    it("covers by a plain index of the shadow, not by a partial one", () => {
      const adopted = fullIndex("items_org_idx", ["org_id"])
      expect(
        covered(adopted, [fullIndex("item_org_title_idx", ["org_id", "title"])])
      ).toEqual([])
      expect(
        covered(adopted, [
          fullIndex("item_org_title_idx", ["org_id", "title"], {
            where: "(x)",
          }),
        ])
      ).toEqual(MISSING)
    })

    it("does not cover a unique index by a deferrable key", () => {
      expect(
        covered(
          fullIndex("items_org_id_key", ["org_id", "id"], { unique: true }),
          [
            eq("constraint", "item_org_id_id_key", [
              "u",
              "UNIQUE (org_id, id) DEFERRABLE",
            ]),
          ]
        )
      ).toEqual(MISSING)
    })

    it("does not cover a NULLS NOT DISTINCT index by a key without it", () => {
      expect(
        covered(
          fullIndex("items_org_id_key", ["org_id", "id"], {
            unique: true,
            nullsNotDistinct: true,
          })
        )
      ).toEqual(MISSING)
    })

    it("does not cover an index with an explicit collation", () => {
      expect(
        covered(
          fullIndex("items_org_idx", ["org_id"], {
            collations: ['pg_catalog."C"'],
          })
        )
      ).toEqual(MISSING)
    })

    it("covers an index whose collation is the column default", () => {
      expect(
        covered(
          fullIndex("items_org_idx", ["org_id"], {
            collations: ['pg_catalog."default"'],
          })
        )
      ).toEqual([])
    })

    it("does not cover an index with INCLUDE", () => {
      expect(
        covered(fullIndex("items_org_idx", ["org_id", "id"], { keys: 1 }))
      ).toEqual(MISSING)
    })

    it("does not cover an index with storage parameters", () => {
      expect(
        covered(
          fullIndex("items_org_idx", ["org_id"], {
            storage: ["fillfactor=70"],
          })
        )
      ).toEqual(MISSING)
    })

    it("covers by the primary key", () => {
      expect(
        covered(fullIndex("items_id_idx", ["id"]), [
          eq("constraint", "item_pkey", ["p", "PRIMARY KEY (id)"]),
        ])
      ).toEqual([])
    })
  })

  it("refuses a default under the class platform: no replacement shape", () => {
    const out = gate(
      {
        conversions: [
          conversion("platform", {
            kind: "default",
            schema: "app",
            table: "items",
            column: "code",
          }),
        ],
      },
      [],
      []
    )
    expect(refusedObjects(out)).toEqual([
      [
        "plan.platform-replacement-missing",
        "error",
        "subject-platform (default app.items.code)",
      ],
    ])
  })

  it("collects the columns that are a Ref to a kind with value elements", async () => {
    const compiled = await compile(enumerations())
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual(
      []
    )
    expect(valueElementColumns(compiled.model!)).toEqual([
      { schema: "app", table: "item", column: "color" },
    ])
  })
})

describe("propertyReproductions", () => {
  // Гейт плану класу `property` (R10 плану П3-2b-0): тінь мусить відтворити
  // прийнятий елемент еквівалентно, за тим самим порівнянням, що й клас
  // `platform`
  const RENAMED = {
    tables: [{ id: OBJECT_ID, schema: "app", from: "items", to: "item" }],
  }
  const eq = (
    kind: EquivalenceObject["kind"],
    name: string,
    parts: unknown[],
    t = "item"
  ): EquivalenceObject => ({
    kind,
    schema: "app",
    table: t,
    name,
    key: JSON.stringify(parts),
    valid: true,
  })
  const unique = (name: string, def: string, t = "item") =>
    eq("constraint", name, ["u", def], t)
  // Частини ключа індексу — у порядку `readEquivalenceObjects`
  const index = (name: string, keys: string[], where: string | null = null) =>
    eq("index", name, [
      "btree",
      false,
      false,
      keys.length,
      keys,
      keys.map(() => 0),
      keys.map(() => "pg_catalog.text_ops"),
      keys.map(() => null),
      keys.map(() => null),
      where,
      null,
    ])
  const indexObject = (name: string): PromotionObject => ({
    kind: "index",
    schema: "app",
    table: "items",
    name,
  })

  const gate = (
    conversions: PromotionRecord["conversions"],
    clone: EquivalenceObject[],
    shadow: EquivalenceObject[]
  ) =>
    propertyReproductions({
      record: record({ ...RENAMED, conversions }),
      cloneEquivalence: clone,
      shadowEquivalence: shadow,
      parse,
    })

  const refused = (out: ReturnType<typeof gate>) =>
    out.map((d) => [d.code, d.severity, d.params])

  it("passes an element the shadow recreates equivalently", () => {
    // Двигун знімає й створює залежний UNIQUE заново при зміні типу колонки
    // (§7.2): ім'я інше, форма та сама — не відмова
    const out = gate(
      [conversion("property", constraint("items_code_key"))],
      [unique("items_code_key", "UNIQUE (code)")],
      [unique("item_code_key", "UNIQUE (code)")]
    )
    expect(out).toEqual([])
  })

  it("refuses a deferred unique the shadow recreates immediate", () => {
    const out = gate(
      [conversion("property", constraint("items_code_key"))],
      [unique("items_code_key", "UNIQUE (code) DEFERRABLE INITIALLY DEFERRED")],
      [
        unique("item_title_key", "UNIQUE (title)"),
        unique("item_code_key", "UNIQUE (code)"),
      ]
    )
    expect(refused(out)).toEqual([
      [
        "plan.property-not-reproduced",
        "error",
        {
          subject: "subject-property",
          object: "constraint app.items.items_code_key",
          // Поля, як у гейті `promote`, а не цілий рядок визначення
          detail: "deferrable: initiallyDeferred → no",
        },
      ],
    ])
  })

  it("names every differing field of a unique, not the whole definition", () => {
    const out = gate(
      [conversion("property", constraint("items_code_key"))],
      [unique("items_code_key", "UNIQUE NULLS NOT DISTINCT (code) DEFERRABLE")],
      [unique("item_code_key", "UNIQUE (code, title)")]
    )
    expect(out.map((d) => d.params?.detail)).toEqual([
      "columns: code → code, title; nullsNotDistinct: true → false; deferrable: deferrable → no",
    ])
  })

  it("falls back to the definition when the unique fields are equal", () => {
    // `INCLUDE` форма UNIQUE не несе: різницю називає рядок визначення
    const out = gate(
      [conversion("property", constraint("items_code_key"))],
      [unique("items_code_key", "UNIQUE (code) INCLUDE (title)")],
      [unique("item_code_key", "UNIQUE (code)")]
    )
    expect(out.map((d) => d.params?.detail)).toEqual([
      "definition: UNIQUE (code) INCLUDE (title) → UNIQUE (code)",
    ])
  })

  it("names the differing fields of an index", () => {
    const out = gate(
      [conversion("property", indexObject("items_code_idx"))],
      [index("items_code_idx", ["code"], "(code IS NOT NULL)")],
      [index("item_code_idx", ["code"])]
    )
    expect(out.map((d) => d.params?.detail)).toEqual([
      "where: (code IS NOT NULL) → (none)",
    ])
  })

  it("refuses an element the shadow does not have at all", () => {
    const out = gate(
      [conversion("property", constraint("items_code_key"))],
      [unique("items_code_key", "UNIQUE (code)")],
      [unique("other_code_key", "UNIQUE (code)", "other")]
    )
    expect(out.map((d) => d.params?.detail)).toEqual([
      "no element of this kind on the table in the desired state",
    ])
  })

  it("ignores the other classes", () => {
    const out = gate(
      [
        conversion("removed", constraint("items_code_key")),
        conversion("platform", constraint("items_code_key")),
      ],
      [unique("items_code_key", "UNIQUE (code)")],
      []
    )
    expect(out).toEqual([])
  })

  it("skips an element the copy of the target does not have", () => {
    // Чого немає на копії цілі, немає й на цілі: знімати нічого
    const out = gate(
      [conversion("property", constraint("items_code_key"))],
      [],
      []
    )
    expect(out).toEqual([])
  })
})
