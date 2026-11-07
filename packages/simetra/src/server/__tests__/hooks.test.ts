import { BATCH_MAX, CommandFailure, TABULAR_LINES_MAX } from "simetra/model"
import type { HookContext, ObjectModule, Operation } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { prepareRead } from "../read"
import {
  createCommandRuntime,
  type CommandRuntime,
  type CommandRuntimeOptions,
} from "../runtime"
import { fakeDatabase, failureOf } from "./fake-database"
import {
  COMPANY,
  ID,
  LINK,
  OTHER,
  TASK,
  catalog,
  commandObject,
  linkCatalog,
  rootCatalog,
  sample,
  taskCatalog,
} from "./fixtures"
import {
  BRANCH,
  CLIENT,
  COMMIT,
  MEMBER_ROW,
  OPEN,
  ORGANIZATION,
  ORG_MEMBER,
  ROOT,
  RIGHTS,
  ROLLBACK,
  SAVE,
  TICKET,
  USER,
  answer,
  assign,
  assignPhase,
  call,
  context,
  create,
  createOrganization,
  generatedIds,
  rootResult,
  session,
  setup,
  setupRoots,
  type Override,
} from "./harness"

// Справжній `prepareRead`; кейс неочікуваного винятку підміняє один виклик.
vi.mock("../read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../read")>()
  return { ...actual, prepareRead: vi.fn(actual.prepareRead) }
})

type Modules = Record<string, ObjectModule<object>>
type Row = Record<string, unknown>

const THIRD = "55555555-5555-4555-8555-555555555555"
const rights = (id = OTHER, code = "R"): Operation => ({
  action: "create",
  object: RIGHTS,
  id,
  values: { code },
})
const rightsRolePhase = (id = OTHER, code = "R") => [
  context("administerRights", "rights_role", id),
  call("rights_role_save", SAVE, [JSON.stringify({ id, code }), null]),
]
const readOf = (table: string, id: string) => ({
  text:
    `SELECT to_jsonb(t)::text AS row FROM "public"."${table}" t` +
    ' WHERE "id" = $1::uuid LIMIT 1',
  params: [id],
})
const readRights = (id: string) => readOf("rights_role", id)
const clientPhaseOf = (id: string) => [
  context("create", "client", id),
  call("client_save", SAVE, [
    JSON.stringify({ id, code: "A", company_id: COMPANY }),
    null,
  ]),
]
const clientPhase = clientPhaseOf(ID)
// Вкладена фаза об'єкта застосунку — для кейсів черги й повтору.
const createTicket = (id = OTHER, code = "R"): Operation => ({
  action: "create",
  object: TICKET,
  id,
  values: { code },
})
const ticketCreatePhase = (id = OTHER, code = "R") => [
  context("create", "ticket", id),
  call("ticket_save", SAVE, [JSON.stringify({ id, code }), null]),
]
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

/** Рядок ядра `Ticket` — з ключем із `p_item` виклику. */
const ticketCore: Override = (text, params) =>
  text.includes("ticket_save")
    ? {
        rows: [
          {
            r: JSON.stringify({
              id: (JSON.parse(params[0]!) as { id: string }).id,
              version: 1,
              code: "R",
              company_id: COMPANY,
            }),
          },
        ],
      }
    : undefined

const withModules = (objectModules: Modules, override?: Override) =>
  setup(
    override ??
      ((text, params) => rightsCore(text, params) ?? ticketCore(text, params)),
    { objectModules }
  )

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
          await ctx.run(createTicket())
          return draft
        },
      },
    })
    const result = await runtime.run(session, create)
    // Інваріант 3: ядро кожної фази — одразу після свого контексту.
    expect(db.calls).toEqual([
      ...OPEN,
      ...ticketCreatePhase(),
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
    // Набір змін — і фази `ctx.run`; рядки — лише операцій команди.
    expect(result.changes.map((c) => [c.object, c.id])).toEqual([
      [TICKET, OTHER],
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

describe("tenant creation hooks", () => {
  let ids: ReturnType<typeof generatedIds>
  beforeEach(() => {
    ids = generatedIds(ROOT, MEMBER_ROW)
  })
  afterEach(() => {
    ids.mockRestore()
  })
  const isCore = (text: string) => text.includes("_create_root")

  it("runs both beforeWrite hooks, the core, then both onWrite hooks (Р-A6-14)", async () => {
    const events: string[] = []
    const contexts: Record<string, unknown> = {}
    const { db, runtime } = await setupRoots(
      (text) => {
        if (text.includes("simetra.command")) events.push("context")
        if (isCore(text)) events.push("core")
        return undefined
      },
      {
        objectModules: {
          "Catalog.Organization": {
            beforeWrite: ({ ctx, draft }) => {
              events.push("root.beforeWrite")
              contexts.root = { object: ctx.object, id: ctx.id }
              return draft
            },
            onWrite: ({ row }) => {
              events.push("root.onWrite")
              contexts.rootRow = row
            },
          },
          "Catalog.OrgMember": {
            beforeWrite: ({ ctx, draft }) => {
              events.push("member.beforeWrite")
              contexts.member = {
                object: ctx.object,
                id: ctx.id,
                isNew: ctx.isNew,
                action: ctx.action,
                draft,
              }
              return { values: { ...draft.values, title: "U" } }
            },
            onWrite: ({ row }) => {
              events.push("member.onWrite")
              contexts.memberRow = row
            },
          },
        },
      }
    )
    await runtime.run(session, createOrganization)
    expect(events).toEqual([
      "root.beforeWrite",
      "member.beforeWrite",
      "context",
      "core",
      "root.onWrite",
      "member.onWrite",
    ])
    expect(contexts).toEqual({
      root: { object: ORGANIZATION, id: ROOT },
      member: {
        object: ORG_MEMBER,
        id: MEMBER_ROW,
        isNew: true,
        action: "create",
        draft: { values: { title: "T" } },
      },
      rootRow: { ref: ROOT, version: 1, code: "A" },
      memberRow: {
        ref: MEMBER_ROW,
        version: 1,
        org: ROOT,
        user: USER,
        title: "T",
      },
    })
    // Чернетку хука членства бачить ядро.
    expect(db.calls.find((c) => "text" in c && isCore(c.text))).toMatchObject({
      params: [expect.any(String), '{"title":"U"}', MEMBER_ROW],
    })
  })

  it("operator model: root onWrite gets the invisible row as id and version", async () => {
    const onWrite = vi.fn()
    const { runtime } = await setupRoots(
      (text) =>
        isCore(text)
          ? { rows: [{ r: rootResult({ id: ROOT, version: "1" }, null) }] }
          : undefined,
      { objectModules: { "Catalog.Branch": { onWrite } } }
    )
    await runtime.run(session, { action: "create", object: BRANCH })
    expect(onWrite).toHaveBeenCalledWith(
      expect.objectContaining({ row: { ref: ROOT, version: 1 } })
    )
  })

  // Членство без права читання творцю невидиме й після гранту: ядро віддає
  // `{ключ, версія}` без скоупу, і це не аномалія (спека П4 §6.13).
  it("membership onWrite gets an invisible member row as id and version", async () => {
    const onWrite = vi.fn()
    const { runtime } = await setupRoots(
      (text) =>
        isCore(text)
          ? {
              rows: [
                {
                  r: rootResult(undefined, { id: MEMBER_ROW, version: "1" }),
                },
              ],
            }
          : undefined,
      { objectModules: { "Catalog.OrgMember": { onWrite } } }
    )
    const result = await runtime.run(session, createOrganization)
    expect(onWrite).toHaveBeenCalledWith(
      expect.objectContaining({ row: { ref: MEMBER_ROW, version: 1 } })
    )
    expect(result.changes.map((c) => c.object)).toEqual([ORGANIZATION])
  })

  it.each<[string, Modules, string]>([
    [
      "root beforeWrite returns tabularSections",
      {
        "Catalog.Organization": {
          beforeWrite: ({ draft }) => ({ ...draft, tabularSections: {} }),
        },
      },
      "tabularSections",
    ],
    [
      "membership beforeWrite returns tabularSections",
      {
        "Catalog.OrgMember": {
          beforeWrite: ({ draft }) => ({ ...draft, tabularSections: {} }),
        },
      },
      "creatorMember",
    ],
    [
      "membership beforeWrite returns a key outside the draft",
      {
        "Catalog.OrgMember": {
          beforeWrite: ({ draft }) => ({ ...draft, id: OTHER }),
        },
      },
      "creatorMember",
    ],
    [
      "membership beforeWrite writes the forced user",
      {
        "Catalog.OrgMember": {
          beforeWrite: () => ({ values: { user: OTHER } }),
        },
      },
      "creatorMember.user",
    ],
  ])("%s: command.invalid before the core", async (_, objectModules, path) => {
    const { db, runtime } = await setupRoots(undefined, { objectModules })
    // Відмова чернетки членства — шлях `creatorMember` операції кореня.
    expect(await failureOf(runtime.run(session, createOrganization))).toEqual({
      code: "command.invalid",
      path,
      object: ORGANIZATION,
    })
    expect(db.calls.some((c) => "text" in c && isCore(c.text))).toBe(false)
    expect(db.calls).toEqual(CLOSED)
  })
})

describe("rights phases in a batch", () => {
  // Права команди тримає знімок бази на початок транзакції (Права-3):
  // хук членства, що призначає роль, не зупиняє наступні фази пакета.
  it("runs a second member of a batch when the membership onWrite assigns a role", async () => {
    const { db, runtime } = await withModules({
      // Довідник членства — дані застосунку, як `Client`.
      "Catalog.Client": {
        async onWrite({ ctx }) {
          await ctx.run(assign(THIRD))
        },
      },
    })
    await runtime.run(session, [create, { ...create, id: OTHER }])
    expect(db.calls).toEqual([
      ...OPEN,
      ...clientPhase,
      ...assignPhase(THIRD),
      ...clientPhaseOf(OTHER),
      ...assignPhase(THIRD),
      COMMIT,
      { release: false },
    ])
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
    // `id` чернетки — ключ запису: у шляху `keyName` (спека П4-B §4.0).
    ["an id", { id: OTHER }, "ref"],
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
        object: target.object,
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
      expect(error).toEqual({
        code: "command.invalid",
        path: key,
        object: CLIENT,
      })
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
            await ctx.run(createTicket()).catch(() => undefined)
            return draft
          },
        },
      },
      (text, params) =>
        text.includes("ticket_save") && cores++ === 0
          ? { error: { code: "40001", message: "retry" } }
          : ticketCore(text, params)
    )
    await runtime.run(session, create)
    expect(db.calls).toEqual([
      ...OPEN,
      ...ticketCreatePhase(),
      ROLLBACK,
      { release: false },
      ...OPEN,
      ...ticketCreatePhase(),
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
      // `ctx.reject` — об'єкт фази хука, а не операції команди.
      expect(await failureOf(runtime.run(session, create))).toEqual({
        code: "command.rejected",
        reason: "nope",
        path: "code",
        object: RIGHTS,
      })
      expect(db.calls).toEqual([
        ...OPEN,
        ...rightsRolePhase(),
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

  it("gives command.depth phases past BATCH_MAX ctx.run phases of one transaction", async () => {
    let started = 0
    const { db, runtime } = await setup(rightsCore, {
      objectModules: {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            for (let i = 0; i <= BATCH_MAX; i++) {
              started++
              await ctx.run(rights())
            }
            return draft
          },
        },
      },
    })
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.depth",
      reason: "phases",
    })
    expect(started).toBe(BATCH_MAX + 1)
    // Перевищення — без оператора: остання фаза до бази не дійшла.
    const cores = db.calls.filter(
      (c) => "text" in c && c.text.includes("rights_role_save")
    )
    expect(cores).toHaveLength(BATCH_MAX)
    expect(db.calls.slice(-2)).toEqual([ROLLBACK, { release: false }])
  })

  it("does not count the phases of the input batch against BATCH_MAX", async () => {
    const half = BATCH_MAX / 2
    const { db, runtime } = await setup(rightsCore, {
      objectModules: {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            for (let i = 0; i < half; i++) await ctx.run(rights())
            return draft
          },
        },
      },
    })
    await runtime.run(session, [create, create])
    expect(db.calls.slice(-2)).toEqual([COMMIT, { release: false }])
  })

  // `maxBatch` — межа вхідного пакета `run`; фази хуків тримає лише `BATCH_MAX`.
  it("does not bound ctx.run phases by a reduced maxBatch", async () => {
    const { db, runtime } = await setup(rightsCore, {
      maxBatch: 1,
      objectModules: {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            for (let i = 0; i < 3; i++) await ctx.run(rights())
            return draft
          },
        },
      },
    })
    await runtime.run(session, create)
    expect(db.calls.slice(-2)).toEqual([COMMIT, { release: false }])
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
          void ctx.run(createTicket())
          return draft
        },
      },
      "Catalog.Ticket": {
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
      ...ticketCreatePhase(),
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
  })

  it("keeps each core call right after its context under Promise.all of two ctx.run", async () => {
    const { db, runtime } = await withModules({
      "Catalog.Client": {
        async beforeWrite({ ctx, draft }) {
          await Promise.all([
            ctx.run(createTicket()),
            ctx.run(createTicket(THIRD)),
          ])
          return draft
        },
      },
      "Catalog.Ticket": {
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
      ...ticketCreatePhase(),
      ...ticketCreatePhase(THIRD),
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
            rows.push(...(await ctx.read({ object: RIGHTS, id: OTHER })).rows)
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

  it("runs ctx.read with include as two statements of the command transaction", async () => {
    const results: unknown[] = []
    const { db, runtime } = await setup(
      (text) =>
        text.includes('"public"."link"')
          ? {
              rows: [
                {
                  row: JSON.stringify({
                    id: OTHER,
                    version: 1,
                    region_id: THIRD,
                  }),
                },
              ],
            }
          : text.includes('"public"."region"')
            ? {
                rows: [
                  { row: JSON.stringify({ id: THIRD, version: 2, code: "N" }) },
                ],
              }
            : undefined,
      {
        catalog: linkCatalog,
        objectModules: {
          "Catalog.Client": {
            async beforeWrite({ ctx, draft }) {
              results.push(
                await ctx.read({ object: LINK, id: OTHER, include: ["region"] })
              )
              return draft
            },
          },
        },
      }
    )
    await runtime.run(session, create)
    expect(db.calls).toEqual([
      ...OPEN,
      readOf("link", OTHER),
      {
        text:
          `SELECT jsonb_build_object('id', t."id", 'version', t."version", 'code', t."code")::text` +
          ` AS row FROM "public"."region" t WHERE "id" = ANY(ARRAY[$1::uuid])`,
        params: [THIRD],
      },
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
    expect(results).toEqual([
      {
        rows: [{ ref: OTHER, version: 1, region: THIRD }],
        included: { "Catalog.Region": [{ ref: THIRD, version: 2, code: "N" }] },
      },
    ])
  })

  it("runs ctx.read of the lines of an owner in the command transaction", async () => {
    const results: unknown[] = []
    const { runtime } = await setup(
      (text) =>
        text.includes("AS owner_version")
          ? {
              rows: [
                {
                  owner_version: "5",
                  tabular: JSON.stringify({
                    sample_lines: [
                      { id: THIRD, parent_id: OTHER, line_number: 1 },
                    ],
                  }),
                },
              ],
            }
          : undefined,
      {
        catalog: rootCatalog,
        objectModules: {
          "Catalog.Client": {
            async beforeWrite({ ctx, draft }) {
              results.push(
                await ctx.read({
                  object: ORGANIZATION,
                  tabularSection: "lines",
                  owner: OTHER,
                })
              )
              return draft
            },
          },
        },
      }
    )
    await runtime.run(session, create)
    expect(results).toEqual([
      {
        rows: [{ ref: THIRD, parent: OTHER, lineNumber: 1 }],
        ownerVersion: 5,
      },
    ])
  })

  it("runs a ctx.read count in the command transaction", async () => {
    const counts: unknown[] = []
    const { db, runtime } = await withModules(
      {
        "Catalog.Client": {
          async beforeWrite({ ctx, draft }) {
            counts.push(await ctx.read({ object: RIGHTS, count: true }))
            return draft
          },
        },
      },
      (text) => (text.includes(" AS n ") ? { rows: [{ n: "4" }] } : undefined)
    )
    await runtime.run(session, create)
    expect(db.calls).toEqual([
      ...OPEN,
      {
        text: 'SELECT count(*) AS n FROM (SELECT 1 FROM "public"."rights_role" t LIMIT $1) c',
        params: ["10001"],
      },
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
    expect(counts).toEqual([{ count: 4 }])
  })

  // `57014` — межа часу читання й у транзакції команди (В7); сам `ctx.read`
  // `statement_timeout` не ставить — оператори нижче це фіксують.
  it.each([
    ["22P02", "command.invalid"],
    ["57014", "command.timeout"],
  ])("maps %s of ctx.read to %s", async (code, mapped) => {
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
          ? { error: { code, message: "bad input" } }
          : undefined
    )
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: mapped,
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

describe("a ctx call rejected without a failure", () => {
  // Хук не чекає `ctx.read`: відхилений проміс без відмови в черзі інакше
  // дав би COMMIT (Р-A3-15).
  const readsSubject = (subject: unknown) =>
    setup(rightsCore, {
      catalog: taskCatalog,
      objectModules: {
        "Catalog.Client": {
          beforeWrite({ ctx, draft }) {
            void ctx.read({
              object: TASK,
              where: { attribute: "subject", op: "eq", value: subject },
              limit: 1,
            })
            return draft
          },
        },
      },
    })

  it("fails the command with a logged command.internal on an unexpected exception", async () => {
    const boom = new Error("boom")
    vi.mocked(prepareRead).mockImplementationOnce(() => {
      throw boom
    })
    const { db, runtime, log } = await readsSubject(null)
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.internal",
    })
    expect(db.calls).toEqual(CLOSED)
    expect(db.calls).not.toContainEqual(COMMIT)
    expect(log.mock.calls).toEqual([[{ kind: "hook", error: boom }]])
  })

  it("fails the command when a where value getter throws", async () => {
    const subject = {
      id: OTHER,
      get type(): string {
        throw new Error("trap")
      },
    }
    const { db, runtime, log } = await readsSubject(subject)
    // Відмова `ctx.read` — об'єкт запиту.
    expect(await failureOf(runtime.run(session, create))).toEqual({
      code: "command.invalid",
      path: "where.value",
      object: TASK,
    })
    expect(db.calls).toEqual(CLOSED)
    expect(db.calls).not.toContainEqual(COMMIT)
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
            await ctx.run(createTicket())
            return draft
          },
          onWrite({ ctx }) {
            seen.push(ctx.additionalProperties.get("seen"))
          },
        },
        "Catalog.Ticket": {
          beforeWrite({ ctx, draft }) {
            sizes.push(["ticket", ctx.additionalProperties.size])
            ctx.additionalProperties.set("seen", "ticket")
            return draft
          },
        },
      },
      (text) => {
        if (text.includes("ticket_save")) {
          cores++
          return {
            rows: [
              {
                r: JSON.stringify({
                  id: OTHER,
                  version: cores,
                  code: "R",
                  company_id: COMPANY,
                }),
              },
            ],
          }
        }
        return text.includes("client_save") && cores === 1
          ? { error: { code: "40001", message: "retry" } }
          : undefined
      }
    )
    const result = await runtime.run(session, create)
    // Інваріант 16: повтор — з порожніми `additionalProperties`.
    expect(sizes).toEqual([
      ["client", 0],
      ["ticket", 0],
      ["client", 0],
      ["ticket", 0],
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
    ...rightsRolePhase(),
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

describe("tabular section arrays", () => {
  const ORDER = { kind: "Catalog" as const, name: "Order" }
  const LINE = "66666666-6666-4666-8666-666666666666"
  const order = commandObject({
    name: "Order",
    table: "order",
    tabularSections: sample.tabularSections,
  })
  const orderCatalog = { ...catalog, objects: [...catalog.objects, order] }
  const update = (extra: object = {}): Operation =>
    ({
      action: "update",
      object: ORDER,
      id: ID,
      expectedVersion: 1,
      tabularSections: { lines: [{ ref: LINE }] },
      ...extra,
    }) as Operation
  const ids = (n: number) =>
    n === 0
      ? "'{}'::uuid[]"
      : `ARRAY[${Array.from({ length: n }, (_, i) => `$${i + 2}::uuid`).join(", ")}]`
  const check = (rows: string[]) => ({
    text:
      'SELECT o."version"::text AS version, (SELECT s."id" FROM' +
      ' "public"."sample_lines" s WHERE s."parent_id" = o."id" AND' +
      ` s."id" <> ALL(${ids(rows.length)}) LIMIT 1) AS missing` +
      ' FROM "public"."order" o WHERE o."id" = $1::uuid',
    params: [ID, ...rows],
  })
  const orderContext = context("update", "order", ID)
  const orderCore = (lines: string[]) =>
    call("order_save", SAVE, [
      JSON.stringify({
        id: ID,
        tabular: { sample_lines: lines.map((id) => ({ id })) },
      }),
      "1",
    ])
  /** Відповідь оператора перевірки; без рядка — власника не видно. */
  const checked =
    (row?: { version: string; missing: string | null }): Override =>
    (text) =>
      text.includes(" AS missing ")
        ? { rows: row === undefined ? [] : [row] }
        : undefined
  const fresh = checked({ version: "1", missing: null })
  const withOrder = (override: Override, objectModules: Modules = {}) =>
    setup(override, { catalog: orderCatalog, objectModules })

  it("checks the input arrays before beforeWrite in one unit with the context", async () => {
    let before = -1
    const { db, runtime } = await withOrder(fresh, {
      "Catalog.Order": {
        beforeWrite({ draft }) {
          before = db.calls.length
          return draft
        },
      },
    })
    await runtime.run(session, update({ deleteIds: { lines: [OTHER] } }))
    expect(db.calls).toEqual([
      ...OPEN,
      orderContext,
      check([LINE, OTHER]),
      orderContext,
      orderCore([LINE]),
      COMMIT,
      { release: false },
    ])
    expect(before).toBe(OPEN.length + 2)
  })

  it.each<[string, Override]>([
    ["the owner is not visible", checked()],
    ["the version differs", checked({ version: "2", missing: OTHER })],
    ["no row is missing", fresh],
  ])("leaves the verdict to the core when %s", async (_, override) => {
    const { db, runtime } = await withOrder(override)
    await runtime.run(session, update())
    expect(db.calls).toEqual([
      ...OPEN,
      orderContext,
      check([LINE]),
      orderContext,
      orderCore([LINE]),
      COMMIT,
      { release: false },
    ])
  })

  it("refuses an array that leaves out an existing row, before hooks and the core", async () => {
    const hook = vi.fn(({ draft }: { draft: object }) => draft)
    const { db, runtime } = await withOrder(
      checked({ version: "1", missing: OTHER }),
      { "Catalog.Order": { beforeWrite: hook } }
    )
    expect(
      await failureOf(
        runtime.run(session, update({ tabularSections: { lines: [] } }))
      )
    ).toEqual({
      code: "command.invalid",
      reason: "tabular-rows-missing",
      path: "lines",
      object: ORDER,
    })
    expect(hook).not.toHaveBeenCalled()
    expect(db.calls).toEqual([
      ...OPEN,
      orderContext,
      check([]),
      ROLLBACK,
      { release: false },
    ])
  })

  it("refuses an id both in the array and in deleteIds before the database", async () => {
    const { db, runtime } = await withOrder(fresh)
    expect(
      await failureOf(
        runtime.run(session, update({ deleteIds: { lines: [OTHER, LINE] } }))
      )
    ).toEqual({
      code: "command.invalid",
      path: "deleteIds.lines.1",
      object: ORDER,
    })
    expect(db.calls).toEqual([])
  })

  it("checks the input array, not the array a hook returns", async () => {
    const { db, runtime } = await withOrder(fresh, {
      "Catalog.Order": {
        beforeWrite: () => ({ tabularSections: { lines: [] } }),
      },
    })
    await runtime.run(session, update())
    expect(db.calls).toContainEqual(check([LINE]))
    expect(db.calls).toContainEqual(orderCore([]))
  })

  it("sends no check with fullTabularArrays", async () => {
    const { db, runtime } = await withOrder(fresh)
    await runtime.run(session, update(), { fullTabularArrays: true })
    expect(db.calls).toEqual([
      ...OPEN,
      orderContext,
      orderCore([LINE]),
      COMMIT,
      { release: false },
    ])
  })

  // Повний масив сам видаляє пропущені рядки, тож `deleteIds` поруч із ним
  // нічого б не значив: мовчазний ігнор сховав би помилку викликача.
  it("refuses deleteIds with fullTabularArrays before the database", async () => {
    const { db, runtime } = await withOrder(fresh)
    expect(
      await failureOf(
        runtime.run(session, update({ deleteIds: { lines: [OTHER] } }), {
          fullTabularArrays: true,
        })
      )
    ).toEqual({ code: "command.invalid", path: "deleteIds", object: ORDER })
    expect(db.calls).toEqual([])
  })

  it("checks a ctx.run phase even when run has fullTabularArrays", async () => {
    const { db, runtime } = await withOrder(fresh, {
      "Catalog.Client": {
        async beforeWrite({ ctx, draft }) {
          await ctx.run(update())
          return draft
        },
      },
    })
    await runtime.run(session, create, { fullTabularArrays: true })
    expect(db.calls).toEqual([
      ...OPEN,
      orderContext,
      check([LINE]),
      orderContext,
      orderCore([LINE]),
      ...clientPhase,
      COMMIT,
      { release: false },
    ])
  })

  it("does not check a create", async () => {
    const { db, runtime } = await withOrder(fresh)
    await runtime.run(session, {
      action: "create",
      object: ORDER,
      id: ID,
      values: { company: COMPANY },
      tabularSections: { lines: [{ ref: LINE }] },
    })
    expect(
      db.calls.some((c) => "text" in c && c.text.includes(" AS missing "))
    ).toBe(false)
  })

  it("shows beforeWrite the whole input array without deleteIds", async () => {
    const seen: unknown[] = []
    const { runtime } = await withOrder(fresh, {
      "Catalog.Order": {
        beforeWrite({ draft }) {
          seen.push(structuredClone(draft))
          return draft
        },
      },
    })
    await runtime.run(session, update({ deleteIds: { lines: [OTHER] } }))
    expect(seen).toEqual([{ tabularSections: { lines: [{ ref: LINE }] } }])
  })

  describe("reduced input limits", () => {
    const tooLarge = {
      code: "command.invalid",
      reason: "tabular-too-large",
      path: "lines",
      object: ORDER,
    }
    const twoLines = update({
      tabularSections: { lines: [{ ref: LINE }, { ref: OTHER }] },
    })

    it.each<[string, Partial<CommandRuntimeOptions>, unknown, object]>([
      [
        "a batch over maxBatch",
        { maxBatch: 2 },
        [create, create, create],
        { code: "command.invalid", reason: "batch-too-large" },
      ],
      [
        "a section over maxTabularLines",
        { maxTabularLines: 1 },
        twoLines,
        tooLarge,
      ],
      [
        "a section over maxTabularLines in the second operation of a batch",
        { maxTabularLines: 1 },
        [update(), twoLines],
        tooLarge,
      ],
    ])("refuses %s before the database", async (_, limits, input, error) => {
      const { db, runtime } = await setup(fresh, {
        catalog: orderCatalog,
        ...limits,
      })
      expect(await failureOf(runtime.run(session, input as Operation))).toEqual(
        error
      )
      expect(db.calls).toEqual([])
    })

    it("runs a batch and a section at the reduced limits", async () => {
      const { db, runtime } = await setup(fresh, {
        catalog: orderCatalog,
        maxBatch: 2,
        maxTabularLines: 1,
      })
      await runtime.run(session, [create, update()])
      expect(db.calls.slice(-2)).toEqual([COMMIT, { release: false }])
    })

    it("refuses a ctx.run section over maxTabularLines before its statements", async () => {
      const { db, runtime } = await setup(fresh, {
        catalog: orderCatalog,
        maxTabularLines: 1,
        objectModules: {
          "Catalog.Client": {
            async beforeWrite({ ctx, draft }) {
              await ctx.run(twoLines)
              return draft
            },
          },
        },
      })
      expect(await failureOf(runtime.run(session, create))).toEqual(tooLarge)
      expect(db.calls).toEqual(CLOSED)
    })

    // Оператор перевірки шле параметр на кожен id: масив і `deleteIds` на
    // сталій межі мусять уміститися в один оператор нижче межі Postgres.
    const rowId = (variant: string, i: number) =>
      `00000000-0000-4000-${variant}000-${String(i).padStart(12, "0")}`
    const full = (lines: number) =>
      update({
        tabularSections: {
          lines: Array.from({ length: lines }, (_, i) => ({
            ref: rowId("8", i),
          })),
        },
        deleteIds: {
          lines: Array.from({ length: TABULAR_LINES_MAX }, (_, i) =>
            rowId("9", i)
          ),
        },
      })

    it("checks TABULAR_LINES_MAX rows and as many deleteIds in one statement", async () => {
      const { db, runtime } = await withOrder(fresh)
      await runtime.run(session, full(TABULAR_LINES_MAX))
      const checks = db.calls.filter(
        (c) => "text" in c && c.text.includes(" AS missing ")
      )
      expect(checks).toHaveLength(1)
      const [statement] = checks as { params: readonly unknown[] }[]
      expect(statement!.params.length).toBeLessThanOrEqual(
        2 * TABULAR_LINES_MAX + 1
      )
    })

    it("refuses one row over TABULAR_LINES_MAX before the database", async () => {
      const { db, runtime } = await withOrder(fresh)
      expect(
        await failureOf(runtime.run(session, full(TABULAR_LINES_MAX + 1)))
      ).toEqual(tooLarge)
      expect(db.calls).toEqual([])
    })
  })

  it("correlates the section with its owner on every column of the foreign key", async () => {
    const [lines] = sample.tabularSections
    const composite = commandObject({
      name: "Order",
      table: "order",
      tabularSections: [
        {
          ...lines!,
          constraints: [
            {
              name: lines!.parentConstraint,
              kind: "foreignKey",
              columns: ["parent_id", "company_id"],
              references: ["id", "company_id"],
            },
          ],
        },
      ],
    })
    const { db, runtime } = await setup(fresh, {
      catalog: { ...catalog, objects: [...catalog.objects, composite] },
    })
    await runtime.run(session, update())
    const plain = check([LINE])
    expect(db.calls).toContainEqual({
      ...plain,
      text: plain.text.replace(
        's."parent_id" = o."id"',
        's."parent_id" = o."id" AND s."company_id" = o."company_id"'
      ),
    })
  })
})
