import { existsSync } from "node:fs"
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runFix } from "../commands/fix"
import { runCompile } from "../commands/compile"

const REFERENCE = resolve(__dirname, "../../../../examples/reference/metadata")
const CURRENCY = "catalogs/Currency/Currency.meta.json"
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true })))
})

/** Копія домену, у якої з довідника валют знято `id` і `$schema`. */
async function copyWithoutId(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "simetra-fix-"))
  temps.push(root)
  const dir = join(root, "metadata")
  await cp(REFERENCE, dir, { recursive: true })
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

describe("simetra fix", () => {
  it("--dry-run writes nothing", async () => {
    const dir = await copyWithoutId()
    const before = await snapshotOf(dir)
    const r = await runFix({ dir, dryRun: true, format: "text" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`would fix ${dir}/${CURRENCY}`)
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("writes and reports", async () => {
    const dir = await copyWithoutId()
    const r = await runFix({ dir, dryRun: false, format: "text" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(`fixed ${dir}/${CURRENCY}`)
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
    const compiled = await runCompile({
      dirs: [dir],
      locale: "en",
      format: "text",
    })
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
  })
})
