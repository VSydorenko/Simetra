import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { commandByName, runTool, toolCommand } from "../cli/command"
import { cliInput } from "../cli/input"
import { TOOLS, toolByName } from "../tools/catalog"
import { TOOL_NAMES } from "../tools/types"
import { project, snapshotOf, useTmpProjects } from "./helpers/catalog"

useTmpProjects()

const noStdin = async (): Promise<string> => {
  throw new Error("stdin must not be read")
}
const tool = (name: string) => toolByName(name)!
const scratch = { kind: "Catalog", name: "Scratch", data: { scope: "none" } }
const scratchTarget = { target: { kind: "Catalog", name: "Scratch" } }

async function withScratch(): Promise<string> {
  const dir = await project()
  const r = await runTool(tool("create"), {
    _: [JSON.stringify(scratch), dir],
  })
  expect(r.exitCode).toBe(0)
  return dir
}

describe("cli adapter", () => {
  it("has a subcommand for every catalog tool", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([...TOOL_NAMES])
    for (const name of TOOL_NAMES) {
      expect(commandByName(name).meta).toMatchObject({ name })
    }
  })

  it("maps explain args onto the catalog input", async () => {
    const { input, dirs } = await cliInput(
      tool("explain"),
      { _: ["Catalog.Products"] },
      noStdin
    )
    expect(tool("explain").input.parse(input)).toEqual({
      kind: "Catalog",
      name: "Products",
    })
    expect(dirs).toEqual(["./metadata"])
  })

  it("reads mutation input from a positional, --input and stdin alike", async () => {
    const json = JSON.stringify(scratchTarget)
    const stdin = async () => json
    const t = tool("delete")
    const a = await cliInput(t, { _: [json, "d"] }, noStdin)
    const b = await cliInput(t, { _: ["d"], input: json }, noStdin)
    const c = await cliInput(t, { _: ["-", "d"] }, stdin)
    expect(a).toEqual({ input: scratchTarget, dirs: ["d"] })
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  it("--dry-run exists only on write tools and --yes only on destructive ones", () => {
    for (const t of TOOLS) {
      const args = toolCommand(t).args ?? {}
      expect("dry-run" in args).toBe(t.effect === "files")
      expect("yes" in args).toBe(t.destructive)
    }
  })

  it("invalid input exits 2 with the zod path", async () => {
    const dir = await project()
    const r = await runTool(tool("rename"), {
      _: ['{"target":{"kind":"Nope","name":"X"},"newName":"Y"}', dir],
    })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("target.kind")
  })

  it("malformed JSON exits 2", async () => {
    const dir = await project()
    const r = await runTool(tool("rename"), { _: ["{ x", dir] })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("not valid JSON")
  })

  it("create works from --input and lands on disk", async () => {
    const dir = await project()
    const r = await runTool(tool("create"), {
      _: [dir],
      input: JSON.stringify(scratch),
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("written")
    expect(existsSync(join(dir, "catalogs/Scratch/Scratch.meta.json"))).toBe(
      true
    )
  })

  it("delete without --yes changes nothing and exits 2", async () => {
    const dir = await withScratch()
    const before = await snapshotOf(dir)
    const r = await runTool(tool("delete"), {
      _: [JSON.stringify(scratchTarget), dir],
    })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("Nothing changed")
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("delete --dry-run without --yes previews and changes nothing", async () => {
    const dir = await withScratch()
    const before = await snapshotOf(dir)
    const r = await runTool(tool("delete"), {
      _: [JSON.stringify(scratchTarget), dir],
      "dry-run": true,
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("would delete")
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("delete with --yes deletes an unreferenced object", async () => {
    const dir = await withScratch()
    const r = await runTool(tool("delete"), {
      _: [JSON.stringify(scratchTarget), dir],
      yes: true,
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("deleted")
    expect(existsSync(join(dir, "catalogs/Scratch/Scratch.meta.json"))).toBe(
      false
    )
  })

  it("delete of a referenced object exits 1 and lists the references", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const r = await runTool(tool("delete"), {
      _: ['{"target":{"kind":"Catalog","name":"Currency"}}', dir],
      yes: true,
    })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain("operation.delete-referenced")
    expect(r.stdout).toContain("catalogs/Contract/Contract.meta.json")
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("a bad explain target exits 2", async () => {
    const r = await runTool(tool("explain"), { _: ["Nope"] })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("<Kind>.<Name>")
  })

  it("--out needs an existing parent directory", async () => {
    const dir = await project()
    const out = join(dir, "no/such/parent/out")
    const r = await runTool(tool("compile"), { _: [dir], out })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("--out")
    expect(existsSync(join(dir, "no"))).toBe(false)
  })

  it("--out pointing at a file exits 2", async () => {
    const dir = await project()
    const out = join(dir, "catalogs/Currency/Currency.meta.json")
    const r = await runTool(tool("compile"), { _: [dir], out })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("not a directory")
  })
})
