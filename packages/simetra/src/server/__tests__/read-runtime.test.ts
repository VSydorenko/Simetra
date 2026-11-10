import {
  runtimeCatalogSchema,
  type ReadPart,
  type ReadQuery,
} from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  createCommandRuntime,
  type CommandRuntime,
  type CommandRuntimeOptions,
} from "../runtime"
import { fakeDatabase, failureOf, type Answer } from "./fake-database"
import {
  ID,
  LINK,
  OTHER,
  TASK,
  catalog,
  client,
  commandObject,
  linkCatalog,
  rootCatalog,
  taskCatalog,
} from "./fixtures"
import {
  EPOCH,
  OPEN,
  READ_BEGIN,
  RIGHTS,
  ROLLBACK,
  ORGANIZATION,
  answer,
  create,
  readSetup,
  session,
  setup,
  statementTimeout,
  type Override,
} from "./harness"

// Профіль без ролі запиту: таблиця T0 підмінна, щоб правило §6.11
// перевірялося без гілки за іменем провайдера.
const purposes = vi.hoisted(() => ({ supabase: ["user"] as string[] }))
vi.mock("simetra/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("simetra/model")>()),
  LOGIN_ROLE_REQUEST_PURPOSES: purposes,
}))
afterEach(() => {
  purposes.supabase = ["user"]
})

// Роль запиту профілю supabase; запасний шлях — роль команд (`readSetup`).
const REQUEST_ROLE = "authenticated"
const COMMIT = { text: "COMMIT", params: [] }
// Оператор читання — за таблицею: створення рантайму теж шле `SELECT`.
const READ = 'FROM "public"."rights_role" t'
const isRead = (text: string) => text.includes(READ)
const CARD = `SELECT to_jsonb(t)::text AS row ${READ}`
const LIST = `SELECT jsonb_build_object('id', t."id", 'version', t."version", 'code', t."code")::text AS row ${READ}`
const byId = {
  text: `${CARD} WHERE t."id" = $1::uuid LIMIT 1`,
  params: [OTHER],
}
const byCode = {
  text: `${LIST} WHERE (t."code" = $1::text AND t."id" > $2::uuid) ORDER BY t."id" LIMIT $3`,
  params: ["R", ID, "200"],
}
const page: ReadQuery = {
  object: RIGHTS,
  where: {
    and: [
      { attribute: "code", op: "eq", value: "R" },
      { attribute: "ref", op: "gt", value: ID },
    ],
  },
  limit: 200,
}
const counted = {
  text: `SELECT count(*) AS n FROM (SELECT 1 ${READ} LIMIT $1) c`,
  params: ["10001"],
}
const rowOf = (id: string, version: number) => ({
  row: JSON.stringify({ id, version, code: "R" }),
})
const rows: Override = (text) =>
  isRead(text) ? { rows: [rowOf(OTHER, 2), rowOf(ID, 3)] } : undefined
/** Відкриття транзакції читання: `BEGIN`, налаштування, епоха. */
const opened = (role = REQUEST_ROLE) => [
  { connect: true },
  READ_BEGIN,
  readSetup(role),
  EPOCH,
]
const read = (
  statement: { text: string; params: string[] },
  role = "simetra_command"
) => [...opened(role), statement, COMMIT, { release: false }]
const failed = (statement: unknown, end: unknown[]) => [
  ...opened(),
  statement,
  ...end,
]

const R1 = "77777777-7777-4777-8777-777777777777"
const linkCard = {
  text: `SELECT to_jsonb(t)::text AS row FROM "public"."link" t WHERE t."id" = $1::uuid LIMIT 1`,
  params: [ID],
}
const regions = {
  text:
    `SELECT jsonb_build_object('id', t."id", 'version', t."version", 'code', t."code")::text` +
    ` AS row FROM "public"."region" t WHERE "id" = ANY(ARRAY[$1::uuid])`,
  params: [R1],
}

// Довідник з лінивим реквізитом: фільтр за ним — відмова до бази (Рд25).
const DOC = { kind: "Catalog" as const, name: "Doc" }
const docCatalog = runtimeCatalogSchema.parse({
  ...catalog,
  objects: [
    ...catalog.objects,
    commandObject({
      id: "00000000-0000-4000-8000-000000000020",
      name: "Doc",
      table: "doc",
      attributes: [
        {
          ...client.attributes[0]!,
          name: "body",
          column: "body",
          type: "Text",
          load: "lazy",
        },
      ],
    }),
  ],
})

/** Значення, будь-яке читання якого кидає. */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  return proxy
}

describe("CommandRuntime.read", () => {
  it("reads under the request role of the profile and decodes the rows", async () => {
    const { db, runtime } = await setup(rows)
    expect(await runtime.read(session, page)).toEqual({
      rows: [
        { ref: OTHER, version: 2, code: "R" },
        { ref: ID, version: 3, code: "R" },
      ],
    })
    expect(db.calls).toEqual(read(byCode, REQUEST_ROLE))
  })

  it("reads a card as rows", async () => {
    const { runtime } = await setup((text) =>
      isRead(text) ? { rows: [rowOf(OTHER, 2)] } : undefined
    )
    expect(await runtime.read(session, { object: RIGHTS, id: OTHER })).toEqual({
      rows: [{ ref: OTHER, version: 2, code: "R" }],
    })
  })

  it.each<[string, string | number, object]>([
    ["a count", "3", { count: 3 }],
    ["a count at the cap", "10000", { count: 10_000 }],
    ["a count past the cap", "10001", { count: 10_000, capped: true }],
    ["a count as a number", 7, { count: 7 }],
  ])("reads %s", async (_, n, expected) => {
    const { db, runtime } = await setup((text) =>
      isRead(text) ? { rows: [{ n }] } : undefined
    )
    expect(
      await runtime.read(session, { object: RIGHTS, count: true })
    ).toEqual(expected)
    expect(db.calls).toEqual(read(counted, REQUEST_ROLE))
  })

  it("keeps the request role when readFallback is set but the membership exists", async () => {
    const { db, runtime } = await setup(rows, { readFallback: true })
    await runtime.read(session, { object: RIGHTS, id: OTHER })
    expect(db.calls).toEqual(read(byId, REQUEST_ROLE))
  })

  it("reads through the fallback path under readFallback without the membership", async () => {
    const { db, runtime } = await setup(
      (text, params) =>
        text.includes("pg_has_role")
          ? { rows: [{ member: "f" }] }
          : rows(text, params),
      { readFallback: true }
    )
    await runtime.read(session, { object: RIGHTS, id: OTHER })
    expect(db.calls).toEqual(read(byId))
  })

  it("reads through the fallback path for a profile without a request role", async () => {
    purposes.supabase = []
    const { db, runtime } = await setup(rows)
    await runtime.read(session, { object: RIGHTS, id: OTHER })
    expect(db.calls).toEqual(read(byId))
  })

  it.each([
    ["a limit over 200", { ...page, limit: 201 }, { path: "limit" }],
    [
      "an unknown attribute",
      { ...page, where: { attribute: "nope", op: "eq", value: 1 } },
      { path: "where.attribute" },
    ],
    [
      "a filter by a lazy attribute",
      {
        object: DOC,
        where: { attribute: "body", op: "eq", value: "x" },
        limit: 1,
      },
      { path: "where.attribute", reason: "lazy" },
    ],
    [
      "a P4-A query",
      { object: RIGHTS, where: {}, after: ID, limit: 1 },
      { path: "where" },
    ],
    [
      "an unknown object",
      { object: { kind: "Catalog", name: "Nope" }, id: ID },
      { path: "object" },
    ],
  ])(
    "rejects %s as command.invalid before the database",
    async (_, query, extra) => {
      const { db, runtime } = await setup(undefined, { catalog: docCatalog })
      // Шлях — відносно об'єкта запиту; невідомий об'єкт — без `object`.
      const { object } = query as { object: unknown }
      expect(await failureOf(runtime.read(session, query as never))).toEqual({
        code: "command.invalid",
        ...extra,
        ...(extra.path === "object" ? {} : { object }),
      })
      expect(db.calls).toEqual([])
    }
  )

  it.each([
    [
      "a pair whose type getter throws",
      "subject",
      {
        id: OTHER,
        get type(): string {
          throw new Error("trap")
        },
      },
    ],
    ["a revoked proxy as a pair", "subject", revoked()],
    ["a revoked proxy as a scalar", "code", revoked()],
  ])(
    "rejects %s in where as command.invalid before the database",
    async (_, name, value) => {
      const { db, runtime } = await setup(undefined, { catalog: taskCatalog })
      const where = { attribute: name, op: "eq" as const, value }
      const object = name === "code" ? RIGHTS : TASK
      expect(
        await failureOf(runtime.read(session, { object, where, limit: 1 }))
      ).toEqual({ code: "command.invalid", path: "where.value", object })
      expect(db.calls).toEqual([])
    }
  )

  it.each([
    ["without sub", { role: "authenticated" }],
    ["with an empty sub", { sub: "" }],
  ])(
    "rejects a session %s as command.unauthenticated before the database",
    async (_, claims) => {
      const { db, runtime } = await setup()
      expect(
        await failureOf(
          runtime.read(claims as never, { object: RIGHTS, id: OTHER })
        )
      ).toEqual({ code: "command.unauthenticated" })
      expect(db.calls).toEqual([])
    }
  )

  it("maps 22P02 of the read to command.invalid without logging", async () => {
    const { db, runtime, log } = await setup((text) =>
      isRead(text)
        ? { error: { code: "22P02", message: "bad input" } }
        : undefined
    )
    expect(
      await failureOf(runtime.read(session, { object: RIGHTS, id: OTHER }))
    ).toEqual({ code: "command.invalid" })
    expect(db.calls).toEqual(failed(byId, [ROLLBACK, { release: false }]))
    expect(log).not.toHaveBeenCalled()
  })

  it("takes the read statement_timeout from readStatementTimeoutMs", async () => {
    const { db, runtime } = await setup(rows, { readStatementTimeoutMs: 250 })
    await runtime.read(session, { object: RIGHTS, id: OTHER })
    expect(db.calls[2]).toEqual(readSetup(REQUEST_ROLE, "250"))
  })

  it("maps 57014 of the read to command.timeout without logging", async () => {
    const { db, runtime, log } = await setup((text) =>
      isRead(text)
        ? { error: { code: "57014", message: "canceling statement" } }
        : undefined
    )
    expect(
      await failureOf(runtime.read(session, { object: RIGHTS, id: OTHER }))
    ).toEqual({ code: "command.timeout" })
    expect(db.calls).toEqual(failed(byId, [ROLLBACK, { release: false }]))
    expect(log).not.toHaveBeenCalled()
  })

  it("maps an unknown database error to command.internal and logs it", async () => {
    const raw = { code: "XX000", message: "secret row data" }
    const { db, runtime, log } = await setup((text) =>
      isRead(text) ? { error: raw } : undefined
    )
    expect(
      await failureOf(runtime.read(session, { object: RIGHTS, id: OTHER }))
    ).toEqual({ code: "command.internal" })
    expect(db.calls).toEqual(failed(byId, [ROLLBACK, { release: false }]))
    expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
  })

  it.each(["40001", "40P01"])(
    "maps %s of the read to command.internal, logs it and does not retry",
    async (code) => {
      const raw = { code, message: "conflict" }
      const { db, runtime, log } = await setup((text) =>
        isRead(text) ? { error: raw } : undefined
      )
      expect(
        await failureOf(runtime.read(session, { object: RIGHTS, id: OTHER }))
      ).toEqual({ code: "command.internal" })
      expect(db.calls).toEqual(failed(byId, [ROLLBACK, { release: false }]))
      expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
    }
  )

  it("destroys the connection on a lost connection without ROLLBACK", async () => {
    const { db, runtime, log } = await setup((text) =>
      isRead(text) ? { error: { code: "08006", message: "gone" } } : undefined
    )
    expect(
      await failureOf(runtime.read(session, { object: RIGHTS, id: OTHER }))
    ).toEqual({ code: "command.unavailable" })
    expect(db.calls).toEqual(failed(byId, [{ release: true }]))
    expect(log).not.toHaveBeenCalled()
  })

  it("destroys the connection once when ROLLBACK fails too", async () => {
    const { db, runtime } = await setup((text) =>
      isRead(text)
        ? { error: { code: "XX000", message: "x" } }
        : text === ROLLBACK.text
          ? { error: { code: "XX000", message: "y" } }
          : undefined
    )
    await failureOf(runtime.read(session, { object: RIGHTS, id: OTHER }))
    expect(db.calls).toEqual(failed(byId, [ROLLBACK, { release: true }]))
  })

  it("maps a failed connect to command.unavailable and logs the original error", async () => {
    const raw = new Error("refused")
    const { db, runtime, log } = await setup(undefined, {}, raw)
    expect(
      await failureOf(runtime.read(session, { object: RIGHTS, id: OTHER }))
    ).toEqual({ code: "command.unavailable" })
    expect(db.calls).toEqual([{ connect: true }])
    expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
  })

  it("destroys the connection on a read error without SQLSTATE and logs it", async () => {
    const raw = new TypeError("driver bug")
    const { db, runtime, log } = await setup((text) =>
      isRead(text) ? { error: raw } : undefined
    )
    expect(
      await failureOf(runtime.read(session, { object: RIGHTS, id: OTHER }))
    ).toEqual({ code: "command.unavailable" })
    expect(db.calls).toEqual(failed(byId, [{ release: true }]))
    expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
  })

  it.each([
    [
      "a COMMIT answered ROLLBACK",
      (text: string): Answer | undefined =>
        text === COMMIT.text ? { command: "ROLLBACK" } : rows(text, []),
      read(byId, REQUEST_ROLE),
    ],
    [
      // Рядки декодуються до `COMMIT`: з них `include` бере id.
      "a row of the wrong shape",
      (text: string): Answer | undefined =>
        isRead(text) ? { rows: [{ row: 42 }] } : undefined,
      failed(byId, [ROLLBACK, { release: false }]),
    ],
  ])("fails %s as command.internal and logs it", async (_, override, calls) => {
    // Відповідь діє лише на читання: створення рантайму теж має `COMMIT`.
    let armed = false
    const { db, runtime, log } = await setup((text) =>
      armed ? override(text) : undefined
    )
    armed = true
    expect(
      await failureOf(runtime.read(session, { object: RIGHTS, id: OTHER }))
    ).toEqual({ code: "command.internal" })
    expect(db.calls).toEqual(calls)
    expect(log.mock.calls).toEqual([
      [{ kind: "database", error: expect.any(Error) }],
    ])
  })

  it("refuses lines over TABULAR_LINES_MAX as command.invalid with the section path", async () => {
    const line = { id: OTHER, parent_id: ID, line_number: 1 }
    const { db, runtime, log } = await setup(
      (text) =>
        text.includes('"public"."organization"')
          ? {
              rows: [
                {
                  owner_version: "1",
                  tabular: JSON.stringify({
                    sample_lines: Array.from({ length: 5001 }, () => line),
                  }),
                },
              ],
            }
          : undefined,
      { catalog: rootCatalog }
    )
    expect(
      await failureOf(
        runtime.read(session, {
          object: ORGANIZATION,
          tabularSection: "lines",
          owner: ID,
        })
      )
    ).toEqual({
      code: "command.invalid",
      reason: "tabular-too-large",
      path: "lines",
      object: ORGANIZATION,
    })
    expect(db.calls).toEqual([
      ...opened(),
      expect.objectContaining({ params: [ID, "5001"] }),
      COMMIT,
      { release: false },
    ])
    expect(log).not.toHaveBeenCalled()
  })

  describe("include", () => {
    const answers =
      (region: unknown): Override =>
      (text) =>
        text.includes('"public"."link"')
          ? {
              rows: [
                { row: JSON.stringify({ id: ID, version: 1, region_id: R1 }) },
              ],
            }
          : text.includes('"public"."region"')
            ? { rows: [{ row: region }] }
            : undefined
    const query = { object: LINK, id: ID, include: ["region"] }

    it("reads the targets by a second statement in the same transaction", async () => {
      const { db, runtime } = await setup(
        answers(JSON.stringify({ id: R1, version: 2, code: "N" })),
        { catalog: linkCatalog }
      )
      expect(await runtime.read(session, query)).toEqual({
        rows: [{ ref: ID, version: 1, region: R1 }],
        included: { "Catalog.Region": [{ ref: R1, version: 2, code: "N" }] },
      })
      expect(db.calls).toEqual([
        ...opened(),
        linkCard,
        regions,
        COMMIT,
        { release: false },
      ])
    })

    it("fails a target row of the wrong shape as a logged command.internal", async () => {
      const { db, runtime, log } = await setup(answers(42), {
        catalog: linkCatalog,
      })
      expect(await failureOf(runtime.read(session, query))).toEqual({
        code: "command.internal",
      })
      expect(db.calls).toEqual(
        failed(linkCard, [regions, ROLLBACK, { release: false }])
      )
      expect(log.mock.calls).toEqual([
        [{ kind: "database", error: expect.any(Error) }],
      ])
    })
  })

  it.each(["the same", "another"])(
    "rejects read of %s runtime inside a hook and fails the command",
    async (which) => {
      const otherDb = fakeDatabase({ query: (text) => answer(text) })
      const other: CommandRuntime = await createCommandRuntime({
        database: otherDb.database,
        catalog,
      })
      otherDb.calls.splice(0)
      const inner: unknown[] = []
      const { db, runtime } = await setup(undefined, {
        objectModules: {
          "Catalog.Client": {
            async beforeWrite({ draft }) {
              const target = which === "the same" ? runtime : other
              inner.push(
                await failureOf(
                  target.read(session, { object: RIGHTS, id: OTHER })
                )
              )
              return draft
            },
          },
        },
      })
      expect(await failureOf(runtime.run(session, create))).toEqual({
        code: "command.nested",
      })
      expect(inner).toEqual([{ code: "command.nested" }])
      expect(db.calls).toEqual([...OPEN, ROLLBACK, { release: false }])
      expect(otherDb.calls).toEqual([])
    }
  )
})

describe("CommandRuntime.readParts", () => {
  const R2 = "88888888-8888-4888-8888-888888888888"
  const R3 = "99999999-9999-4999-8999-999999999999"
  const HEX = "a".repeat(64)
  const card = (id: string): ReadPart => ({
    type: "query",
    query: { object: RIGHTS, id },
  })
  const cardOf = (id: string) => ({
    text: `${CARD} WHERE t."id" = $1::uuid LIMIT 1`,
    params: [id],
  })
  const valueOf = (id: string) => ({
    rows: [{ ref: id, version: 1, code: "R" }],
  })
  // Картка за ключем відповідає своїм рядком: частини видно за id.
  const cards: Override = (text, params) =>
    isRead(text) ? { rows: [rowOf(params[0]!, 1)] } : undefined
  /** Відповідь `answer` лише частині з ключем `id`; решта — `cards`. */
  const failing =
    (id: string, failure: Answer): Override =>
    (text, params) =>
      isRead(text) && params[0] === id ? failure : cards(text, params)
  const three = [card(OTHER), card(R2), card(R3)]
  const ok = (value: unknown) => ({ ok: true, value })
  const fail = (error: unknown) => ({ ok: false, error })
  const ABORTED = { code: "command.unavailable", reason: "batch-aborted" }
  const TIMEOUT = { code: "command.timeout" }

  it("reads every part in one REPEATABLE READ READ ONLY transaction: setup, epoch, a statement per part and target, COMMIT", async () => {
    const { db, runtime } = await setup(
      (text, params) =>
        text.includes("count(*)")
          ? { rows: [{ n: "3" }] }
          : text.includes('"public"."link"')
            ? {
                rows: [
                  {
                    row: JSON.stringify({ id: ID, version: 1, region_id: R1 }),
                  },
                ],
              }
            : text.includes('"public"."region"')
              ? {
                  rows: [
                    { row: JSON.stringify({ id: R1, version: 2, code: "N" }) },
                  ],
                }
              : cards(text, params),
      { catalog: linkCatalog }
    )
    expect(
      await runtime.readParts(session, [
        card(OTHER),
        { type: "query", query: { object: LINK, id: ID, include: ["region"] } },
        { type: "query", query: { object: RIGHTS, count: true } },
      ])
    ).toEqual({
      epoch: null,
      items: [
        ok(valueOf(OTHER)),
        ok({
          rows: [{ ref: ID, version: 1, region: R1 }],
          included: { "Catalog.Region": [{ ref: R1, version: 2, code: "N" }] },
        }),
        ok({ count: 3 }),
      ],
    })
    expect(db.calls).toEqual([
      ...opened(),
      cardOf(OTHER),
      linkCard,
      regions,
      counted,
      COMMIT,
      { release: false },
    ])
  })

  it("sets up the transaction in one statement: claims, time, bytea, limits, the role last", async () => {
    const { db, runtime } = await setup(cards)
    await runtime.readParts(session, [card(OTHER)])
    const { text } = db.calls[2] as { text: string }
    expect(
      [...text.matchAll(/set_config\('([^']+)'/g)].map((m) => m[1])
    ).toEqual([
      "request.jwt.claims",
      "TimeZone",
      "bytea_output",
      "statement_timeout",
      "transaction_timeout",
      "role",
    ])
    expect(text).toMatch(/set_config\('role', \$4, true\)$/)
    expect(db.calls[2]).toEqual(readSetup(REQUEST_ROLE))
  })

  it("returns the epoch of the epoch statement and renders known for it after that statement", async () => {
    const { db, runtime } = await setup((text, params) =>
      text.includes("row_version_epoch")
        ? { rows: [{ epoch: HEX }] }
        : text.includes("simetra_known")
          ? { rows: [{ row: "0" }] }
          : cards(text, params)
    )
    const result = await runtime.readParts(session, [
      { ...card(OTHER), known: { epoch: HEX, keys: [OTHER], versions: ["1"] } },
      {
        ...card(R2),
        known: { epoch: "b".repeat(64), keys: [R2], versions: ["1"] },
      },
    ])
    expect(result).toEqual({
      epoch: HEX,
      items: [ok({ rows: [{ known: 0 }] }), ok(valueOf(R2))],
    })
    // Епоха бази відома лише з оператора епохи: умовна проєкція — після нього.
    expect(db.calls.slice(0, 4)).toEqual(opened())
    expect((db.calls[4] as { text: string }).text).toContain("simetra_known")
    expect(db.calls[5]).toEqual(cardOf(R2))
  })

  it.each<[string, Answer]>([
    ["an epoch that is not 64 hex", { rows: [{ epoch: "zz" }] }],
    ["an epoch of the wrong type", { rows: [{ epoch: 42 }] }],
    ["no epoch row", { rows: [] }],
  ])(
    "fails every part on %s as a logged command.internal",
    async (_, epoch) => {
      const { db, runtime, log } = await setup((text, params) =>
        text.includes("row_version_epoch") ? epoch : cards(text, params)
      )
      expect(await runtime.readParts(session, [card(OTHER), card(R2)])).toEqual(
        {
          epoch: null,
          items: [
            fail({ code: "command.internal" }),
            fail({ code: "command.internal" }),
          ],
        }
      )
      expect(db.calls).toEqual([...opened(), ROLLBACK, { release: false }])
      expect(log.mock.calls).toEqual([
        [{ kind: "database", error: expect.any(Error) }],
      ])
    }
  )

  it("gives 57014 of the second of three parts command.timeout; the first keeps its rows, the third is batch-aborted", async () => {
    const { db, runtime, log } = await setup(
      failing(R2, { error: { code: "57014", message: "canceling statement" } })
    )
    expect(await runtime.readParts(session, three)).toEqual({
      epoch: null,
      items: [ok(valueOf(OTHER)), fail(TIMEOUT), fail(ABORTED)],
    })
    expect(db.calls).toEqual([
      ...opened(),
      cardOf(OTHER),
      cardOf(R2),
      ROLLBACK,
      { release: false },
    ])
    expect(log).not.toHaveBeenCalled()
  })

  it("gives 25P04 of a part command.timeout, aborts the rest and destroys the connection without ROLLBACK", async () => {
    const { db, runtime } = await setup(
      failing(R2, { error: { code: "25P04", message: "transaction timeout" } })
    )
    expect(await runtime.readParts(session, three)).toEqual({
      epoch: null,
      items: [ok(valueOf(OTHER)), fail(TIMEOUT), fail(ABORTED)],
    })
    expect(db.calls).toEqual([
      ...opened(),
      cardOf(OTHER),
      cardOf(R2),
      { release: true },
    ])
  })

  it("gives every part left on a lost connection command.unavailable and destroys it", async () => {
    const { db, runtime, log } = await setup(
      failing(R2, { error: { code: "08006", message: "gone" } })
    )
    expect(await runtime.readParts(session, three)).toEqual({
      epoch: null,
      items: [
        ok(valueOf(OTHER)),
        fail({ code: "command.unavailable" }),
        fail({ code: "command.unavailable" }),
      ],
    })
    expect(db.calls).toEqual([
      ...opened(),
      cardOf(OTHER),
      cardOf(R2),
      { release: true },
    ])
    expect(log).not.toHaveBeenCalled()
  })

  it.each<[string, Answer]>([
    ["an unknown database error", { error: { code: "XX000", message: "x" } }],
    ["a row of the wrong shape", { rows: [{ row: 42 }] }],
  ])(
    "fails a part on %s as a logged command.internal and aborts the rest",
    async (_, failure) => {
      const { db, runtime, log } = await setup(failing(R2, failure))
      expect(await runtime.readParts(session, three)).toEqual({
        epoch: null,
        items: [
          ok(valueOf(OTHER)),
          fail({ code: "command.internal" }),
          fail(ABORTED),
        ],
      })
      expect(db.calls).toEqual([
        ...opened(),
        cardOf(OTHER),
        cardOf(R2),
        ROLLBACK,
        { release: false },
      ])
      expect(log).toHaveBeenCalledTimes(1)
    }
  )

  it("refuses an invalid part alone, before the database, and reads the others", async () => {
    const { db, runtime } = await setup(cards)
    const invalid: ReadPart = { type: "query", query: { ...page, limit: 201 } }
    expect(
      await runtime.readParts(session, [card(OTHER), invalid, card(R2)])
    ).toEqual({
      epoch: null,
      items: [
        ok(valueOf(OTHER)),
        fail({ code: "command.invalid", path: "limit", object: RIGHTS }),
        ok(valueOf(R2)),
      ],
    })
    expect(db.calls).toEqual([
      ...opened(),
      cardOf(OTHER),
      cardOf(R2),
      COMMIT,
      { release: false },
    ])
  })

  it("keeps the refusal of an invalid part after a database error in a part before it", async () => {
    const { runtime } = await setup(
      failing(OTHER, { error: { code: "57014", message: "canceling" } })
    )
    const invalid: ReadPart = { type: "query", query: { ...page, limit: 201 } }
    expect(
      await runtime.readParts(session, [card(OTHER), invalid, card(R2)])
    ).toEqual({
      epoch: null,
      items: [
        fail(TIMEOUT),
        fail({ code: "command.invalid", path: "limit", object: RIGHTS }),
        fail(ABORTED),
      ],
    })
  })

  it.each<[string, Answer]>([
    ["the BEGIN", { error: { code: "08006", message: "gone" } }],
    ["the epoch statement", { error: { code: "08006", message: "gone" } }],
  ])(
    "gives every part command.unavailable when the connection is lost on %s",
    async (where, failure) => {
      // Не `BEGIN` взагалі: створення рантайму теж його шле.
      const marker =
        where === "the BEGIN" ? "REPEATABLE READ" : "row_version_epoch"
      const { db, runtime } = await setup((text, params) =>
        text.includes(marker) ? failure : cards(text, params)
      )
      expect(await runtime.readParts(session, [card(OTHER), card(R2)])).toEqual(
        {
          epoch: null,
          items: [
            fail({ code: "command.unavailable" }),
            fail({ code: "command.unavailable" }),
          ],
        }
      )
      expect(db.calls.at(-1)).toEqual({ release: true })
      expect(db.calls.some((c) => "text" in c && isRead(c.text))).toBe(false)
    }
  )

  it("gives every part command.unavailable on a failed connect and logs it once", async () => {
    const raw = new Error("refused")
    const { db, runtime, log } = await setup(undefined, {}, raw)
    expect(await runtime.readParts(session, [card(OTHER), card(R2)])).toEqual({
      epoch: null,
      items: [
        fail({ code: "command.unavailable" }),
        fail({ code: "command.unavailable" }),
      ],
    })
    expect(db.calls).toEqual([{ connect: true }])
    expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
  })

  it.each<[string, ReadPart[], boolean]>([
    [
      "32 statements of parts",
      Array.from({ length: 32 }, () => card(OTHER)),
      true,
    ],
    [
      "32 statements and an invalid part",
      [
        ...Array.from({ length: 32 }, () => card(OTHER)),
        { type: "query", query: { ...page, limit: 201 } },
      ],
      true,
    ],
    [
      "33 statements of parts",
      Array.from({ length: 33 }, () => card(OTHER)),
      false,
    ],
    [
      // Ціль `include` — свій оператор: 16 × 2 + 1.
      "33 statements with include targets",
      [
        ...Array.from({ length: 16 }, (): ReadPart => ({
          type: "query",
          query: { object: LINK, id: ID, include: ["region"] },
        })),
        card(OTHER),
      ],
      false,
    ],
  ])(
    "bounds the statements by READ_BATCH_STATEMENTS_MAX: %s",
    async (_, parts, accepted) => {
      const { db, runtime } = await setup(cards, { catalog: linkCatalog })
      const read = runtime.readParts(session, parts)
      if (accepted) {
        await read
        expect(db.calls.length).toBe(4 + 32 + 2)
      } else {
        expect(await failureOf(read)).toEqual({
          code: "command.invalid",
          reason: "batch-too-large",
        })
        expect(db.calls).toEqual([])
      }
    }
  )

  it("stops at the part fit reports as overflow: the parts after it are batch-budget without their statements", async () => {
    const { db, runtime } = await setup(cards)
    const fit = vi.fn((index: number) =>
      index === 1 ? ("overflow" as const) : ("accept" as const)
    )
    expect(await runtime.readParts(session, three, { fit })).toEqual({
      epoch: null,
      items: [
        ok(valueOf(OTHER)),
        ok(valueOf(R2)),
        fail({ code: "command.unavailable", reason: "batch-budget" }),
      ],
    })
    expect(fit.mock.calls).toEqual([
      [0, valueOf(OTHER)],
      [1, valueOf(R2)],
    ])
    expect(db.calls).toEqual([
      ...opened(),
      cardOf(OTHER),
      cardOf(R2),
      COMMIT,
      { release: false },
    ])
  })

  it("answers no parts without the database", async () => {
    const { db, runtime } = await setup()
    expect(await runtime.readParts(session, [])).toEqual({
      epoch: null,
      items: [],
    })
    expect(db.calls).toEqual([])
  })

  it("rejects a session without sub as command.unauthenticated before the database", async () => {
    const { db, runtime } = await setup()
    expect(
      await failureOf(
        runtime.readParts({ role: "authenticated" } as never, [card(OTHER)])
      )
    ).toEqual({ code: "command.unauthenticated" })
    expect(db.calls).toEqual([])
  })

  describe("time budget", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["performance", "setTimeout"] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    /** Час «минає» на відповіді бази оператору, для якого `when` істинне. */
    const elapse =
      (
        when: (text: string, params: readonly (string | null)[]) => boolean,
        ms: number
      ): Override =>
      (text, params) => {
        if (when(text, params)) vi.advanceTimersByTime(ms)
        return cards(text, params)
      }
    const atEpoch = (text: string) => text.includes("row_version_epoch")

    it("lowers statement_timeout before a part once the rest is under the ceiling", async () => {
      const { db, runtime } = await setup(elapse(atEpoch, 5000))
      await runtime.readParts(session, [card(OTHER), card(R2)])
      // Другій частині залишок не менший за чинні 10 000 мс — без прелюдії.
      expect(db.calls).toEqual([
        ...opened(),
        statementTimeout("10000"),
        cardOf(OTHER),
        cardOf(R2),
        COMMIT,
        { release: false },
      ])
    })

    it("never sets 0: a rest of 1.2 ms rounds up to 2", async () => {
      const { db, runtime } = await setup(elapse(atEpoch, 14_998.8))
      await runtime.readParts(session, [card(OTHER)])
      expect(db.calls[4]).toEqual(statementTimeout("2"))
    })

    it.each<[string, Partial<CommandRuntimeOptions>, string, string]>([
      ["a budget over the ceiling", { readBudgetMs: 20_000 }, "15000", "21000"],
      ["a budget under the ceiling", { readBudgetMs: 5000 }, "5000", "6000"],
      ["a lower ceiling", { readStatementTimeoutMs: 250 }, "250", "16000"],
    ])(
      "takes the ceiling and the transaction_timeout guard from the options: %s",
      async (_, options, statement, guard) => {
        const { db, runtime } = await setup(elapse(atEpoch, 3000), options)
        await runtime.readParts(session, [card(OTHER)])
        expect(db.calls[2]).toEqual(readSetup(REQUEST_ROLE, statement, guard))
        // Залишок 17 с і 12 с не нижчий за стелю 15 000 і 250 мс; 2 с — нижчий.
        expect(db.calls[4]).toEqual(
          options.readBudgetMs === 5000
            ? statementTimeout("2000")
            : cardOf(OTHER)
        )
      }
    )

    it.each([
      ["at the deadline", 14_999.6],
      ["past the deadline", 15_010],
    ])(
      "gives the parts %s command.timeout without their statements",
      async (_, ms) => {
        const { db, runtime } = await setup(elapse(atEpoch, ms))
        expect(
          await runtime.readParts(session, [card(OTHER), card(R2)])
        ).toEqual({ epoch: null, items: [fail(TIMEOUT), fail(TIMEOUT)] })
        expect(db.calls).toEqual([...opened(), COMMIT, { release: false }])
      }
    )

    it("keeps the rows of a part read before the deadline", async () => {
      const { db, runtime } = await setup(
        elapse((text, params) => isRead(text) && params[0] === OTHER, 15_000)
      )
      expect(await runtime.readParts(session, three)).toEqual({
        epoch: null,
        items: [ok(valueOf(OTHER)), fail(TIMEOUT), fail(TIMEOUT)],
      })
      expect(db.calls).toEqual([
        ...opened(),
        cardOf(OTHER),
        COMMIT,
        { release: false },
      ])
    })

    it("checks the deadline before an include target too", async () => {
      const { db, runtime } = await setup(
        (text, params) => {
          if (text.includes('"public"."link"')) {
            vi.advanceTimersByTime(15_000)
            return {
              rows: [
                { row: JSON.stringify({ id: ID, version: 1, region_id: R1 }) },
              ],
            }
          }
          return cards(text, params)
        },
        { catalog: linkCatalog }
      )
      expect(
        await runtime.readParts(session, [
          {
            type: "query",
            query: { object: LINK, id: ID, include: ["region"] },
          },
          card(OTHER),
        ])
      ).toEqual({ epoch: null, items: [fail(TIMEOUT), fail(TIMEOUT)] })
      expect(db.calls).toEqual([
        ...opened(),
        linkCard,
        COMMIT,
        { release: false },
      ])
    })
  })
})
