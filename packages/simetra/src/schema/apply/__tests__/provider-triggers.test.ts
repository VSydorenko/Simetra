import { describe, expect, it } from "vitest"
import {
  compile,
  loadSqlParser,
  type CompiledModel,
  type PromotionRecord,
} from "simetra/compiler"
import { catalogFromSnapshot, type CatalogModel } from "simetra/model"
import { numberingNotGenerated, providerTriggerConflicts } from "simetra/schema"
import {
  catalog,
  metaFiles,
  project,
  uuid,
} from "../../../compiler/__tests__/helpers"

/**
 * Перевірки плану перед кроками (рішення 7 і 8 плану П3-3a2): чужий тригер
 * з ім'ям згенерованого на таблиці провайдера і нумерація, якої ще не
 * генерують лічильники.
 */

const HANDLER = `CREATE FUNCTION public.on_user() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NEW;
END $$;`

const ITEM_HANDLER = `CREATE FUNCTION public.on_item() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$
BEGIN
  RETURN NEW;
END $$;`

async function compiled(
  entries: Record<string, unknown>
): Promise<CompiledModel> {
  const result = await compile(
    metaFiles({ "project.meta.json": project(), ...entries })
  )
  expect(result.diagnostics).toEqual([])
  return result.model!
}

const subscription = (n: number, name: string, data: object) => ({
  [`event-subscriptions/${name}/${name}.meta.json`]: {
    id: uuid(n),
    kind: "EventSubscription",
    name,
    ...data,
  },
})

/** Підписка `on_user` на `auth.users` і підписка `on_item` на довідник. */
const withSubscriptions = () =>
  compiled({
    "catalogs/Item/Item.meta.json": catalog("Item"),
    ...subscription(7301, "OnUser", {
      physicalName: "on_user",
      sources: [{ providerTable: "auth.users" }],
      event: "onWrite",
      handler: { schema: "public", name: "on_user" },
    }),
    ...subscription(7302, "OnItem", {
      physicalName: "on_item",
      sources: [{ kind: "Catalog", name: "Item" }],
      event: "onWrite",
      handler: { schema: "public", name: "on_item" },
    }),
    "sql/public/handlers.sql": `${HANDLER}\n${ITEM_HANDLER}`,
  })

const trigger = (schema: string, table: string, name: string, sql: string) => ({
  class: "trigger" as const,
  identity: `trigger:${schema}.${table}.${name}`,
  schema,
  name,
  sql,
})

const catalogOf = (units: CatalogModel["units"]): CatalogModel => ({
  tables: [],
  enumTypes: [],
  units,
})

/** Чужий тригер з ім'ям згенерованого: інша функція. */
const FOREIGN_ON_USER = trigger(
  "auth",
  "users",
  "on_user",
  "CREATE TRIGGER on_user AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.foreign_fn()"
)

describe("providerTriggerConflicts", () => {
  it("refuses a foreign trigger that holds the generated name on a provider table", async () => {
    const model = await withSubscriptions()
    const found = providerTriggerConflicts({
      desired: model.sqlUnits,
      live: catalogOf([FOREIGN_ON_USER]),
      applied: undefined,
      appSchemas: ["public", "simetra"],
      parse: await loadSqlParser(),
    })
    expect(found).toEqual([
      expect.objectContaining({
        code: "plan.provider-trigger-taken",
        severity: "error",
        params: { trigger: "on_user", table: "auth.users" },
      }),
    ])
  })

  it("lets an applied trigger change as usual", async () => {
    const model = await withSubscriptions()
    const found = providerTriggerConflicts({
      desired: model.sqlUnits,
      live: catalogOf([FOREIGN_ON_USER]),
      applied: catalogOf([FOREIGN_ON_USER]),
      appSchemas: ["public", "simetra"],
      parse: await loadSqlParser(),
    })
    expect(found).toEqual([])
  })

  it("compares parse trees, not the pg_get_triggerdef text", async () => {
    // Живий текст — `pg_get_triggerdef`: без лапок і `;`, той самий тригер
    const model = await withSubscriptions()
    const found = providerTriggerConflicts({
      desired: model.sqlUnits,
      live: catalogOf([
        trigger(
          "auth",
          "users",
          "on_user",
          "CREATE TRIGGER on_user AFTER INSERT OR UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION public.on_user()"
        ),
      ]),
      applied: undefined,
      appSchemas: ["public", "simetra"],
      parse: await loadSqlParser(),
    })
    expect(found).toEqual([])
  })

  it("leaves triggers on tables of the managed schemas alone", async () => {
    const model = await withSubscriptions()
    const found = providerTriggerConflicts({
      desired: model.sqlUnits,
      live: catalogOf([
        trigger(
          "public",
          "item",
          "on_item",
          "CREATE TRIGGER on_item AFTER DELETE ON public.item FOR EACH ROW EXECUTE FUNCTION public.foreign_fn()"
        ),
      ]),
      applied: undefined,
      appSchemas: ["public", "simetra"],
      parse: await loadSqlParser(),
    })
    expect(found).toEqual([])
  })
})

const PARTY_ID = uuid(7311)
const party = (data: object = {}) =>
  compiled({
    "catalogs/Party/Party.meta.json": catalog("Party", {
      id: PARTY_ID,
      codeLength: 9,
      ...data,
    }),
  })

const promotionOf = (objectId: string) => ({
  record: { objectId } as PromotionRecord,
  file: "plans/promotion.json",
})

describe("numberingNotGenerated", () => {
  it("warns about numbering on a table the plan creates", async () => {
    const model = await party()
    expect(
      numberingNotGenerated({ model, live: catalogOf([]), promotions: [] })
    ).toEqual([
      expect.objectContaining({
        code: "plan.numbering-not-generated",
        severity: "warning",
        params: { object: "Party", table: "public.party" },
      }),
    ])
  })

  it("is silent without autonumber", async () => {
    const model = await party({ autonumber: false })
    expect(
      numberingNotGenerated({ model, live: catalogOf([]), promotions: [] })
    ).toEqual([])
  })

  it("is silent on a table the target already has", async () => {
    const model = await party()
    const live = { ...catalogOf([]), ...catalogFromSnapshot(model.physical) }
    expect(numberingNotGenerated({ model, live, promotions: [] })).toEqual([])
  })

  it("warns about a promotion target", async () => {
    const model = await party()
    const live = { ...catalogOf([]), ...catalogFromSnapshot(model.physical) }
    expect(
      numberingNotGenerated({
        model,
        live,
        promotions: [promotionOf(PARTY_ID)],
      })
    ).toHaveLength(1)
  })
})
