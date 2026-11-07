import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import type { Diagnostic } from "simetra/compiler"
import { elementNameSchema, objectNameSchema } from "simetra/model"
import { afterEach, describe, expect, it } from "vitest"
import { TOOL_PIPELINE } from "./helpers/budget"
import { z } from "zod"
import { writeChanges } from "../io/metadata-dir"
import { UsageError } from "../io/usage-error"
import { parseArgs } from "citty"
import { mcpArgs } from "../commands/mcp-args"
import { mcpOptionsFrom } from "../commands/mcp"
import { createMcpServer } from "../mcp/server"
import { mcpInputSchema, type McpToolOptions } from "../mcp/tools"
import { applyTool, planTool } from "../tools/apply-tools"
import {
  ALLOW_DATA_WRITE_FLAG,
  ALLOW_DATABASE_WRITE_FLAG,
  databaseWriteHint,
  READ_ONLY_FLAG,
  readOnlyHint,
} from "../tools/hints"
import { invoke } from "../tools/invoke"
import { rolesTool } from "../tools/roles-tool"
import type { DataResource, DatabaseResource } from "../tools/types"
import {
  addAdoptedTag,
  project,
  snapshotOf,
  tagMapping,
  useTmpProjects,
} from "./helpers/catalog"
import { expectClean } from "../../../simetra/test/support"

const CURRENCY = "catalogs/Currency/Currency.meta.json"
// Гейт розміру описів `tools/list` (спека designer §3.2). Правило бюджету:
// колишній бюджет + приріст × 1,05; резерв — дубль мапінгу без `$defs`.
// Останній замір: `include` у вході й описі data-read — 27424 символи; до
// нього — 27200 (замір на тому самому дереві перед зміною, бюджет 29764):
// 29764 + ceil((27424 − 27200) × 1,05) = 30000.
// Як заміряти: тимчасово поставити `TOOLS_LIST_BUDGET = 0` і запустити
// `pnpm --filter @simetrajs/designer test mcp -t "within the size budget"` —
// падіння друкує розмір («expected N to be less than or equal to 0»). Обидва
// заміри — свіжі: «до» — на дереві без зміни (база гілки чи коміт перед
// зміною), «після» — на дереві зі зміною; число «до» з цього коментаря не
// брати: між замірами каталог міг вирости іншими змінами.
// Вхід `promote` — 4728 символів із 15120: його визначає
// структура мапінгу (колонки розгортаються в корені й у кожній ТЧ), а не описи
const TOOLS_LIST_BUDGET = 30000
const clients: Client[] = []

useTmpProjects()
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()))
})

async function connect(
  dir: string,
  readOnly: boolean,
  launchArgs?: string[],
  database?: DatabaseResource,
  allowDatabaseWrite = false
): Promise<Client> {
  const server = createMcpServer({
    dir,
    readOnly,
    allowDatabaseWrite,
    launchArgs,
    database,
  })
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: "test", version: "0.0.0" })
  clients.push(client)
  await server.connect(serverEnd)
  await client.connect(clientEnd)
  return client
}

async function connectWith(o: McpToolOptions): Promise<Client> {
  const server = createMcpServer(o)
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
  diagnostics: Diagnostic[]
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

/** Ресурс бази, що рахує підключення: відмова мусить лишити його нулем. */
function spyDatabase(): { database: DatabaseResource; connects: () => number } {
  let connects = 0
  return {
    database: {
      describe: "db.example.test:5432/app",
      connect: () => {
        connects++
        return Promise.reject(new Error("must not connect"))
      },
    },
    connects: () => connects,
  }
}

const applyInput = {
  plan: "plans/initial-0123456789ab.plan.json",
  planHash: "a".repeat(64),
}

describe("roles over MCP", () => {
  it("is refused without --allow-database-write, naming roles in the hint", async () => {
    const spy = spyDatabase()
    const direct = await invoke(
      rolesTool,
      {},
      {
        dir: await project(),
        readOnly: false,
        allowDatabaseWrite: false,
        dryRun: false,
        confirmed: true,
        channel: "mcp",
        database: spy.database,
      }
    )
    expect(direct.refusal?.reason).toBe("database-write-disabled")
    expect(direct.refusal?.message).toBe(
      databaseWriteHint(undefined, { tools: "roles" })
    )
    expect(direct.refusal?.message).toContain("roles cannot write")
    expect(spy.connects()).toBe(0)
  })
})

describe("apply over MCP", () => {
  it("is refused without --allow-database-write, naming the flag, before connecting", async () => {
    const dir = await project()
    const spy = spyDatabase()
    const direct = await invoke(applyTool, applyInput, {
      dir,
      readOnly: false,
      allowDatabaseWrite: false,
      dryRun: false,
      confirmed: true,
      channel: "mcp",
      database: spy.database,
    })
    expect(direct.refusal?.reason).toBe("database-write-disabled")
    expect(direct.refusal?.message).toBe(databaseWriteHint())
    const client = await connect(dir, false, undefined, spy.database)
    const r = await call(client, "apply", { ...applyInput, confirm: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(ALLOW_DATABASE_WRITE_FLAG)
    expect(spy.connects()).toBe(0)
  })

  it("--read-only wins over --allow-database-write", async () => {
    const dir = await project()
    const spy = spyDatabase()
    const client = await connect(dir, true, undefined, spy.database, true)
    const r = await call(client, "apply", { ...applyInput, confirm: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(READ_ONLY_FLAG)
    expect(spy.connects()).toBe(0)
  })

  it("takes confirm but not dryRun", () => {
    const schema = mcpInputSchema(applyTool)
    expect(schema.safeParse({ ...applyInput, confirm: true }).success).toBe(
      true
    )
    expect(schema.safeParse({ ...applyInput, dryRun: true }).success).toBe(
      false
    )
    // `plan` пише лише свій артефакт: ні перегляду, ні підтвердження
    const plan = mcpInputSchema(planTool)
    expect(plan.safeParse({}).success).toBe(true)
    expect(plan.safeParse({ dryRun: true }).success).toBe(false)
    expect(plan.safeParse({ confirm: true }).success).toBe(false)
  })

  it("takes promotion items in allow", () => {
    const schema = mcpInputSchema(applyTool)
    const allow = (items: string[]) =>
      schema.safeParse({ ...applyInput, confirm: true, allow: items }).success
    expect(
      allow([
        "drift",
        "s1",
        "access:app.items",
        "delete:app.items.items_group_fkey",
        "remove:app.items",
        "repair:app.items",
        'repair:"app"."items"',
        // Ім'я з комою — лише масивом MCP: `--allow` CLI ділить за комою
        'access:app."a,b"',
      ])
    ).toBe(true)
    expect(allow(["access:"])).toBe(false)
    // Ремонт без таблиці — не пункт дозволу
    expect(allow(["repair"])).toBe(false)
    expect(allow(["repair:"])).toBe(false)
    expect(allow(["grant:app.items"])).toBe(false)
    expect(allow(["s0"])).toBe(false)
  })

  it("a dry run does not stand in for confirmation", async () => {
    // `dryRun`, якого `apply` не знає, інакше обійшов би підтвердження:
    // `invoke` відмовляє на ньому раніше, ніж дійде до підтвердження
    const dir = await project()
    const spy = spyDatabase()
    const r = await invoke(applyTool, applyInput, {
      dir,
      readOnly: false,
      allowDatabaseWrite: true,
      dryRun: true,
      confirmed: false,
      channel: "mcp",
      database: spy.database,
    })
    expect(r.refusal?.reason).toBe("dry-run-unsupported")
    expect(spy.connects()).toBe(0)
  })

  it("instructions name the database write flag", async () => {
    const off = await connect(await project(), false)
    expect(off.getInstructions()).toContain(
      databaseWriteHint(undefined, {
        refusal: false,
        tools: "apply and roles",
      })
    )
    const on = await connect(await project(), false, undefined, undefined, true)
    expect(on.getInstructions()).not.toContain(
      databaseWriteHint(undefined, {
        refusal: false,
        tools: "apply and roles",
      })
    )
    expect(on.getInstructions()).toContain("planHash")
  })

  it("instructions carry the flag advice without the refusal phrase", async () => {
    const off = await connect(await project(), false)
    expect(off.getInstructions()).toContain(ALLOW_DATABASE_WRITE_FLAG)
    expect(off.getInstructions()).not.toContain("Nothing changed.")
  })

  it("read-only instructions do not advise the database write flag", async () => {
    const both = await connect(
      await project(),
      true,
      undefined,
      undefined,
      true
    )
    expect(both.getInstructions()).toContain(readOnlyHint())
    expect(both.getInstructions()).not.toContain(ALLOW_DATABASE_WRITE_FLAG)
    expect(both.getInstructions()).not.toContain("Nothing changed.")
  })
})

// Інструменти через сервер MCP: мутація й компіляція результату на виклик — бюджет `TOOL_PIPELINE`
describe("simetra mcp", TOOL_PIPELINE, () => {
  it("lists every catalog tool in read-only mode", async () => {
    const client = await connect(await project(), true)
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "add",
      "apply",
      "compile",
      "create",
      "data-command",
      "data-read",
      "delete",
      "diff",
      "explain",
      "fix",
      "introspect",
      "plan",
      "promote",
      "rename",
      "roles",
    ])
  })

  it("a database tool without a connection tells the server to restart", async () => {
    const client = await connect(await project(), false)
    const r = await call(client, "diff", {})
    expect(r.isError).toBe(true)
    expect(r.text).toContain("SIMETRA_DATABASE_URL")
    expect(r.text).toMatch(/restart the server/)
  })

  it("a failed database work is summarised as such, not as metadata errors", async () => {
    // Збій роботи з базою (SQLSTATE не класу підключення) — діагностика
    // `database.failed`, і зведення мусить назвати саме його
    const failing: DatabaseResource = {
      describe: "db.example.test:5432/app",
      connect: () =>
        Promise.reject(Object.assign(new Error("boom"), { code: "XX000" })),
    }
    const client = await connect(await project(), false, undefined, failing)
    const r = await call(client, "diff", {})
    expect(r.isError).toBe(true)
    expect(r.out.diagnostics.map((d) => d.code)).toContain("database.failed")
    expect(r.text).not.toContain("the metadata has errors")
    expect(r.text).toContain("diff: the database work failed")
  })

  it("--read-only refuses a write, changes nothing and names the flag", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const client = await connect(dir, true)
    const r = await call(client, "rename", rename)
    expect(r.isError).toBe(true)
    expect(r.text).toContain(readOnlyHint())
    expect(r.text).toContain(READ_ONLY_FLAG)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("writes are on by default", async () => {
    const dir = await project()
    const r = await call(await connect(dir, false), "rename", rename)
    expect(r.out.written).toBe(true)
    const args = (await import("../commands/mcp")).default.args ?? {}
    expect(args).not.toHaveProperty("allow-write")
    expect(args).toHaveProperty(
      READ_ONLY_FLAG.replace(/^--/, ""),
      expect.objectContaining({ default: false })
    )
  })

  it("a dry run of a write tool in read-only mode is still refused", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const client = await connect(dir, true)
    const r = await call(client, "rename", { ...rename, dryRun: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(readOnlyHint())
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("server instructions carry the same hint", async () => {
    const client = await connect(await project(), true)
    expect(client.getInstructions()).toContain(readOnlyHint())
  })

  it("the hint is built from the real launch arguments", async () => {
    const launchArgs = ["mcp", "metadata", READ_ONLY_FLAG]
    const client = await connect(await project(), true, launchArgs)
    expect(client.getInstructions()).toContain(readOnlyHint(launchArgs))
  })

  it("refusal and instructions carry the same hint built from launch arguments", async () => {
    const dir = await project()
    const launchArgs = ["mcp", dir, READ_ONLY_FLAG]
    const client = await connect(dir, true, launchArgs)
    const r = await call(client, "rename", rename)
    expect(r.isError).toBe(true)
    expect(r.text).toBe(readOnlyHint(launchArgs))
    expect(r.text).toContain(dir)
    expect(client.getInstructions()).toContain(r.text)
  })

  it("tools/list does not change with --read-only", async () => {
    const dir = await project()
    const readOnly = (await (await connect(dir, true)).listTools()).tools
    const writable = (await (await connect(dir, false)).listTools()).tools
    expect(JSON.stringify(readOnly)).toEqual(JSON.stringify(writable))
  })

  it("no description mentions --allow-write", async () => {
    const client = await connect(await project(), false)
    expect(JSON.stringify((await client.listTools()).tools)).not.toContain(
      "--allow-write"
    )
    expect(client.getInstructions()).not.toContain("--allow-write")
  })

  it("annotations come from the catalog", async () => {
    const { tools } = await (await connect(await project(), true)).listTools()
    const by = (n: string) => tools.find((t) => t.name === n)
    expect(by("compile")?.annotations?.readOnlyHint).toBe(true)
    expect(by("rename")?.annotations?.readOnlyHint).toBe(false)
    expect(by("delete")?.annotations?.destructiveHint).toBe(true)
    expect(by("apply")?.annotations?.destructiveHint).toBe(true)
    expect(by("apply")?.annotations?.readOnlyHint).toBe(false)
    expect(by("plan")?.annotations?.destructiveHint).toBe(false)
    // `delete` даних незворотний, тож клієнт за анотацією може питати людину
    expect(by("data-command")?.annotations?.destructiveHint).toBe(true)
    expect(by("data-command")?.annotations?.readOnlyHint).toBe(false)
    expect(by("data-read")?.annotations?.readOnlyHint).toBe(true)
    expect(by("data-read")?.annotations?.destructiveHint).toBe(false)
  })

  it("fix is a write tool with dryRun", async () => {
    const { tools } = await (await connect(await project(), false)).listTools()
    const fix = tools.find((t) => t.name === "fix")
    expect(fix?.inputSchema.properties).toHaveProperty("dryRun")
    expect(fix?.annotations?.readOnlyHint).toBe(false)
  })

  it("promote drops the name descriptions without touching the shared name schemas", async () => {
    // `.meta({ description: undefined })` у `promoteInput` мусить створювати
    // нові схеми, а не міняти спільні в глобальному реєстрі Zod.
    const objectDescription = z.toJSONSchema(objectNameSchema).description
    const elementDescription = z.toJSONSchema(elementNameSchema).description
    expect(objectDescription).toBeTruthy()
    expect(elementDescription).toBeTruthy()
    const { tools } = await (await connect(await project(), true)).listTools()
    const schemaOf = (n: string) =>
      JSON.stringify(tools.find((t) => t.name === n)!.inputSchema)
    // Ті самі описи, що були до `promote`, лишаються у `rename` і `add`.
    expect(schemaOf("rename")).toContain(JSON.stringify(objectDescription))
    expect(schemaOf("create")).toContain(JSON.stringify(objectDescription))
    expect(schemaOf("add")).toContain(JSON.stringify(objectDescription))
    expect(schemaOf("rename")).toContain(JSON.stringify(elementDescription))
    const promote = schemaOf("promote")
    expect(promote).not.toContain(JSON.stringify(objectDescription))
    expect(promote).not.toContain(JSON.stringify(elementDescription))
  })

  it("keeps tools/list within the size budget", async () => {
    const client = await connect(await project(), true)
    const size = JSON.stringify((await client.listTools()).tools).length
    expect(
      size,
      "tools/list budget is deliberate; raising it is a reviewed decision (designer spec §3.2)"
    ).toBeLessThanOrEqual(TOOLS_LIST_BUDGET)
  })

  it("compile tool returns diagnostics", async () => {
    const dir = await project()
    const client = await connect(dir, true)
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
    const client = await connect(await project(), true)
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
    const client = await connect(dir, false)
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
    const client = await connect(dir, false)
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
    const client = await connect(dir, false)
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
    const client = await connect(dir, false)
    const r = await client.callTool({
      name: "rename",
      arguments: { ...rename, bogus: 1 },
    })
    expect(r.isError).toBe(true)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  describe("promote", () => {
    it("returns the record as structured content and as a JSON block", async () => {
      const dir = await project()
      await addAdoptedTag(dir)
      const client = await connect(dir, false)
      const r = await client.callTool({
        name: "promote",
        arguments: tagMapping,
      })
      expect(r.isError).toBeFalsy()
      const out = r.structuredContent as {
        written: boolean
        record: { kind: string; objectId: string }
      }
      expect(out.written).toBe(true)
      expect(out.record.kind).toBe("Catalog")
      const text = (r.content as { text: string }[])[0]!.text
      expect(text).toContain("written catalogs/Tag/Tag.meta.json")
      expect(text).toContain("promotion record:")
      expect(text).toContain(`"objectId": "${out.record.objectId}"`)
    })

    it("dry run reports the record and writes nothing", async () => {
      const dir = await project()
      await addAdoptedTag(dir)
      const before = await snapshotOf(dir)
      const client = await connect(dir, false)
      const r = await call(client, "promote", { ...tagMapping, dryRun: true })
      expect(r.isError).toBe(false)
      expect(r.out.written).toBe(false)
      expect(r.text).toContain("would write catalogs/Tag/Tag.meta.json")
      expect(r.text).toContain("promotion record:")
      expect(await snapshotOf(dir)).toEqual(before)
    })

    it("is refused in read-only mode", async () => {
      const dir = await project()
      await addAdoptedTag(dir)
      const before = await snapshotOf(dir)
      const r = await call(await connect(dir, true), "promote", tagMapping)
      expect(r.isError).toBe(true)
      expect(await snapshotOf(dir)).toEqual(before)
    })
  })

  describe("delete", () => {
    async function withScratch() {
      const dir = await project()
      const client = await connect(dir, false)
      const created = await call(client, "create", {
        kind: "Catalog",
        name: "Scratch",
        data: { scope: "none" },
      })
      expectClean(created.out, { allow: ["rights.scope-kind-unread"] })
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
      const client = await connect(dir, false)
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
    const client = await connect(dir, false)
    const r = await call(client, "add", {
      target: { kind: "Catalog", name: "Currency" },
      collection: "attributes",
      element: { name: "note", type: "String", length: 20 },
    })
    expectClean(r.out, { allow: ["rights.scope-kind-unread"] })
    expect(await readFile(join(dir, CURRENCY), "utf8")).toContain("note")
  })

  it("concurrent mutations both land and the result compiles", async () => {
    // Клієнти-агенти шлють паралельні виклики; без серіалізації друга
    // мутація читала б диск до запису першої й мовчки її затирала.
    const dir = await project()
    const client = await connect(dir, false)
    const add = (name: string) =>
      call(client, "add", {
        target: { kind: "Catalog", name: "Counterparty" },
        collection: "attributes",
        element: { name, type: "Boolean" },
      })
    const results = await Promise.all([add("flagOne"), add("flagTwo")])
    for (const r of results)
      expectClean(r.out, { allow: ["rights.scope-kind-unread"] })
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

it("server reports the package version", async () => {
  const { version } = JSON.parse(
    await readFile(join(__dirname, "../../package.json"), "utf8")
  ) as { version: string }
  const client = await connect(".", true)
  expect(client.getServerVersion()?.version).toBe(version)
})

describe("data over MCP", TOOL_PIPELINE, () => {
  const AS = "00000000-0000-4000-8000-0000000000a1"
  /** Значення змінної середовища: не мусить потрапити ні в текст, ні в помилку. */
  const SECRET_URL = "postgresql://u:secret@h/x"
  const operations = [
    {
      action: "update",
      object: { kind: "Catalog", name: "Currency" },
      id: "00000000-0000-4000-8000-00000000d001",
      expectedVersion: 1,
    },
  ]
  /** Ресурс даних, що рахує `open`: відмова мусить лишити його нулем. */
  function spyData(): { data: DataResource; opens: () => number } {
    let opens = 0
    return {
      data: {
        describe: "localhost:54322/app",
        as: AS,
        open: () => {
          opens++
          return Promise.reject(new Error("must not open"))
        },
      },
      opens: () => opens,
    }
  }
  const options = (argv: string[], env: NodeJS.ProcessEnv) =>
    mcpOptionsFrom(parseArgs(argv, mcpArgs), env, argv)

  it("data-command without --allow-data-write is refused with the flag hint", async () => {
    const spy = spyData()
    const client = await connectWith({
      dir: await project(),
      readOnly: false,
      data: spy.data,
    })
    const r = await call(client, "data-command", { operations })
    expect(r.isError).toBe(true)
    expect(r.text).toContain(ALLOW_DATA_WRITE_FLAG)
    expect(
      (r.out as unknown as { refusal: { reason: string } }).refusal.reason
    ).toBe("data-write-disabled")
    expect(spy.opens()).toBe(0)
  })

  it("--read-only wins over --allow-data-write", async () => {
    const spy = spyData()
    const client = await connectWith({
      dir: await project(),
      readOnly: true,
      allowDataWrite: true,
      data: spy.data,
    })
    const r = await call(client, "data-command", { operations })
    expect(
      (r.out as unknown as { refusal: { reason: string } }).refusal.reason
    ).toBe("read-only")
    expect(spy.opens()).toBe(0)
  })

  it("an empty data variable is refused naming the variable", async () => {
    const o = options(["--data-url-env", "APP_DATA", "--as", AS], {
      APP_DATA: "",
    })
    expect(o.data).toBeUndefined()
    const client = await connectWith({ ...o, dir: await project() })
    const r = await call(client, "data-read", {
      query: { object: { kind: "Catalog", name: "Currency" }, id: AS },
    })
    expect(
      (r.out as unknown as { refusal: { reason: string } }).refusal.reason
    ).toBe("no-data")
    expect(r.text).toContain("APP_DATA")
  })

  it("instructions name the user and the database, never the connection string", async () => {
    const o = options(["--data-url-env", "APP_DATA", "--as", AS], {
      APP_DATA: "postgresql://login_marker:pw_marker@localhost:54322/app",
    })
    const client = await connectWith({ ...o, dir: await project() })
    const text = client.getInstructions() ?? ""
    expect(text).toContain(AS)
    expect(text).toContain("localhost:54322/app")
    expect(text).toContain(ALLOW_DATA_WRITE_FLAG)
    expect(text).toContain("--allow-rights-write")
    expect(text).not.toContain("login_marker")
    expect(text).not.toContain("pw_marker")
  })

  it("read-only instructions do not advise the data write flag", async () => {
    const client = await connectWith({
      dir: await project(),
      readOnly: true,
      data: spyData().data,
    })
    expect(client.getInstructions()).not.toContain(ALLOW_DATA_WRITE_FLAG)
  })

  it.each([
    [["--database-url-env", SECRET_URL], "--database-url-env"],
    [["--shadow-url-env", SECRET_URL], "--shadow-url-env"],
    [["--data-url-env", SECRET_URL, "--as", AS], "--data-url-env"],
    [["--data-url-env", "APP_DATA", "--as", "not-a-uuid"], "--as"],
  ])("launch flags %j are refused without the value", (argv, flag) => {
    let error: unknown
    try {
      options(argv, {})
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(UsageError)
    expect((error as Error).message).toContain(flag)
    expect((error as Error).message).not.toContain("secret")
  })

  it("a full data launch gives the data resource and its variable", () => {
    const argv = [
      "--data-url-env",
      "APP_DATA",
      "--as",
      AS,
      "--allow-data-write",
      "--allow-rights-write",
    ]
    const o = options(argv, {
      APP_DATA: "postgresql://u:p@localhost:54322/app",
    })
    expect(o).toMatchObject({
      dataEnv: "APP_DATA",
      allowDataWrite: true,
      allowRightsWrite: true,
      launchArgs: argv,
    })
    expect(o.data).toMatchObject({ as: AS, describe: "localhost:54322/app" })
    expect(options([], {})).toMatchObject({
      allowDataWrite: false,
      allowRightsWrite: false,
    })
    expect(options([], {}).data).toBeUndefined()
  })
})
