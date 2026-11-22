import { fileObjectKey } from "simetra/model"
import { describe, expect, it } from "vitest"
import { FileStoreError, type FileStore } from "../file-store"
import {
  reconcile,
  RECONCILE_GRACE_MS,
  type ReconcileLogEntry,
  type ReconcileSource,
} from "../reconcile"

const OBJ = "11111111-1111-4111-8111-111111111111"
const OTHER_OBJ = "99999999-9999-4999-8999-999999999999"
const NOW = Date.UTC(2026, 10, 22)
const OLD = new Date(NOW - RECONCILE_GRACE_MS - 1000)
const FRESH = new Date(NOW - RECONCILE_GRACE_MS + 1000)
const rowId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

interface Setup {
  /** key → lastModified */
  objects: Record<string, Date>
  /** object → ids of rows that exist */
  rows: Record<string, string[]>
  /** ids that appear only for the second check (a row created in between) */
  lateRows?: string[]
  refuse?: boolean
}

function setup(s: Setup) {
  const log: ReconcileLogEntry[] = []
  const deleted: string[] = []
  const calls: string[] = []
  const store: FileStore = {
    put: () => Promise.reject(new Error("unused")),
    get: () => Promise.reject(new Error("unused")),
    async delete(key) {
      deleted.push(key)
    },
    async *list(prefix) {
      for (const key of Object.keys(s.objects).sort())
        if (key.startsWith(prefix)) yield { key, lastModified: s.objects[key]! }
    },
    async *listPrefixes() {
      const seen = new Set<string>()
      for (const key of Object.keys(s.objects).sort()) {
        const p = key.slice(0, key.indexOf("/", 2) + 1)
        if (!seen.has(p)) {
          seen.add(p)
          yield p
        }
      }
    },
    async checkInstance() {
      calls.push("check")
      if (s.refuse === true) throw new FileStoreError("foreign-bucket", "other")
    },
  }
  let existsCalls = 0
  const source: ReconcileSource = {
    instance: async () => "inst",
    now: async () => NOW,
    async rowsExist(object, ids) {
      expect(ids.length).toBeLessThanOrEqual(1000)
      existsCalls++
      const have = new Set(s.rows[object] ?? [])
      // Друга перевірка бачить рядок, що з'явився між переліком і видаленням
      if (existsCalls > 1) for (const id of s.lateRows ?? []) have.add(id)
      return new Set(ids.filter((id) => have.has(id)))
    },
    async rowPage(object, after) {
      return (s.rows[object] ?? [])
        .filter((id) => after === null || id > after)
        .sort()
        .slice(0, 1000)
    },
  }
  const run = (graceMs?: number) =>
    reconcile([OBJ, OTHER_OBJ], source, store, {
      log: (e) => log.push(e),
      ...(graceMs === undefined ? {} : { graceMs }),
    })
  return { run, log, deleted, calls }
}

const key = (n: number, object = OBJ) => fileObjectKey(object, rowId(n))

describe("reconcile", () => {
  it("deletes an old object without a row and keeps the one with a row", async () => {
    const t = setup({
      objects: { [key(1)]: OLD, [key(2)]: OLD },
      rows: { [OBJ]: [rowId(1)] },
    })
    const report = await t.run()
    expect(t.deleted).toEqual([key(2)])
    expect(report).toMatchObject({ listed: 2, deleted: 1, refused: null })
  })

  it("keeps an orphan younger than 24 h by the database clock", async () => {
    const t = setup({ objects: { [key(1)]: FRESH }, rows: {} })
    expect((await t.run()).deleted).toBe(0)
    expect(t.deleted).toEqual([])
  })

  it("deletes a fresh orphan only when the grace option says so", async () => {
    const t = setup({ objects: { [key(1)]: FRESH }, rows: {} })
    expect((await t.run(0)).deleted).toBe(1)
  })

  it("does not touch a row of another tenant (the function sees all rows)", async () => {
    // Рядок є в базі, хоч би якого тенанта: `rowsExist` його віддає
    const t = setup({
      objects: { [key(1)]: OLD },
      rows: { [OBJ]: [rowId(1)] },
    })
    expect((await t.run()).deleted).toBe(0)
  })

  it("only logs an unknown prefix and lists nothing under it", async () => {
    const stranger = "88888888-8888-4888-8888-888888888888"
    const t = setup({
      objects: { [key(1, stranger)]: OLD, [key(2)]: OLD },
      rows: { [OBJ]: [rowId(2)] },
    })
    const report = await t.run()
    expect(report.unknownPrefixes).toEqual([`o/${stranger}/`])
    expect(report.listed).toBe(1)
    expect(t.deleted).toEqual([])
    expect(t.log).toContainEqual({
      kind: "unknown-prefix",
      prefix: `o/${stranger}/`,
    })
  })

  it("counts rows without bytes and logs them", async () => {
    const t = setup({ objects: {}, rows: { [OBJ]: [rowId(5)] } })
    const report = await t.run()
    expect(report.rowsWithoutBytes).toBe(1)
    expect(t.log).toContainEqual({
      kind: "row-without-bytes",
      object: OBJ,
      id: rowId(5),
    })
  })

  it("re-checks each orphan before deleting it", async () => {
    const t = setup({
      objects: { [key(1)]: OLD, [key(2)]: OLD },
      rows: {},
      lateRows: [rowId(1)],
    })
    await t.run()
    expect(t.deleted).toEqual([key(2)])
  })

  it("refuses a foreign bucket before any deletion", async () => {
    const t = setup({ objects: { [key(1)]: OLD }, rows: {}, refuse: true })
    const report = await t.run()
    expect(report.refused).toBe("instance")
    expect(t.deleted).toEqual([])
    expect(t.log[0]).toMatchObject({ kind: "refused", reason: "instance" })
  })

  describe("guard: more than 5 % of listed and more than 20", () => {
    const many = (orphans: number, kept: number) => {
      const objects: Record<string, Date> = {}
      const rows: string[] = []
      for (let i = 0; i < orphans; i++) objects[key(1000 + i)] = OLD
      for (let i = 0; i < kept; i++) {
        objects[key(i)] = OLD
        rows.push(rowId(i))
      }
      return setup({ objects, rows: { [OBJ]: rows } })
    }

    it("deletes exactly 20 orphans in a small bucket", async () => {
      const t = many(20, 5)
      expect((await t.run()).deleted).toBe(20)
    })

    it("stops at 21 orphans of 26 listed and deletes nothing", async () => {
      const t = many(21, 5)
      const report = await t.run()
      expect(report).toMatchObject({ deleted: 0, refused: "guard" })
      expect(t.deleted).toEqual([])
    })

    it("deletes 21 orphans when they are within 5 % of the listed", async () => {
      const t = many(21, 1000)
      expect((await t.run()).deleted).toBe(21)
    })
  })

  it("checks ids in pages of at most 1000", async () => {
    const objects: Record<string, Date> = {}
    for (let i = 0; i < 2500; i++) objects[key(i)] = OLD
    const rows = Object.keys(objects).map((k) => k.slice(-36))
    const t = setup({ objects, rows: { [OBJ]: rows } })
    expect((await t.run()).deleted).toBe(0)
  })
})
