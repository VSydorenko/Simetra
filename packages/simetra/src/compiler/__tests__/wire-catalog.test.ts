import { beforeAll, describe, expect, it } from "vitest"
import { buildClientCatalog, buildRuntimeCatalog } from "simetra/compiler"
import {
  catalogIndex,
  decodeRow,
  encodeRow,
  errorFromWire,
  errorToWire,
  operationFromWire,
  operationToWire,
  pathFromWire,
  pathToWire,
  readQueryFromWire,
  readQueryToWire,
  readResultFromWire,
  readResultToWire,
  type CatalogEntry,
  type CatalogIndex,
  type CommandError,
  type LogicalRow,
  type Operation,
  type ReadQuery,
  type RuntimeObject,
} from "simetra/model"
import {
  adminRoles,
  commandCoreLayer,
  compileRights,
  policyDomain,
  rootCreationDomain,
  writeRoles,
} from "./fixtures/rights"

const ID = "11111111-1111-4111-8111-111111111111"
const LINE_ID = "22222222-2222-4222-8222-222222222222"
const TARGET_ID = "33333333-3333-4333-8333-333333333333"

// Скомпільований запис з парою й ТЧ: кодек має працювати на реальних іменах
// колонок і id ТЧ, а не лише на будівнику T0.
let runtime: RuntimeObject
let client: CatalogEntry
// Індекси обох каталогів кожного домену: мапінг має давати одну форму
// передачі, хоч сервер мапить каталогом рантайму, а T4 — клієнтським.
let core: { runtime: CatalogIndex; client: CatalogIndex }
let roots: { runtime: CatalogIndex; client: CatalogIndex }

async function indices(files: Map<string, string>) {
  const { model, diagnostics } = await compileRights(files)
  expect(diagnostics).toEqual([])
  const runtimeCatalog = buildRuntimeCatalog(model!)
  return {
    catalog: runtimeCatalog,
    runtime: catalogIndex(runtimeCatalog.objects),
    client: catalogIndex(buildClientCatalog(runtimeCatalog).objects),
  }
}

beforeAll(async () => {
  const built = await indices(
    policyDomain(writeRoles(), adminRoles(), commandCoreLayer())
  )
  const runtimeCatalog = built.catalog
  core = built
  roots = await indices(rootCreationDomain())
  runtime = runtimeCatalog.objects.find(
    (o) =>
      o.tabularSections.length > 0 &&
      o.attributes.some((a) => a.pair !== undefined)
  )!
  expect(runtime).toBeDefined()
  client = buildClientCatalog(runtimeCatalog).objects.find(
    (o) => o.id === runtime.id
  )!
})

function cardRow(entry: CatalogEntry): LogicalRow {
  const pair = entry.attributes.find((a) => a.pair !== undefined)!
  const target = pair.pair!.targets[0]!
  const section = entry.tabularSections[0]!
  return {
    [entry.keyName]: ID,
    [entry.versionName]: 2,
    [pair.name]: {
      type: `${target.object.kind}.${target.object.name}`,
      id: TARGET_ID,
    },
    tabularSections: {
      [section.name]: [
        {
          [section.keyName]: LINE_ID,
          [section.parentName]: ID,
          [section.lineNumberName]: 1,
        },
      ],
    },
  }
}

describe("wire codec on a compiled catalog", () => {
  it("encodes a pair as two columns and a section by its id", () => {
    const pair = runtime.attributes.find((a) => a.pair !== undefined)!
    const section = runtime.tabularSections[0]!
    const wire = encodeRow(runtime, cardRow(runtime))
    expect(wire).toEqual({
      [runtime.key]: ID,
      [runtime.versionColumn]: "2",
      [pair.pair!.typeColumn]: pair.pair!.targets[0]!.label,
      [pair.column]: TARGET_ID,
      tabularSections: {
        [section.id]: [
          {
            [section.key]: LINE_ID,
            [section.parent]: ID,
            [section.lineNumber]: "1",
          },
        ],
      },
    })
    expect(decodeRow(client, wire)).toEqual(cardRow(client))
  })

  it("gives the same wire form from the runtime and the client entry", () => {
    expect(encodeRow(client, cardRow(client))).toEqual(
      encodeRow(runtime, cardRow(runtime))
    )
  })
})

describe("mapping on a compiled catalog", () => {
  const refOf = (entry: CatalogEntry) => ({
    kind: entry.kind,
    name: entry.name,
  })

  // Обидва каталоги дають ту саму форму передачі, і вона повертається в
  // логічну форму будь-яким із них.
  function sameWire(
    pair: { runtime: CatalogIndex; client: CatalogIndex },
    op: Operation
  ) {
    const wire = operationToWire(pair.runtime, op)
    expect(wire.ok).toBe(true)
    expect(operationToWire(pair.client, op)).toEqual(wire)
    if (!wire.ok) return
    expect(operationFromWire(pair.runtime, wire.value)).toEqual({
      ok: true,
      value: op,
    })
    expect(operationFromWire(pair.client, wire.value)).toEqual({
      ok: true,
      value: op,
    })
  }

  it("maps an operation with a pair and a section line", () => {
    const pair = runtime.attributes.find((a) => a.pair !== undefined)!
    const target = pair.pair!.targets[0]!
    const section = runtime.tabularSections[0]!
    sameWire(core, {
      action: "update",
      object: refOf(runtime),
      id: ID,
      expectedVersion: 1,
      values: {
        [pair.name]: {
          type: `${target.object.kind}.${target.object.name}`,
          id: TARGET_ID,
        },
      },
      tabularSections: { [section.name]: [{ [section.keyName]: LINE_ID }] },
    })
  })

  it("maps an error with a pair and a section attribute", () => {
    const pair = runtime.attributes.find((a) => a.pair !== undefined)!
    const section = runtime.tabularSections.find(
      (s) => s.attributes.length > 0
    )!
    const attribute = section.attributes[0]!
    const error: CommandError = {
      code: "command.constraint",
      kind: "unique",
      object: refOf(runtime),
      attributes: [pair.name, `${section.name}.${attribute.name}`],
    }
    const wire = errorToWire(core.runtime, error)
    expect(wire.attributes).toEqual([
      pair.column,
      `${section.id}.${attribute.column}`,
    ])
    expect(errorToWire(core.client, error)).toEqual(wire)
    expect(errorFromWire(core.client, wire)).toEqual(error)
  })

  it("round-trips a standard section with a synthetic id", () => {
    const owner = [...core.runtime.byId.values()].find((o) =>
      o.tabularSections.some((s) => s.id.includes("#"))
    )!
    const section = owner.tabularSections.find((s) => s.id.includes("#"))!
    const attribute = section.attributes[0]!
    const path = `${section.name}.0.${attribute.name}`
    const wirePath = pathToWire(core.client, owner.id, path)
    expect(wirePath).toBe(`${section.id}.0.${attribute.column}`)
    expect(pathFromWire(core.runtime, owner.id, wirePath)).toBe(path)
    sameWire(core, {
      action: "update",
      object: refOf(owner),
      id: ID,
      expectedVersion: 1,
      tabularSections: { [section.name]: [{ [section.keyName]: LINE_ID }] },
    })
  })

  it("maps creatorMember of a root by its membership catalog", () => {
    const root = [...roots.client.byId.values()].find(
      (o) => o.creatorMembership !== undefined
    )!
    const membership = roots.client.byId.get(root.creatorMembership!)!
    // Одноцільове посилання чи UUID: значення — UUID без перекладу.
    const attribute = membership.attributes.find(
      (a) =>
        (a.type === "UUID" || a.type === "Ref") &&
        a.enumValues === undefined &&
        a.pair === undefined &&
        a.array === undefined
    )!
    const op: Operation = {
      action: "create",
      object: refOf(root),
      creatorMember: { [attribute.name]: TARGET_ID },
    }
    sameWire(roots, op)
    expect(operationToWire(roots.client, op)).toEqual({
      ok: true,
      value: {
        action: "create",
        object: root.id,
        creatorMember: { [attribute.column]: TARGET_ID },
      },
    })
  })
})

describe("read mapping on a compiled catalog", () => {
  const object = () => ({ kind: runtime.kind, name: runtime.name })

  // Обидва каталоги дають ту саму форму передачі запиту, і будь-який з них
  // повертає її в логічну.
  function sameRead(query: ReadQuery) {
    const wire = readQueryToWire(core.runtime, query)
    expect(wire.ok).toBe(true)
    expect(readQueryToWire(core.client, query)).toEqual(wire)
    if (!wire.ok) return undefined
    for (const index of [core.runtime, core.client]) {
      expect(readQueryFromWire(index, wire.value)).toEqual({
        ok: true,
        value: query,
      })
    }
    return wire.value
  }

  it("maps a page by a pair and the version, a card and owner lines", () => {
    const pair = runtime.attributes.find((a) => a.pair !== undefined)!
    const target = pair.pair!.targets[0]!
    const section = runtime.tabularSections[0]!
    const include = runtime.attributes.find(
      (a) => a.ref !== undefined && core.client.byId.has(a.ref.object)
    )!
    expect(include).toBeDefined()
    const page = sameRead({
      object: object(),
      where: {
        and: [
          {
            attribute: pair.name,
            op: "eq",
            value: {
              type: `${target.object.kind}.${target.object.name}`,
              id: TARGET_ID,
            },
          },
          { attribute: runtime.versionName, op: "gt", value: 1 },
        ],
      },
      orderBy: [{ attribute: runtime.keyName, direction: "asc" }],
      limit: 5,
      include: [include.name],
    })
    expect(page).toEqual({
      object: runtime.id,
      where: {
        and: [
          {
            attribute: pair.column,
            op: "eq",
            value: { type: target.label, id: TARGET_ID },
          },
          { attribute: runtime.versionColumn, op: "gt", value: "1" },
        ],
      },
      orderBy: [{ attribute: runtime.key, direction: "asc" }],
      limit: 5,
      include: [include.column],
    })
    expect(
      sameRead({ object: object(), id: ID, tabularSections: [section.name] })
    ).toMatchObject({ tabularSections: [section.id] })
    expect(
      sameRead({ object: object(), tabularSection: section.name, owner: ID })
    ).toMatchObject({ tabularSection: section.id })
  })

  it("maps a card result the same way with both catalogs", () => {
    const query: ReadQuery = { object: object(), id: ID, tabularSections: true }
    const wire = readResultToWire(core.runtime, query, {
      rows: [cardRow(runtime)],
    })
    expect(
      readResultToWire(core.client, query, { rows: [cardRow(client)] })
    ).toEqual(wire)
    expect(readResultFromWire(core.client, query, wire)).toEqual({
      rows: [cardRow(client)],
    })
  })
})
