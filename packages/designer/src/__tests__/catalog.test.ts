import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { compile } from "simetra/compiler"
import { describe, expect, it } from "vitest"
import { readMetadataDir } from "../io/metadata-dir"
import { compileArtifacts } from "../tools/artifacts"
import { TOOLS, toolByName } from "../tools/catalog"
import { invoke, permits } from "../tools/invoke"
import { queueFor } from "../tools/queue"
import { ALLOW_WRITE_FLAG, writeAccessHint } from "../tools/write-access"
import { opts, project, snapshotOf, useTmpProjects } from "./helpers/catalog"

const CURRENCY = "catalogs/Currency/Currency.meta.json"
useTmpProjects()

/** Копія, у якій з довідника валют знято `id`, `$schema` і `physicalName` реквізиту: `fix` має що робити. */
async function brokenProject(): Promise<string> {
  const dir = await project()
  const file = join(dir, CURRENCY)
  const json = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >
  delete json.id
  delete json.$schema
  // Реквізит без `physicalName`: `fix` має його відновити.
  delete (json.attributes as Record<string, unknown>[])[0]!.physicalName
  await writeFile(file, JSON.stringify(json, null, 2))
  return dir
}

describe("tool catalog", () => {
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

  it("compile reports diagnostics and returns the model", async () => {
    const dir = await project()
    const r = await invoke(toolByName("compile")!, {}, opts(dir))
    expect(r.ok).toBe(true)
    expect((r.data as { model?: unknown }).model).toBeDefined()
  })

  it("rejects unknown input fields with the zod path", async () => {
    const dir = await project()
    const r = await invoke(
      toolByName("explain")!,
      { kind: "Catalog", name: "X", extra: 1 },
      opts(dir)
    )
    expect(r.refusal?.reason).toBe("invalid-input")
    expect(r.refusal?.message).toContain("extra")
  })

  it("explain describes an object", async () => {
    const dir = await project()
    const r = await invoke(
      toolByName("explain")!,
      { kind: "Catalog", name: "Currency" },
      opts(dir)
    )
    expect(r.ok).toBe(true)
    expect(r.data).toHaveProperty("tables")
  })

  it("explain of a missing object is a refusal", async () => {
    const dir = await project()
    const r = await invoke(
      toolByName("explain")!,
      { kind: "Catalog", name: "Missing" },
      opts(dir)
    )
    expect(r.refusal).toEqual({
      reason: "refused",
      message: "Object not found: Catalog Missing",
    })
  })

  it("explain of metadata with errors reports diagnostics", async () => {
    const dir = await project()
    await writeFile(join(dir, CURRENCY), "{ not json")
    const r = await invoke(
      toolByName("explain")!,
      { kind: "Catalog", name: "Currency" },
      opts(dir)
    )
    expect(r.ok).toBe(false)
    expect(r.diagnostics.length).toBeGreaterThan(0)
  })

  it("fix without allowWrite writes nothing and explains how to enable writes", async () => {
    const dir = await brokenProject()
    const before = await readMetadataDir(dir)
    const r = await invoke(
      toolByName("fix")!,
      {},
      {
        ...opts(dir),
        allowWrite: false,
      }
    )
    expect(r.refusal).toEqual({
      reason: "write-disabled",
      message: writeAccessHint(),
    })
    expect(await readMetadataDir(dir)).toEqual(before)
  })

  it("fix dryRun reports changes and writes nothing", async () => {
    const dir = await brokenProject()
    const before = await snapshotOf(dir)
    const r = await invoke(
      toolByName("fix")!,
      {},
      {
        ...opts(dir),
        dryRun: true,
      }
    )
    expect(r.ok).toBe(true)
    expect(r.written).toBe(false)
    expect(r.changes.length).toBeGreaterThan(0)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("fix writes when the result compiles", async () => {
    const dir = await brokenProject()
    const r = await invoke(toolByName("fix")!, {}, opts(dir))
    expect(r.ok).toBe(true)
    expect(r.written).toBe(true)
    expect((await compile(await readMetadataDir(dir))).ok).toBe(true)
    const json = JSON.parse(await readFile(join(dir, CURRENCY), "utf8")) as {
      id?: string
    }
    expect(json.id).toBeTypeOf("string")
    const after = JSON.parse(await readFile(join(dir, CURRENCY), "utf8")) as {
      attributes: { physicalName?: string }[]
    }
    expect(after.attributes[0]!.physicalName).toBeTypeOf("string")
  })

  it("permits read always and files only with allowWrite", () => {
    for (const t of TOOLS) {
      expect(permits(t, { allowWrite: false })).toBe(t.effect === "read")
      expect(permits(t, { allowWrite: true })).toBe(true)
    }
  })

  it("compileArtifacts emits snapshot, desired state and entity types", async () => {
    const dir = await project()
    const { model } = await compile(await readMetadataDir(dir))
    const changes = compileArtifacts(model!)
    expect(changes.map((c) => c.path)).toEqual([
      "snapshot.json",
      "desired-state.sql",
      "entities.d.ts",
    ])
    expect(changes.every((c) => typeof c.content === "string")).toBe(true)
  })
})

describe("invoke refusals", () => {
  it("destructive dry-run without confirmation previews and writes nothing", async () => {
    const dir = await project()
    await invoke(
      toolByName("create")!,
      { kind: "Catalog", name: "Scratch", data: { scope: "none" } },
      opts(dir)
    )
    const before = await snapshotOf(dir)
    const r = await invoke(
      toolByName("delete")!,
      { target: { kind: "Catalog", name: "Scratch" } },
      { ...opts(dir), dryRun: true }
    )
    expect(r.ok).toBe(true)
    expect(r.written).toBe(false)
    expect(r.changes.length).toBeGreaterThan(0)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("a nonexistent directory is a refusal with the message", async () => {
    const dir = join(await project(), "missing")
    const r = await invoke(toolByName("compile")!, {}, opts(dir))
    expect(r.refusal).toEqual({
      reason: "refused",
      message: `metadata directory not found: ${dir}`,
    })
  })

  it("an empty zod path gives no leading colon", async () => {
    const dir = await project()
    const r = await invoke(toolByName("compile")!, "oops", opts(dir))
    expect(r.refusal?.reason).toBe("invalid-input")
    expect(r.refusal?.message.startsWith(":")).toBe(false)
  })

  it("written is false when there is nothing to change", async () => {
    const dir = await project()
    // Перший `fix` приводить еталон до канону; другому нічого змінювати.
    await invoke(toolByName("fix")!, {}, opts(dir))
    const r = await invoke(toolByName("fix")!, {}, opts(dir))
    expect(r.ok).toBe(true)
    expect(r.changes).toEqual([])
    expect(r.written).toBe(false)
  })
})

describe("queueFor", () => {
  it("serialises tasks of one directory and survives a failing task", async () => {
    const queued = queueFor("/some/dir")
    const order: string[] = []
    const slow = queued(async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push("slow")
    })
    const failing = queued(async () => {
      order.push("failing")
      throw new Error("boom")
    })
    const last = queued(async () => {
      order.push("last")
    })
    await expect(failing).rejects.toThrow("boom")
    await Promise.all([slow, last])
    expect(order).toEqual(["slow", "failing", "last"])
  })

  it("shares one queue between equivalent paths", async () => {
    const order: string[] = []
    const a = queueFor("/some/./dir")(async () => {
      await new Promise((r) => setTimeout(r, 20))
      order.push("a")
    })
    const b = queueFor("/some/dir")(async () => {
      order.push("b")
    })
    await Promise.all([a, b])
    expect(order).toEqual(["a", "b"])
  })
})

describe("writeAccessHint", () => {
  it("shows the general form without launch args", () => {
    expect(writeAccessHint()).toContain(
      `"args": ["simetra","mcp","${ALLOW_WRITE_FLAG}"]`
    )
  })

  it("echoes the real launch args", () => {
    expect(writeAccessHint(["mcp", "./metadata"])).toContain(
      `"args": ["mcp","./metadata","${ALLOW_WRITE_FLAG}"]`
    )
  })
})
