import { describe, expect, it } from "vitest"
import type { RightsSnapshot } from "simetra/model"
import type { RightsState, ViewSpec } from "../types"
import { TASK, key, seed, settle, setup, watch } from "./core-support"

/*
 * Знімок прав як стан сесії ядра (спека П4-B §9.1, §9.3; план B5b-2, задача 1):
 * частина `rights` у пакеті, `requestRights` single-flight, `rights-failed`.
 */

const USER = "00000000-0000-4000-8000-0000000000a1"
const V1 = "1".repeat(64)
const V2 = "2".repeat(64)
const SNAPSHOT: RightsSnapshot = { userId: USER, scopeSets: [], rights: [] }
const list: ViewSpec = { kind: "keys", object: TASK, keys: [key(1)] }

const harness = (options: Parameters<typeof setup>[0] = {}) => {
  const replaced: Array<[RightsState | undefined, RightsState]> = []
  const h = setup({
    rightsSnapshot: true,
    onRightsReplaced: (prev, next) => replaced.push([prev, next]),
    ...options,
  })
  h.fake.rightsSnapshot = SNAPSHOT
  h.fake.rightsVersion = V1
  return { ...h, replaced }
}

describe("rights part of the core", () => {
  it("sends no rights part, and holds no snapshot, without rightsSnapshot in the catalog", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    watch(core.view(list))
    core.requestRights()
    await settle()
    expect(fake.rightsReads).toEqual([])
    expect(core.rights()).toBeUndefined()
  })

  it("carries rights without known in the first packet and none in the next", async () => {
    const { core, fake, replaced } = harness()
    seed(fake, 1, 2)
    const handle = core.view(list)
    watch(handle)
    watch(core.view({ kind: "keys", object: TASK, keys: [key(2)] }))
    await settle()
    // Частина рядків + одна частина `rights` в одному запиті.
    expect(fake.requests[0]).toBe(3)
    expect(fake.rightsReads).toEqual([undefined])
    expect(handle.getSnapshot().rows).toHaveLength(1)
    expect(core.rights()).toMatchObject({
      snapshot: SNAPSHOT,
      rightsVersion: V1,
    })
    expect(replaced).toHaveLength(1)
    expect(replaced[0]![0]).toBeUndefined()

    watch(core.view({ kind: "keys", object: TASK, keys: [key(1)] }))
    await settle()
    expect(fake.rightsReads).toEqual([undefined])
  })

  it("makes one part of N requestRights calls in one microtask", async () => {
    const { core, fake } = harness()
    for (let i = 0; i < 5; i++) core.requestRights()
    await settle()
    expect(fake.requests).toEqual([1])
    expect(fake.rightsReads).toEqual([undefined])
  })

  it("makes exactly one tail, with known, for calls while the part flies", async () => {
    const { core, fake } = harness()
    fake.holdRights = true
    core.requestRights()
    await settle()
    core.requestRights()
    core.requestRights()
    fake.releaseRights()
    await settle()
    // Хвіст летить із `known` першого знімка й теж утримується.
    expect(fake.rightsReads).toEqual([undefined, V1])
    fake.releaseRights()
    await settle()
    expect(fake.rightsReads).toEqual([undefined, V1])
    expect(fake.requests).toEqual([1, 1])
  })

  it("keeps the snapshot and fixes the version when the answer has no snapshot", async () => {
    const { core, fake, replaced } = harness()
    core.requestRights()
    await settle()
    const first = core.rights()!
    core.requestRights()
    await settle()
    expect(fake.rightsReads).toEqual([undefined, V1])
    expect(core.rights()).toEqual(first)
    expect(replaced).toHaveLength(1)
  })

  it("replaces the snapshot with a larger rightsEpoch and applies after sending", async () => {
    const { core, fake, replaced } = harness()
    core.requestRights()
    await settle()
    const first = core.rights()!
    expect(first.appliedEpoch).toBeGreaterThan(first.rightsEpoch)
    const changed: RightsSnapshot = {
      userId: USER,
      scopeSets: [{ scopeKind: "Organization", scope: key(9) }],
      rights: [],
    }
    fake.rightsSnapshot = changed
    fake.rightsVersion = V2
    core.requestRights()
    await settle()
    const second = core.rights()!
    expect(second.snapshot).toEqual(changed)
    expect(second.rightsVersion).toBe(V2)
    expect(second.rightsEpoch).toBeGreaterThan(first.appliedEpoch)
    expect(replaced.map(([prev]) => prev?.rightsVersion)).toEqual([
      undefined,
      V1,
    ])
  })

  it("logs rights-failed and keeps the old snapshot when the part fails", async () => {
    const { core, fake, log } = harness()
    core.requestRights()
    await settle()
    const first = core.rights()!
    fake.rightsError = { code: "command.unavailable" }
    core.requestRights()
    await settle()
    expect(log).toContainEqual({ kind: "rights-failed" })
    expect(core.rights()).toEqual(first)
    // Автоповтору немає: ще один пакет не йшов.
    expect(fake.rightsReads).toEqual([undefined, V1])
  })

  it("logs rights-failed for a failed first part and holds no snapshot", async () => {
    const { core, fake, log } = harness()
    fake.rightsError = { code: "command.unavailable" }
    seed(fake, 1, 1)
    const handle = core.view(list)
    watch(handle)
    await settle()
    expect(log.filter((e) => e.kind === "rights-failed")).toHaveLength(1)
    expect(core.rights()).toBeUndefined()
    // Дані пакета не страждають від збою службової частини.
    expect(handle.getSnapshot().rows).toHaveLength(1)
  })

  it("writes nothing and asks nothing after dispose", async () => {
    const { core, fake, replaced } = harness()
    fake.holdRights = true
    core.requestRights()
    await settle()
    core.close("disposed")
    fake.releaseRights()
    await settle()
    core.requestRights()
    await settle()
    expect(core.rights()).toBeUndefined()
    expect(replaced).toEqual([])
    expect(fake.rightsReads).toEqual([undefined])
  })
})
