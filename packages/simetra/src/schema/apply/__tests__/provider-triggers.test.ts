import { describe, expect, it } from "vitest"
import {
  compile,
  loadSqlParser,
  type CompiledModel,
  type PromotionRecord,
} from "simetra/compiler"
import { catalogFromSnapshot, type CatalogModel } from "simetra/model"
import {
  appliedCatalog,
  numberingNotGenerated,
  providerTriggerConflicts,
  providerTriggerKey,
} from "simetra/schema"
import {
  catalog,
  document,
  metaFiles,
  project,
  uuid,
} from "../../../compiler/__tests__/helpers"

/**
 * Перевірки плану перед кроками (спека промоції §9.2): чужий тригер
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

const parser = await loadSqlParser()

/** Застосований каталог marker з цими одиницями — так, як його читає план. */
const appliedOf = (units: CatalogModel["units"]) =>
  appliedCatalog(catalogOf(units), parser)

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
      present: new Set(),
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
      applied: appliedOf([FOREIGN_ON_USER]),
      appSchemas: ["public", "simetra"],
      present: new Set(),
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
      present: new Set(),
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
      present: new Set(),
      parse: await loadSqlParser(),
    })
    expect(found).toEqual([])
  })

  it("takes a function name without a schema for another function", async () => {
    // Витяг двигуна ставить `search_path` у `pg_catalog`, тож живий текст
    // завжди кваліфікує функцію схемою; ім'я без схеми — інше дерево, і
    // тотожний тригер хибної відмови не дає лише завдяки цій кваліфікації
    const model = await withSubscriptions()
    const found = providerTriggerConflicts({
      desired: model.sqlUnits,
      live: catalogOf([
        trigger(
          "auth",
          "users",
          "on_user",
          "CREATE TRIGGER on_user AFTER INSERT OR UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION on_user()"
        ),
      ]),
      applied: undefined,
      appSchemas: ["public", "simetra"],
      present: new Set(),
      parse: await loadSqlParser(),
    })
    expect(found.map((d) => d.code)).toEqual(["plan.provider-trigger-taken"])
  })

  describe("whenChanged on a varchar column of the provider table", () => {
    // `pg_get_triggerdef` друкує умову над `varchar` з `::text`, генератор —
    // без нього: тотожний тригер не мусить ставати «чужим»
    const withColumns = (whenChanged: string[]) =>
      compiled({
        ...subscription(7303, "OnUser", {
          physicalName: "on_user",
          sources: [{ providerTable: "auth.users" }],
          event: "onWrite",
          whenChanged,
          handler: { schema: "public", name: "on_user" },
        }),
        "sql/public/handlers.sql": HANDLER,
      })
    const conflicts = async (when: string, whenChanged = ["email"]) =>
      providerTriggerConflicts({
        desired: (await withColumns(whenChanged)).sqlUnits,
        live: catalogOf([
          trigger(
            "auth",
            "users",
            "on_user",
            `CREATE TRIGGER on_user AFTER UPDATE ON auth.users FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION public.on_user()`
          ),
        ]),
        applied: undefined,
        appSchemas: ["public", "simetra"],
        present: new Set(),
        parse: await loadSqlParser(),
      }).map((d) => d.code)

    it("takes the live ::text form for the same trigger", async () => {
      expect(
        await conflicts(
          "((old.email)::text IS DISTINCT FROM (new.email)::text)"
        )
      ).toEqual([])
    })

    it("still refuses a trigger that differs in something else", async () => {
      expect(
        await conflicts(
          "((old.phone)::text IS DISTINCT FROM (new.phone)::text)"
        )
      ).toEqual(["plan.provider-trigger-taken"])
      expect(
        await conflicts(
          "((old.email)::integer IS DISTINCT FROM (new.email)::integer)"
        )
      ).toEqual(["plan.provider-trigger-taken"])
    })

    it("takes the live ::text form of several columns joined by OR", async () => {
      expect(
        await conflicts(
          "(((old.email)::text IS DISTINCT FROM (new.email)::text) OR ((old.phone)::text IS DISTINCT FROM (new.phone)::text))",
          ["email", "phone"]
        )
      ).toEqual([])
    })

    it("still refuses when one disjunct names another column", async () => {
      expect(
        await conflicts(
          "(((old.email)::text IS DISTINCT FROM (new.email)::text) OR ((old.role)::text IS DISTINCT FROM (new.role)::text))",
          ["email", "phone"]
        )
      ).toEqual(["plan.provider-trigger-taken"])
    })
  })

  describe("a name taken outside the boundary", () => {
    // Свідок не бачить тригера, функція якого у схемі провайдера: базова
    // політика його виключає, а засів тіні переносить. Зайнятість імені — з
    // каталогу цілі
    const conflicts = async (
      present: string[],
      applied?: ReturnType<typeof appliedOf>
    ) =>
      providerTriggerConflicts({
        desired: (await withSubscriptions()).sqlUnits,
        live: catalogOf([]),
        applied,
        appSchemas: ["public", "simetra"],
        present: new Set(present),
        parse: await loadSqlParser(),
      })

    it("refuses a generated name the catalog holds on the same table", async () => {
      expect(
        await conflicts([
          providerTriggerKey({ schema: "auth", name: "users" }, "on_user"),
        ])
      ).toEqual([
        expect.objectContaining({
          code: "plan.provider-trigger-taken",
          params: { trigger: "on_user", table: "auth.users" },
        }),
      ])
    })

    it("lets the name pass on another table", async () => {
      expect(
        await conflicts([
          providerTriggerKey({ schema: "auth", name: "identities" }, "on_user"),
        ])
      ).toEqual([])
    })
  })

  describe("the applied catalog of a marker (decision R10)", () => {
    // Таблиця провайдера `better_auth."user"`: ключове слово — у лапках за
    // правилом ідентичності, а marker, записаний до нього, тримає
    // `trigger:better_auth.user.on_user`
    const onUser = () =>
      compiled({
        "project.meta.json": project({ database: { provider: "postgres" } }),
        ...subscription(7304, "OnUser", {
          physicalName: "on_user",
          sources: [{ providerTable: "better_auth.user" }],
          event: "onWrite",
          handler: { schema: "public", name: "on_user" },
        }),
        "sql/public/handlers.sql": HANDLER,
      })
    /** Наш тригер у попередньому визначенні: його змінює звичайний крок. */
    const EARLIER =
      'CREATE TRIGGER on_user AFTER INSERT ON better_auth."user" FOR EACH ROW EXECUTE FUNCTION public.on_user()'
    const STORED = {
      ...trigger("better_auth", "user", "on_user", EARLIER),
      identity: "trigger:better_auth.user.on_user",
    }
    const LIVE = {
      ...trigger("better_auth", "user", "on_user", EARLIER),
      identity: 'trigger:better_auth."user".on_user',
    }
    const conflicts = async (
      live: CatalogModel["units"],
      applied: CatalogModel["units"]
    ) =>
      providerTriggerConflicts({
        desired: (await onUser()).sqlUnits,
        live: catalogOf(live),
        applied: appliedOf(applied),
        appSchemas: ["public", "simetra"],
        present: new Set(),
        parse: parser,
      })

    it("sees its own trigger recorded in the older identity form", async () => {
      expect(await conflicts([LIVE], [STORED])).toEqual([])
    })

    it("lets a trigger the target does not have pass with an unreadable unit", async () => {
      // Ні живого тригера, ні імені в каталогі: займати нічого, тож нечитна
      // одиниця marker відмови не дає
      expect(
        await conflicts([], [trigger("app", "t", "x", "CREATE TRIGGER x ???")])
      ).toEqual([])
    })

    it("refuses the identical live trigger when a marker unit does not read", async () => {
      // Без нечитної одиниці тотожний тригер пропускається; з нею тотожність
      // не доводить, що тригер наш
      const desired = (await onUser()).sqlUnits.find(
        (u) => u.class === "trigger" && u.name === "on_user"
      )!
      const same = { ...LIVE, sql: desired.sql }
      expect(await conflicts([same], [])).toEqual([])
      expect(
        await conflicts(
          [same],
          [trigger("app", "t", "x", "CREATE TRIGGER x ???")]
        )
      ).toEqual([
        expect.objectContaining({
          code: "plan.provider-trigger-taken",
          params: { trigger: "on_user", table: "better_auth.user" },
        }),
      ])
    })
  })

  it("refuses when the live trigger text does not parse", async () => {
    // Не розібраний текст не доводить тотожності: обережно — відмова
    const model = await withSubscriptions()
    const found = providerTriggerConflicts({
      desired: model.sqlUnits,
      live: catalogOf([
        trigger("auth", "users", "on_user", "CREATE TRIGGER on_user ???"),
      ]),
      applied: undefined,
      appSchemas: ["public", "simetra"],
      present: new Set(),
      parse: await loadSqlParser(),
    })
    expect(found).toEqual([
      expect.objectContaining({
        code: "plan.provider-trigger-taken",
        params: { trigger: "on_user", table: "auth.users" },
      }),
    ])
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

  it("warns about the numbering of a new document", async () => {
    const model = await compiled({
      "documents/Sale/Sale.meta.json": document("Sale", { id: uuid(7312) }),
    })
    expect(
      numberingNotGenerated({ model, live: catalogOf([]), promotions: [] })
    ).toEqual([
      expect.objectContaining({
        code: "plan.numbering-not-generated",
        severity: "warning",
        params: { object: "Sale", table: "public.sale" },
      }),
    ])
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
