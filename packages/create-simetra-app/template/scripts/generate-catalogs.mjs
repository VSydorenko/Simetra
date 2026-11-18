import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import config from "../simetra.config.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
// Комітяться лише каталоги рантайму й клієнта; решту артефактів `compile --out`
// (знімок, SQL, типи) застосунок не читає.
export const CATALOG_FILES = ["runtime-catalog.json", "client-catalog.json"]

/** Компілює проєкт метаданих і кладе каталоги рантайму й клієнта в `outDir`. */
export function generateCatalogs(outDir) {
  const designer = dirname(
    createRequire(import.meta.url).resolve("@simetrajs/designer/package.json")
  )
  const scratch = mkdtempSync(join(tmpdir(), "simetra-template-"))
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(designer, "bin/simetra.mjs"),
        "compile",
        join(ROOT, config.metadataDir),
        "--out",
        scratch,
      ],
      { encoding: "utf8" }
    )
    if (result.status !== 0)
      throw new Error(`compile failed:\n${result.stdout}${result.stderr}`)
    mkdirSync(outDir, { recursive: true })
    for (const file of CATALOG_FILES)
      copyFileSync(join(scratch, file), join(outDir, file))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  generateCatalogs(join(ROOT, config.generatedDir))
