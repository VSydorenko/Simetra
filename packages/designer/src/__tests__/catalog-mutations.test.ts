import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { serializeCanonical, type PromotionRecord } from "simetra/compiler"
import { describe, expect, it, vi } from "vitest"
import { writeChanges } from "../io/metadata-dir"
import { toolByName } from "../tools/catalog"
import {
  addAdoptedTag,
  opts,
  project,
  run,
  snapshotOf,
  TAG_FILE,
  tagMapping,
  useTmpProjects,
} from "./helpers/catalog"
import { expectClean } from "../../../simetra/test/support"

// Шпигун лише записує виклики й пише як є: тест порядку читає їхню чергу.
vi.mock("../io/metadata-dir", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../io/metadata-dir")>()
  return { ...actual, writeChanges: vi.fn(actual.writeChanges) }
})

const CURRENCY = "catalogs/Currency/Currency.meta.json"
const TAG_ID = "00000000-0000-4000-8000-00000000a000"
/** Запис промоції лягає в `plans/` поруч із текою метаданих. */
const recordFile = (dir: string) =>
  join(dirname(dir), "plans", `${TAG_ID}.promotion.json`)

useTmpProjects()

const rename = {
  target: { kind: "Catalog", name: "Currency" },
  newName: "Money",
}

describe("mutation tools", () => {
  it("only delete is destructive; every mutation writes files", () => {
    for (const name of ["create", "add", "rename", "delete", "promote"]) {
      const t = toolByName(name)!
      expect(t.files).toBe("write")
      expect(t.database).toBe("none")
      expect(t.destructive).toBe(name === "delete")
    }
    expect(toolByName("delete")!.description).not.toContain("confirm")
  })

  it("rename writes on ok", async () => {
    const dir = await project()
    const r = await run("rename", dir, rename)
    expect(r.ok).toBe(true)
    expect(r.written).toBe(true)
    expect(existsSync(join(dir, CURRENCY))).toBe(false)
    expect(existsSync(join(dir, "catalogs/Money/Money.meta.json"))).toBe(true)
    expect(r.changes.some((c) => c.deleted)).toBe(true)
    expect((await run("compile", dir, {})).ok).toBe(true)
  })

  it("dry run writes nothing", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const r = await run("rename", dir, rename, { ...opts(dir), dryRun: true })
    expect(r.ok).toBe(true)
    expect(r.written).toBe(false)
    expect(r.changes.length).toBeGreaterThan(0)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("broken input writes nothing", async () => {
    const dir = await project()
    await writeFile(join(dir, CURRENCY), "{ not json")
    const before = await snapshotOf(dir)
    const r = await run("rename", dir, {
      target: { kind: "Catalog", name: "Counterparty" },
      newName: "Partner",
    })
    expect(r.ok).toBe(false)
    expect(r.written).toBe(false)
    expect(r.diagnostics.map((d) => d.code)).toContain(
      "operation.input-invalid"
    )
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("rejects unknown fields", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const r = await run("rename", dir, { ...rename, bogus: 1 })
    expect(r.refusal?.reason).toBe("invalid-input")
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("delete needs confirmation", async () => {
    const dir = await project()
    const created = await run("create", dir, {
      kind: "Catalog",
      name: "Scratch",
      data: { scope: "none" },
    })
    expectClean(created, { allow: ["rights.scope-kind-unread"] })
    const file = join(dir, "catalogs/Scratch/Scratch.meta.json")
    expect(existsSync(file)).toBe(true)
    const target = { kind: "Catalog", name: "Scratch" }
    const before = await snapshotOf(dir)
    const refused = await run("delete", dir, { target })
    expect(refused.refusal?.reason).toBe("unconfirmed")
    expect(await snapshotOf(dir)).toEqual(before)
    const done = await run(
      "delete",
      dir,
      { target },
      {
        ...opts(dir),
        confirmed: true,
      }
    )
    expect(done.ok).toBe(true)
    expect(done.written).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(done.changes).toContainEqual({
      path: "catalogs/Scratch/Scratch.meta.json",
      deleted: true,
    })
  })

  it("delete refuses a referenced object", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const r = await run(
      "delete",
      dir,
      { target: { kind: "Catalog", name: "Currency" } },
      { ...opts(dir), confirmed: true }
    )
    expect(r.ok).toBe(false)
    expect(r.diagnostics.length).toBeGreaterThan(0)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("add adds an attribute", async () => {
    const dir = await project()
    const r = await run("add", dir, {
      target: { kind: "Catalog", name: "Currency" },
      collection: "attributes",
      element: { name: "note", type: "String", length: 20 },
    })
    expectClean(r, { allow: ["rights.scope-kind-unread"] })
    expect(await readFile(join(dir, CURRENCY), "utf8")).toContain("note")
  })

  it("concurrent mutations both land and the result compiles", async () => {
    const dir = await project()
    const add = (name: string) =>
      run("add", dir, {
        target: { kind: "Catalog", name: "Counterparty" },
        collection: "attributes",
        element: { name, type: "Boolean" },
      })
    const results = await Promise.all([add("flagOne"), add("flagTwo")])
    for (const r of results)
      expectClean(r, { allow: ["rights.scope-kind-unread"] })
    const text = await readFile(
      join(dir, "catalogs/Counterparty/Counterparty.meta.json"),
      "utf8"
    )
    expect(text).toContain('"flagOne"')
    expect(text).toContain('"flagTwo"')
    expect((await run("compile", dir, {})).ok).toBe(true)
  })

  describe("promote", () => {
    it("writes on ok and returns the record", async () => {
      const dir = await project()
      await addAdoptedTag(dir)
      const r = await run("promote", dir, tagMapping)
      expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([])
      expect(r.ok).toBe(true)
      expect(r.written).toBe(true)
      expect(existsSync(join(dir, TAG_FILE))).toBe(false)
      expect(existsSync(join(dir, "catalogs/Tag/Tag.meta.json"))).toBe(true)
      expect(r.data).toMatchObject({ kind: "Catalog", objectId: TAG_ID })
      expect(r.artifacts).toEqual([`plans/${TAG_ID}.promotion.json`])
      expect(await readFile(recordFile(dir), "utf8")).toBe(
        serializeCanonical(r.data as PromotionRecord)
      )
      expect((await run("compile", dir, {})).ok).toBe(true)
    })

    it("writes the record before the files of the metadata directory", async () => {
      const dir = await project()
      await addAdoptedTag(dir)
      const spy = vi.mocked(writeChanges)
      spy.mockClear()
      const r = await run("promote", dir, tagMapping)
      expect(r.written).toBe(true)
      // Запис без змін теки інертний, зміни теки без запису не відновити.
      expect(spy.mock.calls.map(([, changes]) => changes[0]!.path)).toEqual([
        `plans/${TAG_ID}.promotion.json`,
        expect.not.stringMatching(/^plans\//),
      ])
    })

    it("dry run writes nothing but still returns the record", async () => {
      const dir = await project()
      await addAdoptedTag(dir)
      const before = await snapshotOf(dir)
      const r = await run("promote", dir, tagMapping, {
        ...opts(dir),
        dryRun: true,
      })
      expect(r.ok).toBe(true)
      expect(r.written).toBe(false)
      expect(r.changes.length).toBeGreaterThan(0)
      expect(r.data).toBeDefined()
      expect(await snapshotOf(dir)).toEqual(before)
      expect(existsSync(dirname(recordFile(dir)))).toBe(false)
    })

    it("a refused mapping writes nothing and has no record", async () => {
      const dir = await project()
      await addAdoptedTag(dir)
      const before = await snapshotOf(dir)
      const r = await run("promote", dir, {
        ...tagMapping,
        columns: { id: { to: "standard", name: "ref" } },
      })
      expect(r.ok).toBe(false)
      expect(r.written).toBe(false)
      expect(r.data).toBeUndefined()
      expect(r.artifacts).toBeUndefined()
      expect(await snapshotOf(dir)).toEqual(before)
    })

    it("refuses assigned fields in the mapping before the operation runs", async () => {
      const dir = await project()
      await addAdoptedTag(dir)
      const before = await snapshotOf(dir)
      const r = await run("promote", dir, {
        ...tagMapping,
        into: {
          ...tagMapping.into,
          data: { ...tagMapping.into.data, physicalName: "hijacked" },
        },
      })
      expect(r.refusal?.reason).toBe("invalid-input")
      expect(r.refusal?.message).toContain("physicalName")
      expect(await snapshotOf(dir)).toEqual(before)
    })
  })
})
