import { beforeAll, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { EventSubscriptionContract } from "../contracts"
import { mechanicsTriggerName } from "../mechanics-units"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import {
  buildSubscriptionUnits,
  subscriptionTriggerNames,
} from "../subscription-units"
import {
  acceptDebt,
  attribute,
  catalog,
  metaFiles,
  project,
  uuid,
} from "./helpers"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const SUBSCRIPTION_ID = uuid(7101)

function contract(
  overrides: Partial<EventSubscriptionContract> = {}
): EventSubscriptionContract {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    name: "audit",
    sources: [{ schema: "public", table: "item", whenChanged: [] }],
    event: "beforeWrite",
    handler: { schema: "app", name: "h" },
    ...overrides,
  }
}

const sqlOf = (c: EventSubscriptionContract) =>
  buildSubscriptionUnits([c], "TestApp", parse).map((u) => u.sql)

describe("buildSubscriptionUnits", () => {
  it("beforeWrite without whenChanged gives one BEFORE INSERT OR UPDATE trigger", () => {
    const units = buildSubscriptionUnits([contract()], "TestApp", parse)
    expect(units.map((u) => [u.identity, u.sql])).toEqual([
      [
        "trigger:public.item.audit",
        "CREATE TRIGGER audit BEFORE INSERT OR UPDATE ON public.item FOR EACH ROW EXECUTE FUNCTION app.h();",
      ],
    ])
    expect(units[0]).toMatchObject({
      class: "trigger",
      generator: "subscription",
      ownerObjectId: SUBSCRIPTION_ID,
      module: "TestApp",
    })
    expect(units[0]!.file).toBeUndefined()
  })

  it.each([
    ["onWrite", "AFTER INSERT OR UPDATE"],
    ["beforeDelete", "BEFORE DELETE"],
    ["onDelete", "AFTER DELETE"],
  ] as const)("%s maps to %s", (event, timing) => {
    expect(sqlOf(contract({ event }))).toEqual([
      `CREATE TRIGGER audit ${timing} ON public.item FOR EACH ROW EXECUTE FUNCTION app.h();`,
    ])
  })

  it("whenChanged gives an UPDATE trigger with the condition and a separate INSERT trigger", () => {
    const c = contract({
      sources: [{ schema: "public", table: "item", whenChanged: ["a", "b"] }],
    })
    expect(subscriptionTriggerNames(c, c.sources[0]!)).toEqual([
      "audit",
      "audit_insert",
    ])
    const units = buildSubscriptionUnits([c], "TestApp", parse)
    expect(units.map((u) => [u.identity, u.sql])).toEqual([
      [
        "trigger:public.item.audit",
        "CREATE TRIGGER audit BEFORE UPDATE ON public.item FOR EACH ROW WHEN ((OLD.a IS DISTINCT FROM NEW.a) OR (OLD.b IS DISTINCT FROM NEW.b)) EXECUTE FUNCTION app.h();",
      ],
      [
        "trigger:public.item.audit_insert",
        "CREATE TRIGGER audit_insert BEFORE INSERT ON public.item FOR EACH ROW EXECUTE FUNCTION app.h();",
      ],
    ])
  })

  it("a delete event gets no insert trigger name", () => {
    const c = contract({
      event: "onDelete",
      sources: [{ schema: "public", table: "item", whenChanged: ["a"] }],
    })
    expect(subscriptionTriggerNames(c, c.sources[0]!)).toEqual(["audit"])
  })

  it("two sources give the same names on both tables, distinct identities", () => {
    const c = contract({
      event: "onWrite",
      sources: [
        { schema: "public", table: "item", whenChanged: [] },
        { schema: "public", table: "partner", whenChanged: [] },
      ],
    })
    const units = buildSubscriptionUnits([c], "TestApp", parse)
    expect(units.map((u) => [u.identity, u.name])).toEqual([
      ["trigger:public.item.audit", "audit"],
      ["trigger:public.partner.audit", "audit"],
    ])
  })

  it("a provider table source puts the trigger on auth.users", () => {
    expect(
      sqlOf(
        contract({
          event: "onWrite",
          sources: [{ schema: "auth", table: "users", whenChanged: [] }],
        })
      )
    ).toEqual([
      "CREATE TRIGGER audit AFTER INSERT OR UPDATE ON auth.users FOR EACH ROW EXECUTE FUNCTION app.h();",
    ])
  })
})

const SUBSCRIPTION = "event-subscriptions/Audit/Audit.meta.json"
const HANDLER =
  "CREATE FUNCTION app.h() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN RETURN NEW; END $$;"

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: SUBSCRIPTION_ID,
    kind: "EventSubscription",
    name: "Audit",
    physicalName: "audit",
    sources: [{ kind: "Catalog", name: "Item" }],
    event: "beforeWrite",
    handler: { schema: "app", name: "h" },
    ...overrides,
  }
}

function entries(
  overrides: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    "project.meta.json": project(),
    "catalogs/Item/Item.meta.json": catalog("Item", {
      attributes: [attribute("price", { type: "Integer" })],
    }),
    [SUBSCRIPTION]: subscription(overrides),
    "sql/app/h.sql": HANDLER,
    ...extra,
  }
}

const found = async (files: Record<string, unknown>) =>
  (await compile(metaFiles(files))).diagnostics.map((d) => [
    d.code,
    d.file,
    d.pointer,
    d.params,
  ])

describe("subscription triggers in the compiled model", () => {
  it("the compiled model carries the subscription triggers", async () => {
    const result = await compile(metaFiles(entries({ whenChanged: ["price"] })))
    expect(result.diagnostics).toEqual([])
    expect(
      result
        .model!.sqlUnits.filter((u) => u.generator === "subscription")
        .map((u) => u.identity)
    ).toEqual(["trigger:public.item.audit", "trigger:public.item.audit_insert"])
  })

  it("a verbatim CREATE TRIGGER with the same name on the table is a duplicate", async () => {
    const result = await compile(
      await acceptDebt(
        metaFiles(
          entries(
            {},
            {
              "sql/app/units.sql":
                "CREATE TRIGGER audit BEFORE UPDATE ON public.item FOR EACH ROW EXECUTE FUNCTION app.h();\n",
            }
          )
        )
      )
    )
    const duplicate = result.diagnostics.find(
      (d) => d.code === "sql.unit-duplicate"
    )
    expect(duplicate?.params).toMatchObject({
      identity: "trigger:public.item.audit",
      first: "the event subscription Audit",
    })
  })

  it("audit_insert next to audit with whenChanged on the same table is taken", async () => {
    const other = "event-subscriptions/AuditInsert/AuditInsert.meta.json"
    expect(
      await found(
        entries(
          { whenChanged: ["price"] },
          {
            [other]: subscription({
              id: uuid(7102),
              name: "AuditInsert",
              physicalName: "audit_insert",
            }),
          }
        )
      )
    ).toEqual([
      [
        "subscription.trigger-name-taken",
        other,
        "/physicalName",
        {
          name: "audit_insert",
          table: "public.item",
          holder: "the event subscription Audit",
        },
      ],
    ])
  })

  it("the name of the row mechanics trigger is taken", async () => {
    expect(
      await found(entries({ physicalName: mechanicsTriggerName("item") }))
    ).toEqual([
      [
        "subscription.trigger-name-taken",
        SUBSCRIPTION,
        "/physicalName",
        {
          name: "item_simetra_touch",
          table: "public.item",
          holder: "the row mechanics of Item",
        },
      ],
    ])
  })

  it("the name of a platform layer trigger on auth.users is taken", async () => {
    expect(
      await found(
        entries(
          {
            physicalName: "simetra_provision_user",
            sources: [{ providerTable: "auth.users" }],
            event: "onWrite",
          },
          {
            "catalogs/Users/Users.meta.json": catalog("Users", {
              role: "users",
              scope: "none",
            }),
          }
        )
      )
    ).toEqual([
      [
        "subscription.trigger-name-taken",
        SUBSCRIPTION,
        "/physicalName",
        {
          name: "simetra_provision_user",
          table: "auth.users",
          holder: "the platform layer of Users",
        },
      ],
    ])
  })
})
