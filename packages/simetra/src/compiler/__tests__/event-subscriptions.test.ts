import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { attribute, catalog, metaFiles, project, uuid } from "./helpers"

const SUBSCRIPTION = "event-subscriptions/StampContract/StampContract.meta.json"
const HANDLER_FILE = "sql/app/stamp.sql"
const HANDLER_SQL =
  "CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$;"

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(7001),
    kind: "EventSubscription",
    name: "StampContract",
    physicalName: "stamp_contract",
    sources: [{ kind: "Catalog", name: "Contract" }],
    event: "beforeWrite",
    whenChanged: ["number"],
    handler: { schema: "app", name: "stamp" },
    ...overrides,
  }
}

function entries(
  overrides: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    "project.meta.json": project(),
    "catalogs/Contract/Contract.meta.json": catalog("Contract", {
      attributes: [attribute("number", { type: "String", length: 20 })],
    }),
    [SUBSCRIPTION]: subscription(overrides),
    [HANDLER_FILE]: HANDLER_SQL,
    ...extra,
  }
}

const codes = async (files: Record<string, unknown>) =>
  (await compile(metaFiles(files))).diagnostics.map((d) => [
    d.code,
    d.file,
    d.pointer,
  ])

describe("EventSubscription", () => {
  it("a subscription on a catalog compiles into a trigger contract", async () => {
    const result = await compile(metaFiles(entries()))
    expect(result.diagnostics).toEqual([])
    expect(result.model!.contracts.eventSubscriptions).toEqual([
      {
        subscriptionId: uuid(7001),
        name: "stamp_contract",
        sources: [
          { schema: "public", table: "contract", whenChanged: ["number"] },
        ],
        event: "beforeWrite",
        handler: { schema: "app", name: "stamp" },
      },
    ])
  })

  it("names standard attributes and provider preset columns in whenChanged", async () => {
    const result = await compile(
      metaFiles(
        entries(
          {
            sources: [{ providerTable: "auth.users" }],
            event: "onWrite",
            whenChanged: ["email", "phone"],
            handler: { name: "on_user" },
          },
          {
            "sql/public/on-user.sql":
              "CREATE FUNCTION public.on_user() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$;",
          }
        )
      )
    )
    expect(result.diagnostics).toEqual([])
    expect(result.model!.contracts.eventSubscriptions[0]).toMatchObject({
      sources: [
        { schema: "auth", table: "users", whenChanged: ["email", "phone"] },
      ],
      handler: { schema: "public", name: "on_user" },
    })
    const standard = await compile(
      metaFiles(entries({ whenChanged: ["description", "code"] }))
    )
    expect(standard.diagnostics).toEqual([])
    expect(
      standard.model!.contracts.eventSubscriptions[0]!.sources[0]!.whenChanged
    ).toEqual(["description", "code"])
  })

  it("provider table source must be in the provider preset", async () => {
    expect(
      await codes(entries({ sources: [{ providerTable: "auth.sessions" }] }))
    ).toEqual([
      ["subscription.provider-table-unknown", SUBSCRIPTION, "/sources/0"],
    ])
  })

  it("whenChanged names an attribute of every source", async () => {
    expect(
      await codes(
        entries(
          {
            sources: [
              { kind: "Catalog", name: "Contract" },
              { kind: "Catalog", name: "Partner" },
              { providerTable: "auth.users" },
            ],
          },
          { "catalogs/Partner/Partner.meta.json": catalog("Partner") }
        )
      )
    ).toEqual([
      ["subscription.when-changed-unknown", SUBSCRIPTION, "/whenChanged/0"],
      ["subscription.when-changed-unknown", SUBSCRIPTION, "/whenChanged/0"],
    ])
  })

  it("each source carries its own physical whenChanged columns", async () => {
    const result = await compile(
      metaFiles(
        entries(
          {
            sources: [
              { kind: "Catalog", name: "Contract" },
              { kind: "Catalog", name: "Partner" },
            ],
          },
          {
            "catalogs/Partner/Partner.meta.json": catalog("Partner", {
              attributes: [
                attribute("number", {
                  physicalName: "partner_number",
                  type: "String",
                  length: 20,
                }),
              ],
            }),
          }
        )
      )
    )
    expect(result.diagnostics).toEqual([])
    expect(result.model!.contracts.eventSubscriptions[0]!.sources).toEqual([
      { schema: "public", table: "contract", whenChanged: ["number"] },
      { schema: "public", table: "partner", whenChanged: ["partner_number"] },
    ])
  })

  it("a polymorphic attribute watches both pair columns", async () => {
    const result = await compile(
      metaFiles(
        entries(
          { whenChanged: ["party"] },
          {
            "catalogs/Contract/Contract.meta.json": catalog("Contract", {
              attributes: [
                attribute("party", {
                  type: "Ref",
                  allowedTypes: [
                    { kind: "Catalog", name: "Contract" },
                    { kind: "Catalog", name: "Partner" },
                  ],
                }),
              ],
            }),
            "catalogs/Partner/Partner.meta.json": catalog("Partner"),
          }
        )
      )
    )
    expect(result.diagnostics).toEqual([])
    expect(
      result.model!.contracts.eventSubscriptions[0]!.sources[0]!.whenChanged
    ).toEqual(["party_type", "party_id"])
  })

  it("a source and a whenChanged name are listed once", async () => {
    expect(
      await codes(
        entries({
          sources: [
            { kind: "Catalog", name: "Contract" },
            { providerTable: "auth.users" },
            { kind: "Catalog", name: "Contract" },
            { providerTable: "auth.users" },
          ],
          whenChanged: undefined,
        })
      )
    ).toEqual([
      ["subscription.source-duplicate", SUBSCRIPTION, "/sources/2"],
      ["subscription.source-duplicate", SUBSCRIPTION, "/sources/3"],
    ])
    expect(await codes(entries({ whenChanged: ["number", "number"] }))).toEqual(
      [["subscription.when-changed-duplicate", SUBSCRIPTION, "/whenChanged/1"]]
    )
  })

  it("two subscriptions cannot share a trigger base name", async () => {
    const other = "event-subscriptions/StampAgain/StampAgain.meta.json"
    expect(
      await codes(
        entries(
          {},
          {
            [other]: subscription({
              id: uuid(7003),
              name: "StampAgain",
              physicalName: "stamp_contract",
              whenChanged: undefined,
            }),
          }
        )
      )
    ).toEqual([
      // Помилку отримує пізніший за шляхом файл.
      ["subscription.name-duplicate", SUBSCRIPTION, "/physicalName"],
    ])
  })

  it("whenChanged with a delete event is an error", async () => {
    expect(await codes(entries({ event: "onDelete" }))).toEqual([
      ["subscription.when-changed-on-delete", SUBSCRIPTION, "/whenChanged"],
    ])
    expect(
      await codes(entries({ event: "beforeDelete", whenChanged: undefined }))
    ).toEqual([])
  })

  it("handler must exist, take no arguments and return trigger", async () => {
    expect(await codes(entries({}, { [HANDLER_FILE]: "" }))).toEqual([
      ["subscription.handler-missing", SUBSCRIPTION, "/handler"],
    ])
    const signature = async (sql: string) =>
      (await compile(metaFiles(entries({}, { [HANDLER_FILE]: sql }))))
        .diagnostics
    const withArgs = await signature(
      "CREATE FUNCTION app.stamp(a int) RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN RETURN NEW; END $$;"
    )
    expect(withArgs.map((d) => [d.code, d.params?.problem])).toEqual([
      ["subscription.handler-signature", "it takes arguments"],
    ])
    const notTrigger = await signature(
      "CREATE FUNCTION app.stamp() RETURNS int LANGUAGE sql VOLATILE AS $$ SELECT 1 $$;"
    )
    expect(notTrigger.map((d) => [d.code, d.params?.problem])).toEqual([
      ["subscription.handler-signature", "it does not return trigger"],
    ])
  })

  it("a handler outside the closed shell is an error even in a shared file", async () => {
    // Обробник не буває боргом (рішення 8 плану промоції 2b): без переліку
    // боргу звітує саме його правило, а не `sql.debt-grows`.
    const found = async (sql: string) =>
      (
        await compile(metaFiles(entries({}, { [HANDLER_FILE]: sql })))
      ).diagnostics.map((d) => [d.code, d.file, d.pointer, d.params?.problem])
    expect(
      await found(
        "CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;"
      )
    ).toEqual([
      [
        "subscription.handler-not-closed",
        SUBSCRIPTION,
        "/handler",
        "volatility",
      ],
    ])
    expect(
      await found(
        "CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$;"
      )
    ).toEqual([
      [
        "subscription.handler-not-closed",
        SUBSCRIPTION,
        "/handler",
        "searchPath",
      ],
    ])
  })

  it("a subscription on an enumeration is an error", async () => {
    expect(
      await codes(
        entries(
          {
            sources: [{ kind: "Enumeration", name: "Color" }],
            whenChanged: undefined,
          },
          {
            "enumerations/Color/Color.meta.json": {
              id: uuid(7002),
              kind: "Enumeration",
              name: "Color",
              physicalName: "color",
              values: [],
            },
          }
        )
      )
    ).toEqual([["subscription.source-not-table", SUBSCRIPTION, "/sources/0"]])
  })

  it("the trigger base name is assigned once", async () => {
    const result = await compile(
      metaFiles(entries({ physicalName: "stamp_contract_v2" })),
      { baseline: metaFiles(entries()) }
    )
    expect(
      result.diagnostics.map((d) => [d.code, d.file, d.pointer, d.params])
    ).toEqual([
      [
        "identity.assigned-once-changed",
        SUBSCRIPTION,
        "/physicalName",
        {
          field: "physicalName",
          before: "stamp_contract",
          after: "stamp_contract_v2",
        },
      ],
    ])
  })

  it("a subscription cannot be referenced", async () => {
    expect(
      await codes(
        entries(
          {},
          {
            "catalogs/Contract/Contract.meta.json": catalog("Contract", {
              attributes: [
                attribute("number", { type: "String", length: 20 }),
                attribute("hook", {
                  type: "Ref",
                  ref: { kind: "EventSubscription", name: "StampContract" },
                }),
              ],
            }),
          }
        )
      )
    ).toEqual([
      [
        "reference.not-referenceable",
        "catalogs/Contract/Contract.meta.json",
        "/attributes/1/ref",
      ],
    ])
  })
})
