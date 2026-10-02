import { existsSync } from "node:fs"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { TOOLS, toolByName } from "../tools/catalog"
import { invoke } from "../tools/invoke"
import { tmpProject } from "./helpers/tmp-project"

const CURRENCY = "catalogs/Currency/Currency.meta.json"
const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((d) => d()))
})

async function project(): Promise<string> {
  const p = await tmpProject()
  disposers.push(p.dispose)
  return p.dir
}

const opts = (dir: string) => ({
  dir,
  allowWrite: true,
  dryRun: false,
  confirmed: false,
})

const run = (name: string, dir: string, input: unknown, o = opts(dir)) =>
  invoke(toolByName(name)!, input, o)

async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const result: Record<string, string> = {}
  for (const e of entries) {
    if (!e.isFile()) continue
    const full = join(e.parentPath, e.name)
    result[full] = await readFile(full, "utf8")
  }
  return result
}

const rename = {
  target: { kind: "Catalog", name: "Currency" },
  newName: "Money",
}

describe("mutation tools", () => {
  it("names every tool once", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "add",
      "compile",
      "create",
      "delete",
      "explain",
      "fix",
      "rename",
    ])
  })

  it("only delete is destructive; every mutation writes files", () => {
    for (const name of ["create", "add", "rename", "delete"]) {
      const t = toolByName(name)!
      expect(t.effect).toBe("files")
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
    expect(created.diagnostics).toEqual([])
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
    expect(r.diagnostics).toEqual([])
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
    expect(results.map((r) => r.diagnostics)).toEqual([[], []])
    const text = await readFile(
      join(dir, "catalogs/Counterparty/Counterparty.meta.json"),
      "utf8"
    )
    expect(text).toContain('"flagOne"')
    expect(text).toContain('"flagTwo"')
    expect((await run("compile", dir, {})).ok).toBe(true)
  })
})
