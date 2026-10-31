import type { HookContext, ObjectModule, Operation } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommandFailure } from "../errors"
import { createCommandRuntime, type CommandRuntime } from "../runtime"
import { fakeDatabase, failureOf } from "./fake-database"
import { COMPANY, ID, OTHER, catalog, commandObject, sample } from "./fixtures"
import {
  CLIENT,
  COMMIT,
  OPEN,
  RIGHTS,
  ROLLBACK,
  SAVE,
  USER,
  answer,
  call,
  context,
  create,
  createCall,
  session,
  setup,
  type Override,
} from "./harness"

type Modules = Record<string, ObjectModule<object>>
type Row = Record<string, unknown>

const THIRD = "55555555-5555-4555-8555-555555555555"
const rights = (id = OTHER, code = "R"): Operation => ({
  action: "create",
  object: RIGHTS,
  id,
  values: { code },
})
const rightsPhase = (id = OTHER, code = "R") => [
  context("administerRights", "rights_role", id),
  call("rights_role_save", SAVE, [JSON.stringify({ id, code }), null]),
]
const readRights = (id: string) => ({
  text:
    'SELECT to_jsonb(t)::text AS row FROM "public"."rights_role" t' +
    ' WHERE "id" = $1::uuid ORDER BY "id" LIMIT $2',
  params: [id, "1"],
})
const clientPhase = [context("create", "client", ID), createCall]
const CLOSED: unknown[] = [...OPEN, ROLLBACK, { release: false }]

/** Рядок ядра довідника прав — з ключем із `p_item` виклику. */
const rightsCore: Override = (text, params) =>
  text.includes("rights_role_save")
    ? {
        rows: [
          {
            r: JSON.stringify({
              id: (JSON.parse(params[0]!) as { id: string }).id,
              version: 1,
              code: "R",
            }),
          },
        ],
      }
    : undefined

/** Відкладений сигнал: тест сам вирішує, коли продовження піде далі. */
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const withModules = (objectModules: Modules, override?: Override) =>
  setup(override ?? rightsCore, { objectModules })

// Відхилений проміс, якого ніхто не чекав, — дефект T3, а не тесту.
const unhandled = vi.fn()
beforeEach(() => {
  unhandled.mockClear()
  process.on("unhandledRejection", unhandled)
})
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5))
  process.off("unhandledRejection", unhandled)
  expect(unhandled).not.toHaveBeenCalled()
})

describe("hook order", () => {
  it("sets the phase context after beforeWrite; a ctx.run phase sets its own first", async () => {
    const { db, runtime } = await withModules({
      "Catalog.Client": {
        async beforeWrite({ ctx, draft }) {
          await ctx.run(rights())
          return draft
        },
      },
    })
    const result = await runtime.run(session, create)
    // Інваріант 3: ядро кожної фази — одразу після свого контексту.
    expect(db.calls).toEqual([
      ...OPEN,
      ...rightsPhase(),
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
    // Набір змін — і фази `ctx.run`; рядки — лише операцій команди.
    expect(result.changes.map((c) => [c.object, c.id])).toEqual([
      [RIGHTS, OTHER],
      [CLIENT, ID],
    ])
    expect(result.rows.map((r) => r.ref)).toEqual([ID])
  })

  it("passes the draft returned by beforeWrite to the core", async () => {
    const { db, runtime } = await withModules({
      "Catalog.Client": {
        beforeWrite: ({ draft }) => ({
          values: { ...draft.values, code: "B" },
        }),
      },
    })
    await runtime.run(session, create)
    expect(db.calls[OPEN.length + 1]).toEqual(
      call("client_save", SAVE, [
        JSON.stringify({ id: ID, code: "B", company_id: COMPANY }),
        null,
      ])
    )
  })

  it("does not call hooks on delete", async () => {
    const beforeWrite = vi.fn()
    const onWrite = vi.fn()
    const { runtime } = await withModules({
      "Catalog.Client": { beforeWrite, onWrite },
    })
    await runtime.run(session, {
      action: "delete",
      object: CLIENT,
      id: ID,
      expectedVersion: 1,
    })
    expect(beforeWrite).not.toHaveBeenCalled()
    expect(onWrite).not.toHaveBeenCalled()
  })

  it("keeps the result row when onWrite changes its row", async () => {
    const { runtime } = await withModules({
      "Catalog.Client": {
        onWrite({ row }) {
          ;(row as Row).code = "Z"
        },
      },
    })
    const result = await runtime.run(session, create)
    expect(result.rows[0]!.code).toBe("A")
  })
})

describe("draft of beforeWrite", () => {
  const update: Operation = {
    action: "update",
    object: CLIENT,
    id: ID,
    expectedVersion: 1,
    values: { code: "A" },
  }
  const lines = commandObject({
    name: "Order",
    table: "order",
    tabularSections: sample.tabularSections,
  })

  it.each<[string, object, string]>([
    ["a key outside the grant", { values: { company: COMPANY } }, "company"],
    ["the table key", { values: { ref: OTHER } }, "ref"],
    ["an unknown section", { tabularSections: { nope: [] } }, "nope"],
    [
      "a section row without id",
      { tabularSections: { lines: [{}] } },
      "lines.0.ref",
    ],
    ["an id", { id: OTHER }, "id"],
    ["an undefined key", { values: undefined }, "values"],
  ])(
    "revalidates the draft returned by beforeWrite: %s",
    async (_, draft, path) => {
      const { db, runtime } = await setup(rightsCore, {
        catalog: { ...catalog, objects: [...catalog.objects, lines] },
        objectModules: {
          "Catalog.Client": { beforeWrite: () => draft },
          "Catalog.Order": { beforeWrite: () => draft },
        },
      })
      const target = path.startsWith("lines")
        ? { ...update, object: { kind: "Catalog" as const, name: "Order" } }
        : update
      expect(await failureOf(runtime.run(session, target))).toEqual({
        code: "command.invalid",
        path,
      })
      expect(db.calls).toEqual(CLOSED)
    }
  )

  it.each(["values", "tabularSections", "mark"])(
    "rejects a markDeletion draft with %s",
    async (key) => {
      const seen: unknown[] = []
      const { db, runtime } = await withModules({
        "Catalog.Client": {
          beforeWrite({ draft }) {
            seen.push(draft)
            return { [key]: {} }
          },
        },
      })
      const error = await failureOf(
        runtime.run(session, {
          action: "markDeletion",
          object: CLIENT,
          id: ID,
          expectedVersion: 1,
          mark: true,
        })
      )
      expect(error).toEqual({ code: "command.invalid", path: key })
      expect(seen).toEqual([{}])
      expect(db.calls).toEqual(CLOSED)
    }
  )

  it.each<[string, unknown]>([
    ["undefined", undefined],
    ["null", null],
    ["an array", []],
  ])(
    "fails with command.internal when beforeWrite returns %s",
    async (_, value) => {
      const { db, runtime, log } = await withModules({
        "Catalog.Client": { beforeWrite: () => value as object },
      })
      expect(await failureOf(runtime.run(session, create))).toEqual({
        code: "command.internal",
      })
      expect(db.calls).toEqual(CLOSED)
      expect(log.mock.calls).toEqual([
        [{ kind: "hook", error: expect.any(Error) }],
      ])
    }
  )

  it.each<[string, ProxyHandler<object>]>([
    [
      "a prototype trap",
      {
        getPrototypeOf() {
          throw new Error("trap")
        },
      },
    ],
    [
      "an own-keys trap",
      {
        ownKeys() {
          throw new Error("trap")
        },
      },
    ],
    [
      "a getter trap",
      {
        get() {
          throw new Error("trap")
        },
      },
    ],
  ])(
    "maps a draft with %s to a logged command.internal",
    async (_, handler) => {
      const { db, runtime, log } = await withModules({
        "Catalog.Client": {
          beforeWrite: () => new Proxy({ values: { code: "A" } }, handler),
        },
      })
      expect(await failureOf(runtime.run(session, create))).toEqual({
        code: "command.internal",
      })
      expect(db.calls).toEqual(CLOSED)
      expect(log.mock.calls).toEqual([
        [{ kind: "hook", error: expect.any(Error) }],
      ])
    }
  )

  it("maps a draft whose values getter throws, while then stays readable, to a logged command.internal", async () => {
    // Пастка лише на `values`: `await` читає `then` і не спрацьовує першим,
    // тож кидок трапляється саме в `checkDraft`.
    const trap = new Proxy(
      {},
      {
        get(_, key) {
          if (key === "values") throw new Error("trap")
          return undefined
        },
        ownKeys: () => ["values"],
        getOwnPropertyDescriptor: () => ({
          configurable: true,
          enumerable: true,
          value: undefined,
        }),
        getPrototypeOf: () => Object.prototype,
      }
    )
    const { db, runtime, log } = await withModules({
      "Catalog.Client": { beforeWrite: () => trap },
    })
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.internal",
    })
    expect(db.calls).toEqual([...OPEN, ROLLBACK, { release: false }])
    expect(db.calls).not.toContainEqual(COMMIT)
    expect(log.mock.calls).toEqual([
      [{ kind: "hook", error: expect.any(Error) }],
    ])
  })

  it("gives each attempt the original input after a hook changed it", async () => {
    const seen: unknown[] = []
    let cores = 0
    const { runtime } = await withModules(
      {
        "Catalog.Client": {
          beforeWrite({ draft }) {
            const extra = (draft.values as { extra: { n: number } }).extra
            seen.push(extra.n)
            extra.n = 2
            return draft
          },
        },
      },
      (text) =>
        text.includes("client_save") && cores++ === 0
          ? { error: { code: "40001", message: "retry" } }
          : undefined
    )
    await runtime.run(session, {
      ...create,
      values: { code: "A", company: COMPANY, extra: { n: 1 } },
    })
    expect(seen).toEqual([1, 1])
  })
})

describe("hook failures", () => {
  it.each(["beforeWrite", "onWrite"] as const)(
    "maps a thrown hook error to command.internal (%s)",
    async (key) => {
      const boom = new Error("secret row data")
      const action = vi.fn()
      const { db, runtime, log } = await withModules({
        "Catalog.Client": {
          [key]({ ctx }: { ctx: HookContext }) {
            ctx.afterCommit(action)
            throw boom
          },
        },
      })
      const thrown = await runtime.run(session, create).catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(CommandFailure)
      expect((thrown as CommandFailure).error).toEqual({
        code: "command.internal",
      })
      expect((thrown as CommandFailure).message).toBe("command.internal")
      expect((thrown as CommandFailure).cause).toBeUndefined()
      expect(db.calls).toEqual([
        ...OPEN,
        ...(key === "onWrite" ? clientPhase : []),
        ROLLBACK,
        { release: false },
      ])
      expect(log.mock.calls).toEqual([[{ kind: "hook", error: boom }]])
      expect(action).not.toHaveBeenCalled()
    }
  )

  it("fails with a ctx.run rejection the hook caught; later ctx.run never reaches the port", async () => {
    const action = vi.fn()
    const later: unknown[] = []
    const { db, runtime } = await withModules({
      "Catalog.Client": {
        async beforeWrite({ ctx, draft }) {
          ctx.afterCommit(action)
          await ctx.run(rights()).catch(() => undefined)
          later.push(await failureOf(ctx.run(rights(THIRD))))
          return draft
        },
      },
      "Catalog.RightsRole": {
        beforeWrite: ({ ctx }) => ctx.reject("busy"),
      },
    })
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.rejected",
      reason: "busy",
    })
    expect(later).toEqual([{ code: "command.rejected", reason: "busy" }])
    expect(db.calls).toEqual(CLOSED)
    expect(action).not.toHaveBeenCalled()
  })

  it("stops a batch when onWrite caught a ctx.run rejection", async () => {
    const before: string[] = []
    const { db, runtime, log } = await withModules({
      "Catalog.Client": {
        beforeWrite({ ctx, draft }) {
          before.push(ctx.id)
          return draft
        },
        async onWrite({ ctx }) {
          await ctx.run(rights()).catch(() => undefined)
        },
      },
      "Catalog.RightsRole": {
        beforeWrite: ({ ctx }) => ctx.reject("busy"),
      },
    })
    const error = await failureOf(
      runtime.run(session, [create, { ...create, id: OTHER }])
    )
    expect(error).toEqual({ code: "command.rejected", reason: "busy" })
    // Фаза з перехопленою відмовою не йде далі: `beforeWrite` op2 не викликано.
    expect(before).toEqual([ID])
    expect(db.calls).toEqual([
      ...OPEN,
      ...clientPhase,
      ROLLBACK,
      { release: false },
    ])
    expect(log).not.toHaveBeenCalled()
  })

  it("does not check the draft after beforeWrite caught a rejection", async () => {
    const { runtime, log } = await withModules({
      "Catalog.Client": {
        async beforeWrite({ ctx }) {
          await ctx.run(rights()).catch(() => undefined)
          return undefined as unknown as object
        },
      },
      "Catalog.RightsRole": {
        beforeWrite: ({ ctx }) => ctx.reject("busy"),
      },
    })
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.rejected",
      reason: "busy",
    })
    expect(log).not.toHaveBeenCalled()
  })

  it("releases once and keeps the code when the host log throws", async () => {
    const { db, runtime } = await setup(rightsCore, {
      log: () => {
        throw new TypeError("log down")
      },
      objectModules: {
        "Catalog.Client": {
          beforeWrite() {
            throw new Error("boom")
          },
        },
      },
    })
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.internal",
    })
    expect(db.calls).toEqual(CLOSED)
  })

  it("retries when a hook caught a 40001 from ctx.run", async () => {
    let cores = 0
    const { db, runtime } = await withModules(
      {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            await ctx.run(rights()).catch(() => undefined)
            return draft
          },
        },
      },
      (text, params) =>
        text.includes("rights_role_save") && cores++ === 0
          ? { error: { code: "40001", message: "retry" } }
          : rightsCore(text, params)
    )
    await runtime.run(session, create)
    expect(db.calls).toEqual([
      ...OPEN,
      ...rightsPhase(),
      ROLLBACK,
      { release: false },
      ...OPEN,
      ...rightsPhase(),
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
  })

  it.each([
    ["awaited and caught", true],
    ["not awaited", false],
  ])(
    "fails closed on a nested onWrite rejection the outer hook %s",
    async (_, awaited) => {
      const { db, runtime } = await withModules({
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            const nested = ctx.run(rights())
            if (awaited) await nested.catch(() => undefined)
            return draft
          },
        },
        "Catalog.RightsRole": {
          onWrite: ({ ctx }) => ctx.reject("nope", "code"),
        },
      })
      expect(await failureOf(runtime.run(session, create))).toEqual({
        code: "command.rejected",
        reason: "nope",
        path: "code",
      })
      expect(db.calls).toEqual([
        ...OPEN,
        ...rightsPhase(),
        ROLLBACK,
        { release: false },
      ])
    }
  )
})

describe("depth and queue", () => {
  it("gives command.depth past maxDepth", async () => {
    const { db, runtime } = await setup(rightsCore, {
      maxDepth: 1,
      objectModules: {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            await ctx.run(rights())
            return draft
          },
        },
        "Catalog.RightsRole": {
          async beforeWrite({ ctx, draft }) {
            if (ctx.id === OTHER) await ctx.run(rights(THIRD))
            return draft
          },
        },
      },
    })
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.depth",
    })
    expect(db.calls).toEqual(CLOSED)
  })

  it("counts depth from the async context when a captured root ctx recurses", async () => {
    let root: HookContext | undefined
    let nested = 0
    const { runtime } = await setup(rightsCore, {
      maxDepth: 3,
      objectModules: {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            root = ctx
            await ctx.run(rights())
            return draft
          },
        },
        "Catalog.RightsRole": {
          async beforeWrite({ draft }) {
            // Запобіжник тесту: глибина з `ctx` дала б нескінченну рекурсію.
            if (++nested > 10) throw new Error("runaway")
            await root!.run(rights())
            return draft
          },
        },
      },
    })
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.depth",
    })
    expect(nested).toBe(3)
  })

  it("waits for a ctx.run the hook did not await", async () => {
    const { db, runtime } = await withModules({
      "Catalog.Client": {
        beforeWrite({ ctx, draft }) {
          void ctx.run(rights())
          return draft
        },
      },
      "Catalog.RightsRole": {
        async beforeWrite({ ctx, draft }) {
          await ctx.read({ object: RIGHTS, id: OTHER })
          return draft
        },
      },
    })
    await runtime.run(session, create)
    expect(db.calls).toEqual([
      ...OPEN,
      readRights(OTHER),
      ...rightsPhase(),
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
  })

  it("keeps each core call right after its context under Promise.all of two ctx.run", async () => {
    const { db, runtime } = await withModules({
      "Catalog.Client": {
        async beforeWrite({ ctx, draft }) {
          await Promise.all([ctx.run(rights()), ctx.run(rights(THIRD))])
          return draft
        },
      },
      "Catalog.RightsRole": {
        async beforeWrite({ ctx, draft }) {
          await ctx.read({ object: RIGHTS, id: ctx.id })
          return draft
        },
      },
    })
    await runtime.run(session, create)
    expect(db.calls).toEqual([
      ...OPEN,
      readRights(OTHER),
      readRights(THIRD),
      ...rightsPhase(),
      ...rightsPhase(THIRD),
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
  })

  it("runs ctx.read in the command transaction and decodes its rows", async () => {
    const rows: unknown[] = []
    const { db, runtime } = await withModules(
      {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            rows.push(...(await ctx.read({ object: RIGHTS, id: OTHER })))
            return draft
          },
        },
      },
      (text) =>
        text.includes(" AS row ")
          ? {
              rows: [
                { row: JSON.stringify({ id: OTHER, version: 2, code: "R" }) },
              ],
            }
          : undefined
    )
    await runtime.run(session, create)
    expect(db.calls).toEqual([
      ...OPEN,
      readRights(OTHER),
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
    expect(rows).toEqual([{ ref: OTHER, version: 2, code: "R" }])
  })

  it("maps 22P02 of ctx.read to command.invalid", async () => {
    const { db, runtime, log } = await withModules(
      {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            await ctx.read({ object: RIGHTS, id: OTHER })
            return draft
          },
        },
      },
      (text) =>
        text.includes(" AS row ")
          ? { error: { code: "22P02", message: "bad input" } }
          : undefined
    )
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.invalid",
    })
    expect(db.calls).toEqual([
      ...OPEN,
      readRights(OTHER),
      ROLLBACK,
      { release: false },
    ])
    expect(log).not.toHaveBeenCalled()
  })
})

describe("hook context", () => {
  // Ключі `HookContext` T0: `satisfies` ламає typecheck, коли контракт
  // змінюється, а перелік — ні.
  const KEYS = {
    object: true,
    id: true,
    action: true,
    isNew: true,
    mark: true,
    additionalProperties: true,
    user: true,
    act: true,
    run: true,
    read: true,
    reject: true,
    afterCommit: true,
  } satisfies Record<keyof HookContext, true>

  it.each<[string, Operation, boolean, boolean | undefined]>([
    ["create", create, true, undefined],
    [
      "update",
      {
        action: "update",
        object: CLIENT,
        id: ID,
        expectedVersion: 1,
        values: { code: "A" },
      },
      false,
      undefined,
    ],
    [
      "markDeletion",
      {
        action: "markDeletion",
        object: CLIENT,
        id: ID,
        expectedVersion: 1,
        mark: true,
      },
      false,
      true,
    ],
  ])(
    "gives action, isNew, id and mark on %s",
    async (action, op, isNew, mark) => {
      const seen: HookContext[] = []
      const { runtime } = await withModules({
        "Catalog.Client": {
          beforeWrite({ ctx, draft }) {
            seen.push(ctx)
            return draft
          },
          onWrite({ ctx }) {
            seen.push(ctx)
          },
        },
      })
      await runtime.run({ ...session, act: { sub: "agent-1" } }, op)
      for (const ctx of seen) {
        expect({
          object: ctx.object,
          id: ctx.id,
          action: ctx.action,
          isNew: ctx.isNew,
          mark: ctx.mark,
          user: ctx.user,
          act: ctx.act,
        }).toEqual({
          object: CLIENT,
          id: ID,
          action,
          isNew,
          mark,
          user: USER,
          act: { sub: "agent-1" },
        })
        // Інваріант 6: рівно ключі контракту — жодного клієнта бази.
        const expected = Object.keys(KEYS).filter(
          (k) => k !== "mark" || mark !== undefined
        )
        expect(Reflect.ownKeys(ctx).sort()).toEqual(expected.sort())
      }
      expect(seen).toHaveLength(2)
    }
  )

  it("has no act key without an agent", async () => {
    let keys: (string | symbol)[] = []
    const { runtime } = await withModules({
      "Catalog.Client": {
        beforeWrite({ ctx, draft }) {
          keys = Reflect.ownKeys(ctx)
          return draft
        },
      },
    })
    await runtime.run(session, create)
    expect(keys).not.toContain("act")
    expect(keys).not.toContain("mark")
  })

  it("shares additionalProperties within a phase only; a retry drops the failed attempt", async () => {
    const sizes: [string, number][] = []
    const seen: unknown[] = []
    const ran: number[] = []
    let attempt = 0
    let cores = 0
    const { runtime } = await withModules(
      {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            attempt++
            const n = attempt
            sizes.push(["client", ctx.additionalProperties.size])
            ctx.additionalProperties.set("seen", n)
            ctx.afterCommit(() => ran.push(n))
            await ctx.run(rights())
            return draft
          },
          onWrite({ ctx }) {
            seen.push(ctx.additionalProperties.get("seen"))
          },
        },
        "Catalog.RightsRole": {
          beforeWrite({ ctx, draft }) {
            sizes.push(["rights", ctx.additionalProperties.size])
            ctx.additionalProperties.set("seen", "rights")
            return draft
          },
        },
      },
      (text, params) => {
        if (text.includes("rights_role_save")) {
          cores++
          return {
            rows: [
              { r: JSON.stringify({ id: OTHER, version: cores, code: "R" }) },
            ],
          }
        }
        return text.includes("client_save") && cores === 1
          ? { error: { code: "40001", message: "retry" } }
          : rightsCore(text, params)
      }
    )
    const result = await runtime.run(session, create)
    // Інваріант 16: повтор — з порожніми `additionalProperties`.
    expect(sizes).toEqual([
      ["client", 0],
      ["rights", 0],
      ["client", 0],
      ["rights", 0],
    ])
    expect(seen).toEqual([2])
    expect(ran).toEqual([2])
    expect(result.changes.map((c) => [c.id, c.version])).toEqual([
      [OTHER, 2],
      [ID, 1],
    ])
  })
})

describe("ctx lifetime", () => {
  it("rejects a ctx kept past its hook with command.internal", async () => {
    let kept: HookContext | undefined
    const { db, runtime, log } = await withModules({
      "Catalog.Client": {
        beforeWrite({ ctx, draft }) {
          kept = ctx
          return draft
        },
      },
    })
    await runtime.run(session, create)
    db.calls.splice(0)
    log.mockClear()
    expect(await failureOf(kept!.read({ object: RIGHTS, id: OTHER }))).toEqual({
      code: "command.internal",
    })
    expect(await failureOf(kept!.run(rights()))).toEqual({
      code: "command.internal",
    })
    expect(() => kept!.reject("late")).toThrow("command.internal")
    expect(() => kept!.afterCommit(() => {})).toThrow("command.internal")
    // Невичеканий виклик — лише запис у журналі, без unhandled rejection.
    void kept!.run(rights())
    await Promise.resolve()
    expect(db.calls).toEqual([])
    expect(log.mock.calls.map(([entry]) => entry.kind)).toEqual([
      "hook",
      "hook",
      "hook",
      "hook",
      "hook",
    ])
  })

  it("rejects a ctx of a running hook used from another command", async () => {
    let kept: HookContext | undefined
    const a = fakeDatabase({
      query: (text) => (text.includes(" AS row ") ? undefined : answer(text)),
    })
    const first = await createCommandRuntime({
      database: a.database,
      catalog,
      log: () => {},
      objectModules: {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            kept = ctx
            await ctx.read({ object: RIGHTS, id: OTHER })
            return draft
          },
        },
      },
    })
    const { db: b, runtime: second } = await withModules({
      "Catalog.Client": {
        async beforeWrite({ draft }) {
          // Перехоплена відмова однаково закриває чергу команди B.
          await kept!.read({ object: RIGHTS, id: THIRD }).catch(() => undefined)
          return draft
        },
      },
    })
    a.calls.splice(0)
    const running = first.run(session, create)
    const read = await a.next()
    expect(await failureOf(second.run(session, create))).toEqual({
      code: "command.internal",
    })
    expect(b.calls).toEqual(CLOSED)
    read.answer()
    await running
    expect(a.calls).toEqual([
      ...OPEN,
      readRights(OTHER),
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
  })

  it("fails the command when a hook continuation calls ctx after the hook returned", async () => {
    const { db, runtime, log } = await withModules({
      "Catalog.Client": {
        beforeWrite({ ctx, draft }) {
          ctx
            .read({ object: RIGHTS, id: OTHER })
            .then(() => ctx.run(rights()))
            .catch(() => undefined)
          return draft
        },
      },
    })
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.internal",
    })
    // Без `opB` команда не комітить частково.
    expect(db.calls).toEqual([
      ...OPEN,
      readRights(OTHER),
      ROLLBACK,
      { release: false },
    ])
    expect(log.mock.calls).toEqual([
      [{ kind: "hook", error: expect.any(Error) }],
    ])
  })

  it("fails a batch whose second hook uses the ctx kept by the first", async () => {
    let kept: HookContext | undefined
    const { db, runtime } = await withModules({
      "Catalog.Client": {
        async beforeWrite({ ctx, draft }) {
          if (kept === undefined) kept = ctx
          else await kept.run(rights()).catch(() => undefined)
          return draft
        },
      },
    })
    const error = await failureOf(
      runtime.run(session, [create, { ...create, id: OTHER }])
    )
    expect(error).toEqual({ code: "command.internal" })
    expect(db.calls).toEqual([
      ...OPEN,
      ...clientPhase,
      ROLLBACK,
      { release: false },
    ])
  })

  it("logs command.internal for ctx.run from afterCommit and keeps the result", async () => {
    const { runtime, log } = await withModules({
      "Catalog.Client": {
        beforeWrite({ ctx, draft }) {
          ctx.afterCommit(() => ctx.run(rights()))
          return draft
        },
      },
    })
    const result = await runtime.run(session, create)
    expect(result.rows).toHaveLength(1)
    expect(log.mock.calls).toEqual([
      [{ kind: "hook", error: expect.any(Error) }],
      [{ kind: "afterCommit", error: expect.any(CommandFailure) }],
    ])
    expect(
      (log.mock.calls[1]![0] as { error: CommandFailure }).error.error
    ).toEqual({
      code: "command.internal",
    })
  })
})

describe("afterCommit", () => {
  const registering = (actions: (() => unknown)[]): Modules => ({
    "Catalog.Client": {
      beforeWrite({ ctx, draft }) {
        for (const action of actions) ctx.afterCommit(action)
        return draft
      },
    },
  })

  it("runs actions in order before run resolves without defer", async () => {
    const order: string[] = []
    const { db, runtime } = await withModules(
      registering([
        () => order.push(`a:${db.calls.length}`),
        () => order.push("b"),
      ])
    )
    await runtime.run(session, create)
    // Після `COMMIT` і `release()`.
    expect(order).toEqual([`a:${OPEN.length + 4}`, "b"])
  })

  it("hands the actions to defer", async () => {
    const order: string[] = []
    const works: Promise<unknown>[] = []
    const gate = deferred()
    const { runtime } = await setup(rightsCore, {
      objectModules: registering([
        async () => {
          order.push("a")
          await gate.promise
          order.push("b")
        },
      ]),
      defer: (work) => works.push(work),
    })
    await runtime.run(session, create)
    // `run` повернувся, не чекаючи дії: її чекає платформа.
    expect(works).toHaveLength(1)
    expect(order).toEqual(["a"])
    gate.resolve()
    await works[0]
    expect(order).toEqual(["a", "b"])
  })

  it("keeps the result when defer throws", async () => {
    const boom = new Error("defer down")
    const { runtime, log } = await setup(rightsCore, {
      objectModules: registering([() => {}]),
      defer: () => {
        throw boom
      },
    })
    const result = await runtime.run(session, create)
    expect(result.rows).toHaveLength(1)
    expect(log.mock.calls).toEqual([[{ kind: "defer", error: boom }]])
  })
})

describe("command.nested", () => {
  // Друга команда — окрема транзакція після звільнення з'єднання першої.
  const TWO_COMMANDS = [
    ...OPEN,
    ...clientPhase,
    COMMIT,
    { release: false },
    ...OPEN,
    ...rightsPhase(),
    COMMIT,
    { release: false },
  ]

  it.each(["the same", "another"])(
    "rejects run of %s runtime inside a hook and fails the command",
    async (which) => {
      const otherDb = fakeDatabase({ query: (text) => answer(text) })
      const other: CommandRuntime = await createCommandRuntime({
        database: otherDb.database,
        catalog,
      })
      const inner: unknown[] = []
      const { db, runtime } = await withModules({
        "Catalog.Client": {
          async beforeWrite({ draft }) {
            const target = which === "the same" ? runtime : other
            inner.push(await failureOf(target.run(session, rights())))
            return draft
          },
        },
      })
      otherDb.calls.splice(0)
      expect(await failureOf(runtime.run(session, create))).toEqual({
        code: "command.nested",
      })
      expect(inner).toEqual([{ code: "command.nested" }])
      expect(db.calls).toEqual(CLOSED)
      expect(otherDb.calls).toEqual([])
    }
  )

  it("allows run from a continuation scheduled by a hook after the command", async () => {
    const gate = deferred()
    let continuation: Promise<unknown> | undefined
    const { db, runtime } = await withModules({
      "Catalog.Client": {
        beforeWrite({ draft }) {
          continuation ??= gate.promise.then(() =>
            runtime.run(session, rights())
          )
          return draft
        },
      },
    })
    await runtime.run(session, create)
    gate.resolve()
    await continuation
    expect(db.calls).toEqual(TWO_COMMANDS)
  })

  it("allows an afterCommit action to start a new command", async () => {
    let nested: Promise<unknown> | undefined
    const { db, runtime } = await withModules({
      "Catalog.Client": {
        beforeWrite({ ctx, draft }) {
          ctx.afterCommit(() => {
            nested = runtime.run(session, rights())
            return nested
          })
          return draft
        },
      },
    })
    await runtime.run(session, create)
    await nested
    expect(db.calls).toEqual(TWO_COMMANDS)
  })
})
