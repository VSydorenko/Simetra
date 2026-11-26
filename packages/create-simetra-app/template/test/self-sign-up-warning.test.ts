import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import config from "../simetra.config"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

type Diagnostic = { code: string; params?: Record<string, string> }

/** Діагностики компіляції метаданих шаблону тим самим CLI, що й `generate`. */
function compileDiagnostics(): Diagnostic[] {
  const designer = dirname(
    createRequire(import.meta.url).resolve("@simetrajs/designer/package.json")
  )
  const result = spawnSync(
    process.execPath,
    [
      join(designer, "bin/simetra.mjs"),
      "compile",
      join(ROOT, config.metadataDir),
      "--format=json",
    ],
    { encoding: "utf8" }
  )
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as Diagnostic[]
}

describe("self sign-up warning of the template", () => {
  // Country відкрито межі `authenticated`, а не гостю: відкрита самореєстрація
  // робить його видимим будь-кому, і попередження мусить це назвати (Р-D5-9)
  it("lists Country among the objects open to every signed-in user", () => {
    const warning = compileDiagnostics().find(
      (diagnostic) => diagnostic.code === "project.self-sign-up"
    )
    expect(warning?.params?.objects.split(", ")).toContain("Country")
  }, 60_000)
})
