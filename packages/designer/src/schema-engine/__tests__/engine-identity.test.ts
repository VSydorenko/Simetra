import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createPgDeltaEngine } from "../pg-delta/adapter"

const PACKAGE = "@supabase/pg-delta"

/**
 * Версія встановленого двигуна з його `package.json`: пакет не експортує
 * його через `exports`, тож іде вгору від резолвленого входу до маніфесту
 * з власним ім'ям.
 */
function installedVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.resolve(PACKAGE)))
  for (;;) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8")
      ) as { name?: string; version?: string }
      if (manifest.name === PACKAGE && manifest.version !== undefined)
        return manifest.version
    } catch {
      // Маніфесту на цьому рівні немає — ідемо вище
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`${PACKAGE}: package.json not found`)
    dir = parent
  }
}

describe("pg-delta engine identity", () => {
  // Ідентичність потрапляє в артефакт плану й журнал застосування: записана
  // вручну версія, що відстала від оновленого пакета, мовчки дала б хибну
  // ідентичність двигуна
  it("names the installed engine package version", () => {
    expect(createPgDeltaEngine().identity).toEqual({
      name: "pg-delta",
      version: installedVersion(),
    })
  })
})
