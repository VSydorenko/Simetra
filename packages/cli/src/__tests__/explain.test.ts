import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runExplain } from "../commands/explain"

const REFERENCE = resolve(__dirname, "../../../../examples/reference/metadata")
const temps: string[] = []

afterEach(async () => {
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true })))
})

describe("simetra explain", () => {
  it("--format json parses", async () => {
    const r = await runExplain({
      target: "Document.ServiceAccrual",
      dir: REFERENCE,
      format: "json",
    })
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout) as {
      object: { name: string }
      tables: unknown[]
    }
    expect(parsed.object.name).toBe("ServiceAccrual")
    expect(parsed.tables.length).toBeGreaterThan(0)
  })

  it("text output names every table", async () => {
    const json = await runExplain({
      target: "Document.ServiceAccrual",
      dir: REFERENCE,
      format: "json",
    })
    const tables = (
      JSON.parse(json.stdout) as { tables: { schema: string; name: string }[] }
    ).tables
    const text = await runExplain({
      target: "Document.ServiceAccrual",
      dir: REFERENCE,
      format: "text",
    })
    for (const t of tables)
      expect(text.stdout).toContain(`${t.schema}.${t.name}`)
  })

  it("usage errors exit 2", async () => {
    const base = { dir: REFERENCE, format: "text" as const }
    expect((await runExplain({ ...base, target: "Nope" })).exitCode).toBe(2)
    expect(
      (
        await runExplain({
          ...base,
          target: "Catalog.Currency",
          locale: "xx" as "en",
        })
      ).exitCode
    ).toBe(2)
    expect((await runExplain({ ...base, target: "Bogus.X" })).exitCode).toBe(2)
    expect(
      (await runExplain({ ...base, target: "Catalog.Nope" })).exitCode
    ).toBe(2)
    expect(
      (
        await runExplain({
          ...base,
          target: "Catalog.Currency",
          format: "yaml" as "text",
        })
      ).exitCode
    ).toBe(2)
  })

  it("broken compile prints diagnostics and exits 1", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "simetra-cli-")), "metadata")
    temps.push(join(dir, ".."))
    await cp(REFERENCE, dir, { recursive: true })
    const file = join(dir, "catalogs/Currency/Currency.meta.json")
    const json = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >
    delete json.id
    await writeFile(file, JSON.stringify(json, null, 2))
    const r = await runExplain({
      target: "Catalog.Currency",
      dir,
      format: "text",
    })
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toContain("error")
  })
})
