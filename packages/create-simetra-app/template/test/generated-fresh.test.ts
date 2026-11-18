import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import config from "../simetra.config"
import {
  CATALOG_FILES,
  generateCatalogs,
} from "../scripts/generate-catalogs.mjs"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), "simetra-fresh-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe("generated catalogs", () => {
  // Каталоги комітяться: застарілий файл дав би рантайму іншу модель, ніж у
  // метаданих, і лишився б непоміченим до першого запиту.
  it("match a fresh compile of the metadata", () => {
    generateCatalogs(scratch)
    for (const file of CATALOG_FILES) {
      expect(
        readFileSync(join(scratch, file), "utf8"),
        `${file} is stale: run pnpm generate`
      ).toBe(readFileSync(join(ROOT, config.generatedDir, file), "utf8"))
    }
  }, 60_000)
})
