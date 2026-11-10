import { beforeAll, describe, expect, it } from "vitest"
import { buildClientCatalog } from "simetra/compiler"
import {
  catalogIndex,
  changesFromWire,
  changesToWire,
  errorFromWire,
  errorToWire,
  objectColumns,
  operationFromWire,
  operationToWire,
  readQueryFromWire,
  readQueryToWire,
  readResultFromWire,
  readResultToWire,
  type CatalogEntry,
  type CatalogIndex,
  type Change,
  type CommandError,
  type LogicalRow,
  type Operation,
  type ReadQuery,
  type RuntimeCatalog,
} from "simetra/model"
import { EVOLUTION, evolvedCatalogs } from "./fixtures/evolution"
import { TICKET_ID } from "./fixtures/rights"

const ID = "11111111-1111-4111-8111-111111111111"
const LINE_ID = "22222222-2222-4222-8222-222222222222"
const SECOND_LINE_ID = "44444444-4444-4444-8444-444444444444"
const TARGET_ID = "33333333-3333-4333-8333-333333333333"

const { object, attribute, section, added, removed } = EVOLUTION

/**
 * Клієнт на каталозі `A` (стара вкладка), сервер на каталозі рантайму `A′`
 * після перейменування й сумісного розширення (спека П4-B §10, Рд12): форма
 * передачі тримається на UUID і фізичних колонках, тож обидві сторони
 * розуміють одна одну без спільних логічних імен.
 */
let a: RuntimeCatalog
let aPrime: RuntimeCatalog
let client: CatalogIndex
let server: CatalogIndex
let ticket: CatalogEntry
let issue: CatalogEntry

beforeAll(async () => {
  ;({ a, aPrime } = await evolvedCatalogs())
  client = catalogIndex(buildClientCatalog(a).objects)
  server = catalogIndex(aPrime.objects)
  ticket = client.byId.get(TICKET_ID)!
  issue = server.byId.get(TICKET_ID)!
  // Без цього кейси нічого б не доводили: каталоги мусять розійтися саме в
  // іменах, а UUID об'єкта — лишитися.
  expect(ticket.name).toBe(object.from)
  expect(issue.name).toBe(object.to)
})

const refOf = (entry: CatalogEntry) => ({ kind: entry.kind, name: entry.name })
const sectionOf = (entry: CatalogEntry, name: string) =>
  entry.tabularSections.find((s) => s.name === name)!
const attributeOf = (
  owner: { attributes: CatalogEntry["attributes"] },
  name: string
) => owner.attributes.find((a) => a.name === name)!

/** Рядок картки з ТЧ: `memo` — лише в рядку сервера. */
function cardRow(
  entry: CatalogEntry,
  names: { attribute: string; section: string },
  extra: LogicalRow = {}
): LogicalRow {
  const lines = sectionOf(entry, names.section)
  return {
    [entry.keyName]: ID,
    [entry.versionName]: 2,
    [names.attribute]: TARGET_ID,
    ...extra,
    tabularSections: {
      [names.section]: [
        {
          [lines.keyName]: LINE_ID,
          [lines.parentName]: ID,
          [lines.lineNumberName]: 1,
          region: TARGET_ID,
          ...extra,
        },
      ],
    },
  }
}

const oldNames = { attribute: attribute.from, section: section.from }
const newNames = { attribute: attribute.to, section: section.to }

describe("mapping between catalogs A and A′", () => {
  it.each<[string, (names: { attribute: string; section: string }) => object]>([
    [
      "a page with a filter and include",
      (names) => ({
        where: { attribute: names.attribute, op: "eq", value: TARGET_ID },
        include: [names.attribute],
        limit: 10,
      }),
    ],
    [
      "a card with sections and include",
      (names) => ({
        id: ID,
        include: [names.attribute],
        tabularSections: [names.section],
      }),
    ],
  ])("maps %s by new names", (_, body) => {
    const query = (
      entry: CatalogEntry,
      names: { attribute: string; section: string }
    ) => ({ object: refOf(entry), ...body(names) }) as ReadQuery
    const wire = readQueryToWire(client, query(ticket, oldNames))
    expect(wire.ok).toBe(true)
    if (!wire.ok) return
    expect(readQueryFromWire(server, wire.value)).toEqual({
      ok: true,
      value: query(issue, newNames),
    })
    // Перейменування об'єкта, реквізиту й ТЧ форми передачі не змінює.
    expect(readQueryToWire(server, query(issue, newNames))).toEqual(wire)
    expect(wire.value).toMatchObject({
      object: TICKET_ID,
      include: [attributeOf(ticket, attribute.from).column],
    })
  })

  it("keeps the section id on the wire after renaming the section", () => {
    expect(sectionOf(issue, section.to).id).toBe(
      sectionOf(ticket, section.from).id
    )
  })

  it("decodes a card result of A′ into A's names without the new column", () => {
    const region = [...client.byId.values()].find(
      (o) => o.kind === "Catalog" && o.name === "Region"
    )!
    const included = {
      [`${region.kind}.${region.name}`]: [
        { [region.keyName]: TARGET_ID, [region.versionName]: 1 },
      ],
    }
    const queryOf = (entry: CatalogEntry, name: string): ReadQuery => ({
      object: refOf(entry),
      id: ID,
      tabularSections: [name],
      include: [entry === issue ? attribute.to : attribute.from],
    })
    const wire = readResultToWire(server, queryOf(issue, section.to), {
      rows: [cardRow(issue, newNames, { [added]: "note" })],
      included,
    })
    const decoded = readResultFromWire(
      client,
      queryOf(ticket, section.from),
      wire
    )
    expect(decoded).toEqual({ rows: [cardRow(ticket, oldNames)], included })
    // Окремо від `toEqual`: стара вкладка не бачить нової колонки ні в
    // шапці, ні в рядку ТЧ.
    if (!("rows" in decoded)) return
    // Запит без `known`: маркерів у відповіді немає.
    const row = decoded.rows[0] as LogicalRow
    const lines = (row.tabularSections as Record<string, LogicalRow[]>)[
      section.from
    ]!
    expect(Object.keys(row)).not.toContain(added)
    expect(Object.keys(lines[0]!)).not.toContain(added)
  })

  it("maps an update with a full replacement of section lines", () => {
    const op = (
      entry: CatalogEntry,
      names: { attribute: string; section: string }
    ): Operation => {
      const lines = sectionOf(entry, names.section)
      return {
        action: "update",
        object: refOf(entry),
        id: ID,
        expectedVersion: 1,
        values: { [names.attribute]: TARGET_ID },
        tabularSections: {
          [names.section]: [
            { [lines.keyName]: LINE_ID, region: TARGET_ID },
            { [lines.keyName]: SECOND_LINE_ID },
          ],
        },
      }
    }
    const wire = operationToWire(client, op(ticket, oldNames))
    expect(wire.ok).toBe(true)
    if (!wire.ok) return
    const mapped = operationFromWire(server, wire.value)
    expect(mapped).toEqual({ ok: true, value: op(issue, newNames) })
    expect(operationToWire(server, op(issue, newNames))).toEqual(wire)
    // Стара вкладка нової колонки не називає: значення `memo` в наявних
    // рядках зберігає сервер (B1b-2), а мапінг не дописує його порожнім.
    const memoColumn = attributeOf(sectionOf(issue, section.to), added).column
    const wireLines = (
      wire.value as { tabularSections: Record<string, LogicalRow[]> }
    ).tabularSections[sectionOf(issue, section.to).id]!
    for (const line of wireLines) expect(line).not.toHaveProperty(memoColumn)
    if (!mapped.ok) return
    const lines = (
      mapped.value as { tabularSections: Record<string, LogicalRow[]> }
    ).tabularSections[section.to]!
    for (const line of lines) expect(line).not.toHaveProperty(added)
  })

  it("decodes a command.constraint error of A′ into A's names", () => {
    const error = (
      entry: CatalogEntry,
      names: { attribute: string; section: string }
    ): CommandError => ({
      code: "command.constraint",
      kind: "unique",
      object: refOf(entry),
      attributes: [names.attribute, `${names.section}.region`],
    })
    const wire = errorToWire(server, error(issue, newNames))
    expect(wire).toEqual(errorToWire(client, error(ticket, oldNames)))
    expect(errorFromWire(client, wire)).toEqual(error(ticket, oldNames))
  })

  it("decodes a change set of A′ into A's object", () => {
    const changes = (entry: CatalogEntry): Change[] => [
      { object: refOf(entry), id: ID, version: 2, operation: "update" },
    ]
    const wire = changesToWire(server, changes(issue))
    expect(wire).toEqual(changesToWire(client, changes(ticket)))
    expect(wire.ok).toBe(true)
    if (!wire.ok) return
    expect(changesFromWire(client, wire.value)).toEqual({
      ok: true,
      value: changes(ticket),
    })
  })

  it("reports a query naming the removed attribute as unknown on A′", () => {
    const gone = attributeOf(ticket, removed)
    const target = gone.pair!.targets[0]!
    const wire = readQueryToWire(client, {
      object: refOf(ticket),
      where: {
        attribute: removed,
        op: "eq",
        value: { type: `${target.object.kind}.${target.object.name}`, id: ID },
      },
      limit: 10,
    })
    expect(wire.ok).toBe(true)
    if (!wire.ok) return
    expect(readQueryFromWire(server, wire.value)).toEqual({
      ok: false,
      unknown: { object: TICKET_ID, column: gone.column },
    })
  })

  it("only extends the column lists", () => {
    const gone = attributeOf(ticket, removed)
    const goneColumns = [gone.column, gone.pair!.typeColumn]
    const before = objectColumns(ticket)
    const after = objectColumns(issue)
    const kept = (columns: readonly string[]) =>
      columns.filter((c) => !goneColumns.includes(c))
    for (const list of ["insert", "update", "read", "lazy"] as const) {
      expect(after[list], list).toEqual(
        expect.arrayContaining(kept(before[list]))
      )
    }
    for (const [id, lists] of before.tabularSections) {
      const next = after.tabularSections.get(id)!
      for (const list of ["insert", "read"] as const) {
        expect(next[list], `${id} ${list}`).toEqual(
          expect.arrayContaining([...lists[list]])
        )
      }
    }
    // Окремо: колонка видаленого реквізиту зникла з переліків `A′`, тож
    // запит, що її називає, — несумісний (Рд12).
    const all = [after.insert, after.update, after.read, after.lazy].flat()
    for (const column of goneColumns) expect(all).not.toContain(column)
  })
})
