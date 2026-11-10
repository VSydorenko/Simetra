import { runtimeCatalogSchema, type ReadQuery } from "simetra/model"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandRuntime, type CommandRuntime } from "../runtime"
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
  CLAIMS,
  OPEN,
  RIGHTS,
  ROLE,
  ROLLBACK,
  ORGANIZATION,
  READ_TIMEOUT,
  answer,
  create,
  readTimeout,
  session,
  setup,
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

const BEGIN = {
  text: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  params: [],
}
const REQUEST_ROLE = { text: 'SET LOCAL ROLE "authenticated"', params: [] }
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
const read = (statement: { text: string; params: string[] }, role = ROLE) => [
  { connect: true },
  BEGIN,
  READ_TIMEOUT,
  CLAIMS,
  role,
  statement,
  COMMIT,
  { release: false },
]
const failed = (statement: unknown, end: unknown[]) => [
  { connect: true },
  BEGIN,
  READ_TIMEOUT,
  CLAIMS,
  REQUEST_ROLE,
  statement,
  ...end,
]

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
    expect(db.calls[2]).toEqual(readTimeout("250"))
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
      { connect: true },
      BEGIN,
      READ_TIMEOUT,
      CLAIMS,
      REQUEST_ROLE,
      expect.objectContaining({ params: [ID, "5001"] }),
      COMMIT,
      { release: false },
    ])
    expect(log).not.toHaveBeenCalled()
  })

  describe("include", () => {
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
        { connect: true },
        BEGIN,
        READ_TIMEOUT,
        CLAIMS,
        REQUEST_ROLE,
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
