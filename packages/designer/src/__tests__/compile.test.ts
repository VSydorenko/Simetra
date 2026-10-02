import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { compile, MESSAGES, type Locale } from "simetra/compiler"
import { renderDesiredState } from "simetra/schema"
import { readMetadataDir } from "../io/metadata-dir"
import { runTool, type CliArgs } from "../cli/command"
import { toolByName } from "../tools/catalog"
import { project, snapshotOf, useTmpProjects } from "./helpers/catalog"

const REFERENCE = resolve(__dirname, "../../../../examples/reference/metadata")

useTmpProjects()

const compileCli = (args: CliArgs) => runTool(toolByName("compile")!, args)

/** Копія референсного домену, у якого в одному файлі знято `id`. */
async function brokenCopy(): Promise<string> {
  const dir = await project()
  const file = join(dir, "catalogs/Currency/Currency.meta.json")
  const json = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >
  delete json.id
  await writeFile(file, JSON.stringify(json, null, 2))
  return dir
}

/** Тека поруч із `metadata` у тимчасовому проєкті: існує батько, самої теки немає. */
async function outDir(): Promise<string> {
  return join(await project(), "..", "out")
}

describe("simetra compile", () => {
  it("reference domain compiles", async () => {
    const r = await compileCli({ _: [REFERENCE], locale: "en", format: "text" })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("0 error(s)")
  })

  it("errors give exit code 1 with file:line:col", async () => {
    const dir = await brokenCopy()
    const r = await compileCli({ _: [dir], locale: "en", format: "text" })
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
    const r = await compileCli({ _: [dir], locale: "en", format: "json" })
    const list = JSON.parse(r.stdout) as Record<string, unknown>[]
    expect(Array.isArray(list)).toBe(true)
    const d = list.find((x) => x.code === "identity.id-missing")
    expect(d).toMatchObject({ dir, file: expect.any(String) })
    expect(d?.range).toBeDefined()
  })

  it("uk locale", async () => {
    const dir = await brokenCopy()
    const r = await compileCli({ _: [dir], locale: "uk", format: "json" })
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
    const r = await compileCli({
      _: [join(await project(), "nope")],
      locale: "en",
      format: "text",
    })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("error:")
  })

  it("--out writes snapshot, sql and types", async () => {
    const out = await outDir()
    const r = await compileCli({
      _: [REFERENCE],
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
    const dir = await project()
    const before = await snapshotOf(dir)
    await compileCli({ _: [dir], locale: "en", format: "text" })
    expect(await snapshotOf(dir)).toEqual(before)
  })

  it("invalid locale gives exit code 2", async () => {
    const r = await compileCli({
      _: [REFERENCE],
      locale: "xx" as Locale,
      format: "text",
    })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("--locale")
  })

  it("--out with several dirs gives exit code 2 and writes nothing", async () => {
    const out = await outDir()
    const r = await compileCli({
      _: [REFERENCE, REFERENCE],
      out,
      locale: "en",
      format: "text",
    })
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain("--out")
    await expect(readdir(out)).rejects.toThrow()
  })

  it("trailing slash does not double the separator", async () => {
    const r = await compileCli({
      _: [`${REFERENCE}/`],
      locale: "en",
      format: "text",
    })
    expect(r.stdout).not.toContain("//")
  })
})
