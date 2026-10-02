import type { EngineAction } from "simetra/schema"
import { describe, expect, it } from "vitest"
import { narrow } from "../tools/database-tools"
import { toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import type { DatabaseResource } from "../tools/types"
import { opts, project, useTmpProjects } from "./helpers/catalog"
import {
  DatabaseRefusal,
  classifyDatabaseError,
  connectionErrorMessage,
  databaseResource,
  describeConnection,
  withDatabase,
} from "../io/database"
import {
  ShadowCreateRefusedError,
  ShadowServerError,
  ShadowServerMismatchError,
} from "../schema-engine/errors"
import { shadowServerRefusal } from "../schema-engine/pg-delta/adapter"

/**
 * Облікові дані не витікають (план E2b, Review Focus 3): межа
 * `connectionErrorMessage` складає текст лише зі стабільних фраз, адреси
 * `host:port/db` і коду помилки. Рядки нижче досить незвичні, щоб пошук
 * підрядка доводив їхню відсутність.
 */
useTmpProjects()

const USER = "leaky_user_q7x"
const PASSWORD = "S3cret-pa55-Zq9"
const URL_ = `postgresql://${USER}:${PASSWORD}@db.example.test:6543/app_db`
const DESCRIBE = describeConnection(URL_)

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const leaks = (text: string) =>
  [USER, PASSWORD, URL_].filter((secret) => text.includes(secret))

describe("describeConnection", () => {
  it("shows host, port and database only", () => {
    expect(DESCRIBE).toBe("db.example.test:6543/app_db")
    expect(leaks(DESCRIBE)).toEqual([])
  })

  it("defaults the port and never quotes an unparsable string", () => {
    expect(describeConnection("postgres://u:p@h/db")).toBe("h:5432/db")
    expect(describeConnection(PASSWORD)).toBe("the configured database")
  })
})

describe("classifyDatabaseError", () => {
  const names = {
    target: DESCRIBE,
    shadow: "shadow.example.test:5432/postgres",
  }
  const refusals: [string, unknown, RegExp][] = [
    [
      "a bad password",
      pgError("28P01", `password authentication failed for user "${USER}"`),
      /^Authentication to the database at db\.example\.test:6543\/app_db failed/,
    ],
    [
      "another 28xxx",
      pgError("28000", `role "${USER}" is not permitted to log in`),
      /^Authentication to the database/,
    ],
    [
      "an unreachable host",
      pgError("ECONNREFUSED", `connect ECONNREFUSED ${URL_}`),
      /is unreachable \(ECONNREFUSED\)/,
    ],
    [
      "an unknown host",
      pgError("ENOTFOUND", `getaddrinfo ENOTFOUND ${USER}`),
      /is unreachable \(ENOTFOUND\)/,
    ],
    [
      "a connection exception 08xxx",
      pgError("08006", `connection failure ${URL_}`),
      /connection to the database at .* failed \(SQLSTATE 08006\)/,
    ],
    [
      "a missing database",
      pgError("3D000", `database "${PASSWORD}" does not exist`),
      /does not exist/,
    ],
    [
      "a missing privilege",
      pgError("42501", `permission denied for ${USER}`),
      /lacks a privilege .* \(SQLSTATE 42501\)/,
    ],
    [
      "an invalid URL",
      Object.assign(new TypeError(`Invalid URL ${URL_}`), {
        code: "ERR_INVALID_URL",
      }),
      /^The connection string is not a valid URL/,
    ],
    [
      "a lost connection without a code",
      new Error(`Connection terminated unexpectedly ${URL_}`),
      /was lost or timed out/,
    ],
    [
      "a connection timeout without a code",
      new Error("Connection terminated due to connection timeout"),
      /was lost or timed out/,
    ],
    [
      "a failed shadow cleanup",
      new AggregateError(
        [pgError("28P01", USER), new Error(PASSWORD)],
        `shadow run failed ${URL_}`
      ),
      /^Authentication to the database/,
    ],
    [
      "another major version of the shadow server",
      new ShadowServerMismatchError("safe mismatch text"),
      /^safe mismatch text$/,
    ],
    ["our own refusal", new DatabaseRefusal("safe text"), /^safe text$/],
  ]
  for (const [name, error, expected] of refusals) {
    it(`refuses ${name} with a redacted message`, () => {
      const c = classifyDatabaseError(error, names)
      expect(c.kind).toBe("refusal")
      const text = c.kind === "refusal" ? c.message : ""
      expect(text).toMatch(expected)
      expect(leaks(text)).toEqual([])
    })
  }

  const failures: [string, unknown, Record<string, string>][] = [
    [
      "a read-only violation",
      pgError("25006", `cannot execute CREATE TABLE ${URL_}`),
      { database: DESCRIBE, error: "Error", sqlstate: "25006" },
    ],
    [
      "an internal error",
      pgError("XX000", `boom ${PASSWORD}`),
      { database: DESCRIBE, error: "Error", sqlstate: "XX000" },
    ],
    [
      // П'ять літер, як SQLSTATE, але це код Node
      "a Node code shaped like a SQLSTATE",
      pgError("EPIPE", `write EPIPE ${URL_}`),
      { database: DESCRIBE, error: "Error EPIPE" },
    ],
    [
      "a TypeError that mentions a url",
      new TypeError(`cannot read url of ${URL_}`),
      { database: DESCRIBE, error: "TypeError" },
    ],
    [
      "an error without a code",
      new Error(`boom ${URL_}`),
      { database: DESCRIBE, error: "Error" },
    ],
    [
      "a non-error",
      `${USER}:${PASSWORD}`,
      { database: DESCRIBE, error: "unknown" },
    ],
  ]
  for (const [name, error, params] of failures) {
    it(`reports ${name} as a failure, not a refusal`, () => {
      expect(classifyDatabaseError(error, names)).toEqual({
        kind: "failure",
        params,
      })
      const text = connectionErrorMessage(error, DESCRIBE, "diff")
      expect(text).toMatch(/^The diff call to the database at /)
      expect(leaks(text)).toEqual([])
    })
  }

  it("names the server that failed to create the shadow", () => {
    const own = classifyDatabaseError(
      new ShadowCreateRefusedError(false),
      names
    )
    expect(own).toMatchObject({ kind: "refusal" })
    expect(own.kind === "refusal" && own.message).toContain(
      `created on ${DESCRIBE}: the connecting role lacks CREATEDB. Point --shadow-url-env`
    )
    const base = classifyDatabaseError(
      new ShadowCreateRefusedError(true),
      names
    )
    expect(base.kind === "refusal" && base.message).toContain(
      "created on shadow.example.test:5432/postgres: the connecting role lacks CREATEDB."
    )
  })

  it("describes a failure on the shadow server by its own address", () => {
    const unreachable = classifyDatabaseError(
      new ShadowServerError(pgError("ECONNREFUSED", URL_)),
      names
    )
    expect(unreachable.kind === "refusal" && unreachable.message).toContain(
      "The database at shadow.example.test:5432/postgres is unreachable"
    )
    expect(
      classifyDatabaseError(
        new ShadowServerError(pgError("XX000", USER)),
        names
      )
    ).toEqual({
      kind: "failure",
      params: {
        database: "shadow.example.test:5432/postgres",
        error: "Error",
        sqlstate: "XX000",
      },
    })
  })

  it("recognises our errors by class, not by name", () => {
    const impostor = new Error(`impostor ${PASSWORD}`)
    impostor.name = "ShadowServerMismatchError"
    expect(classifyDatabaseError(impostor, names)).toMatchObject({
      kind: "failure",
    })
  })
})

describe("databaseResource", () => {
  it("is absent without the variable named at launch", () => {
    expect(databaseResource({}, { url: "APP_DB" })).toBeUndefined()
    expect(databaseResource({ APP_DB: "" }, { url: "APP_DB" })).toBeUndefined()
    // Типова змінна не підміняє названу
    expect(
      databaseResource({ SIMETRA_DATABASE_URL: URL_ }, { url: "APP_DB" })
    ).toBeUndefined()
  })

  it("reads the named variable and describes it without credentials", async () => {
    const resource = databaseResource({ APP_DB: URL_ }, { url: "APP_DB" })!
    expect(resource.describe).toBe(DESCRIBE)
    expect(await resource.connect()).toEqual({
      target: { url: URL_ },
      describe: DESCRIBE,
    })
  })

  it("adds the shadow server named at launch", async () => {
    const resource = databaseResource(
      { APP_DB: URL_, APP_SHADOW: "postgres://s/x" },
      { url: "APP_DB", shadow: "APP_SHADOW" }
    )!
    expect((await resource.connect()).shadowBase).toEqual({
      url: "postgres://s/x",
    })
  })

  it("refuses a shadow variable named at launch but not set", async () => {
    const resource = databaseResource(
      { APP_DB: URL_ },
      { url: "APP_DB", shadow: "APP_SHADOW" }
    )!
    await expect(resource.connect()).rejects.toThrow(
      /APP_SHADOW named by --shadow-url-env is not set/
    )
  })
})

describe("withDatabase", () => {
  const resource = databaseResource({ APP_DB: URL_ }, { url: "APP_DB" })!

  it("turns a connection failure into a redacted refusal without a cause", async () => {
    const error = await withDatabase(resource, "diff", () =>
      Promise.reject(
        pgError("28P01", `password authentication failed for user "${USER}"`)
      )
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DatabaseRefusal)
    expect(leaks((error as Error).message)).toEqual([])
    expect((error as Error).cause).toBeUndefined()
  })

  it("turns a failure of the database work into a redacted diagnostic", async () => {
    const outcome = await withDatabase(resource, "diff", () =>
      Promise.reject(pgError("XX000", `internal error near ${URL_}`))
    )
    expect(outcome).toMatchObject({
      ok: false,
      diagnostic: {
        code: "database.failed",
        severity: "error",
        params: {
          tool: "diff",
          database: DESCRIBE,
          error: "Error",
          sqlstate: "XX000",
        },
      },
    })
    expect(leaks(JSON.stringify(outcome))).toEqual([])
  })

  it("lets a bug in the work through instead of reporting database.failed", async () => {
    const bug = new TypeError(
      "Cannot read properties of undefined (reading 'x')"
    )
    const error = await withDatabase(resource, "diff", () =>
      Promise.reject(bug)
    ).catch((e: unknown) => e)
    expect(error).toBe(bug)
  })

  it("still classifies a driver error without a code as database.failed", async () => {
    // Текст драйвера без коду (`Error`) лишається за межею: його не цитують
    const outcome = await withDatabase(resource, "diff", () =>
      Promise.reject(new Error(`Client error near ${URL_}`))
    )
    expect(outcome).toMatchObject({
      ok: false,
      diagnostic: { code: "database.failed" },
    })
    expect(leaks(JSON.stringify(outcome))).toEqual([])
  })

  it("describes a shadow-server failure with the shadow address", async () => {
    const withShadow = databaseResource(
      {
        APP_DB: URL_,
        APP_SHADOW: `postgres://${USER}:${PASSWORD}@sh.test:7000/x`,
      },
      { url: "APP_DB", shadow: "APP_SHADOW" }
    )!
    const error = await withDatabase(withShadow, "diff", () =>
      Promise.reject(new ShadowServerError(pgError("ECONNREFUSED", URL_)))
    ).catch((e: unknown) => e)
    expect((error as Error).message).toContain("The database at sh.test:7000/x")
    expect(leaks((error as Error).message)).toEqual([])
  })
})

describe("shadow on another server", () => {
  it("is accepted with the same major version", () => {
    expect(shadowServerRefusal(17, 17)).toBeUndefined()
  })

  it("is refused with another major version", () => {
    // Другого сервера іншої мажорної версії локально немає: перевірку
    // версії адаптер робить саме цією функцією, тож версії впорскуються
    expect(shadowServerRefusal(17, 16)).toBe(
      "The shadow server runs PostgreSQL 16, the target runs PostgreSQL 17; the shadow must run the same major version. Nothing changed."
    )
  })
})

describe("diff narrowed to tables", () => {
  const action = (
    over: Partial<EngineAction> & Pick<EngineAction, "sql">
  ): EngineAction => ({
    verb: "create",
    produces: [],
    consumes: [],
    destroys: [],
    transactionality: "transactional",
    lockClass: "accessExclusive",
    dataLoss: false,
    rewriteRisk: false,
    ...over,
  })
  // FK замовлення залежить від клієнта, але належить замовленню; GRANT не
  // має ні `produces`, ні `destroys` — його ціль лише в `consumes`
  const fk = action({
    sql: "alter table app.orders add constraint orders_customer_id_fkey …",
    produces: ["constraint:app.orders.orders_customer_id_fkey"],
    consumes: ["table:app.orders", "table:app.customer"],
  })
  const grant = action({
    sql: "grant select on app.customer to anon",
    verb: "alter",
    consumes: ["table:app.customer", "role:anon"],
  })
  const index = action({
    sql: "create index customer_name_idx on app.customer (name)",
    produces: ["index:app.customer_name_idx"],
    consumes: ["table:app.customer"],
  })
  const models = [
    {
      tables: [
        {
          schema: "app",
          name: "customer",
          columns: [],
          indexes: [{ name: "customer_name_idx" }],
        },
        { schema: "app", name: "orders", columns: [], indexes: [] },
      ],
      enumTypes: [],
      units: [],
    },
  ]
  const data = {
    plan: [fk, grant, index],
    differences: [
      {
        path: "tables.app.orders.foreignKeys.orders_customer_id_fkey",
        kind: "missing" as const,
        detail: "",
      },
      {
        path: "tables.app.customer.indexes.customer_name_idx",
        kind: "missing" as const,
        detail: "",
      },
      {
        path: "units.acl:(table:app.customer).anon",
        kind: "missing" as const,
        detail: "",
      },
    ],
    diagnostics: [],
  }

  it("keeps an action by what it creates or drops, not by what it depends on", () => {
    const customer = narrow(data, [{ schema: "app", name: "customer" }], models)
    expect(customer.plan).toEqual([grant, index])
    expect(customer.differences.map((d) => d.path)).toEqual([
      "tables.app.customer.indexes.customer_name_idx",
      "units.acl:(table:app.customer).anon",
    ])
    const orders = narrow(data, [{ schema: "app", name: "orders" }], models)
    expect(orders.plan).toEqual([fk])
    expect(orders.differences.map((d) => d.path)).toEqual([
      "tables.app.orders.foreignKeys.orders_customer_id_fkey",
    ])
  })
  describe("types and sequences of the named tables", () => {
    // Енам і послідовність адресуються схемою, а не таблицею: зв'язок з
    // таблицею дають колонки й одиниці обох моделей
    const table = (
      name: string,
      columns: {
        name: string
        type: string
        default?: string
        identity?: { generation: "always" | "byDefault"; sequence: string }
      }[]
    ) => ({ schema: "app", name, columns, indexes: [] })
    const desired = {
      tables: [
        table("orders", [
          {
            name: "id",
            type: "bigint",
            identity: {
              generation: "always" as const,
              sequence: "orders_id_seq",
            },
          },
          { name: "status", type: "app.order_status" },
          {
            name: "number",
            type: "integer",
            default: "nextval('app.order_number_seq'::regclass)",
          },
          { name: "line", type: "integer" },
        ]),
        table("customer", [{ name: "kind", type: "customer_kind[]" }]),
      ],
      enumTypes: [
        { schema: "app", name: "order_status", values: ["new", "done"] },
        { schema: "app", name: "customer_kind", values: ["a"] },
      ],
      units: [
        {
          class: "sequenceOwnedBy" as const,
          identity: "sequenceOwnedBy:app.order_line_seq",
          schema: "app",
          name: "order_line_seq",
          sql: 'ALTER SEQUENCE app.order_line_seq OWNED BY app."orders".line',
        },
        {
          class: "sequenceOwnedBy" as const,
          identity: "sequenceOwnedBy:app.customer_seq",
          schema: "app",
          name: "customer_seq",
          sql: "ALTER SEQUENCE app.customer_seq OWNED BY app.customer.id",
        },
      ],
    }
    // У живій базі колонки статусу ще немає: енам видно лише з бажаної моделі
    const target = {
      tables: [table("orders", []), table("customer", [])],
      enumTypes: [{ schema: "app", name: "order_status", values: ["new"] }],
      units: [],
    }
    const typeAction = (id: string) =>
      action({ sql: `alter type ${id}`, verb: "alter", produces: [id] })
    const seqAction = (id: string) =>
      action({ sql: `create sequence ${id}`, produces: [id] })
    const plan = [
      typeAction("type:app.order_status"),
      typeAction("type:app.customer_kind"),
      seqAction("sequence:app.orders_id_seq"),
      seqAction("sequence:app.order_number_seq"),
      seqAction("sequence:app.order_line_seq"),
      seqAction("sequence:app.customer_seq"),
    ]
    const difference = (path: string) => ({
      path,
      kind: "missing" as const,
      detail: "",
    })
    const differences = [
      difference("enumTypes.app.customer_kind"),
      difference("enumTypes.app.order_status"),
      difference("units.acl:(sequence:app.order_number_seq).anon"),
      difference("units.sequence:app.customer_seq"),
      difference("units.sequence:app.order_line_seq"),
      difference("units.sequenceOwnedBy:app.order_line_seq"),
    ]

    it("keeps the enum types and sequences of the named tables and drops the others", () => {
      const orders = narrow(
        { plan, differences, diagnostics: [] },
        [{ schema: "app", name: "orders" }],
        [target, desired]
      )
      expect(orders.plan.map((a) => a.produces[0])).toEqual([
        "type:app.order_status",
        "sequence:app.orders_id_seq",
        "sequence:app.order_number_seq",
        "sequence:app.order_line_seq",
      ])
      expect(orders.differences.map((d) => d.path)).toEqual([
        "enumTypes.app.order_status",
        "units.acl:(sequence:app.order_number_seq).anon",
        "units.sequence:app.order_line_seq",
        "units.sequenceOwnedBy:app.order_line_seq",
      ])
    })

    it("resolves an unqualified array of an enum type", () => {
      const customer = narrow(
        { plan, differences, diagnostics: [] },
        [{ schema: "app", name: "customer" }],
        [target, desired]
      )
      expect(customer.plan.map((a) => a.produces[0])).toEqual([
        "type:app.customer_kind",
        "sequence:app.customer_seq",
      ])
      expect(customer.differences.map((d) => d.path)).toEqual([
        "enumTypes.app.customer_kind",
        "units.sequence:app.customer_seq",
      ])
    })
  })
})

describe("database failures through the catalog", () => {
  const failing = (error: Error): DatabaseResource => ({
    describe: DESCRIBE,
    connect: () => Promise.reject(error),
  })

  it("a failure of the database work exits 1 with a redacted diagnostic", async () => {
    const dir = await project()
    const r = await invoke(
      toolByName("diff")!,
      {},
      {
        ...opts(dir),
        database: failing(pgError("XX000", `boom ${URL_}`)),
      }
    )
    expect(r.refusal).toBeUndefined()
    expect(r.ok).toBe(false)
    expect(r.diagnostics.map((d) => d.code)).toContain("database.failed")
    expect(leaks(JSON.stringify(r))).toEqual([])
  })

  it("a refused connection is a refusal", async () => {
    const dir = await project()
    const r = await invoke(
      toolByName("diff")!,
      {},
      {
        ...opts(dir),
        database: failing(
          pgError("28P01", `password authentication failed for user "${USER}"`)
        ),
      }
    )
    expect(r.refusal?.reason).toBe("refused")
    expect(leaks(JSON.stringify(r))).toEqual([])
  })
})
