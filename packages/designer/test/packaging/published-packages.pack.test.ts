import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { publint } from "publint"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  exec,
  installConsumer,
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
