import { runtimeCatalogSchema, type ReadQuery } from "simetra/model"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createCommandRuntime, type CommandRuntime } from "../runtime"
import { fakeDatabase, failureOf, type Answer } from "./fake-database"
import {
  ID,
  OTHER,
  TASK,
  catalog,
  client,
  commandObject,
  taskCatalog,
} from "./fixtures"
import {
  CLAIMS,
  OPEN,
  RIGHTS,
  ROLE,
  ROLLBACK,
  answer,
  create,
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
  text: `${CARD} WHERE "id" = $1::uuid LIMIT 1`,
  params: [OTHER],
}
const byCode = {
  text: `${LIST} WHERE ("code" = $1::text AND "id" > $2::uuid) ORDER BY "id" LIMIT $3`,
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
  CLAIMS,
  role,
  statement,
  COMMIT,
  { release: false },
]
const failed = (statement: unknown, end: unknown[]) => [
  { connect: true },
  BEGIN,
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
      expect(await failureOf(runtime.read(session, query as never))).toEqual({
        code: "command.invalid",
        ...extra,
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
      ).toEqual({ code: "command.invalid", path: "where.value" })
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
    ],
    [
      "a row of the wrong shape",
      (text: string): Answer | undefined =>
        isRead(text) ? { rows: [{ row: 42 }] } : undefined,
    ],
  ])("fails %s as command.internal and logs it", async (_, override) => {
    // Відповідь діє лише на читання: створення рантайму теж має `COMMIT`.
    let armed = false
    const { db, runtime, log } = await setup((text) =>
      armed ? override(text) : undefined
    )
    armed = true
    expect(
      await failureOf(runtime.read(session, { object: RIGHTS, id: OTHER }))
    ).toEqual({ code: "command.internal" })
    expect(db.calls).toEqual(read(byId, REQUEST_ROLE))
    expect(log.mock.calls).toEqual([
      [{ kind: "database", error: expect.any(Error) }],
    ])
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
