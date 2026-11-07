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

const withoutServerOnly = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutServerOnly)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => !SERVER_ONLY.includes(key))
            .map(([key, v]) => [key, withoutServerOnly(v)])
        )
      : value

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

  // Структурна рівність, а не перевірка форми: проєкція не сміє ні
  // загубити спільне поле, ні підмінити його значення.
  it("each entry equals its runtime entry without the server-only keys", () => {
    // Домени несуть кожне необов'язкове поле — інакше рівність мовчки
    // пройшла б і на проєкції, що його губить.
    const keys = new Set(clients.flatMap(keysOf))
    expect(
      [
        "ref",
        "load",
        "parentConstraint",
        "creatorMembership",
        "scopeKindId",
      ].filter((key) => !keys.has(key))
    ).toEqual([])
    clients.forEach((client, index) => {
      client.objects.forEach((entry, i) => {
        expect(entry, entry.name).toEqual(
          withoutServerOnly(runtimes[index]!.objects[i]!)
        )
      })
    })
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
