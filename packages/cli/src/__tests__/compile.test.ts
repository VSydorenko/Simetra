import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compile, MESSAGES } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import { readMetadataDir } from "../io/metadata-dir"
import { runCompile } from "../commands/compile"

const REFERENCE = resolve(__dirname, "../../../../examples/reference/metadata")
const temps: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "simetra-cli-"))
  temps.push(dir)
  return dir
}

/** Копія референсного домену, у якого в одному файлі знято `id`. */
async function brokenCopy(): Promise<string> {
  const dir = join(await tempDir(), "metadata")
  await cp(REFERENCE, dir, { recursive: true })
  const file = join(dir, "catalogs/Currency/Currency.meta.json")
  const json = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >
  delete json.id
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

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true })))
})

describe("simetra compile", () => {
  it("reference domain compiles", async () => {
    const r = await runCompile({
      dirs: [REFERENCE],
      locale: "en",
      format: "text",
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("0 error(s)")
  })

  it("errors give exit code 1 with file:line:col", async () => {
    const dir = await brokenCopy()
    const r = await runCompile({ dirs: [dir], locale: "en", format: "text" })
    expect(r.exitCode).toBe(1)
    const line = r.stdout
      .split("\n")
      .find((l) => l.includes("identity.id-missing"))
    expect(line).toBeDefined()
    expect(line).toMatch(
      new RegExp(
        `^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/catalogs/Currency/Currency\\.meta\\.json:\\d+:\\d+ error identity\\.id-missing `
      )
    )
    expect(r.stdout).not.toContain(" 0 error(s)")
  })

  it("json format is the diagnostic list", async () => {
    const dir = await brokenCopy()
    const r = await runCompile({ dirs: [dir], locale: "en", format: "json" })
    const list = JSON.parse(r.stdout) as Record<string, unknown>[]
    expect(Array.isArray(list)).toBe(true)
    const d = list.find((x) => x.code === "identity.id-missing")
    expect(d).toMatchObject({ dir, file: expect.any(String) })
    expect(d?.range).toBeDefined()
  })

  it("uk locale", async () => {
    const dir = await brokenCopy()
    const r = await runCompile({ dirs: [dir], locale: "uk", format: "json" })
    const list = JSON.parse(r.stdout) as {
      code: string
      message: string
      params?: Record<string, string | number>
    }[]
    const d = list.find((x) => x.code === "identity.id-missing")!
    expect(d.message).toBe(MESSAGES["identity.id-missing"].uk(d.params ?? {}))
    expect(d.message).not.toBe(
      MESSAGES["identity.id-missing"].en(d.params ?? {})
    )
  })

  it("missing dir gives exit code 2", async () => {
    const r = await runCompile({
      dirs: [join(await tempDir(), "nope")],
      locale: "en",
      format: "text",
    })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("error:")
  })

  it("--out writes snapshot, sql and types", async () => {
    const out = join(await tempDir(), "out")
    const r = await runCompile({
      dirs: [REFERENCE],
      out,
      locale: "en",
      format: "text",
    })
    expect(r.exitCode).toBe(0)
    expect((await readdir(out)).sort()).toEqual([
      "desired-state.sql",
      "entities.d.ts",
      "snapshot.json",
    ])
    const model = (await compile(await readMetadataDir(REFERENCE))).model!
    expect(await readFile(join(out, "desired-state.sql"), "utf8")).toBe(
      renderDesiredState(model).sql
    )
  })

  it("no --out writes nothing", async () => {
    const dir = join(await tempDir(), "metadata")
    await cp(REFERENCE, dir, { recursive: true })
    const before = await snapshotOf(dir)
    await runCompile({ dirs: [dir], locale: "en", format: "text" })
    expect(await snapshotOf(dir)).toEqual(before)
  })
})
