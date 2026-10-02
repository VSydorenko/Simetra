import { existsSync } from "node:fs"
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it } from "vitest"
import { writeChanges } from "../io/metadata-dir"
import { UsageError } from "../io/usage-error"
import { createMcpServer } from "../mcp/server"

const REFERENCE = resolve(__dirname, "../../../../examples/reference/metadata")
const CURRENCY = "catalogs/Currency/Currency.meta.json"
const temps: string[] = []
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true })))
})

async function copyDomain(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-mcp-"))
  temps.push(root)
  const dir = join(root, "metadata")
  await cp(REFERENCE, dir, { recursive: true })
  return dir
}

async function connect(dir: string, allowWrite: boolean): Promise<Client> {
  const server = createMcpServer({ dir, allowWrite })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  clients.push(client)
  await server.connect(serverEnd)
  await client.connect(clientEnd)
  return client
}

interface Out {
  ok: boolean
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

async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  const result: Record<string, string> = {}
  for (const e of entries) {
    if (e.isFile()) {
      const full = join(e.parentPath, e.name)
      result[full] = await readFile(full, "utf8")
    }
  }
  return result
}

const rename = {
  target: { kind: "Catalog", name: "Currency" },
  newName: "Money",
}

describe("simetra mcp", () => {
  it("read-only by default", async () => {
    const client = await connect(await copyDomain(), false)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(["compile", "explain"])
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true)
  })

  it("lists mutation tools with allowWrite", async () => {
    const client = await connect(await copyDomain(), true)
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_element",
      "compile",
      "create_object",
      "delete",
      "explain",
      "rename",
    ])
    const del = tools.find((t) => t.name === "delete")
    expect(del?.annotations?.destructiveHint).toBe(true)
  })

  it("compile tool returns diagnostics", async () => {
    const dir = await copyDomain()
    const client = await connect(dir, false)
    const clean = await call(client, "compile", {})
    expect(clean.isError).toBe(false)
    expect(clean.out.ok).toBe(true)
    // Ламаємо файл після підключення: стан — диск, а не пам'ять сервера.
    const { writeFile } = await import("node:fs/promises")
    await writeFile(join(dir, CURRENCY), "{ not json")
    const broken = await call(client, "compile", {})
    expect(broken.out.ok).toBe(false)
    expect(broken.out.diagnostics.length).toBeGreaterThan(0)
  })

  it("explain tool describes an object", async () => {
    const client = await connect(await copyDomain(), false)
    const r = await client.callTool({
      name: "explain",
      arguments: { kind: "Catalog", name: "Currency" },
    })
    expect(r.isError).not.toBe(true)
    const missing = await client.callTool({
      name: "explain",
      arguments: { kind: "Catalog", name: "Nope" },
    })
    expect(missing.isError).toBe(true)
  })

  it("rename writes on ok", async () => {
    const dir = await copyDomain()
    const client = await connect(dir, true)
    const r = await call(client, "rename", rename)
    expect(r.isError).toBe(false)
    expect(r.out.ok).toBe(true)
    expect(existsSync(join(dir, CURRENCY))).toBe(false)
    expect(existsSync(join(dir, "catalogs/Money/Money.meta.json"))).toBe(true)
    expect(r.out.changes.some((c) => c.deleted)).toBe(true)
    expect((await call(client, "compile", {})).out.ok).toBe(true)
  })

  it("dry run writes nothing", async () => {
    const dir = await copyDomain()
    const before = await snapshotOf(dir)
    const client = await connect(dir, true)
    const r = await call(client, "rename", { ...rename, dryRun: true })
    expect(r.isError).toBe(false)
    expect(r.out.ok).toBe(true)
    expect(r.out.changes.length).toBeGreaterThan(0)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("broken input writes nothing", async () => {
    const dir = await copyDomain()
    const { writeFile } = await import("node:fs/promises")
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
    const dir = await copyDomain()
    const before = await snapshotOf(dir)
    const client = await connect(dir, true)
    const r = await client.callTool({
      name: "rename",
      arguments: { ...rename, bogus: 1 },
    })
    expect(r.isError).toBe(true)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("delete needs confirm", async () => {
    const dir = await copyDomain()
    const client = await connect(dir, true)
    const created = await call(client, "create_object", {
      kind: "Catalog",
      name: "Scratch",
      data: { scope: "none" },
    })
    expect(created.out.diagnostics).toEqual([])
    const file = join(dir, "catalogs/Scratch/Scratch.meta.json")
    expect(existsSync(file)).toBe(true)
    const target = { kind: "Catalog", name: "Scratch" }
    const refused = await call(client, "delete", { target, confirm: false })
    expect(refused.isError).toBe(true)
    expect(existsSync(file)).toBe(true)
    const done = await client.callTool({
      name: "delete",
      arguments: { target, confirm: true },
    })
    expect(done.isError).not.toBe(true)
    expect(existsSync(file)).toBe(false)
    const text = (done.content as { type: string; text?: string }[])
      .map((c) => c.text ?? "")
      .join("\n")
    expect(text).toContain("deleted catalogs/Scratch/Scratch.meta.json")
  })

  it("delete refuses a referenced object", async () => {
    const dir = await copyDomain()
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

  it("add_element adds an attribute", async () => {
    const dir = await copyDomain()
    const client = await connect(dir, true)
    const r = await call(client, "add_element", {
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
    const dir = await copyDomain()
    const client = await connect(dir, true)
    const add = (name: string) =>
      call(client, "add_element", {
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
    const compiled = await call(client, "compile", {})
    expect(compiled.out.ok).toBe(true)
  })

  it("writeChanges refuses an escaping path before touching the disk", async () => {
    const dir = await copyDomain()
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
    const dir = await copyDomain()
    await writeChanges(dir, [
      { path: "x/a.meta.json", content: "{}" },
      { path: "x/a.meta.json", content: null },
    ])
    expect(existsSync(join(dir, "x/a.meta.json"))).toBe(true)
  })
})
