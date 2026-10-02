import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it } from "vitest"
import { writeChanges } from "../io/metadata-dir"
import { UsageError } from "../io/usage-error"
import { createMcpServer } from "../mcp/server"
import { ALLOW_WRITE_FLAG, writeAccessHint } from "../tools/write-access"
import { project, snapshotOf, useTmpProjects } from "./helpers/catalog"

const CURRENCY = "catalogs/Currency/Currency.meta.json"
// виміряно в designer-1: 8398 символів JSON усіх інструментів
const TOOLS_LIST_MEASURED = 8398
const TOOLS_LIST_BUDGET = Math.ceil(TOOLS_LIST_MEASURED * 1.2)
const clients: Client[] = []

useTmpProjects()
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
})

async function connect(
  dir: string,
  allowWrite: boolean,
  launchArgs?: string[]
): Promise<Client> {
  const server = createMcpServer({ dir, allowWrite, launchArgs })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  clients.push(client)
  await server.connect(serverEnd)
  await client.connect(clientEnd)
  return client
}

interface Out {
  ok: boolean
  written: boolean
  changes: { path: string; deleted: boolean }[]
  diagnostics: { code: string }[]
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; out: Out; text: string }> {
  const r = await client.callTool({ name, arguments: args })
  return {
    isError: r.isError === true,
    out: r.structuredContent as unknown as Out,
    text: (r.content as { type: string; text?: string }[])
      .map((c) => c.text ?? "")
      .join("\n"),
  }
}

const rename = {
  target: { kind: "Catalog", name: "Currency" },
  newName: "Money",
}

describe("simetra mcp", () => {
  it("lists every catalog tool in read-only mode", async () => {
    const client = await connect(await project(), false)
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "add",
      "compile",
      "create",
      "delete",
      "explain",
      "fix",
      "rename",
    ])
  })

  it("write tool in read-only mode changes nothing and explains how to enable writes", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const client = await connect(dir, false)
    const r = await call(client, "rename", rename)
    expect(r.isError).toBe(true)
    expect(r.text).toContain(writeAccessHint())
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("a dry run of a write tool in read-only mode is still refused", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const client = await connect(dir, false)
    const r = await call(client, "rename", { ...rename, dryRun: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(writeAccessHint())
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("server instructions carry the same hint", async () => {
    const client = await connect(await project(), false)
    expect(client.getInstructions()).toContain(writeAccessHint())
  })

  it("the hint is built from the real launch arguments", async () => {
    const client = await connect(await project(), false, ["mcp", "metadata"])
    expect(client.getInstructions()).toContain(
      writeAccessHint(["mcp", "metadata"])
    )
  })

  it("refusal and instructions carry the same hint built from launch arguments", async () => {
    const dir = await project()
    const launchArgs = ["mcp", dir]
    const client = await connect(dir, false, launchArgs)
    const r = await call(client, "rename", rename)
    expect(r.isError).toBe(true)
    expect(r.text).toBe(writeAccessHint(launchArgs))
    expect(r.text).toContain(dir)
    expect(client.getInstructions()).toContain(r.text)
  })

  it("tools/list is the same with and without --allow-write", async () => {
    const dir = await project()
    const readOnly = (await (await connect(dir, false)).listTools()).tools
    const writable = (await (await connect(dir, true)).listTools()).tools
    expect(JSON.stringify(readOnly)).toEqual(JSON.stringify(writable))
  })

  it("the hint names the real mcp flag", async () => {
    const args = (await import("../commands/mcp")).default.args
    expect(Object.keys(args ?? {})).toContain(
      ALLOW_WRITE_FLAG.replace(/^--/, "")
    )
  })

  it("annotations come from the catalog", async () => {
    const { tools } = await (await connect(await project(), false)).listTools()
    const by = (n: string) => tools.find((t) => t.name === n)
    expect(by("compile")?.annotations?.readOnlyHint).toBe(true)
    expect(by("rename")?.annotations?.readOnlyHint).toBe(false)
    expect(by("delete")?.annotations?.destructiveHint).toBe(true)
    expect(by("rename")?.description).toContain(ALLOW_WRITE_FLAG)
  })

  it("fix is a write tool with dryRun", async () => {
    const { tools } = await (await connect(await project(), true)).listTools()
    const fix = tools.find((t) => t.name === "fix")
    expect(fix?.inputSchema.properties).toHaveProperty("dryRun")
    expect(fix?.annotations?.readOnlyHint).toBe(false)
  })

  it("keeps tools/list within the size budget", async () => {
    const client = await connect(await project(), false)
    const size = JSON.stringify((await client.listTools()).tools).length
    expect(
      size,
      "tools/list budget is deliberate; raising it is a reviewed decision (designer spec §3.2)"
    ).toBeLessThanOrEqual(TOOLS_LIST_BUDGET)
  })

  it("compile tool returns diagnostics", async () => {
    const dir = await project()
    const client = await connect(dir, false)
    const clean = await call(client, "compile", {})
    expect(clean.isError).toBe(false)
    expect(clean.out.ok).toBe(true)
    // Ламаємо файл після підключення: стан — диск, а не пам'ять сервера.
    await writeFile(join(dir, CURRENCY), "{ not json")
    const broken = await call(client, "compile", {})
    expect(broken.out.ok).toBe(false)
    expect(broken.out.diagnostics.length).toBeGreaterThan(0)
  })

  it("explain tool describes an object", async () => {
    const client = await connect(await project(), false)
    const r = await client.callTool({
      name: "explain",
      arguments: { kind: "Catalog", name: "Currency" },
    })
    expect(r.isError).not.toBe(true)
    expect(r.structuredContent).toHaveProperty("tables")
    const missing = await client.callTool({
      name: "explain",
      arguments: { kind: "Catalog", name: "Nope" },
    })
    expect(missing.isError).toBe(true)
  })

  it("rename writes on ok", async () => {
    const dir = await project()
    const client = await connect(dir, true)
    const r = await call(client, "rename", rename)
    expect(r.isError).toBe(false)
    expect(r.out.ok).toBe(true)
    expect(r.out.written).toBe(true)
    expect(existsSync(join(dir, CURRENCY))).toBe(false)
    expect(existsSync(join(dir, "catalogs/Money/Money.meta.json"))).toBe(true)
    expect(r.out.changes.some((c) => c.deleted)).toBe(true)
    expect((await call(client, "compile", {})).out.ok).toBe(true)
  })

  it("dry run writes nothing", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const client = await connect(dir, true)
    const r = await call(client, "rename", { ...rename, dryRun: true })
    expect(r.isError).toBe(false)
    expect(r.out.ok).toBe(true)
    expect(r.out.written).toBe(false)
    expect(r.out.changes.length).toBeGreaterThan(0)
    expect(r.text).toContain("would delete")
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("broken input writes nothing", async () => {
    const dir = await project()
    await writeFile(join(dir, CURRENCY), "{ not json")
    const before = await snapshotOf(dir)
    const client = await connect(dir, true)
    const r = await call(client, "rename", {
      target: { kind: "Catalog", name: "Counterparty" },
      newName: "Partner",
    })
    expect(r.isError).toBe(true)
    expect(r.out.ok).toBe(false)
    expect(await snapshotOf(dir)).toEqual(before)
    // Діагностика без файлу не має позиції: фальшивого `:1:1` у тексті немає.
    const line = r.text
      .split("\n")
      .find((l) => l.includes("operation.input-invalid"))
    expect(line).toBe(
      `${dir}: error operation.input-invalid The operation needs metadata that compiles without errors; nothing was changed`
    )
  })

  it("rejects unknown tool fields", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const client = await connect(dir, true)
    const r = await client.callTool({
      name: "rename",
      arguments: { ...rename, bogus: 1 },
    })
    expect(r.isError).toBe(true)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  describe("delete", () => {
    async function withScratch() {
      const dir = await project()
      const client = await connect(dir, true)
      const created = await call(client, "create", {
        kind: "Catalog",
        name: "Scratch",
        data: { scope: "none" },
      })
      expect(created.out.diagnostics).toEqual([])
      const file = join(dir, "catalogs/Scratch/Scratch.meta.json")
      expect(existsSync(file)).toBe(true)
      return { dir, client, file, target: { kind: "Catalog", name: "Scratch" } }
    }

    it("without confirm and without dryRun changes nothing", async () => {
      const { dir, client, target } = await withScratch()
      const before = await snapshotOf(dir)
      const r = await call(client, "delete", { target })
      expect(r.isError).toBe(true)
      expect(r.text).toContain("confirmation")
      expect(await snapshotOf(dir)).toEqual(before)
    })

    it("dry run without confirm lists the changes and leaves the disk byte-identical", async () => {
      const { dir, client, target } = await withScratch()
      const before = await snapshotOf(dir)
      const r = await call(client, "delete", { target, dryRun: true })
      expect(r.isError).toBe(false)
      expect(r.out.ok).toBe(true)
      expect(r.out.written).toBe(false)
      expect(r.out.changes.length).toBeGreaterThan(0)
      expect(r.text).toContain(
        "would delete catalogs/Scratch/Scratch.meta.json"
      )
      expect(await snapshotOf(dir)).toEqual(before)
    })

    it("with confirm deletes", async () => {
      const { client, file, target } = await withScratch()
      const done = await call(client, "delete", { target, confirm: true })
      expect(done.isError).toBe(false)
      expect(existsSync(file)).toBe(false)
      expect(done.text).toContain("deleted catalogs/Scratch/Scratch.meta.json")
    })

    it("refuses a referenced object", async () => {
      const dir = await project()
      const before = await snapshotOf(dir)
      const client = await connect(dir, true)
      const r = await call(client, "delete", {
        target: { kind: "Catalog", name: "Currency" },
        confirm: true,
      })
      expect(r.isError).toBe(true)
      expect(r.out.ok).toBe(false)
      expect(r.out.diagnostics.length).toBeGreaterThan(0)
      expect(await snapshotOf(dir)).toEqual(before)
    })
  })

  it("add adds an attribute", async () => {
    const dir = await project()
    const client = await connect(dir, true)
    const r = await call(client, "add", {
      target: { kind: "Catalog", name: "Currency" },
      collection: "attributes",
      element: { name: "note", type: "String", length: 20 },
    })
    expect(r.out.diagnostics).toEqual([])
    expect(await readFile(join(dir, CURRENCY), "utf8")).toContain("note")
  })

  it("concurrent mutations both land and the result compiles", async () => {
    // Клієнти-агенти шлють паралельні виклики; без серіалізації друга
    // мутація читала б диск до запису першої й мовчки її затирала.
    const dir = await project()
    const client = await connect(dir, true)
    const add = (name: string) =>
      call(client, "add", {
        target: { kind: "Catalog", name: "Counterparty" },
        collection: "attributes",
        element: { name, type: "Boolean" },
      })
    const results = await Promise.all([add("flagOne"), add("flagTwo")])
    expect(results.map((r) => r.out.diagnostics)).toEqual([[], []])
    const text = await readFile(
      join(dir, "catalogs/Counterparty/Counterparty.meta.json"),
      "utf8"
    )
    expect(text).toContain('"flagOne"')
    expect(text).toContain('"flagTwo"')
    expect((await call(client, "compile", {})).out.ok).toBe(true)
  })

  it("writeChanges refuses an escaping path before touching the disk", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    await expect(
      writeChanges(dir, [
        { path: CURRENCY, content: null },
        { path: "catalogs/New/New.meta.json", content: "{}" },
        { path: "../x.meta.json", content: "{}" },
      ])
    ).rejects.toThrow(UsageError)
    expect(await snapshotOf(dir)).toEqual(before)
    expect(existsSync(join(dir, "../x.meta.json"))).toBe(false)
  })

  it("writeChanges deletes before writing", async () => {
    // На регістронезалежній ФС старий і новий шлях case-only перейменування —
    // один файл; запис мусить іти після видалення.
    const dir = await project()
    await writeChanges(dir, [
      { path: "x/a.meta.json", content: "{}" },
      { path: "x/a.meta.json", content: null },
    ])
    expect(existsSync(join(dir, "x/a.meta.json"))).toBe(true)
  })
})
