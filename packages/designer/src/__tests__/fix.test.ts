import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { runTool, type CliArgs } from "../cli/command"
import { toolByName } from "../tools/catalog"
import { project, snapshotOf, useTmpProjects } from "./helpers/catalog"

const REFERENCE = resolve(__dirname, "../../../../examples/reference/metadata")
const CURRENCY = "catalogs/Currency/Currency.meta.json"

useTmpProjects()

type FixArgs = Omit<CliArgs, "_" | "dry-run"> & { dir: string; dryRun: boolean }
const runFix = ({ dir, dryRun, ...rest }: FixArgs) =>
  runTool(toolByName("fix")!, { _: [dir], "dry-run": dryRun, ...rest })
const runCompile = ({ dirs }: { dirs: string[] }) =>
  runTool(toolByName("compile")!, { _: dirs })

/** Копія домену, у якої з довідника валют знято `id` і `$schema`. */
async function copyWithoutId(): Promise<string> {
  const dir = await project()
  const file = join(dir, CURRENCY)
  const json = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >
  delete json.id
  delete json.$schema
  await writeFile(file, JSON.stringify(json, null, 2))
  return dir
}

describe("simetra fix", () => {
  it("--dry-run writes nothing", async () => {
    const dir = await copyWithoutId()
    const before = await snapshotOf(dir)
    const r = await runFix({ dir, dryRun: true, format: "text" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`would write ${dir}/${CURRENCY}`)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("writes and reports", async () => {
    const dir = await copyWithoutId()
    const r = await runFix({ dir, dryRun: false, format: "text" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`written ${dir}/${CURRENCY}`)
    const json = JSON.parse(await readFile(join(dir, CURRENCY), "utf8")) as {
      id: string
      $schema: string
    }
    expect(json.id).toMatch(/^[0-9a-f-]{36}$/)
    // `$schema` — відносний шлях до справжнього файлу схеми пакета.
    expect(
      existsSync(resolve(dirname(join(dir, CURRENCY)), json.$schema))
    ).toBe(true)
    expect(json.$schema.endsWith("/catalogs.schema.json")).toBe(true)
    const compiled = await runCompile({ dirs: [dir] })
    expect(compiled.exitCode).toBe(0)
    // Другий прогін нічого не змінює.
    const again = await runFix({ dir, dryRun: false, format: "json" })
    expect(again.exitCode).toBe(0)
    expect(JSON.parse(again.stdout)).toMatchObject({ changed: [] })
  })

  it("a result with errors writes nothing and exits 1", async () => {
    const dir = await copyWithoutId()
    await writeFile(join(dir, "catalogs/Contract/Contract.meta.json"), "{ x")
    const before = await snapshotOf(dir)
    const r = await runFix({ dir, dryRun: false, format: "json" })
    expect(r.exitCode).toBe(1)
    const report = JSON.parse(r.stdout) as {
      written: boolean
      diagnostics: { code: string }[]
    }
    expect(report.written).toBe(false)
    expect(report.diagnostics.map((d) => d.code)).toContain("file.invalid-json")
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("usage errors exit 2", async () => {
    expect(
      (await runFix({ dir: REFERENCE, dryRun: true, format: "yaml" as "text" }))
        .exitCode
    ).toBe(2)
    expect(
      (await runFix({ dir: "/nonexistent/x", dryRun: true, format: "text" }))
        .exitCode
    ).toBe(2)
    expect(
      (
        await runFix({
          dir: REFERENCE,
          dryRun: true,
          format: "text",
          locale: "xx" as "en",
        })
      ).exitCode
    ).toBe(2)
  })
})
