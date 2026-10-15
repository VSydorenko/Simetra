import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { compile, type FileChange } from "simetra/compiler"
import { z } from "zod"
import { describe, expect, it, vi } from "vitest"
import { runTool, toolCommand } from "../cli/command"
import { readMetadataDir } from "../io/metadata-dir"
import { mcpInputSchema } from "../mcp/tools"
import { applyTool, planTool } from "../tools/apply-tools"
import { compileArtifacts } from "../tools/artifacts"
import { TOOLS, toolByName } from "../tools/catalog"
import { invoke, permits } from "../tools/invoke"
import { queueFor } from "../tools/queue"
import {
  DEFAULT_DATABASE_URL_ENV,
  noDatabaseHint,
  READ_ONLY_FLAG,
  readOnlyHint,
} from "../tools/hints"
import {
  DATABASE_ACCESS,
  defineTool,
  FILES_ACCESS,
  type DatabaseResource,
  type Tool,
} from "../tools/types"
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
      "apply",
      "compile",
      "create",
      "delete",
      "diff",
      "explain",
      "fix",
      "introspect",
      "plan",
      "promote",
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

  it("--read-only refuses a write, writes nothing and names the flag", async () => {
    const dir = await brokenProject()
    const before = await readMetadataDir(dir)
    const r = await invoke(
      toolByName("fix")!,
      {},
      {
        ...opts(dir),
        readOnly: true,
      }
    )
    expect(r.refusal).toEqual({ reason: "read-only", message: readOnlyHint() })
    expect(r.refusal?.message).toContain(READ_ONLY_FLAG)
    expect(await readMetadataDir(dir)).toEqual(before)
  })

  it("writes are on by default", async () => {
    const dir = await brokenProject()
    const r = await invoke(toolByName("fix")!, {}, opts(dir))
    expect(r.refusal).toBeUndefined()
    expect(r.written).toBe(true)
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

  it("every (files, database) pair has a permit rule", () => {
    // Повний добуток осей, а не лише пари з TOOLS: правило для нової пари
    // мусить існувати до того, як з'явиться інструмент із нею.
    // Запис у базу — лише без `--read-only` і з прапорцем запуску
    // `--allow-database-write`; запис файлів прапорця не потребує.
    for (const files of FILES_ACCESS) {
      for (const database of DATABASE_ACCESS) {
        const t = { ...toolByName("compile")!, files, database }
        for (const readOnly of [false, true]) {
          for (const allowDatabaseWrite of [false, true]) {
            const expected =
              (files === "read" || !readOnly) &&
              (database !== "write" || (!readOnly && allowDatabaseWrite))
            expect(
              permits(t, { readOnly, allowDatabaseWrite }),
              `${files}/${database} readOnly=${readOnly} allowDatabaseWrite=${allowDatabaseWrite}`
            ).toBe(expected)
          }
        }
      }
    }
    // `apply` пише лише свій артефакт і в базу: `--read-only` вимикає і його
    for (const t of TOOLS) {
      expect(
        permits(t, { readOnly: true, allowDatabaseWrite: true }),
        t.name
      ).toBe(t.files === "read" && t.database !== "write")
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
  it("delete still needs confirm when writes are on", async () => {
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
      opts(dir)
    )
    expect(r.refusal?.reason).toBe("unconfirmed")
    expect(await snapshotOf(dir)).toEqual(before)
  })

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

describe("readOnlyHint", () => {
  it("shows the general form without launch args", () => {
    expect(readOnlyHint()).toContain(
      `ending in ["simetra","mcp","${READ_ONLY_FLAG}"] become ["simetra","mcp"]`
    )
  })

  it("echoes the real launch args as the tail of the client's args", () => {
    const hint = readOnlyHint(["mcp", "./metadata", READ_ONLY_FLAG])
    expect(hint).toContain(`remove ${READ_ONLY_FLAG} from`)
    expect(hint).toContain(
      `ending in ["mcp","./metadata","${READ_ONLY_FLAG}"] become ["mcp","./metadata"]`
    )
    // Лаунчер клієнта (`pnpm exec simetra …`, `npx …`) додає свої аргументи
    // попереду, тож підказка не видає хвіст за повний конфіг.
    expect(hint).not.toContain(`"args": [`)
  })
})

/** Заглушка бази: відмови `invoke` перевіряються без двигуна й без стеку. */
const dbStub = defineTool({
  name: "compile",
  description: "Database stub.",
  input: z.strictObject({}),
  files: "read",
  database: "read",
  destructive: false,
  async run(ctx) {
    await ctx.database!.connect()
    return { ok: true, changes: [], diagnostics: [] }
  },
}) as Tool

describe("artifacts", () => {
  it("an artifact with null content is refused: artifacts never delete files", async () => {
    const dir = await project()
    const deleting = defineTool({
      ...dbStub,
      database: "none",
      files: "write",
      async run() {
        return {
          ok: true,
          changes: [],
          diagnostics: [],
          artifacts: [{ path: "plans/old.json", content: null }],
        }
      },
    }) as Tool
    const r = await invoke(deleting, {}, opts(dir))
    expect(r.refusal?.reason).toBe("refused")
    expect(r.refusal?.message).toContain("never delete")
    expect(r.written).toBe(false)
  })
})

describe("database as a launch resource", () => {
  it("a database tool without a connection is refused with the env hint", async () => {
    const dir = await project()
    const r = await invoke(dbStub, {}, opts(dir))
    expect(r.refusal).toEqual({
      reason: "no-database",
      message: noDatabaseHint(DEFAULT_DATABASE_URL_ENV, "cli"),
    })
    expect(r.refusal?.message).toContain("SIMETRA_DATABASE_URL")
  })

  it("the hint names the variable chosen at launch", async () => {
    const dir = await project()
    const r = await invoke(dbStub, {}, { ...opts(dir), databaseEnv: "APP_DB" })
    expect(r.refusal?.message).toBe(noDatabaseHint("APP_DB", "cli"))
    expect(r.refusal?.message).not.toContain(DEFAULT_DATABASE_URL_ENV)
  })

  it("read-only is decided before the missing connection", async () => {
    const dir = await project()
    const writer = { ...dbStub, database: "write" } as Tool
    const r = await invoke(writer, {}, { ...opts(dir), readOnly: true })
    expect(r.refusal?.reason).toBe("read-only")
  })

  it("the missing connection is decided before confirmation", async () => {
    const dir = await project()
    const destructive = { ...dbStub, destructive: true } as Tool
    const r = await invoke(destructive, {}, opts(dir))
    expect(r.refusal?.reason).toBe("no-database")
  })

  it("passes the resource only to a tool that uses the database", async () => {
    const dir = await project()
    let connects = 0
    const database: DatabaseResource = {
      describe: "localhost:5432/app",
      connect: () => {
        connects++
        return Promise.reject(new Error("not in a unit test"))
      },
    }
    let seen: unknown = "unset"
    const noDb = defineTool({
      ...dbStub,
      database: "none",
      async run(ctx) {
        seen = ctx.database
        return { ok: true, changes: [], diagnostics: [] }
      },
    }) as Tool
    await invoke(noDb, {}, { ...opts(dir), database })
    expect(seen).toBeUndefined()
    expect(connects).toBe(0)
    await expect(
      invoke(dbStub, {}, { ...opts(dir), database })
    ).rejects.toThrow("not in a unit test")
    expect(connects).toBe(1)
  })
})

/** Заглушка `plan`: артефакт пише `invoke`, а не інструмент. */
const artifactStub = (path: string) =>
  defineTool({
    name: "plan",
    description: "Artifact stub.",
    input: z.strictObject({}),
    files: "write",
    database: "none",
    destructive: false,
    async run(ctx) {
      return {
        ok: true,
        changes: [],
        diagnostics: [],
        artifacts: [{ path, content: `${ctx.root}\n` }],
      }
    },
  }) as Tool

describe("plan artifacts", () => {
  it("are written under plans/ next to the metadata directory", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const r = await invoke(artifactStub("plans/a.plan.json"), {}, opts(dir))
    expect(r.ok).toBe(true)
    expect(r.written).toBe(true)
    expect(r.artifacts).toEqual(["plans/a.plan.json"])
    const root = dirname(resolve(dir))
    expect(await readFile(join(root, "plans/a.plan.json"), "utf8")).toBe(
      `${root}\n`
    )
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("take the project root from the metadata directory itself", async () => {
    // Запуск із самої теки метаданих (`dir = "."`) не кладе `plans/` у неї:
    // `<dir>/.` ламає наївний `dirname` так само, як `.`, без зміни cwd
    const dir = await project()
    const r = await invoke(
      artifactStub("plans/b.plan.json"),
      {},
      opts(`${dir}/.`)
    )
    expect(r.written).toBe(true)
    expect(existsSync(join(dir, "plans"))).toBe(false)
    expect(existsSync(join(dirname(dir), "plans/b.plan.json"))).toBe(true)
  })

  it("are not written by a dry run", async () => {
    const dir = await project()
    const r = await invoke(
      artifactStub("plans/c.plan.json"),
      {},
      {
        ...opts(dir),
        dryRun: true,
      }
    )
    expect(r.written).toBe(false)
    expect(r.artifacts).toEqual(["plans/c.plan.json"])
    expect(existsSync(join(dirname(dir), "plans"))).toBe(false)
  })

  it("outside plans/ are refused before touching the disk", async () => {
    const dir = await project()
    for (const path of ["metadata/x.plan.json", "plans/../x.plan.json", "x"]) {
      const r = await invoke(artifactStub(path), {}, opts(dir))
      expect(r.refusal?.reason, path).toBe("refused")
      expect(r.written).toBe(false)
    }
    expect(existsSync(join(dirname(dir), "x.plan.json"))).toBe(false)
    expect(existsSync(join(dir, "x.plan.json"))).toBe(false)
  })
})

/** Заглушка інструмента осі `artifact`: пише лише свій артефакт. */
const artifactTool = (changes: FileChange[] = []) =>
  defineTool({
    name: "plan",
    description: "Artifact tool stub.",
    input: z.strictObject({}),
    files: "artifact",
    database: "none",
    destructive: false,
    async run() {
      return {
        ok: true,
        changes,
        diagnostics: [],
        artifacts: [{ path: "plans/d.plan.json", content: "{}\n" }],
      }
    },
  }) as Tool

const applyInput = {
  plan: "plans/initial-0123456789ab.plan.json",
  planHash: "a".repeat(64),
}

/** Поля об'єктної схеми входу MCP. */
const mcpFields = (tool: Tool): string[] => {
  const schema = mcpInputSchema(tool)
  return schema instanceof z.ZodObject ? Object.keys(schema.shape) : []
}

describe("files axis", () => {
  it("plan and apply write only their artifacts", () => {
    // Рішення 10 плану П3-2b-3: одна вісь для «пише лише plans/»
    expect(planTool.files).toBe("artifact")
    expect(applyTool.files).toBe("artifact")
    expect(toolByName("promote")!.files).toBe("write")
  })

  it("dryRun exists only for tools that write files", () => {
    // Перегляд має сенс лише для змін теки метаданих: інструмент осі
    // `artifact` нічого не показує наперед, а `dryRun` у `apply` обійшов би
    // підтвердження
    for (const t of TOOLS) {
      expect(mcpFields(t).includes("dryRun"), t.name).toBe(t.files === "write")
      expect("dry-run" in (toolCommand(t).args ?? {}), t.name).toBe(
        t.files === "write"
      )
    }
  })

  it("apply has no dryRun", async () => {
    const schema = mcpInputSchema(applyTool)
    expect(schema.safeParse({ ...applyInput, confirm: true }).success).toBe(
      true
    )
    expect(
      schema.safeParse({ ...applyInput, confirm: true, dryRun: true }).success
    ).toBe(false)
    const run = vi.fn<Tool["run"]>()
    const cli = await runTool(
      { ...applyTool, run } as Tool,
      {
        _: [applyInput.plan, await project()],
        "plan-hash": applyInput.planHash,
        yes: true,
        "dry-run": true,
      },
      () => Promise.resolve("")
    )
    expect(cli.exitCode).toBe(2)
    expect(cli.stderr).toContain("apply has no --dry-run")
    expect(run).not.toHaveBeenCalled()
    const unconfirmed = await invoke(
      { ...applyTool, run } as Tool,
      applyInput,
      {
        ...opts(await project()),
        allowDatabaseWrite: true,
        database: {
          describe: "db.example.test:5432/app",
          connect: () => Promise.reject(new Error("must not connect")),
        },
      }
    )
    expect(unconfirmed.refusal?.reason).toBe("unconfirmed")
    expect(run).not.toHaveBeenCalled()
  })

  it("apply with dryRun commits nothing", async () => {
    // Канали такого входу не дають, але `invoke` на них не покладається:
    // `dryRun` інструмента без перегляду — відмова до `run`, а не
    // підтверджене застосування
    let connects = 0
    const database: DatabaseResource = {
      describe: "db.example.test:5432/app",
      connect: () => {
        connects++
        return Promise.reject(new Error("must not connect"))
      },
    }
    for (const tool of [applyTool, planTool, toolByName("compile")!]) {
      const run = vi.fn<Tool["run"]>()
      const r = await invoke(
        { ...tool, run } as Tool,
        tool === applyTool ? applyInput : {},
        {
          ...opts(await project()),
          allowDatabaseWrite: true,
          dryRun: true,
          confirmed: true,
          database,
        }
      )
      expect(r.refusal?.reason, tool.name).toBe("dry-run-unsupported")
      expect(r.written).toBe(false)
      expect(run).not.toHaveBeenCalled()
    }
    expect(connects).toBe(0)
  })

  it("read-only forbids an artifact tool", async () => {
    for (const tool of [planTool, applyTool]) {
      expect(
        permits(tool, { readOnly: true, allowDatabaseWrite: true }),
        tool.name
      ).toBe(false)
      expect(
        permits(tool, { readOnly: false, allowDatabaseWrite: true }),
        tool.name
      ).toBe(true)
    }
    const dir = await project()
    const r = await invoke(artifactTool(), {}, { ...opts(dir), readOnly: true })
    expect(r.refusal?.reason).toBe("read-only")
    expect(existsSync(join(dirname(dir), "plans"))).toBe(false)
  })

  it("an artifact tool writes its artifacts without a preview", async () => {
    const dir = await project()
    const before = await snapshotOf(dir)
    const r = await invoke(artifactTool(), {}, opts(dir))
    expect(r.written).toBe(true)
    expect(r.artifacts).toEqual(["plans/d.plan.json"])
    expect(existsSync(join(dirname(dir), "plans/d.plan.json"))).toBe(true)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("an artifact tool may not change the directory", async () => {
    // Зміни теки в інструмента осі `artifact` — дефект інструмента, а не
    // відмова: нічого не пишеться, ні теки, ні артефакту
    const dir = await project()
    const before = await snapshotOf(dir)
    await expect(
      invoke(artifactTool([{ path: CURRENCY, content: "{}" }]), {}, opts(dir))
    ).rejects.toThrow(/artifact tool/)
    expect(await snapshotOf(dir)).toEqual(before)
    expect(existsSync(join(dirname(dir), "plans"))).toBe(false)
  })
})

describe("noDatabaseHint", () => {
  it("names the environment variable and nothing else", () => {
    for (const channel of ["cli", "mcp"] as const) {
      const hint = noDatabaseHint("MY_DB_URL", channel)
      expect(hint).toContain("MY_DB_URL")
      expect(hint).not.toContain(DEFAULT_DATABASE_URL_ENV)
    }
  })

  it("tells the command line to export the variable, not to restart a server", () => {
    const hint = noDatabaseHint("MY_DB_URL", "cli")
    expect(hint).not.toMatch(/restart|server/i)
    expect(hint).toContain("--database-url-env")
  })

  it("tells the MCP server to set the variable in its environment and restart", () => {
    expect(noDatabaseHint("MY_DB_URL", "mcp")).toMatch(/restart/)
  })
})
