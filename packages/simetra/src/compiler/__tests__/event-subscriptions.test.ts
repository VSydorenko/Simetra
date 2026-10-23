import { describe, expect, it } from "vitest"
import { makeObjectName } from "simetra/model"
import { compile } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  metaFiles,
  project,
  uuid,
} from "./helpers"
import {
  COUNT_COMMENT_FILE,
  COUNT_COMMENT_SQL_FILE,
  policyDomain,
} from "./fixtures/rights"

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

  it("whenChanged checks the length of the second trigger name", async () => {
    // 60 байтів: саме ім'я влазить у 63, а `<ім'я>_insert` — ні.
    const long = "s".repeat(60)
    expect(
      (
        await compile(metaFiles(entries({ physicalName: long })))
      ).diagnostics.map((d) => [d.code, d.file, d.pointer, d.params])
    ).toEqual([
      [
        "physical.name-too-long",
        SUBSCRIPTION,
        "/physicalName",
        { name: `${long}_insert` },
      ],
    ])
    expect(
      await codes(entries({ physicalName: long, whenChanged: undefined }))
    ).toEqual([])
    // Подія видалення тригера вставки не дає: лише помилка `whenChanged`.
    expect(
      await codes(entries({ physicalName: long, event: "onDelete" }))
    ).toEqual([
      ["subscription.when-changed-on-delete", SUBSCRIPTION, "/whenChanged"],
    ])
  })

  it("whenChanged cannot list a column the row mechanics maintains", async () => {
    expect(await codes(entries({ whenChanged: ["version"] }))).toEqual([
      ["subscription.when-changed-mechanics", SUBSCRIPTION, "/whenChanged/0"],
    ])
    expect(
      await codes(entries({ whenChanged: ["number", "updatedAt"] }))
    ).toEqual([
      ["subscription.when-changed-mechanics", SUBSCRIPTION, "/whenChanged/1"],
    ])
    // Стиль проєкту: `origin.standard` несе стилізоване ім'я.
    expect(
      await codes({
        ...entries({ whenChanged: ["updated_at"] }),
        "project.meta.json": project({
          naming: { attributeCase: "snake_case" },
        }),
      })
    ).toEqual([
      ["subscription.when-changed-mechanics", SUBSCRIPTION, "/whenChanged/0"],
    ])
  })

  it("whenChanged may list a CustomTable's own version and updated_at columns", async () => {
    // Механіку впізнає `origin.standard`, а не ім'я: власні колонки таблиці
    // з тими самими іменами механіка не тримає
    const own = (
      name: string,
      physicalName: string,
      n: number,
      type: string
    ) => ({
      id: uuid(n),
      name,
      physicalName,
      type,
    })
    expect(
      await codes(
        entries(
          {
            sources: [{ kind: "CustomTable", name: "Ledger" }],
            whenChanged: ["version", "updatedAt"],
          },
          {
            "custom-tables/Ledger/Ledger.meta.json": customTable("Ledger", {
              columns: [
                { ...own("id", "id", 7111, "UUID"), notNull: true },
                own("version", "version", 7112, "Integer"),
                own("updatedAt", "updated_at", 7113, "DateTime"),
              ],
            }),
          }
        )
      )
    ).toEqual([])
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

  it("a handler with dynamic SQL or an unparsable body is not closed", async () => {
    const found = async (body: string) =>
      (
        await compile(
          metaFiles(
            entries(
              {},
              {
                [HANDLER_FILE]: `CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ ${body} $$;`,
              }
            )
          )
        )
      ).diagnostics.map((d) => [d.code, d.pointer, d.params?.problem])
    expect(await found("BEGIN EXECUTE 'select 1'; RETURN NEW; END")).toEqual([
      ["subscription.handler-not-closed", "/handler", "dynamicSql"],
    ])
    expect(await found("BEGIN SELEKT 1; RETURN NEW; END")).toEqual([
      ["subscription.handler-not-closed", "/handler", "body"],
    ])
  })

  describe("a beforeWrite handler leaves the row mechanics alone", () => {
    const handler = (body: string) =>
      `CREATE FUNCTION app.stamp() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ ${body} $$;`
    const found = async (
      body: string,
      overrides: Record<string, unknown> = {},
      extra: Record<string, unknown> = {}
    ) =>
      (
        await compile(
          metaFiles(
            entries(overrides, { [HANDLER_FILE]: handler(body), ...extra })
          )
        )
      ).diagnostics.map((d) => [d.code, d.file, d.pointer, d.params?.problem])
    const assigns = (problem: string) => [
      [
        "subscription.handler-assigns-mechanics",
        SUBSCRIPTION,
        "/handler",
        problem,
      ],
    ]

    it.each([
      ["BEGIN NEW.version := 1; RETURN NEW; END", "new.version"],
      ["BEGIN NEW.Updated_At := now(); RETURN NEW; END", "new.updated_at"],
      ["BEGIN NEW := OLD; RETURN NEW; END", "new"],
      ["BEGIN SELECT OLD.* INTO NEW; RETURN NEW; END", "new"],
      // Postgres приймає поле запису ціллю GET DIAGNOSTICS.
      [
        "BEGIN GET DIAGNOSTICS NEW.version = ROW_COUNT; RETURN NEW; END",
        "new.version",
      ],
      [
        "DECLARE r record; BEGIN r := NEW; r.version := 5; RETURN r; END",
        "RETURN r",
      ],
      ["BEGIN RETURN OLD; END", "RETURN OLD"],
      // Псевдонім дерево не несе зовсім, а змінна `new` затіняє запис тригера:
      // `RETURN new` тоді повертає інше, ніж бачить перевірка.
      [
        "DECLARE new ALIAS FOR OLD; BEGIN RETURN new; END",
        "declares a variable named NEW",
      ],
      [
        "BEGIN DECLARE new app.t := OLD; BEGIN RETURN new; END; END",
        "declares a variable named NEW",
      ],
      // Параметр `INOUT` процедури пише в аргумент без цілі в дереві.
      [
        "BEGIN CALL app.bump(NEW.version); RETURN NEW; END",
        "CALL app.bump(NEW.version)",
      ],
      ["BEGIN CALL app.swap(NEW); RETURN NEW; END", "CALL app.swap(NEW)"],
      // `INTO` у безіменний рядок: ціль — розв'язана змінна, а не текст автора.
      [
        "DECLARE r ALIAS FOR NEW; BEGIN SELECT 1 INTO r.version; RETURN NEW; END",
        "new.version",
      ],
      [
        "DECLARE a int; r ALIAS FOR NEW; BEGIN SELECT 1, 2 INTO a, r.version; RETURN NEW; END",
        "new.version",
      ],
      [
        "DECLARE c CURSOR FOR SELECT 1; r ALIAS FOR NEW; BEGIN OPEN c; FETCH c INTO r.version; RETURN NEW; END",
        "new.version",
      ],
      [
        "DECLARE a int; c CURSOR FOR SELECT 1, 2; r ALIAS FOR NEW; BEGIN OPEN c; FETCH c INTO a, r.version; RETURN NEW; END",
        "new.version",
      ],
      [
        "<<b>> DECLARE a int; r ALIAS FOR NEW; BEGIN SELECT 1, 2 INTO a, b.r.version; RETURN NEW; END",
        "new.version",
      ],
      [
        "DECLARE r ALIAS FOR NEW; BEGIN INSERT INTO app.log (n) VALUES (1) RETURNING n INTO r.version; RETURN NEW; END",
        "new.version",
      ],
      // Ціль псевдоніма дерево не зберігає, а `NEW` живе й під міткою функції.
      [
        "DECLARE r ALIAS FOR NEW; BEGIN CALL app.bump(r.version); RETURN NEW; END",
        "CALL app.bump(r.version)",
      ],
      [
        "BEGIN CALL app.bump(stamp.new.version); RETURN NEW; END",
        "CALL app.bump(stamp.new.version)",
      ],
      [
        "BEGIN CALL app.swap(stamp.new); RETURN NEW; END",
        "CALL app.swap(stamp.new)",
      ],
    ])("%s", async (body, problem) => {
      expect(await found(body)).toEqual(assigns(problem))
    })

    it("dynamic SQL INTO NEW is stopped by the closed shell first", async () => {
      expect(
        await found("BEGIN EXECUTE 'SELECT 1' INTO NEW; RETURN NEW; END")
      ).toEqual([
        [
          "subscription.handler-not-closed",
          SUBSCRIPTION,
          "/handler",
          "dynamicSql",
        ],
      ])
    })

    it("an unparsable body is stopped by the closed shell", async () => {
      expect(
        await found("BEGIN SELEKT 1; NEW.version := 1; RETURN NEW; END")
      ).toEqual([
        ["subscription.handler-not-closed", SUBSCRIPTION, "/handler", "body"],
      ])
    })

    it("other columns of NEW, RETURN NEW and RETURN NULL are fine", async () => {
      expect(
        await found("BEGIN NEW.number := upper(NEW.number); RETURN NEW; END")
      ).toEqual([])
      expect(
        await found("BEGIN CALL app.log(NEW.number); RETURN NEW; END")
      ).toEqual([])
      expect(
        await found(
          "BEGIN IF NEW.number = '' THEN RETURN NULL; END IF; RETURN NEW; END"
        )
      ).toEqual([])
    })

    it("an AFTER event or a source without mechanics is not checked", async () => {
      const body = "BEGIN NEW.version := 1; RETURN OLD; END"
      expect(await found(body, { event: "onWrite" })).toEqual([])
      expect(
        await found(
          body,
          {
            sources: [{ kind: "CustomTable", name: "Ledger" }],
            whenChanged: undefined,
          },
          {
            // Власна колонка `version` таблиці — не механіка.
            "custom-tables/Ledger/Ledger.meta.json": customTable("Ledger", {
              columns: [
                {
                  id: uuid(7101),
                  name: "id",
                  physicalName: "id",
                  type: "UUID",
                  notNull: true,
                },
                {
                  id: uuid(7102),
                  name: "version",
                  physicalName: "version",
                  type: "Integer",
                },
              ],
            }),
          }
        )
      ).toEqual([])
    })

    it("a handler shared with a beforeWrite subscription on mechanics is checked", async () => {
      const other = "event-subscriptions/AuditContract/AuditContract.meta.json"
      expect(
        await found(
          "BEGIN NEW.version := 1; RETURN NEW; END",
          { event: "onWrite" },
          {
            [other]: subscription({
              id: uuid(7002),
              name: "AuditContract",
              physicalName: "audit_contract",
            }),
          }
        )
      ).toEqual([
        [
          "subscription.handler-assigns-mechanics",
          other,
          "/handler",
          "new.version",
        ],
      ])
    })

    describe("and the rights carrier copies", () => {
      // Копія шляху `TaskComment` (власність через `task`) і її перший крок.
      const COPY = makeObjectName("task_id", undefined, "assignee_id")
      const carrierFound = async (body: string, event = "beforeWrite") => {
        const files = policyDomain({ [COUNT_COMMENT_FILE]: { event } })
        files.set(
          COUNT_COMMENT_SQL_FILE,
          `CREATE FUNCTION public.count_comment() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ ${body} $$;`
        )
        return (await compile(files)).diagnostics.map((d) => [
          d.code,
          d.file,
          d.pointer,
          d.params?.column,
        ])
      }
      const at = (code: string, column: string) => [
        code,
        COUNT_COMMENT_FILE,
        "/handler",
        column,
      ]
      const assigns = (column: string) => [
        at("subscription.handler-assigns-carrier", column),
      ]
      const reads = (column: string) => [
        at("subscription.handler-reads-carrier", column),
      ]

      it.each([
        [`BEGIN NEW.${COPY} := NULL; RETURN NEW; END`, assigns(COPY)],
        ["BEGIN NEW.task_id := NULL; RETURN NEW; END", assigns("task_id")],
        // Параметр `INOUT` процедури пише в перший крок шляху.
        [
          "BEGIN CALL public.bump(NEW.task_id); RETURN NEW; END",
          assigns("task_id"),
        ],
        [
          `BEGIN IF NEW.${COPY} IS NULL THEN RETURN NULL; END IF; RETURN NEW; END`,
          reads(COPY),
        ],
        [`BEGIN NEW.description := NEW.${COPY}; RETURN NEW; END`, reads(COPY)],
        [
          `BEGIN INSERT INTO public.comment_counter (comment_id) VALUES (NEW.${COPY}); RETURN NEW; END`,
          reads(COPY),
        ],
        [`DECLARE c uuid := NEW.${COPY}; BEGIN RETURN NEW; END`, reads(COPY)],
        // Запис цілком — звичайний патерн журналу; копії в ньому не читаються
        // як окреме значення.
        ["BEGIN PERFORM public.log(to_jsonb(NEW)); RETURN NEW; END", []],
        ["BEGIN PERFORM public.log(NEW); RETURN NEW; END", []],
        ["DECLARE r record; BEGIN SELECT NEW.* INTO r; RETURN NEW; END", []],
        [
          "BEGIN NEW.description := upper(NEW.description); RETURN NEW; END",
          [],
        ],
      ])("%s", async (body, expected) => {
        expect(await carrierFound(body)).toEqual(expected)
      })

      it("an AFTER handler is not checked: Postgres ignores its row", async () => {
        expect(
          await carrierFound(
            `BEGIN NEW.task_id := NEW.${COPY}; RETURN NEW; END`,
            "onWrite"
          )
        ).toEqual([])
      })
    })
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
