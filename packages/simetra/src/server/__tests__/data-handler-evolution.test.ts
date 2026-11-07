import { beforeAll, describe, expect, it, vi } from "vitest"
import { buildClientCatalog } from "simetra/compiler"
import {
  catalogIndex,
  changesFromWire,
  decodeRow,
  errorFromWire,
  operationToWire,
  readQueryToWire,
  readResultFromWire,
  type CatalogEntry,
  type CatalogIndex,
  type DataResponse,
  type Operation,
  type ReadQuery,
  type RuntimeCatalog,
  type WireRow,
} from "simetra/model"
import {
  EVOLUTION,
  evolvedCatalogs,
} from "../../compiler/__tests__/fixtures/evolution"
import { TICKET_ID } from "../../compiler/__tests__/fixtures/rights"
import { createDataHandler } from "../data-handler"
import type { RequestOrigin } from "../origin"
import { session, setup, type Override } from "./harness"

/**
 * Клієнт на каталозі `A` (стара вкладка), обробник над рантаймом `A′`
 * (спека П4-B §10): запит будують `*ToWire` клієнтського індексу, відповідь
 * читають `*FromWire` того самого індексу, а порт-фейк бази показує, що
 * дійшло до сервера. Платформа тут одна: перейменування й розширення не
 * змінюють форми передачі, тож `stale-client` дає лише те, чого в `A′` немає.
 */

const { object, attribute, section, added, removed } = EVOLUTION
const ID = "11111111-1111-4111-8111-111111111111"
const LINE_ID = "22222222-2222-4222-8222-222222222222"
const TARGET = "33333333-3333-4333-8333-333333333333"
const ORG = "44444444-4444-4444-8444-444444444444"
const UNKNOWN = "00000000-0000-4000-8000-0000000000ee"
const HTTP: RequestOrigin = {
  secFetchSite: "same-origin",
  expectedOrigin: "https://app.example",
}

let aPrime: RuntimeCatalog
let client: CatalogIndex
let ticket: CatalogEntry
let region: CatalogEntry
let sectionKey: string
let sectionId: string

beforeAll(async () => {
  let a: RuntimeCatalog
  ;({ a, aPrime } = await evolvedCatalogs())
  client = catalogIndex(buildClientCatalog(a).objects)
  const server = catalogIndex(aPrime.objects)
  ticket = client.byId.get(TICKET_ID)!
  // Без цього кейси нічого б не доводили: розійтися мають імена, а UUID і
  // `kernelHash` об'єкта — лишитися (інваріант спеки).
  expect(ticket.name).toBe(object.from)
  expect(server.byId.get(TICKET_ID)!.name).toBe(object.to)
  expect(server.byId.get(TICKET_ID)!.kernelHash).toBe(ticket.kernelHash)
  region = [...client.byId.values()].find((o) => o.name === "Region")!
  const lines = ticket.tabularSections.find((s) => s.name === section.from)!
  sectionKey = lines.keyName
  sectionId = lines.id
})

const refOf = (entry: CatalogEntry) => ({ kind: entry.kind, name: entry.name })
const columnOf = (name: string) =>
  ticket.attributes.find((a) => a.name === name)!.column

/** Рядок шапки `A′` у відповіді бази: `memo` — колонка, якої клієнт не знає. */
const ticketRow = {
  id: ID,
  version: 2,
  org_id: ORG,
  region_id: TARGET,
  [added]: "note",
}

/** Відповіді бази: читання шапки, ТЧ і цілі `include`, ядро запису. */
const database: Override = (text) => {
  if (text.includes("applied_snapshot_hash"))
    return { rows: [{ hash: aPrime.snapshotHash }] }
  if (text.includes('"public"."ticket" t')) {
    return {
      rows: [
        {
          row: JSON.stringify(ticketRow),
          tabular: JSON.stringify({
            ticket_checklist: [
              {
                id: LINE_ID,
                parent_id: ID,
                line_number: 1,
                org_id: ORG,
                line_region_id: TARGET,
                [added]: "line note",
              },
            ],
          }),
        },
      ],
    }
  }
  if (text.includes('"public"."region" t')) {
    return { rows: [{ row: JSON.stringify({ id: TARGET, version: 1 }) }] }
  }
  if (text.endsWith("AS r")) return { rows: [{ r: JSON.stringify(ticketRow) }] }
  return undefined
}

async function harness(override: Override = () => undefined) {
  // Створення рантайму теж питає базу: відповідь кейсу — лише на виклик.
  let live = false
  const { db, runtime } = await setup(
    (text, params) =>
      (live ? override(text, params) : undefined) ?? database(text, params),
    { catalog: aPrime }
  )
  live = true
  const run = vi.spyOn(runtime, "run")
  const read = vi.spyOn(runtime, "read")
  const handler = createDataHandler(runtime, { log: vi.fn() })
  const kernels = { [TICKET_ID]: ticket.kernelHash }
  const send = (request: object) =>
    handler(session, { subject: session.sub, request }, HTTP)
  return {
    db,
    run,
    read,
    readWire: (query: ReadQuery) => {
      const wire = readQueryToWire(client, query)
      if (!wire.ok) throw new Error(`unmapped query: ${JSON.stringify(wire)}`)
      return send({ type: "read", query: wire.value })
    },
    runWire: (operation: Operation) => {
      const wire = operationToWire(client, operation)
      if (!wire.ok) throw new Error(`unmapped op: ${JSON.stringify(wire)}`)
      return send({ type: "run", operation: wire.value, kernels })
    },
    send,
    kernels,
  }
}

const valueOf = (response: DataResponse) => {
  if (!response.ok) throw new Error(JSON.stringify(response.error))
  return response.value
}
const errorOf = (response: DataResponse) => {
  if (response.ok) throw new Error(JSON.stringify(response.value))
  return response.error
}

const update = (values: Record<string, unknown> = {}): Operation => ({
  action: "update",
  object: refOf(ticket),
  id: ID,
  expectedVersion: 1,
  values: { [attribute.from]: TARGET, ...values },
  tabularSections: {
    [section.from]: [{ [sectionKey]: LINE_ID, region: TARGET }],
  },
})

describe("data handler between catalogs A and A′", () => {
  // Каталог відомий щойно в `beforeAll`: таблиця дає будівники запитів.
  it.each<[string, () => ReadQuery]>([
    [
      "a page with a filter and include",
      () => ({
        object: refOf(ticket),
        where: { attribute: attribute.from, op: "eq", value: TARGET },
        include: [attribute.from],
        limit: 10,
      }),
    ],
    [
      "a card with include and sections",
      () => ({
        object: refOf(ticket),
        id: ID,
        include: [attribute.from],
        tabularSections: [section.from],
      }),
    ],
  ])("decodes %s into A's names", async (_, build) => {
    const query = build()
    const { readWire, read } = await harness()
    const value = valueOf(await readWire(query))
    // Сервер прочитав запит під іменами `A′`.
    expect(read.mock.calls[0]![1]).toMatchObject({
      object: { name: object.to },
      include: [attribute.to],
    })
    const decoded = readResultFromWire(client, query, value as never)
    if (!("rows" in decoded)) throw new Error("expected rows")
    const row = decoded.rows[0]!
    expect(row).toMatchObject({
      [ticket.keyName]: ID,
      [attribute.from]: TARGET,
    })
    expect(row).not.toHaveProperty(added)
    expect(Object.keys(decoded.included ?? {})).toEqual([
      `${region.kind}.${region.name}`,
    ])
    if (!("id" in query)) return
    const lines = (row.tabularSections as Record<string, object[]>)[
      section.from
    ]!
    expect(lines[0]).toMatchObject({ region: TARGET })
    expect(lines[0]).not.toHaveProperty(added)
  })

  it("runs an update with sections: the runtime gets A′ names, the reply decodes into A's", async () => {
    const { runWire, run } = await harness()
    const value = valueOf(await runWire(update())) as {
      rows: WireRow[]
      changes: Parameters<typeof changesFromWire>[1]
    }
    expect(run.mock.calls[0]![1]).toMatchObject({
      object: { name: object.to },
      values: { [attribute.to]: TARGET },
      tabularSections: { [section.to]: [{ region: TARGET }] },
    })
    const row = decodeRow(ticket, value.rows[0]!)
    expect(row).toMatchObject({
      [ticket.keyName]: ID,
      [attribute.from]: TARGET,
    })
    expect(row).not.toHaveProperty(added)
    expect(changesFromWire(client, value.changes)).toMatchObject({
      ok: true,
      value: [{ object: refOf(ticket), id: ID, operation: "update" }],
    })
  })

  it.each<[string, string, string[]]>([
    ["a header attribute", "ticket", [attribute.from]],
    ["a section attribute", "ticket_checklist", [`${section.from}.region`]],
  ])(
    "decodes a not-null violation of %s into A's names",
    async (_, table, attributes) => {
      const column =
        table === "ticket" ? columnOf(attribute.from) : "line_region_id"
      const { runWire } = await harness((text) =>
        text.endsWith("AS r")
          ? { error: { code: "23502", table, column } }
          : undefined
      )
      const error = errorFromWire(client, errorOf(await runWire(update())))
      expect(error).toEqual({
        code: "command.constraint",
        kind: "notNull",
        attributes,
        object: refOf(ticket),
      })
    }
  )

  describe("stale-client", () => {
    const subject = () => ({
      type: "Catalog.Project",
      id: TARGET,
    })

    it("a read naming the removed attribute", async () => {
      const { readWire, read, db } = await harness()
      const before = db.calls.length
      const error = errorOf(
        await readWire({
          object: refOf(ticket),
          where: { attribute: removed, op: "eq", value: subject() },
          limit: 10,
        })
      )
      expect(error).toMatchObject({ code: "command.stale-client" })
      expect(read).not.toHaveBeenCalled()
      expect(db.calls).toHaveLength(before)
    })

    it("a write setting the removed attribute", async () => {
      const { runWire, run } = await harness()
      const error = errorOf(await runWire(update({ [removed]: subject() })))
      expect(error).toMatchObject({ code: "command.stale-client" })
      expect(run).not.toHaveBeenCalled()
    })

    it("a write naming a section the model lacks", async () => {
      const { send, run, kernels } = await harness()
      const wire = operationToWire(client, update())
      if (!wire.ok) throw new Error("unmapped")
      const { tabularSections, ...rest } = wire.value as {
        tabularSections: Record<string, unknown>
      }
      const error = errorOf(
        await send({
          type: "run",
          operation: {
            ...rest,
            tabularSections: { [UNKNOWN]: tabularSections[sectionId] },
          },
          kernels,
        })
      )
      expect(error).toMatchObject({ code: "command.stale-client" })
      expect(run).not.toHaveBeenCalled()
    })

    it("a write without the removed attribute passes", async () => {
      const { runWire, run } = await harness()
      valueOf(await runWire(update()))
      expect(run).toHaveBeenCalledTimes(1)
    })
  })
})
