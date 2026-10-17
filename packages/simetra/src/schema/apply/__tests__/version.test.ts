import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { PLATFORM_VERSION } from "simetra/schema"

describe("PLATFORM_VERSION", () => {
  it("equals the version of the simetra package", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(__dirname, "../../../../package.json"), "utf8")
    ) as { version: string }
    expect(PLATFORM_VERSION).toBe(manifest.version)
  })
})
