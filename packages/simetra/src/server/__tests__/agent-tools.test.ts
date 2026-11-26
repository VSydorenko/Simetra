import {
  CommandFailure,
  COMMAND_ERROR_CODES,
  type Batch,
  type CommandResult,
  type ReadQuery,
  type SessionClaims,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  AGENT_ERROR_CODES,
  AGENT_OUTCOMES,
  agentResultToMcp,
  type AgentToolError,
  type AgentToolResult,
  type AgentToolSuccess,
} from "../agent"
import { createAgentToolCatalog } from "../agent-catalog"
import type { CommandRuntime } from "../runtime"
import { CLIENT, RIGHTS, ROLE_ASSIGNMENT, TICKET, session } from "./harness"
import { ID, catalog } from "./fixtures"

const claims = session as SessionClaims

// Бюджет описів каталогу (Р-F3-14): розмір JSON переліку
// `{ name, title, description, inputSchema, annotations }`. Правило зміни:
// новий бюджет = виміряний розмір × 1,05 з округленням угору; зниження
// опускає бюджет на цілу різницю. Як заміряти: тимчасово поставити
// `AGENT_TOOLS_BUDGET = 20_902` і запустити цей файл — падіння друкує розмір
// («expected N to be less than or equal to 0») на дереві без зміни та на
// дереві зі зміною; число з цього коментаря не брати. Замір 19731 символ →
// бюджет 20 718 (19731 × 1,05). Додано `offset` у вхід `describe` (сторінки
// переліку, Р-F3-11): до — 19731, після — 19906 (+175), бюджет 20 718 +
// ceil(175 × 1,05) = 20 902. Операції `publish` і `unpublish` (Р-D1-11) —
// два варіанти схеми пакета в `write` і `remove`: замір 23741 символ → бюджет
// 24 929 (23741 × 1,05).
const AGENT_TOOLS_BUDGET = 24_929

const update = (object: typeof CLIENT, id = ID) =>
  ({
    action: "update",
    object,
    id,
    expectedVersion: 1,
    values: { code: "B" },
  }) as const
const mark = (object: typeof CLIENT) =>
  ({
    action: "markDeletion",
    object,
    id: ID,
    expectedVersion: 1,
    mark: true,
  }) as const
const del = (object: typeof CLIENT) =>
  ({ action: "delete", object, id: ID, expectedVersion: 1 }) as const
const createOp = {
  action: "create",
  object: CLIENT,
  values: { code: "A" },
} as const

interface Fake {
  runs: Batch[]
  reads: ReadQuery[]
  tools: ReturnType<typeof createAgentToolCatalog>
}

/** Каталог над фейковим рантаймом: `runs` — усе, що дійшло до `run`. */
function fake(
  options: {
    run?: (batch: Batch) => CommandResult | Error
    read?: (query: ReadQuery) => unknown
    maxResultChars?: number
    rightsWrite?: boolean
  } = {}
): Fake {
  const runs: Batch[] = []
  const reads: ReadQuery[] = []
  const runtime = {
    catalog,
    async run(_: SessionClaims, batch: Batch) {
      runs.push(batch)
      const out = options.run?.(batch) ?? {
        rows: batch.map(() => ({ ref: ID, version: 2 })),
        changes: [],
        epoch: "e",
      }
      if (out instanceof Error) throw out
      return out
    },
    async read(_: SessionClaims, query: ReadQuery) {
      reads.push(query)
      return options.read?.(query) ?? { rows: [] }
    },
  } as unknown as CommandRuntime
  return {
    runs,
    reads,
    tools: createAgentToolCatalog({
      runtime,
      maxResultChars: options.maxResultChars,
      permissions: { rightsWrite: options.rightsWrite === true },
    }),
  }
}

const isError = (r: AgentToolResult): r is AgentToolError => "code" in r
function failed(r: AgentToolResult): AgentToolError {
  if (!isError(r)) throw new Error("expected an error result")
  return r
}
function ok(r: AgentToolResult): AgentToolSuccess {
  if (isError(r)) throw new Error(`unexpected error ${r.code}: ${r.message}`)
  return r
}

describe("descriptors", () => {
  const { tools } = fake().tools

  it("перелічують describe, read, write, remove з іменами й описами за межами", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "describe",
      "read",
      "write",
      "remove",
    ])
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,47}$/)
      expect(t.description.length).toBeLessThanOrEqual(4096)
      expect(t.title.length).toBeGreaterThan(0)
    }
  })

  // Типові значення MCP небезпечні (`destructiveHint: true`,
  // `openWorldHint: true`), тож кожне значення задано явно.
  it("несуть усі позначки явно, значення спеки §5.3", () => {
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]))
    const readOnly = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
    const writes = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    }
    expect(hints).toEqual({
      describe: readOnly,
      read: readOnly,
      write: writes,
      remove: writes,
    })
  })

  // Р-F3-14
  it("вкладаються в бюджет розміру описів", () => {
    const listing = tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input),
      annotations: t.annotations,
    }))
    expect(
      JSON.stringify(listing).length,
      "the catalog budget is deliberate; raising it is a reviewed decision (P4-F spec §5.3)"
    ).toBeLessThanOrEqual(AGENT_TOOLS_BUDGET)
  })
})

describe("input narrowing (І-F3-5)", () => {
  const cases: [string, string, Batch, string][] = [
    ["write", "порожній пакет", [], "operations"],
    ["remove", "порожній пакет", [], "operations"],
    [
      "write",
      "remove-дія",
      [update(CLIENT), mark(CLIENT)],
      "operations.1.action",
    ],
    [
      "write",
      "два об'єкти",
      [update(CLIENT), update(TICKET)],
      "operations.1.object",
    ],
    ["remove", "write-дія", [mark(CLIENT), createOp], "operations.1.action"],
    // Публікація нічого не видаляє: вона — дієслово запису (Р-D1-11).
    [
      "remove",
      "publish",
      [mark(CLIENT), { ...del(CLIENT), action: "publish" }],
      "operations.1.action",
    ],
    [
      "remove",
      "два об'єкти",
      [mark(CLIENT), del(TICKET)],
      "operations.1.object",
    ],
  ]
  it.each(cases)(
    "%s: %s — invalid-input зі шляхом, run не кличеться",
    async (tool, _, batch, path) => {
      const f = fake()
      const r = failed(await f.tools.call(claims, tool, { operations: batch }))
      expect(r.code).toBe("catalog.invalid-input")
      expect(r.path).toBe(path)
      expect(r.outcome).toBe("fix_input")
      expect(f.runs).toEqual([])
    }
  )

  it("write пропускає publish і unpublish", async () => {
    const f = fake()
    ok(
      await f.tools.call(claims, "write", {
        operations: [
          { ...del(CLIENT), action: "publish" },
          { ...del(CLIENT), action: "unpublish" },
        ],
      })
    )
  })

  it("пропускає свої дієслова над одним об'єктом", async () => {
    const f = fake()
    ok(
      await f.tools.call(claims, "write", {
        operations: [createOp, update(CLIENT)],
      })
    )
    ok(
      await f.tools.call(claims, "remove", {
        operations: [mark(CLIENT), del(CLIENT)],
      })
    )
    expect(f.runs).toHaveLength(2)
  })

  it("відмовляє на невідомому інструменті й зайвому ключі", async () => {
    const f = fake()
    expect(failed(await f.tools.call(claims, "nope", {})).code).toBe(
      "catalog.unknown-tool"
    )
    const r = failed(await f.tools.call(claims, "describe", { extra: 1 }))
    expect(r.code).toBe("catalog.invalid-input")
    expect(f.runs).toEqual([])
  })

  it("read відхиляє форму зі шляхом", async () => {
    const f = fake()
    const r = failed(
      await f.tools.call(claims, "read", {
        query: { object: CLIENT, limit: 0 },
      })
    )
    expect(r.code).toBe("catalog.invalid-input")
    expect(r.path).toContain("limit")
    expect(f.reads).toEqual([])
  })
})

describe("rights guard through every verb (І-F3-1)", () => {
  // Мутація «запобіжник лише під `write`» ловиться саме цими рядками:
  // `remove` змінює права через markDeletion ролі й delete призначення.
  it.each([
    ["write", [update(RIGHTS)]],
    ["write", [{ action: "create", object: ROLE_ASSIGNMENT, values: {} }]],
    ["remove", [mark(RIGHTS)]],
    ["remove", [del(ROLE_ASSIGNMENT)]],
    ["remove", [mark(ROLE_ASSIGNMENT)]],
  ] as [string, Batch][])(
    "%s без дозволу: відмова до run",
    async (tool, batch) => {
      const f = fake()
      const r = failed(await f.tools.call(claims, tool, { operations: batch }))
      expect(r.code).toBe("catalog.rights-write-refused")
      expect(r.outcome).toBe("ask_user")
      expect(f.runs).toEqual([])
    }
  )

  it("з дозволом доходить до run", async () => {
    const f = fake({ rightsWrite: true })
    ok(
      await f.tools.call(claims, "remove", {
        operations: [del(ROLE_ASSIGNMENT)],
      })
    )
    expect(f.runs).toHaveLength(1)
  })
})

describe("describe tool", () => {
  it("без аргументів перелічує об'єкти, з назвою — описує", async () => {
    const f = fake()
    const list = ok(await f.tools.call(claims, "describe", {}))
    expect(list.state).toBe("done")
    expect((list.data as { objects: unknown[] }).objects).toHaveLength(
      catalog.objects.length
    )
    const one = ok(await f.tools.call(claims, "describe", { object: CLIENT }))
    expect((one.data as { object: unknown }).object).toEqual(CLIENT)
    expect(f.runs).toEqual([])
  })

  it("невідомий об'єкт — catalog.unknown-object, fix_input", async () => {
    const r = failed(
      await fake().tools.call(claims, "describe", {
        object: { kind: "Catalog", name: "Ghost" },
      })
    )
    expect(r.code).toBe("catalog.unknown-object")
    expect(r.outcome).toBe("fix_input")
  })

  it("перелік понад межу — сторінки за continuation.offset, кожен об'єкт рівно раз", async () => {
    const f = fake({ maxResultChars: 400 })
    const seen: string[] = []
    let offset: number | undefined
    let pages = 0
    do {
      const r = ok(
        await f.tools.call(
          claims,
          "describe",
          offset === undefined ? {} : { offset }
        )
      )
      expect(JSON.stringify(r).length).toBeLessThanOrEqual(400)
      const page = (r.data as { objects: { object: { name: string } }[] })
        .objects
      expect(page.length).toBeGreaterThan(0)
      seen.push(...page.map((o) => o.object.name))
      if (r.truncated) {
        expect(r.hint).toContain("offset")
        expect(r.continuation).toEqual({ offset: seen.length })
        offset = r.continuation!.offset
      } else {
        expect(r.continuation).toBeUndefined()
        offset = undefined
      }
      pages++
    } while (offset !== undefined)
    expect(pages).toBeGreaterThan(1)
    expect(seen).toEqual(catalog.objects.map((o) => o.name))
  })

  it("offset разом з object — invalid-input", async () => {
    const f = fake()
    const r = failed(
      await f.tools.call(claims, "describe", { object: CLIENT, offset: 1 })
    )
    expect(r.code).toBe("catalog.invalid-input")
    expect(r.path).toBe("offset")
  })

  it("offset поза переліком — порожня сторінка без помилки", async () => {
    const r = ok(await fake().tools.call(claims, "describe", { offset: 999 }))
    expect((r.data as { objects: unknown[] }).objects).toEqual([])
    expect(r.truncated).toBeUndefined()
  })
})

describe("result size (Р-F3-11)", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ref: `id-${i}`,
      code: "x".repeat(100),
    }))

  it("сторінка read урізається з кінця з continuation.offset", async () => {
    const f = fake({ maxResultChars: 1500, read: () => ({ rows: rows(30) }) })
    const r = ok(
      await f.tools.call(claims, "read", {
        query: { object: CLIENT, limit: 30, offset: 10 },
      })
    )
    const kept = (r.data as { rows: unknown[] }).rows.length
    expect(r.truncated).toBe(true)
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(30)
    expect(r.continuation).toEqual({ offset: 10 + kept })
    expect(f.runs).toEqual([])
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(1500)
  })

  it("included лишається лише для лишених рядків", async () => {
    const f = fake({
      maxResultChars: 1500,
      read: () => ({
        rows: Array.from({ length: 30 }, (_, i) => ({
          ref: `id-${i}`,
          code: "x".repeat(100),
          company: `c-${i}`,
        })),
        included: {
          "Catalog.Client": Array.from({ length: 30 }, (_, i) => ({
            ref: `c-${i}`,
          })),
        },
      }),
    })
    const r = ok(
      await f.tools.call(claims, "read", {
        query: { object: CLIENT, limit: 30, include: ["company"] },
      })
    )
    const data = r.data as {
      rows: { company: string }[]
      included: Record<string, { ref: string }[]>
    }
    expect(data.included["Catalog.Client"]!.map((x) => x.ref)).toEqual(
      data.rows.map((x) => x.company)
    )
  })

  it("картка понад межу — result-too-large, fix_input", async () => {
    const f = fake({
      maxResultChars: 300,
      read: () => ({ rows: [{ ref: ID, code: "x".repeat(1000) }] }),
    })
    const r = failed(
      await f.tools.call(claims, "read", { query: { object: CLIENT, id: ID } })
    )
    expect(r.code).toBe("catalog.result-too-large")
    expect(r.outcome).toBe("fix_input")
  })

  it("рядки ТЧ власника понад межу — result-too-large, що називає форму", async () => {
    const f = fake({
      maxResultChars: 300,
      read: () => ({ rows: [{ line: "x".repeat(1000) }] }),
    })
    const r = failed(
      await f.tools.call(claims, "read", {
        query: { object: CLIENT, tabularSection: "lines", owner: ID },
      })
    )
    expect(r.code).toBe("catalog.result-too-large")
    expect(r.message).toContain("tabular section lines of one owner")
    expect(r.message).not.toContain("card")
  })

  it("результат запису понад межу — ніколи не помилка: ключ і версія, потім з кінця", async () => {
    const big = (n: number): CommandResult => ({
      rows: Array.from({ length: n }, (_, i) => ({
        ref: `id-${i}`,
        version: 2,
        code: "x".repeat(200),
      })),
      changes: Array.from({ length: n }, (_, i) => ({
        object: CLIENT,
        id: `id-${i}`,
        version: 2,
        operation: "update" as const,
      })),
      epoch: "e",
    })
    // Крок 1: достатньо урізати рядки до ключа й версії.
    const slim = fake({ run: () => big(10), maxResultChars: 1800 })
    const r1 = ok(
      await slim.tools.call(claims, "write", { operations: [createOp] })
    )
    expect(r1.state).toBe("done")
    expect(r1.truncated).toBe(true)
    const d1 = r1.data as CommandResult
    expect(d1.rows).toHaveLength(10)
    expect(Object.keys(d1.rows[0]!).sort()).toEqual(["ref", "version"])
    // Крок 2: і цього замало — рядки йдуть з кінця.
    const tight = fake({ run: () => big(10), maxResultChars: 600 })
    const r2 = ok(
      await tight.tools.call(claims, "remove", { operations: [del(CLIENT)] })
    )
    expect(r2.state).toBe("done")
    expect(r2.truncated).toBe(true)
    expect((r2.data as CommandResult).rows.length).toBeLessThan(10)
    expect(JSON.stringify(r2).length).toBeLessThanOrEqual(600)
    expect(tight.runs).toHaveLength(1)
  })

  it("одиничний рядок запису, що не вміщується, — усе одно done з truncated, не помилка", async () => {
    const f = fake({
      maxResultChars: 120,
      run: () => ({
        rows: [{ ref: ID, version: 2 }],
        changes: [{ object: CLIENT, id: ID, version: 2, operation: "create" }],
        epoch: "e".repeat(64),
      }),
    })
    const r = ok(
      await f.tools.call(claims, "write", { operations: [createOp] })
    )
    expect(r.state).toBe("done")
    expect(r.truncated).toBe(true)
    expect((r.data as CommandResult).rows).toEqual([])
    expect(f.runs).toHaveLength(1)
  })

  it("без урізання результат не несе truncated, а state ніколи не awaiting_confirmation", async () => {
    const r = ok(
      await fake().tools.call(claims, "write", { operations: [createOp] })
    )
    expect(r.truncated).toBeUndefined()
    expect(r.state).toBe("done")
  })
})

describe("errors (Р-F3-9)", () => {
  it("відображення outcome повне над усіма кодами", () => {
    expect(Object.keys(AGENT_OUTCOMES).sort()).toEqual(
      [...AGENT_ERROR_CODES].sort()
    )
    for (const code of COMMAND_ERROR_CODES)
      expect(AGENT_OUTCOMES[code]).toBeDefined()
    expect(AGENT_OUTCOMES["catalog.result-too-large"]).toBe("fix_input")
  })

  it("помилка рантайму несе вихідний CommandError без втрат", async () => {
    const error = {
      code: "command.conflict" as const,
      object: CLIENT,
      currentVersion: 5,
      path: "ref",
    }
    const f = fake({ run: () => new CommandFailure(error) })
    const r = failed(
      await f.tools.call(claims, "write", { operations: [update(CLIENT)] })
    )
    expect(r.code).toBe("command.conflict")
    expect(r.error).toEqual(error)
    expect(r.hint.length).toBeGreaterThan(0)
    expect(r.outcome).toBe("fix_input")
  })

  it("помилка читання теж CommandFailure у результаті", async () => {
    const f = fake()
    f.reads.length = 0
    const r = failed(
      await createAgentToolCatalog({
        runtime: {
          catalog,
          read: async () => {
            throw new CommandFailure({ code: "command.forbidden" })
          },
          run: async () => {
            throw new Error("no")
          },
        } as unknown as CommandRuntime,
      }).call(claims, "read", { query: { object: CLIENT, id: ID } })
    )
    expect(r.code).toBe("command.forbidden")
    expect(r.outcome).toBe("ask_user")
  })
})

describe("MCP presentation (Р-F3-10)", () => {
  // Кожне необов'язкове поле (`truncated`, `continuation`, `hint`) має бути
  // і в `structuredContent`, і в тексті: клієнти показують моделі різні частини.
  async function results(): Promise<[string, AgentToolSuccess][]> {
    const page = fake({
      maxResultChars: 1500,
      read: () => ({
        rows: Array.from({ length: 30 }, (_, i) => ({
          ref: `id-${i}`,
          code: "x".repeat(100),
        })),
      }),
    })
    const cutWrite = fake({
      maxResultChars: 300,
      run: () => ({
        rows: Array.from({ length: 10 }, (_, i) => ({
          ref: `id-${i}`,
          version: 2,
          code: "x".repeat(200),
        })),
        changes: [],
        epoch: "e",
      }),
    })
    return [
      [
        "describe",
        ok(await fake().tools.call(claims, "describe", { object: CLIENT })),
      ],
      [
        "cut read",
        ok(
          await page.tools.call(claims, "read", {
            query: { object: CLIENT, limit: 30 },
          })
        ),
      ],
      [
        "cut write",
        ok(
          await cutWrite.tools.call(claims, "write", { operations: [createOp] })
        ),
      ],
    ]
  }

  it("успіх: structuredContent — об'єкт результату, content — його повний текст", async () => {
    for (const [label, r] of await results()) {
      const mcp = agentResultToMcp(r)
      expect(mcp.isError, label).toBeUndefined()
      expect(mcp.structuredContent, label).toEqual(r)
      const text = mcp.content[0].text
      for (const [key, value] of Object.entries(mcp.structuredContent!))
        expect(text, `${label}: ${key}`).toContain(
          JSON.stringify({ [key]: value }).slice(1, -1)
        )
      expect(JSON.parse(text), label).toEqual(r)
    }
    const cut = (await results()).filter(([l]) => l.startsWith("cut"))
    for (const [, r] of cut) {
      expect(r.truncated).toBe(true)
      expect(r.hint).toBeDefined()
    }
    expect(cut[0]![1].continuation).toBeDefined()
  })

  it("помилка: isError, лише content з code, message, hint, outcome", async () => {
    const r = failed(
      await fake().tools.call(claims, "describe", {
        object: { kind: "Catalog", name: "Ghost" },
      })
    )
    const mcp = agentResultToMcp(r)
    expect(mcp.isError).toBe(true)
    expect(mcp.structuredContent).toBeUndefined()
    const parsed = JSON.parse(mcp.content[0].text)
    expect(parsed).toMatchObject({
      code: r.code,
      message: r.message,
      hint: r.hint,
      outcome: r.outcome,
    })
  })
})
