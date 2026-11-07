import { beforeAll, describe, expect, it } from "vitest"
import {
  buildClientCatalog,
  buildRuntimeCatalog,
  type CompiledModel,
} from "simetra/compiler"
import {
  clientCatalogSchema,
  objectColumns,
  type ClientCatalog,
  type RuntimeCatalog,
} from "simetra/model"
import {
  adminRoles,
  commandCoreLayer,
  compileRights,
  gaugeLoadLayer,
  policyDomain,
  rootCreationDomain,
  writeRoles,
} from "./fixtures/rights"

// Два домени разом дають усе, що несе спільна частина: `ref` з FK, ТЧ із
// `parentConstraint`, лінивий реквізит і корінь з творцем.
const domains = {
  core: () =>
    policyDomain(
      writeRoles(),
      adminRoles(),
      commandCoreLayer(),
      gaugeLoadLayer({})
    ),
  roots: rootCreationDomain,
}

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const { model, diagnostics } = await compileRights(files)
  expect(diagnostics).toEqual([])
  return model!
}

let runtimes: RuntimeCatalog[]
let clients: ClientCatalog[]
beforeAll(async () => {
  runtimes = await Promise.all(
    Object.values(domains).map(async (files) =>
      buildRuntimeCatalog(await compiled(files()))
    )
  )
  clients = runtimes.map(buildClientCatalog)
})

// Ключі, яких клієнт не бачить (рішення В7): їх знає лише ядро T3.
const SERVER_ONLY = [
  "operations",
  "membership",
  "constraints",
  "pgType",
  "castType",
  "function",
]

const keysOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap(keysOf)
    : typeof value === "object" && value !== null
      ? Object.entries(value).flatMap(([key, v]) => [key, ...keysOf(v)])
      : []

describe("buildClientCatalog", () => {
  it("passes the T0 schema and keeps the runtime provider and hash", () => {
    clients.forEach((client, index) => {
      expect(clientCatalogSchema.parse(client)).toEqual(client)
      expect(client.provider).toBe(runtimes[index]!.provider)
      expect(client.snapshotHash).toBe(runtimes[index]!.snapshotHash)
    })
  })

  it("is deterministic across compilations", async () => {
    const again = buildClientCatalog(
      buildRuntimeCatalog(await compiled(domains.core()))
    )
    expect(JSON.stringify(again)).toBe(JSON.stringify(clients[0]))
  })

  it("keeps the runtime object order", () => {
    clients.forEach((client, index) => {
      expect(client.objects.map((o) => o.id)).toEqual(
        runtimes[index]!.objects.map((o) => o.id)
      )
    })
  })

  it("carries no server-only key anywhere", () => {
    const keys = new Set(clients.flatMap(keysOf))
    // Без цього тест мовчки пройшов би на порожньому дереві.
    expect(keys.has("ref")).toBe(true)
    expect(SERVER_ONLY.filter((key) => keys.has(key))).toEqual([])
  })

  it("every entry carries kind, kindLabel, kernelHash and signal", () => {
    clients
      .flatMap((c) => c.objects)
      .forEach((entry) => {
        expect(entry.kind, entry.name).toBeTypeOf("string")
        expect(entry.kindLabel, entry.name).toBeTypeOf("string")
        expect(entry.kernelHash, entry.name).toMatch(/^[0-9a-f]{64}$/)
        expect(entry.signal, entry.name).toBeTypeOf("boolean")
      })
  })

  it("keeps ref with constraint, load, parentConstraint, section id and creatorMembership", () => {
    const pairs = clients.flatMap((client, index) =>
      client.objects.map((entry) => ({
        entry,
        runtime: runtimes[index]!.objects.find((o) => o.id === entry.id)!,
      }))
    )
    const attributes = pairs.flatMap(({ entry, runtime }) => [
      ...entry.attributes.map((a, i) => [a, runtime.attributes[i]!] as const),
      ...entry.tabularSections.flatMap((s, si) =>
        s.attributes.map(
          (a, i) => [a, runtime.tabularSections[si]!.attributes[i]!] as const
        )
      ),
    ])
    const refs = attributes.filter(([, r]) => r.ref !== undefined)
    expect(refs.length).toBeGreaterThan(0)
    refs.forEach(([a, r]) => expect(a.ref).toEqual(r.ref))
    const lazy = attributes.filter(([, r]) => r.load === "lazy")
    expect(lazy.length).toBeGreaterThan(0)
    lazy.forEach(([a]) => expect(a.load).toBe("lazy"))

    const sections = pairs.flatMap(({ entry, runtime }) =>
      entry.tabularSections.map((s, i) => [s, runtime.tabularSections[i]!])
    )
    expect(sections.length).toBeGreaterThan(0)
    sections.forEach(([s, r]) => {
      expect(s!.id).toBe(r!.id)
      expect(s!.parentConstraint).toBe(r!.parentConstraint)
    })

    const creators = pairs.filter(
      ({ runtime }) => runtime.creatorMembership !== undefined
    )
    expect(creators.length).toBeGreaterThan(0)
    creators.forEach(({ entry, runtime }) =>
      expect(entry.creatorMembership).toBe(runtime.creatorMembership)
    )
  })

  // Сервер і клієнт виводять переліки колонок однією функцією T0 (рішення
  // В2): проєкція не сміє загубити поле, від якого вони залежать.
  it("objectColumns of each projected entry equals that of the runtime entry", () => {
    clients.forEach((client, index) => {
      client.objects.forEach((entry, i) => {
        expect(objectColumns(entry), entry.name).toEqual(
          objectColumns(runtimes[index]!.objects[i]!)
        )
      })
    })
  })
})

describe("clientCatalogSchema", () => {
  it("rejects a creatorMembership outside the catalog", () => {
    const client = clients[1]!
    const membership = client.objects.find(
      (o) => o.creatorMembership !== undefined
    )!.creatorMembership
    const broken = {
      ...client,
      objects: client.objects.filter((o) => o.id !== membership),
    }
    const root = broken.objects.findIndex(
      (o) => o.creatorMembership !== undefined
    )
    const result = clientCatalogSchema.safeParse(broken)
    expect(result.success).toBe(false)
    expect(result.error!.issues.map((i) => i.path)).toEqual([
      ["objects", root, "creatorMembership"],
    ])
  })
})
