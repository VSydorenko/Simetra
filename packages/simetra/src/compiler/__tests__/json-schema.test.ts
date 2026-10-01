import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { KIND_REGISTRY } from "simetra/model"
import { buildJsonSchemas } from "../json-schema"

const SCHEMAS_DIR = join(import.meta.dirname, "../../../schemas")

type JsonObject = Record<string, unknown>

describe("buildJsonSchemas", () => {
  it("every kind has a schema", () => {
    const schemas = buildJsonSchemas()
    for (const def of Object.values(KIND_REGISTRY)) {
      expect(schemas).toHaveProperty([`${def.dir}.schema.json`])
    }
    expect(schemas).toHaveProperty(["project.schema.json"])
  })

  it("generation does not throw on any kind", () => {
    expect(() => buildJsonSchemas()).not.toThrow()
  })

  it("is deterministic", () => {
    expect(JSON.stringify(buildJsonSchemas())).toBe(
      JSON.stringify(buildJsonSchemas())
    )
  })

  it("schemas are up to date", () => {
    for (const [file, schema] of Object.entries(buildJsonSchemas())) {
      const text = JSON.stringify(schema, null, 2) + "\n"
      const path = join(SCHEMAS_DIR, file)
      if (process.env.UPDATE_JSON_SCHEMAS === "1") {
        writeFileSync(path, text)
        continue
      }
      expect(readFileSync(path, "utf8"), file).toBe(text)
    }
  })

  it("descriptions are present", () => {
    const catalogs = buildJsonSchemas()["catalogs.schema.json"] as JsonObject
    const properties = catalogs.properties as Record<string, JsonObject>
    expect(properties.codeLength?.description).toEqual(expect.any(String))
  })

  it("kind is a const and required", () => {
    const schemas = buildJsonSchemas()
    for (const [kind, def] of Object.entries(KIND_REGISTRY)) {
      const schema = schemas[`${def.dir}.schema.json`] as JsonObject
      const properties = schema.properties as Record<string, JsonObject>
      expect(properties.kind?.const, kind).toBe(kind)
      expect(schema.required as string[], kind).toContain("kind")
    }
  })
})
