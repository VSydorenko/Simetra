import { cp, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { publint } from "publint"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  exec,
  installConsumer,
  REPO,
  listPackedFiles,
  packWorkspace,
  readPackedManifest,
  removeTemps,
} from "./support"

// Гейт пакування: потребує свіжого `pnpm build:packages` (корінь репо).
let tarballs: { simetra: string; designer: string }

beforeAll(async () => {
  tarballs = await packWorkspace()
})

afterAll(removeTemps)

/** publint над tarball: повідомлення рівня warning і вище. */
async function publintMessages(tarball: string): Promise<string[]> {
  const buffer = await readFile(tarball)
  const { messages } = await publint({
    pack: {
      tarball: buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      ),
    },
    level: "warning",
  })
  return messages.map((m) => `${m.code} ${m.path.join(".")}`)
}

describe("simetra", () => {
  let consumer: string

  beforeAll(async () => {
    consumer = await installConsumer([tarballs.simetra])
  })

  it("exposes only the built tiers", async () => {
    const manifest = await readPackedManifest(tarballs.simetra)
    expect(Object.keys(manifest.exports as object).sort()).toEqual([
      "./compiler",
      "./model",
      "./schema",
      "./schemas/*",
    ])
    expect(manifest.private).toBeUndefined()
    expect(JSON.stringify(manifest)).not.toContain("workspace:")
  })

  it("ships dist, schemas and the licence, not sources or tests", async () => {
    const files = await listPackedFiles(tarballs.simetra)
    for (const f of [
      "dist/model/index.js",
      "dist/model/index.d.ts",
      "dist/compiler/index.js",
      "dist/schema/index.js",
      "schemas/catalogs.schema.json",
      "LICENSE",
      "README.md",
    ])
      expect(files).toContain(f)
    expect(
      files.filter((f) => f.startsWith("src/") || f.includes("__tests__"))
    ).toEqual([])
  })

  it("each tier is self-contained in dist", async () => {
    // Спільний чанк між ярусами = друга копія модуля в рантаймі споживача
    // (реєстр видів, схеми Zod), бо ярус імпортує інший ярус через `simetra/<ярус>`
    const js = (await listPackedFiles(tarballs.simetra)).filter((f) =>
      f.endsWith(".js")
    )
    expect(
      js.filter((f) => !/^dist\/(model|compiler|schema)\//.test(f))
    ).toEqual([])
  })

  it("imports every tier in plain Node", async () => {
    const script = [
      'const model = await import("simetra/model")',
      'const compiler = await import("simetra/compiler")',
      'const schema = await import("simetra/schema")',
      "console.log([model, compiler, schema].map((m) => Object.keys(m).length > 0).join())",
    ].join("\n")
    const { stdout } = await exec(
      process.execPath,
      ["--input-type=module", "-e", script],
      { cwd: consumer }
    )
    expect(stdout.trim()).toBe("true,true,true")
  })

  it("passes publint", async () => {
    expect(await publintMessages(tarballs.simetra)).toEqual([])
  })

  it("passes arethetypeswrong (esm-only)", async () => {
    // attw завершується ненульовим кодом на будь-якій проблемі резолву типів
    await expect(
      exec(join(import.meta.dirname, "../../node_modules/.bin/attw"), [
        tarballs.simetra,
        "--profile",
        "esm-only",
        "--format",
        "ascii",
      ])
    ).resolves.toBeDefined()
  })
})

describe("@simetrajs/designer", () => {
  let consumer: string
  let bin: string
  const run = (args: string[]) => exec(bin, args, { cwd: consumer })

  beforeAll(async () => {
    consumer = await installConsumer([tarballs.simetra, tarballs.designer])
    // Симлінк, який створив npm, а не `node dist/main.js`: так його запускає споживач
    bin = join(consumer, "node_modules/.bin/simetra")
    await cp(
      join(REPO, "examples/reference/metadata"),
      join(consumer, "metadata"),
      { recursive: true }
    )
  })

  it("pins simetra to its own version and has no dev launcher deps", async () => {
    const m = await readPackedManifest(tarballs.designer)
    const s = await readPackedManifest(tarballs.simetra)
    expect(m.version).toBe(s.version) // lockstep, Р1
    expect((m.dependencies as Record<string, string>).simetra).toBe(s.version)
    expect(m.dependencies).not.toHaveProperty("tsx")
    expect(m.bin).toEqual({ simetra: "./dist/main.js" })
  })

  it("ships dist and both consumer skills, not the dev launcher", async () => {
    const files = await listPackedFiles(tarballs.designer)
    for (const f of [
      "dist/main.js",
      "skills/simetra-metadata/SKILL.md",
      "skills/simetra-adoption/SKILL.md",
      "LICENSE",
      "README.md",
    ])
      expect(files).toContain(f)
    expect(files.filter((f) => /^(bin|src)\//.test(f))).toEqual([])
  })

  it("--version prints the package version", async () => {
    const { version } = await readPackedManifest(tarballs.designer)
    const { stdout } = await run(["--version"])
    expect(stdout.trim()).toBe(version)
  })

  it("compiles the reference metadata", async () => {
    const { stdout } = await run(["compile", "metadata"])
    expect(stdout).toContain("0 error(s)")
  })

  it("fix writes $schema that resolves inside node_modules/simetra", async () => {
    const file = join(consumer, "metadata/catalogs/Currency/Currency.meta.json")
    const json = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >
    delete json.$schema
    await writeFile(file, JSON.stringify(json, null, 2))
    await run(["fix", "metadata"])
    const { $schema } = JSON.parse(await readFile(file, "utf8"))
    const target = resolve(dirname(file), $schema)
    expect(
      target.startsWith(join(consumer, "node_modules/simetra/schemas") + sep)
    ).toBe(true)
    await expect(readFile(target, "utf8")).resolves.toContain('"$schema"')
  })

  it("serves tools over MCP", async () => {
    const client = new Client({ name: "packaging-gate", version: "0" })
    await client.connect(
      new StdioClientTransport({
        command: bin,
        args: ["mcp", "metadata", "--read-only"],
        cwd: consumer,
      })
    )
    try {
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toContain("compile")
    } finally {
      await client.close()
    }
  })

  it("passes publint", async () => {
    expect(await publintMessages(tarballs.designer)).toEqual([])
  })
})
