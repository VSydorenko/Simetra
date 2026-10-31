import type { Operation } from "simetra/model"
import { describe, expect, it, vi } from "vitest"
import { createCommandRuntime } from "../runtime"
import { runAfterCommit, Transaction, type RuntimeState } from "../transaction"
import { fakeDatabase, failureOf, type Answer } from "./fake-database"
import {
  COMPANY,
  ID,
  OTHER,
  catalog,
  client,
  commandObject,
  rightsRole,
} from "./fixtures"
import {
  CLIENT,
  COMMIT,
  OPEN,
  RIGHTS,
  ROLLBACK,
  SAVE,
  answer,
  call,
  context,
  coreRow,
  create,
  createCall,
  session,
  setup,
} from "./harness"

describe("command transaction", () => {
  it("runs a create as the exact statement sequence", async () => {
    const { db, runtime } = await setup()
    const result = await runtime.run(session, create)
    expect(db.calls).toEqual([
      ...OPEN,
      context("create", "client", ID),
      createCall,
      COMMIT,
      { release: false },
    ])
    expect(result).toEqual({
      rows: [{ ref: ID, version: 1, code: "A", company: COMPANY }],
      changes: [
        {
          object: CLIENT,
          scopeKind: client.scopeKindId,
          scope: COMPANY,
          id: ID,
          version: 1,
          operation: "create",
        },
      ],
    })
  })

  it("runs a batch of two phases with one row per operation", async () => {
    const { db, runtime } = await setup((text) =>
      text.includes("mark_deletion")
        ? { rows: [{ r: coreRow(OTHER, 4) }] }
        : text.endsWith("AS r")
          ? { rows: [{ r: coreRow(ID, 3) }] }
          : undefined
    )
    const result = await runtime.run(session, [
      {
        action: "update",
        object: CLIENT,
        id: ID,
        expectedVersion: 2,
        values: { code: "A" },
      },
      {
        action: "markDeletion",
        object: CLIENT,
        id: OTHER,
        expectedVersion: 3,
        mark: true,
      },
    ])
    expect(db.calls).toEqual([
      ...OPEN,
      context("update", "client", ID),
      call("client_save", SAVE, [JSON.stringify({ id: ID, code: "A" }), "2"]),
      context("markDeletion", "client", OTHER),
      call("client_mark_deletion", "$1::uuid, $2::bigint, $3::boolean", [
        OTHER,
        "3",
        "true",
      ]),
      COMMIT,
      { release: false },
    ])
    expect(result.rows.map((r) => [r.ref, r.version])).toEqual([
      [ID, 3],
      [OTHER, 4],
    ])
    expect(result.changes.map((c) => [c.id, c.operation])).toEqual([
      [ID, "update"],
      [OTHER, "markDeletion"],
    ])
  })

  it("calls delete with the id and the version", async () => {
    const { db, runtime } = await setup()
    await runtime.run(session, {
      action: "delete",
      object: CLIENT,
      id: ID,
      expectedVersion: 5,
    })
    expect(db.calls).toEqual([
      ...OPEN,
      context("delete", "client", ID),
      call("client_delete", "$1::uuid, $2::bigint", [ID, "5"]),
      COMMIT,
      { release: false },
    ])
  })

  it("sets administerRights and a NULL version on a rights catalog create", async () => {
    const { db, runtime } = await setup()
    const result = await runtime.run(session, {
      action: "create",
      object: RIGHTS,
      id: ID,
      values: { code: "R" },
    })
    expect(db.calls).toEqual([
      ...OPEN,
      context("administerRights", "rights_role", ID),
      call("rights_role_save", SAVE, [
        JSON.stringify({ id: ID, code: "R" }),
        null,
      ]),
      COMMIT,
      { release: false },
    ])
    // Нескоуплений об'єкт — без скоупу в наборі змін.
    expect(result.changes).toEqual([
      { object: RIGHTS, id: ID, version: 1, operation: "create" },
    ])
    expect(rightsRole.scopeColumn).toBeUndefined()
  })

  it.each<[string, unknown, string | undefined]>([
    [
      "create with expectedVersion",
      { ...create, expectedVersion: 1 },
      undefined,
    ],
    [
      "update without expectedVersion",
      { ...create, action: "update" },
      "expectedVersion",
    ],
    [
      "markDeletion without mark",
      { action: "markDeletion", object: CLIENT, id: ID, expectedVersion: 1 },
      "mark",
    ],
    [
      "delete without id",
      { action: "delete", object: CLIENT, expectedVersion: 1 },
      "id",
    ],
    [
      "an action outside the operations",
      { ...create, action: "administerRights" },
      "action",
    ],
    ["an unknown key", { ...create, extra: 1 }, undefined],
    ["an id that is not a UUID", { ...create, id: "x" }, "id"],
    ["an object as a string", { ...create, object: "Client" }, "object"],
    ["an empty batch", [], undefined],
    [
      "an unknown object",
      { ...create, object: { kind: "Catalog", name: "Nope" } },
      "object",
    ],
    [
      "an operation the catalog lacks",
      { action: "delete", object: RIGHTS, id: ID, expectedVersion: 1 },
      "action",
    ],
    [
      "an invalid value",
      { ...create, values: { code: "far too long code" } },
      "code",
    ],
    [
      "a key outside the grant",
      {
        action: "update",
        object: CLIENT,
        id: ID,
        expectedVersion: 1,
        values: { company: COMPANY },
      },
      "company",
    ],
  ])("rejects %s before the port", async (_, input, path) => {
    const { db, runtime } = await setup()
    const error = await failureOf(runtime.run(session, input as Operation))
    expect(error.code).toBe("command.invalid")
    if (path !== undefined) expect(error.path).toBe(path)
    expect(db.calls).toEqual([])
  })

  it("rejects without a user before any phase", async () => {
    const { db, runtime } = await setup((text) =>
      text.includes("current_user_id")
        ? { rows: [{ user_id: null }] }
        : undefined
    )
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.unauthenticated",
    })
    expect(db.calls).toEqual([...OPEN, ROLLBACK, { release: false }])
  })

  it.each(["40001", "40P01"])(
    "retries %s from step 1 on a copy of the input",
    async (code) => {
      let calls = 0
      const input = {
        ...create,
        values: { ...create.values, extra: { n: 1 } },
      }
      const { db, runtime } = await setup((text) => {
        if (!text.endsWith("AS r") || calls++ > 0) return undefined
        // Викликач змінює вхід між спробами: повтор цього не бачить.
        input.values.extra.n = 2
        return { error: { code, message: "retry" } }
      })
      await runtime.run(session, input)
      const item = JSON.stringify({
        id: ID,
        code: "A",
        company_id: COMPANY,
        extra: { n: 1 },
      })
      const phase = [
        context("create", "client", ID),
        call("client_save", SAVE, [item, null]),
      ]
      expect(db.calls).toEqual([
        ...OPEN,
        ...phase,
        ROLLBACK,
        { release: false },
        ...OPEN,
        ...phase,
        COMMIT,
        { release: false },
      ])
    }
  )

  it("gives command.retry-exhausted after the last failed attempt", async () => {
    const { db, runtime } = await setup((text) =>
      text.endsWith("AS r")
        ? { error: { code: "40001", message: "retry" } }
        : undefined
    )
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.retry-exhausted",
    })
    const attempt = [
      ...OPEN,
      context("create", "client", ID),
      createCall,
      ROLLBACK,
      { release: false },
    ]
    expect(db.calls).toEqual([...attempt, ...attempt, ...attempt])
  })

  it("fails when COMMIT answers ROLLBACK", async () => {
    let commits = 0
    // Перший `COMMIT` — транзакція створення рантайму.
    const { db, runtime, log } = await setup((text) =>
      text === "COMMIT" && commits++ > 0 ? { command: "ROLLBACK" } : undefined
    )
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.internal",
    })
    expect(db.calls).toEqual([
      ...OPEN,
      context("create", "client", ID),
      createCall,
      COMMIT,
      { release: false },
    ])
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "database" })
    )
  })

  // Помилка без SQLSTATE — обрив чи власна вада T3/драйвера: назовні
  // `command.unavailable`, але оригінал іде в журнал, інакше вада зникла б.
  it("maps connect failure and logs the original error", async () => {
    const raw = new Error("ECONNREFUSED")
    const { db, runtime, log } = await setup(undefined, {}, raw)
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.unavailable",
    })
    expect(db.calls).toEqual([{ connect: true }])
    expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
  })

  it("destroys the connection on a statement error without SQLSTATE and logs it", async () => {
    const raw = new TypeError("driver bug")
    const { db, runtime, log } = await setup((text) =>
      text.endsWith("AS r") ? { error: raw } : undefined
    )
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.unavailable",
    })
    expect(db.calls).toEqual([
      ...OPEN,
      context("create", "client", ID),
      createCall,
      { release: true },
    ])
    expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
  })

  it("destroys a lost connection", async () => {
    const { db, runtime } = await setup((text) =>
      text.endsWith("AS r")
        ? { error: { code: "57P01", message: "terminating" } }
        : undefined
    )
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.unavailable",
    })
    expect(db.calls).toEqual([
      ...OPEN,
      context("create", "client", ID),
      createCall,
      { release: true },
    ])
  })

  it("sends only ROLLBACK after the first database error", async () => {
    let contexts = 0
    const raw = { code: "XX000", message: "secret row data" }
    const { db, runtime, log } = await setup((text) =>
      text.includes("simetra.command") && contexts++ === 0
        ? { error: raw }
        : undefined
    )
    const error = await failureOf(
      runtime.run(session, [create, { ...create, id: OTHER }])
    )
    expect(error).toEqual({ code: "command.internal" })
    // Пара неподільна: виклик ядра після відмови контексту не йде в порт.
    expect(db.calls).toEqual([
      ...OPEN,
      context("create", "client", ID),
      ROLLBACK,
      { release: false },
    ])
    expect(log).toHaveBeenCalledWith({ kind: "database", error: raw })
  })

  it.each([
    ["an undecodable row", { r: "not json" }],
    ["a row without r", {}],
  ])("decodes the row before COMMIT and logs %s", async (_, row) => {
    const { db, runtime, log } = await setup((text) =>
      text.endsWith("AS r") ? { rows: [row] } : undefined
    )
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.internal",
    })
    expect(db.calls).toEqual([
      ...OPEN,
      context("create", "client", ID),
      createCall,
      ROLLBACK,
      { release: false },
    ])
    expect(log.mock.calls).toEqual([
      [{ kind: "database", error: expect.any(Error) }],
    ])
  })

  it("logs an unexpected exception as command.internal", async () => {
    const boom = new Error("boom")
    const { db, runtime, log } = await setup((text) =>
      text.includes("current_user_id")
        ? {
            rows: [
              new Proxy(
                {},
                {
                  get() {
                    throw boom
                  },
                }
              ),
            ],
          }
        : undefined
    )
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.internal",
    })
    expect(db.calls).toEqual([...OPEN, ROLLBACK, { release: false }])
    expect(log.mock.calls).toEqual([[{ kind: "database", error: boom }]])
  })

  it("puts the row id as the scope of a scope root", async () => {
    // У кореня скоупу колонка скоупу — ключ, тож рядок ядра не має окремої.
    const root = commandObject({
      name: "Company",
      table: "company",
      scopeColumn: "id",
    })
    const runtime = await createCommandRuntime({
      database: fakeDatabase({
        query: (text) =>
          text.endsWith("AS r")
            ? {
                rows: [
                  { r: JSON.stringify({ id: ID, version: 1, code: "A" }) },
                ],
              }
            : answer(text),
      }).database,
      catalog: { ...catalog, objects: [root] },
    })
    const result = await runtime.run(session, {
      action: "update",
      object: { kind: "Catalog", name: "Company" },
      id: ID,
      expectedVersion: 1,
      values: { code: "A" },
    })
    expect(result.changes).toEqual([
      {
        object: { kind: "Catalog", name: "Company" },
        scopeKind: root.scopeKindId,
        scope: ID,
        id: ID,
        version: 1,
        operation: "update",
      },
    ])
  })

  it("retries a 40001 on COMMIT", async () => {
    let commits = 0
    const { db, runtime } = await setup((text) =>
      text === "COMMIT" && commits++ === 1
        ? { error: { code: "40001", message: "retry" } }
        : undefined
    )
    await runtime.run(session, create)
    const phase = [context("create", "client", ID), createCall, COMMIT]
    expect(db.calls).toEqual([
      ...OPEN,
      ...phase,
      ROLLBACK,
      { release: false },
      ...OPEN,
      ...phase,
      { release: false },
    ])
  })

  it("drops the rows and changes of a failed attempt", async () => {
    let calls = 0
    const { runtime } = await setup((text) => {
      if (!text.endsWith("AS r")) return undefined
      calls++
      // Спроба 1: фаза 1 — версія 7, фаза 2 — 40001; спроба 2 — версії 2 і 3.
      if (calls === 1) return { rows: [{ r: coreRow(ID, 7) }] }
      if (calls === 2) return { error: { code: "40001", message: "retry" } }
      return { rows: [{ r: coreRow(calls === 3 ? ID : OTHER, calls - 1) }] }
    })
    const result = await runtime.run(session, [
      create,
      { ...create, id: OTHER },
    ])
    expect(result.rows.map((r) => [r.ref, r.version])).toEqual([
      [ID, 2],
      [OTHER, 3],
    ])
    expect(result.changes.map((c) => [c.id, c.version])).toEqual([
      [ID, 2],
      [OTHER, 3],
    ])
  })

  it("destroys the connection when ROLLBACK fails", async () => {
    const { db, runtime } = await setup((text) =>
      text.endsWith("AS r")
        ? { error: { code: "23505", message: "dup" } }
        : text === "ROLLBACK"
          ? { error: { code: "XX000", message: "broken" } }
          : undefined
    )
    await failureOf(runtime.run(session, create))
    expect(db.calls).toEqual([
      ...OPEN,
      context("create", "client", ID),
      createCall,
      ROLLBACK,
      { release: true },
    ])
  })
})

describe("statement queue", () => {
  it("closes at the first failure: later units never reach the port", async () => {
    const db = fakeDatabase({
      query: (text): Answer =>
        text === "first" ? { error: { code: "XX000", message: "x" } } : {},
    })
    const connection = await db.database.connect()
    const state = { catalog, log: () => {} } as unknown as RuntimeState
    const tx = new Transaction(connection, state)
    const first = tx.enqueue([{ text: "first", params: [] }])
    const second = tx.enqueue([{ text: "second", params: [] }])
    expect((await failureOf(first)).code).toBe("command.internal")
    expect((await failureOf(second)).code).toBe("command.internal")
    expect(db.calls).toEqual([{ connect: true }, { text: "first", params: [] }])
  })

  it("runs units one after another", async () => {
    const db = fakeDatabase({ query: () => undefined })
    const connection = await db.database.connect()
    const tx = new Transaction(connection, {
      catalog,
    } as unknown as RuntimeState)
    const done = Promise.all([
      tx.enqueue([
        { text: "a", params: [] },
        { text: "b", params: [] },
      ]),
      tx.enqueue([{ text: "c", params: [] }]),
    ])
    for (const expected of ["a", "b", "c"]) {
      const query = await db.next()
      expect(db.pending.map((q) => q.text)).toEqual([expected])
      query.answer()
    }
    await done
  })
})

describe("runAfterCommit", () => {
  it("runs every action even after a failing one and logs each failure", async () => {
    const order: string[] = []
    const log = vi.fn()
    const boom = new Error("boom")
    await runAfterCommit(
      [
        () => {
          order.push("a")
          throw boom
        },
        async () => {
          order.push("b")
          await Promise.reject(boom)
        },
        () => order.push("c"),
      ],
      log
    )
    expect(order).toEqual(["a", "b", "c"])
    expect(log.mock.calls).toEqual([
      [{ kind: "afterCommit", error: boom }],
      [{ kind: "afterCommit", error: boom }],
    ])
  })
})
