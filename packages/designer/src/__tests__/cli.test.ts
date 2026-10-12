import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { commandByName, runTool, toolCommand } from "../cli/command"
import { cliInput } from "../cli/input"
import { renderResult } from "../cli/render"
import type { PlanData } from "../tools/apply-tools"
import { TOOLS, toolByName, type Tool } from "../tools/catalog"
import { TOOL_NAMES } from "../tools/types"
import {
  addAdoptedTag,
  project,
  snapshotOf,
  TAG_FILE,
  tagMapping,
  useTmpProjects,
} from "./helpers/catalog"

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
      expect("dry-run" in args).toBe(t.files === "write")
      expect("yes" in args).toBe(t.destructive)
    }
  })

  it("writes are on by default and delete still needs --yes", async () => {
    const dir = await withScratch()
    const file = join(dir, "catalogs/Scratch/Scratch.meta.json")
    expect(existsSync(file)).toBe(true)
    const unconfirmed = await runTool(tool("delete"), {
      _: [JSON.stringify(scratchTarget), dir],
    })
    expect(unconfirmed.exitCode).toBe(2)
    expect(existsSync(file)).toBe(true)
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

  it("maps introspect and diff flags onto the catalog input", async () => {
    expect(
      await cliInput(
        tool("introspect"),
        {
          _: ["meta/"],
          schemas: "app, reports",
          "project-name": "Shop",
          "attribute-case": "snake_case",
          "database-provider": "supabase",
        },
        noStdin
      )
    ).toEqual({
      input: {
        schemas: ["app", "reports"],
        project: {
          name: "Shop",
          attributeCase: "snake_case",
          database: { provider: "supabase" },
        },
      },
      dirs: ["meta"],
    })
    expect(await cliInput(tool("introspect"), { _: [] }, noStdin)).toEqual({
      input: {},
      dirs: ["./metadata"],
    })
    expect(
      await cliInput(
        tool("diff"),
        { _: [], tables: "app.orders,lines" },
        noStdin
      )
    ).toEqual({
      input: { tables: ["app.orders", "lines"] },
      dirs: ["./metadata"],
    })
    await expect(
      cliInput(tool("diff"), { _: [], tables: "a,,b" }, noStdin)
    ).rejects.toThrow("--tables expects a comma-separated list")
  })

  it("database flags exist only on database tools", () => {
    for (const t of TOOLS) {
      const args = toolCommand(t).args ?? {}
      const db = t.database !== "none"
      expect("database-url-env" in args, t.name).toBe(db)
      expect("shadow-url-env" in args, t.name).toBe(db)
    }
  })

  it("an unknown database provider exits 2", async () => {
    const dir = await project()
    const r = await runTool(
      tool("introspect"),
      { _: [dir], schemas: "app", "database-provider": "mysql" },
      noStdin,
      process.cwd(),
      { SIMETRA_DATABASE_URL: "postgres://u:p@h/db" }
    )
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("project.database.provider")
  })

  it("a database tool without a connection exits 2 naming the chosen variable", async () => {
    const dir = await project()
    const r = await runTool(
      tool("diff"),
      { _: [dir], "database-url-env": "APP_DB" },
      noStdin,
      process.cwd(),
      { SIMETRA_DATABASE_URL: "postgres://u:p@h/db" }
    )
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("APP_DB")
    expect(r.stderr).not.toContain("SIMETRA_DATABASE_URL")
    expect(r.stderr).not.toMatch(/restart/i)
  })

  it("a tool without the database never reads the environment", async () => {
    const dir = await project()
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get: () => {
        throw new Error("the environment must not be read")
      },
    })
    const r = await runTool(
      tool("compile"),
      { _: [dir] },
      noStdin,
      process.cwd(),
      env
    )
    expect(r.exitCode).toBe(0)
  })

  it("promote reads the mapping from stdin, writes and prints the record summary", async () => {
    const dir = await project()
    await addAdoptedTag(dir)
    const r = await runTool(tool("promote"), { _: ["-", dir] }, async () =>
      JSON.stringify(tagMapping)
    )
    expect(r.exitCode).toBe(0)
    expect(existsSync(join(dir, TAG_FILE))).toBe(false)
    expect(existsSync(join(dir, "catalogs/Tag/Tag.meta.json"))).toBe(true)
    expect(r.stdout).toContain("written")
    expect(r.stdout).toMatch(/^promoted \S+ into Catalog$/m)
  })

  it("promote --dry-run says the summary would promote", async () => {
    const dir = await project()
    await addAdoptedTag(dir)
    const before = await snapshotOf(dir)
    const r = await runTool(tool("promote"), {
      _: [JSON.stringify(tagMapping), dir],
      "dry-run": true,
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("would write")
    expect(r.stdout).toMatch(/^would promote \S+ into Catalog$/m)
    expect(r.stdout).not.toMatch(/^promoted /m)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("promote --format json carries the record", async () => {
    const dir = await project()
    await addAdoptedTag(dir)
    const before = await snapshotOf(dir)
    const r = await runTool(tool("promote"), {
      _: [JSON.stringify(tagMapping), dir],
      "dry-run": true,
      format: "json",
    })
    expect(r.exitCode).toBe(0)
    const out = JSON.parse(r.stdout) as {
      written: boolean
      record: { kind: string; tables: unknown[] }
    }
    expect(out.written).toBe(false)
    expect(out.record.kind).toBe("Catalog")
    expect(out.record.tables.length).toBeGreaterThan(0)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  describe("plan and apply", () => {
    const hash = "b".repeat(64)
    const env = { SIMETRA_DATABASE_URL: "postgres://u:p@db.example.test/app" }

    it("plan takes its directory as a positional, not JSON", async () => {
      expect(await cliInput(tool("plan"), { _: ["meta/"] }, noStdin)).toEqual({
        input: {},
        dirs: ["meta"],
      })
      expect(await cliInput(tool("plan"), { _: [] }, noStdin)).toEqual({
        input: {},
        dirs: ["./metadata"],
      })
    })

    it("maps apply flags onto the catalog input", async () => {
      expect(
        await cliInput(
          tool("apply"),
          {
            _: ["plans/initial-0123456789ab.plan.json", "meta"],
            "plan-hash": hash,
            allow: "drift,s2",
            rehearse: true,
            "lock-timeout-ms": "5000",
            "statement-timeout-ms": "60000",
          },
          noStdin
        )
      ).toEqual({
        input: {
          plan: "plans/initial-0123456789ab.plan.json",
          planHash: hash,
          allow: ["drift", "s2"],
          rehearse: true,
          lockTimeoutMs: 5000,
          statementTimeoutMs: 60000,
        },
        dirs: ["meta"],
      })
      await expect(
        cliInput(tool("apply"), { _: [], "plan-hash": hash }, noStdin)
      ).rejects.toThrow("apply needs the plan file")
    })

    it("an allow item that is neither a step id nor drift is an input error", async () => {
      const r = await runTool(
        tool("apply"),
        {
          _: ["plans/initial-0123456789ab.plan.json", await project()],
          "plan-hash": hash,
          allow: "drifts",
          yes: true,
        },
        noStdin,
        process.cwd(),
        env
      )
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain("allow")
    })

    it("apply without --yes exits 2 and connects nowhere", async () => {
      const r = await runTool(
        tool("apply"),
        {
          _: ["plans/initial-0123456789ab.plan.json", await project()],
          "plan-hash": hash,
        },
        noStdin,
        process.cwd(),
        env
      )
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain("needs confirmation")
    })

    it("apply --yes --dry-run exits 2 before the tool runs", async () => {
      // Усі підключення до бази відкриває `run` інструмента: не викликаний
      // `run` — жодного підключення
      const run = vi.fn<Tool["run"]>()
      const r = await runTool(
        { ...tool("apply"), run },
        {
          _: ["plans/initial-0123456789ab.plan.json", await project()],
          "plan-hash": hash,
          yes: true,
          "dry-run": true,
        },
        noStdin,
        process.cwd(),
        env
      )
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain("--rehearse")
      expect(run).not.toHaveBeenCalled()
    })

    it("--dry-run on a tool that writes no files exits 2", async () => {
      const r = await runTool(tool("compile"), {
        _: [await project()],
        "dry-run": true,
      })
      expect(r.exitCode).toBe(2)
      expect(r.stderr).toContain("compile has no --dry-run")
    })

    it("apply has --yes and no --dry-run; plan has --dry-run", () => {
      const apply = toolCommand(tool("apply")).args ?? {}
      for (const flag of [
        "plan-hash",
        "allow",
        "rehearse",
        "lock-timeout-ms",
        "statement-timeout-ms",
        "yes",
      ])
        expect(flag in apply, flag).toBe(true)
      expect("dry-run" in apply).toBe(false)
      expect("dry-run" in (toolCommand(tool("plan")).args ?? {})).toBe(true)
    })

    it("the text of a plan shows drift before the first step", () => {
      const data: PlanData = {
        file: "plans/0123456789ab-ba9876543210.plan.json",
        planHash: hash,
        fromHash: "0123456789ab".padEnd(64, "0"),
        toHash: "ba9876543210".padEnd(64, "0"),
        drift: {
          reason: "drift",
          sections: ["relations"],
          paths: ["tables.app.party.columns.extra"],
        },
        promotion: null,
        steps: [
          {
            id: "s1",
            origin: "engine",
            class: "destructive",
            lockClass: "accessExclusive",
            sql: "ALTER TABLE app.party DROP COLUMN extra;\n-- second line",
          },
        ],
        requiredPermissions: ["drift", "s1"],
      }
      const { stdout } = renderResult(
        tool("plan"),
        {
          ok: true,
          written: true,
          changes: [],
          artifacts: [data.file],
          diagnostics: [],
          data,
        },
        { dir: "metadata", locale: "en", format: "text" }
      )
      const drift = stdout.indexOf("drift (drift)")
      const step = stdout.indexOf("s1 engine destructive")
      expect(drift).toBeGreaterThan(-1)
      expect(step).toBeGreaterThan(drift)
      expect(stdout).toContain(hash)
      expect(stdout).toContain(data.file)
      expect(stdout).toContain("needs allow: drift")
      expect(stdout).toContain("needs allow: s1")
      expect(stdout).not.toContain("second line")
    })

    it("the text of a plan shows the promotion between drift and steps", () => {
      const item = { schema: "app", name: "item" }
      const data: PlanData = {
        file: "plans/0123456789ab-ba9876543210.plan.json",
        planHash: hash,
        fromHash: "0123456789ab".padEnd(64, "0"),
        toHash: "ba9876543210".padEnd(64, "0"),
        drift: { reason: "drift", sections: ["relations"], paths: [] },
        promotion: {
          objectId: "00000000-0000-4000-8000-000000009311",
          kind: "Catalog",
          name: "Item",
          recordHash: "f".repeat(64),
          tables: [{ schema: "app", from: "items", to: "item" }],
          columns: [{ table: item, from: "title", to: "description" }],
          canonicalNames: [
            {
              kind: "constraint",
              table: item,
              from: "items_pkey",
              to: "item_pkey",
            },
          ],
          permissionItems: [
            { token: "access:app.item", summary: ["policy item_read"] },
            { token: "remove:app.item", summary: ["Item#comment"] },
          ],
          // Ім'я з крапкою лишається однозначним: лапки, а не склеювання
          implicitLocks: [{ schema: "app", name: "odd.name" }],
        },
        steps: [
          {
            id: "s1",
            origin: "intent",
            class: "catalogOnly",
            lockClass: "accessExclusive",
            sql: "ALTER TABLE app.items RENAME TO item",
          },
          {
            id: "s2",
            origin: "engine",
            class: "destructive",
            lockClass: "accessExclusive",
            sql: 'ALTER TABLE "app"."item" DROP COLUMN "legacy"',
            conversion: "removed",
          },
        ],
        requiredPermissions: ["drift", "access:app.item", "s2"],
      }
      const { stdout } = renderResult(
        tool("plan"),
        {
          ok: true,
          written: true,
          changes: [],
          artifacts: [data.file],
          diagnostics: [],
          data,
        },
        { dir: "metadata", locale: "en", format: "text" }
      )
      const lines = stdout.split("\n")
      const at = (line: string) => lines.indexOf(line)
      const block = [
        "promotion: Catalog Item (00000000-0000-4000-8000-000000009311)",
        `  record hash: ${"f".repeat(64)}`,
        "  table app.items -> app.item",
        "  column app.item: title -> description",
        "  constraint app.item: items_pkey -> item_pkey",
        '  implicit lock of the FK step: app."odd.name"',
        "  access:app.item (needs allow: access:app.item)",
        "    policy item_read",
        "  remove:app.item",
        "    Item#comment",
      ]
      const start = at(block[0]!)
      expect(lines.slice(start, start + block.length)).toEqual(block)
      expect(start).toBeGreaterThan(at("drift (drift): needs allow: drift"))
      expect(at("steps (2):")).toBe(start + block.length)
      expect(lines).toContain(
        "  s1 intent catalogOnly (lock accessExclusive) ALTER TABLE app.items RENAME TO item"
      )
      expect(lines).toContain(
        '  s2 engine destructive (lock accessExclusive; conversion removed; needs allow: s2) ALTER TABLE "app"."item" DROP COLUMN "legacy"'
      )
    })

    it("the text of a rehearsal warns about ACCESS EXCLUSIVE", () => {
      const { stdout } = renderResult(
        tool("apply"),
        {
          ok: true,
          written: false,
          changes: [],
          diagnostics: [],
          data: { status: "rolledBack", attempts: 1 },
        },
        { dir: "metadata", locale: "en", format: "text" }
      )
      expect(stdout).toContain("ACCESS EXCLUSIVE")
      expect(stdout).toContain("rolled back")
    })
  })
})
